<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { useRegisterSW } from "virtual:pwa-register/vue";
import LoginPage from "./components/auth/LoginPage.vue";
import SessionUnavailablePage from "./components/auth/SessionUnavailablePage.vue";
import StartupPage from "./components/auth/StartupPage.vue";
import HomePage from "./components/home/HomePage.vue";
import SettingsPanel from "./components/settings/SettingsPanel.vue";
import AccountWorkspace from "./components/refueling/AccountWorkspace.vue";
import { useAuthSession } from "./composables/useAuthSession";
import { useAppearance } from "./ui/appearance";
import { createModalFocus } from "./ui/modal-focus";
import {
  parseAppRoute,
  routeHref,
  routeKey,
  type AppRoute,
  type RefuelingRoute,
} from "./ui/app-route";

/**
 * 会话呈现：enter 可进入目标页，startup 等待确认，login 明确未登录，
 * unavailable 无法确认。未知状态不再复用登录呈现，也不把地址与标题改成登录页。
 */
type SessionPresentation = "enter" | "startup" | "login" | "unavailable";
const loginReturnPageKey = "hako:login-return-page";
const shellWideMediaQuery = "(min-width: 880px)";

/**
 * 目标路由（targetRoute）是应用维护的当前页面身份：
 * - 匿名门禁期间地址强制为 /#login，但目标路由保留原值，重新确认后恢复；
 * - #login 地址本身不覆盖目标路由（历史不能绕过会话检查）；
 * - 离开编辑器路由或加油工作区前先等待草稿落盘，失败保持原页。
 */
function initialTargetRoute(): AppRoute {
  // 一次性本机导航线索只接受固定页面类别（home / refueling），不承载返回 URL。
  let hash = window.location.hash;
  try {
    const returnPage = window.sessionStorage.getItem(loginReturnPageKey);
    window.sessionStorage.removeItem(loginReturnPageKey);
    if ((hash === "" || hash === "#" || hash === "#login") && returnPage === "refueling") {
      window.history.replaceState(null, "", "/#refueling");
      hash = "#refueling";
    }
  } catch {
    // sessionStorage 不可用时仍从首页进入；草稿由独立 IndexedDB 恢复。
  }
  return parseAppRoute(hash);
}

const targetRoute = shallowRef<AppRoute>(initialTargetRoute());
/**
 * 最近一次由应用压入的历史跳转 {from, to}：仅在链未被浏览器前进/后退或其他
 * 导航打断时可信。编辑器保存/放弃、设置层关闭等「返回来源」只在邻项可信时
 * 调用 history.back，否则替换到已知来源页（设计 §3.3 一次性来源标记）。
 */
const lastPush = shallowRef<{ from: string; to: string } | null>(null);
/** 设置层的来源页面（内存）：直接打开/刷新时无来源，Web 叠在首页。 */
const settingsBackdrop = shallowRef<AppRoute | null>(null);

const accounts = shallowRef<{ id: string; opened: boolean }[]>([]);
const workspaces = shallowRef<InstanceType<typeof AccountWorkspace>[]>([]);
const loginPage = shallowRef<InstanceType<typeof LoginPage> | null>(null);
const startupPage = shallowRef<InstanceType<typeof StartupPage> | null>(null);
const unavailablePage = shallowRef<InstanceType<typeof SessionUnavailablePage> | null>(null);
const homePage = shallowRef<InstanceType<typeof HomePage> | null>(null);
const settingsPanel = shallowRef<InstanceType<typeof SettingsPanel> | null>(null);
/**
 * 设置层焦点管理（打开记录触发点、层内陷阱、关闭还原；UI-R13）。关闭动作
 * （Esc/关闭按钮/遮罩共用）走统一的关闭导航：还原焦点 → 回到打开时的背景页。
 */
const settingsFocus = createModalFocus({
  close: () => {
    const backdrop = settingsBackdrop.value?.name === "refueling" ? settingsBackdrop.value : { name: "home" as const };
    settingsBackdrop.value = null;
    backTo(backdrop);
  },
  initialFocus: () => (typeof document !== "undefined" && typeof document.querySelector === "function"
    ? document.querySelector<HTMLElement>("#settings-title")
    : null),
  // 设置层关闭经路由/历史返回（宏任务）：焦点还原统一由 settingsOpen 关闭
  // watcher 处理（Esc/按钮/遮罩/浏览器返回单一入口），本模块不重复还原。
  restoreOnClose: false,
});

const { auth, refresh: refreshAuth, login: startLogin, logout: endLogin, recheckRejectedSession } = useAuthSession();
const appearanceState = useAppearance();
const refreshingRestoredPage = shallowRef(false);
const canEnter = computed(() => auth.value.status === "authenticated" && auth.value.accountId !== null && !refreshingRestoredPage.value);
const sessionPresentation = computed<SessionPresentation>(() => {
  if (canEnter.value) return "enter";
  // 缓存文档恢复与同步拒绝后的重新确认都保持门禁关闭，并复用启动等待呈现。
  if (refreshingRestoredPage.value) return "startup";
  if (auth.value.status === "anonymous") return "login";
  if (auth.value.status === "unavailable") return "unavailable";
  return "startup";
});
const loginNotice = shallowRef("");
const navigationNotice = shallowRef("");
const sessionFeedback = computed(() => loginNotice.value || auth.value.message);
const loginPhase = shallowRef<"idle" | "preparing" | "navigating">("idle");
const loginInProgress = computed(() => loginPhase.value !== "idle");
const navigationBusy = computed(() => loginInProgress.value || workspaces.value.some((workspace) => workspace.saving));
const accountActive = computed(() => canEnter.value && !loginInProgress.value && !auth.value.loggingIn && !auth.value.loggingOut);
const registrationError = shallowRef("");
const { offlineReady, needRefresh } = useRegisterSW({
  onRegisterError() {
    registrationError.value = "离线资源准备失败；重新联网打开后再检查。";
  },
});
const wideShell = shallowRef(typeof window === "undefined" || typeof window.matchMedia !== "function"
  ? true
  : window.matchMedia(shellWideMediaQuery).matches);
const accountLabel = computed(() => (auth.value.status === "authenticated" ? "已登录 · eruoo" : "未登录"));

const refuelingRoute = computed<RefuelingRoute>(() =>
  targetRoute.value.name === "refueling" ? targetRoute.value.refueling : { name: "records" });
const workspaceRoute = computed(() => targetRoute.value);
/** 工作区在加油路由下保持可见；设置层叠在加油区之上时同样保留渲染（仅被覆盖）。 */
const workspaceVisible = computed(() => {
  if (!canEnter.value) return false;
  const route = targetRoute.value;
  if (route.name === "refueling") return true;
  return route.name === "settings" && settingsBackdrop.value?.name === "refueling";
});
const homeVisible = computed(() => {
  if (!canEnter.value) return false;
  const route = targetRoute.value;
  if (route.name === "home") return true;
  return route.name === "settings" && (settingsBackdrop.value?.name ?? "home") === "home";
});
const settingsOpen = computed(() => canEnter.value && targetRoute.value.name === "settings");
/**
 * 设置层关闭的统一焦点还原（UI-R13）：Esc、关闭按钮、遮罩与浏览器返回
 * （历史导航）都会使 settingsOpen 变 false——在这里统一把焦点还给触发点
 * （触发点失效时由 modal-focus 回退）。仅在账号/门禁仍匹配时还原；层又被
 * 打开时还原调度自身会跳过。
 */
watch(settingsOpen, (open, previous) => {
  if (open || !previous) return;
  if (!canEnter.value) return;
  settingsFocus.restoreFocus();
});

function routeTitle(route: AppRoute): string {
  if (route.name === "home") return "Hako";
  if (route.name === "login") return "登录 · Hako";
  if (route.name === "settings") return "设置 · Hako";
  switch (route.refueling.name) {
    case "records": return "加油记录 · Hako";
    case "record-detail": return "记录详情 · Hako";
    case "record-new": return "记一次加油 · Hako";
    case "record-edit": return "编辑记录 · Hako";
    case "statistics": return "加油统计 · Hako";
    case "data": return "数据 · Hako";
    case "data-backups": return "备份与恢复 · Hako";
    case "data-backup-preview": return "恢复预览 · Hako";
    case "data-restore-result": return "恢复结果 · Hako";
    case "data-retained": return "保留内容 · Hako";
    case "data-legacy-import": return "导入旧验证记录 · Hako";
  }
}

function syncVisiblePage() {
  // 未确认会话时不挂载业务组件；已有实例仅隐藏，待写草稿与占用继续存活。
  const presentation = sessionPresentation.value;
  const href = presentation === "login" ? "/#login" : routeHref(targetRoute.value);
  window.history.replaceState(null, "", href);
  try {
    if (canEnter.value) window.sessionStorage.removeItem(loginReturnPageKey);
    else window.sessionStorage.setItem(loginReturnPageKey, targetRoute.value.name === "refueling" ? "refueling" : "home");
  } catch {
    // 页面线索不可用时仍保持门禁，草稿由独立 IndexedDB 保留。
  }
  // 检查中与暂不可确认保留目标页标题；只有明确未登录才是登录页标题。
  document.title = presentation === "login" ? "登录 · Hako" : routeTitle(targetRoute.value);
}
syncVisiblePage();
watch([canEnter, sessionPresentation, () => auth.value.accountId, targetRoute], () => {
  syncVisiblePage();
}, { flush: "sync" });

// 焦点管理：进入/门禁变化聚焦当前标题；加油区内部路由标题由工作区自行聚焦。
// 滚动只在粗粒度页面（首页↔加油区）切换时回到顶部；加油子路由的主从选择不
// 丢正在浏览的位置（UI-R12）。
let previousCoarsePage: "home" | "refueling" | null = null;
watch([canEnter, sessionPresentation, targetRoute], (_values, previous) => {
  // 离开设置层的本次变化跳过页面标题聚焦：焦点由 settingsOpen 关闭 watcher
  // 还原到设置触发点（UI-R13），标题聚焦不得与触发点还原争夺焦点。
  const leavingSettings = (previous[2] as AppRoute | undefined)?.name === "settings";
  if (sessionPresentation.value === "enter") {
    if (targetRoute.value.name === "settings") settingsPanel.value?.focusHeading();
    else if (targetRoute.value.name === "home" && !leavingSettings) homePage.value?.focusHeading();
  } else if (sessionPresentation.value === "login") loginPage.value?.focusHeading();
  else if (sessionPresentation.value === "unavailable") unavailablePage.value?.focusHeading();
  else if (!leavingSettings) startupPage.value?.focusHeading();
  const coarsePage = targetRoute.value.name === "refueling" ? "refueling" : targetRoute.value.name === "home" ? "home" : null;
  if (coarsePage !== null && coarsePage !== previousCoarsePage) window.scrollTo?.(0, 0);
  previousCoarsePage = coarsePage;
}, { flush: "post" });

/**
 * 隐藏的加油工作区在离开加油区前也须完成待写草稿（成功才隐藏）。失败只返回
 * 可读信息，不直接写全局提示（UI-R04.2）：提示属于发起导航的任务，由调用方
 * 在归属复核通过后才发布，旧任务的失败不得越过检查写给当前账号。
 */
async function flushWorkspaces(): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const workspace of workspaces.value) {
    const result = await workspace.flushDraft();
    if (!result.ok) {
      return { ok: false, message: result.message || "草稿尚未保存到本机，已取消切换。" };
    }
  }
  return { ok: true };
}

/**
 * 会话生命周期代次（UI-R04.1）：已观测到的账号变化即作废在途导航任务——
 * 恢复同一个 accountId（A→B→A）开启的是新生命周期，不重新授权旧任务；
 * 仅比较当前 accountId 无法表达「操作期间身份一直有效」。
 */
let authLifecycleEpoch = 0;
watch(() => auth.value.accountId, () => {
  authLifecycleEpoch += 1;
});

/**
 * 导航归属（UI-R04）：每个导航意图（含目标相同的重复意图）都使旧任务失效；
 * 任务发起时绑定会话生命周期代次，任何 await（当前为草稿 flush）之后只有
 * 仍是最新意图、会话生命周期未变、会话可用且不忙时才写入路由与历史。迟到
 * 的旧意图（已回退、已前进、已被更新的同路由意图取代、期间账号发生过变化）
 * 不落位、不追加历史、不发布提示，失败回写同样按该身份核对，不给过期任务
 * 补历史或把旧失败提示写给当前账号。
 */
let navigationSequence = 0;

async function commitRouteChange(
  previous: AppRoute,
  next: AppRoute,
  write: () => void,
  ownership: () => boolean,
): Promise<{ changed: boolean; superseded: boolean }> {
  navigationNotice.value = "";
  // 接收意图即作废在途任务：目标相同的重复点击也撤销旧的（例如等待 flush 的
  // 统计导航被用户改选回当前页）。
  const sequence = ++navigationSequence;
  const ownerEpoch = authLifecycleEpoch;
  const supersededNow = (): boolean => sequence !== navigationSequence || authLifecycleEpoch !== ownerEpoch;
  if (routeKey(previous) === routeKey(next)) return { changed: false, superseded: false };
  if (previous.name === "refueling") {
    const flushed = await flushWorkspaces();
    if (!flushed.ok) {
      // 失败提示与路由写入同样按归属发布：任务已过期（较新意图或期间账号
      // 变化）时旧失败不写给当前页面；归属仍有效才给出可读提示（UI-R04.2）。
      if (!supersededNow()) navigationNotice.value = flushed.message;
      return { changed: false, superseded: supersededNow() };
    }
  }
  // 归属复核：await 期间出现更新的导航意图、会话生命周期变化、忙态时不落位。
  if (supersededNow()) {
    return { changed: false, superseded: true };
  }
  if (!ownership()) return { changed: false, superseded: false };
  write();
  targetRoute.value = next;
  return { changed: true, superseded: false };
}

/** 应用内导航：离开加油区（含编辑器路由）先等待草稿落盘，失败保持原页。 */
async function navigate(next: AppRoute): Promise<void> {
  if (!canEnter.value || navigationBusy.value) return;
  const previous = targetRoute.value;
  const wantedBackdrop = next.name === "settings" ? previous : null;
  const { changed } = await commitRouteChange(previous, next, () => {
    window.history.pushState({ hako: true }, "", routeHref(next));
    lastPush.value = { from: routeKey(previous), to: routeKey(next) };
  }, () => canEnter.value && !navigationBusy.value);
  if (changed) settingsBackdrop.value = wantedBackdrop;
  else settingsBackdrop.value = null;
}

/** 地址替换（记录解析失败回根页等内部修正）：不新增历史条目。 */
async function replaceRoute(next: AppRoute): Promise<void> {
  if (!canEnter.value) return;
  const previous = targetRoute.value;
  if (next.name === "settings") settingsBackdrop.value = null;
  await commitRouteChange(previous, next, () => {
    window.history.replaceState({ hako: true }, "", routeHref(next));
    lastPush.value = null;
  }, () => canEnter.value && !navigationBusy.value);
}

/**
 * 返回目标页：仅当最近一次应用压入正是「从目标页到当前页」时走 history.back
 * （历史邻项可信），否则替换到目标页，不依赖不确定的历史深度。
 */
function backTo(target: AppRoute): void {
  const currentKey = routeKey(targetRoute.value);
  const push = lastPush.value;
  if (push !== null && push.to === currentKey && push.from === routeKey(target)) {
    lastPush.value = null;
    window.history.back();
    return;
  }
  void replaceRoute(target);
}

/**
 * 浏览器导航（popstate/hashchange）协调（UI-R04）：同一浏览器动作的配对事件
 * 串行处理——进行中的处理完成后按最新地址复算，不重复触发离开保护或重复
 * 恢复历史；await 期间地址已被更新的前进/后退改变时，旧处理不落位。
 */
let locationChangeInFlight = false;
let locationChangeQueued = false;

async function onLocationChanged(): Promise<void> {
  if (locationChangeInFlight) {
    locationChangeQueued = true;
    return;
  }
  locationChangeInFlight = true;
  try {
    do {
      locationChangeQueued = false;
      await handleLocationChangeOnce();
    } while (locationChangeQueued);
  } finally {
    locationChangeInFlight = false;
  }
}

async function handleLocationChangeOnce(): Promise<void> {
  // 浏览器发起的前进/后退打断应用压入链：邻项可信标记失效。
  lastPush.value = null;
  if (navigationBusy.value) {
    window.history.replaceState(null, "", sessionPresentation.value === "login" ? "/#login" : routeHref(targetRoute.value));
    return;
  }
  const hash = window.location.hash;
  const parsed = parseAppRoute(hash);
  // 登录页本身不覆盖原先要进入的固定页面，历史记录也不能绕过会话检查。
  if (parsed.name === "login" && sessionPresentation.value !== "enter") return;
  const previous = targetRoute.value;
  if (parsed.name !== "settings") settingsBackdrop.value = null;
  if (routeKey(parsed) === routeKey(previous)) {
    // 同一逻辑目标（popstate/hashchange 配对事件的第二次）：不重新赋值，避免
    // 对象身份变化再次触发页面级 watcher（焦点/滚动）。
    return;
  }
  const { changed, superseded } = await commitRouteChange(previous, parsed, () => undefined, () => window.location.hash === hash);
  if (!changed && !superseded) {
    if (window.location.hash === hash) {
      // 草稿未落盘且地址仍是被拒绝的目标：把地址推回原页面（离开保护），
      // 用户输入与占用保持不变。地址已被更新的导航或账号变化取代时不追加历史。
      window.history.pushState({ hako: true }, "", routeHref(previous));
    }
  }
}

function openSettings(event?: Event) {
  settingsFocus.focusOnOpen(event);
  void navigate({ name: "settings" });
}

/** 关闭设置层：焦点还原与关闭导航都由 settingsFocus 的统一关闭动作完成。 */
function closeSettings() {
  // 焦点还原统一由 settingsOpen 关闭 watcher 处理（覆盖 Esc/按钮/遮罩/浏览器
  // 返回所有路径）；此处只触发关闭动作（含路由返回）。
  settingsFocus.focusOnClose();
}

function onSettingsLayerKeydown(event: KeyboardEvent) {
  if (!settingsOpen.value) return;
  settingsFocus.onLayerKeydown(event);
}

async function confirmDraftSaved(): Promise<boolean> {
  // 首页尚未打开工作区时没有本页待写内容；已打开后即使隐藏也必须等待它落盘。
  for (const workspace of workspaces.value) {
    const result = await workspace.flushDraft();
    if (!result.ok) { loginNotice.value = result.message; return false; }
  }
  return true;
}

async function login() {
  if (navigationBusy.value || auth.value.loggingIn || auth.value.loggingOut) return;
  loginNotice.value = "";
  loginPhase.value = "preparing";
  try {
    // 先让冻结与首次工作区挂载生效，再等待最新草稿写入。
    await nextTick();
    if (!(await confirmDraftSaved())) return;
    const result = await startLogin();
    if (!result.ok) {
      loginNotice.value = result.message;
      return;
    }
    if (!(await confirmDraftSaved())) return;
    try {
      window.sessionStorage.setItem(loginReturnPageKey, targetRoute.value.name === "refueling" ? "refueling" : "home");
    } catch {
      // 导航线索失败不影响已确认落盘的草稿，也不阻止登录。
    }
    loginPhase.value = "navigating";
    await nextTick();
    window.location.assign(result.authorizationUrl);
  } finally {
    if (loginPhase.value !== "navigating") loginPhase.value = "idle";
  }
}

async function logout() {
  loginNotice.value = "";
  if (settingsOpen.value) closeSettings();
  const result = await endLogin();
  if (!result.ok) loginNotice.value = result.message;
}

function onPageShow(event: PageTransitionEvent) {
  if (!event.persisted) return;
  // 授权页返回可能复用整个文档；解除离页冻结，账号状态由 useAuthSession 重读。
  loginPhase.value = "idle";
  refreshingRestoredPage.value = true;
  // 与 useAuthSession 的 pageshow 读取合并；缓存文档必须重新确认后再展示内容。
  void refreshAuth().finally(() => {
    refreshingRestoredPage.value = false;
  });
}

function syncVisibleWorkspace() {
  // 只有真正进入加油区后才挂载工作区；挂载后仅隐藏，实例与草稿保留。
  const accountId = auth.value.accountId;
  if (canEnter.value && accountId && workspaceRoute.value.name === "refueling") {
    const known = accounts.value.find((account) => account.id === accountId);
    if (!known) accounts.value = [...accounts.value, { id: accountId, opened: true }];
    else if (!known.opened) {
      accounts.value = accounts.value.map((account) => account.id === accountId ? { ...account, opened: true } : account);
    }
  }
}
watch([canEnter, workspaceRoute, () => auth.value.accountId], () => {
  syncVisibleWorkspace();
}, { flush: "sync" });

function onShellMediaChange(event: MediaQueryListEvent) {
  wideShell.value = event.matches;
}

let shellMedia: MediaQueryList | null = null;
onMounted(() => {
  window.addEventListener("popstate", onLocationChanged);
  window.addEventListener("hashchange", onLocationChanged);
  window.addEventListener("pageshow", onPageShow);
  if (typeof window.matchMedia === "function") {
    shellMedia = window.matchMedia(shellWideMediaQuery);
    shellMedia.addEventListener("change", onShellMediaChange);
  }
});
onUnmounted(() => {
  window.removeEventListener("popstate", onLocationChanged);
  window.removeEventListener("hashchange", onLocationChanged);
  window.removeEventListener("pageshow", onPageShow);
  shellMedia?.removeEventListener("change", onShellMediaChange);
  shellMedia = null;
  appearanceState.dispose();
});

// 首次挂载时按当前会话与目标路由装配工作区（登录返回线索已在 initialTargetRoute 消费）。
syncVisibleWorkspace();
</script>

<template>
  <div class="app-root" :data-route="targetRoute.name === 'refueling' ? 'refueling' : targetRoute.name">
    <!-- 会话呈现分离：未知状态显示启动等待，无法确认显示独立重试状态；都不呈现
         登录入口。外框（品牌标识）保留，私人工作区不露出。 -->
    <div v-if="sessionPresentation !== 'enter'" class="gate-frame">
      <header class="gate-brand">
        <img class="gate-brand-mark" :src="'/hako-mark-32.png'" :srcset="'/hako-mark-48.png 1.5x, /hako-mark-64.png 2x'" width="32" height="32" alt="" decoding="async" />
        <span class="gate-brand-name">Hako</span>
      </header>
      <StartupPage v-if="sessionPresentation === 'startup'" ref="startupPage" />
      <SessionUnavailablePage v-else-if="sessionPresentation === 'unavailable'" ref="unavailablePage" :message="sessionFeedback" :busy="navigationBusy" @retry="refreshAuth" />
      <LoginPage v-else-if="sessionPresentation === 'login'" ref="loginPage" :notice="loginNotice" :busy="navigationBusy" @login="login" @retry="refreshAuth" />
    </div>

    <!-- 已确认身份：工具首页（设置层叠在首页时保留渲染，仅被覆盖）。 -->
    <HomePage v-if="homeVisible" ref="homePage" :account-label="accountLabel" :busy="navigationBusy"
      @open-settings="openSettings($event)" @open-refueling="navigate({ name: 'refueling', refueling: { name: 'records' } })" />

    <!-- 首次进入才挂载，之后只隐藏：表单、待写草稿与 Web Locks 随页面继续存活。
         离开加油区（含编辑器路由）由 navigate/onLocationChanged 先等待草稿落盘。 -->
    <AccountWorkspace v-for="account in accounts" :key="account.id" ref="workspaces" :account-id="account.id"
      :active="accountActive && auth.accountId === account.id" :opened="account.opened"
      :visible="workspaceVisible && auth.accountId === account.id"
      :route="refuelingRoute" :app-route="workspaceRoute"
      :navigate="navigate" :replace-route="replaceRoute" :back-to="backTo" :open-settings="openSettings"
      :navigating-for-login="loginPhase === 'navigating'" @session-rejected="recheckRejectedSession" />

    <!-- 账号与外观（G4）：Web 右侧设置层，手机整页；关闭还原焦点。 -->
    <div v-if="settingsOpen" :ref="(element) => { settingsFocus.layerRoot.value = element as HTMLElement | null; }"
      class="settings-layer" role="dialog" aria-modal="true" aria-label="设置"
      @keydown="onSettingsLayerKeydown">
      <div class="settings-backdrop" @click="closeSettings"></div>
      <div class="settings-surface" role="document">
        <header class="settings-header">
          <button v-if="!wideShell" type="button" class="settings-back" @click="closeSettings">返回</button>
          <h2 class="settings-heading">账号与外观</h2>
          <button v-if="wideShell" type="button" class="settings-close" aria-label="关闭设置" @click="closeSettings">✕</button>
        </header>
        <SettingsPanel ref="settingsPanel" :appearance="appearanceState.appearance.value"
          :system-dark="appearanceState.systemDark.value"
          :account-label="accountLabel" :logging-out="auth.loggingOut" :busy="navigationBusy"
          @set-appearance="appearanceState.setAppearance" @logout="logout" />
      </div>
    </div>

    <p v-if="canEnter && navigationNotice" class="app-notice" role="alert">{{ navigationNotice }}</p>
    <p v-if="canEnter && registrationError" class="app-notice app-warning" role="alert">{{ registrationError }}</p>
    <p v-else-if="canEnter && offlineReady" class="app-notice">离线页面已准备好</p>
    <p v-if="canEnter && needRefresh" class="app-notice app-warning" role="alert">新版本已就绪。请保存所有窗口中的输入，再关闭并重新打开 Hako。</p>
  </div>
</template>

<style scoped>
.app-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.gate-frame {
  max-width: 65rem;
  width: 100%;
  margin: 0 auto;
  padding: 22px 24px 40px;
}
.gate-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border-default);
}
.gate-brand-mark { display: block; width: 32px; height: 32px; }
.gate-brand-name { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.3px; }
@media (max-width: 719px) {
  .gate-frame { padding: 16px 16px 32px; }
}
.app-notice {
  margin: 8px auto 0;
  padding: 0 16px 16px;
  max-width: 65rem;
  width: 100%;
  font-size: 0.75rem;
  color: var(--text-secondary);
}
.app-warning {
  color: var(--status-warning-fg);
}
.settings-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.settings-backdrop {
  position: absolute;
  inset: 0;
  background: rgb(9 8 12 / 0.32);
}
.settings-surface {
  position: absolute;
  inset: 0;
  background: var(--surface-canvas);
  padding: 18px 20px 32px;
  overflow-y: auto;
}
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.settings-heading {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
.settings-back {
  min-height: 40px;
  padding: 6px 14px;
  font-size: 0.875rem;
}
.settings-close {
  display: grid;
  place-items: center;
  width: 40px;
  min-height: 40px;
  padding: 0;
  font-size: 0.9375rem;
  border-radius: 50%;
}
/* Web（≥880px）：右侧设置层，遮罩之外保留底层页面可见。 */
@media (min-width: 880px) {
  .settings-surface {
    inset: 0 0 0 auto;
    width: min(420px, 92vw);
    border-left: 1px solid var(--border-default);
    background: var(--surface-panel);
    padding: 22px 24px 32px;
    box-shadow: var(--shadow-panel, 0 18px 48px rgb(9 8 12 / 0.18));
  }
}
</style>
