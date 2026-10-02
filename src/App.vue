<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { useRegisterSW } from "virtual:pwa-register/vue";
import AuthStatus from "./components/auth/AuthStatus.vue";
import LoginPage from "./components/auth/LoginPage.vue";
import RefuelingWorkspace from "./components/refueling/RefuelingWorkspace.vue";
import { useAuthSession } from "./composables/useAuthSession";

type AppPage = "home" | "refueling";
const loginReturnPageKey = "hako:login-return-page";

function pageFromLocation(): AppPage {
  return window.location.hash === "#refueling" ? "refueling" : "home";
}

function pageHref(page: AppPage): string {
  return page === "refueling" ? "/#refueling" : "/";
}

function initialPage(): AppPage {
  // 一次性本机导航线索只接受固定页面，不表示登录成功，也不承载返回 URL。
  try {
    const returnPage = window.sessionStorage.getItem(loginReturnPageKey);
    window.sessionStorage.removeItem(loginReturnPageKey);
    if (["", "#login"].includes(window.location.hash) && returnPage === "refueling") {
      window.history.replaceState(null, "", pageHref("refueling"));
    }
  } catch {
    // sessionStorage 不可用时仍从首页进入；草稿由独立 IndexedDB 恢复。
  }
  return pageFromLocation();
}

const page = shallowRef<AppPage>(initialPage());
const workspaceOpened = shallowRef(false);
const workspace = shallowRef<InstanceType<typeof RefuelingWorkspace> | null>(null);
const loginPage = shallowRef<InstanceType<typeof LoginPage> | null>(null);
const pageHeading = shallowRef<HTMLHeadingElement | null>(null);
const { auth, refresh: refreshAuth, login: startLogin, logout: endLogin } = useAuthSession();
const refreshingRestoredPage = shallowRef(false);
const canEnter = computed(() => auth.value.status === "authenticated" && !refreshingRestoredPage.value);
const loginPageAuth = computed(() => refreshingRestoredPage.value
  ? { ...auth.value, status: "checking" as const }
  : auth.value);
const loginNotice = shallowRef("");
const loginPhase = shallowRef<"idle" | "preparing" | "navigating">("idle");
const loginInProgress = computed(() => loginPhase.value !== "idle");
const navigationBusy = computed(() => loginInProgress.value || workspace.value?.saving === true);
const registrationError = shallowRef("");
const { offlineReady, needRefresh } = useRegisterSW({
  onRegisterError() {
    registrationError.value = "离线资源准备失败；重新联网打开后再检查。";
  },
});

function visiblePageHref(): string {
  return canEnter.value ? pageHref(page.value) : "/#login";
}

function syncVisiblePage() {
  // 未确认会话时不挂载业务组件；已有实例仅隐藏，待写草稿与占用继续存活。
  if (canEnter.value && page.value === "refueling") workspaceOpened.value = true;
  window.history.replaceState(null, "", visiblePageHref());
  try {
    if (canEnter.value) window.sessionStorage.removeItem(loginReturnPageKey);
    else window.sessionStorage.setItem(loginReturnPageKey, page.value);
  } catch {
    // 页面线索不可用时仍保持门禁，草稿由独立 IndexedDB 保留。
  }
  document.title = !canEnter.value ? "登录 · Hako" : page.value === "home" ? "Hako" : "加油记录 · Hako";
}
syncVisiblePage();
watch([canEnter, page], async () => {
  syncVisiblePage();
  await nextTick();
  if (canEnter.value) pageHeading.value?.focus({ preventScroll: true });
  else loginPage.value?.focusHeading();
  window.scrollTo(0, 0);
}, { flush: "sync" });

function navigate(event: MouseEvent, next: AppPage) {
  if (!canEnter.value || navigationBusy.value) {
    event.preventDefault();
    return;
  }
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (next !== page.value) window.history.pushState(null, "", pageHref(next));
  page.value = next;
}

function onLocationChanged() {
  if (navigationBusy.value) {
    window.history.replaceState(null, "", visiblePageHref());
    return;
  }
  // 登录页本身不覆盖原先要进入的固定页面，历史记录也不能绕过会话检查。
  if (window.location.hash !== "#login") page.value = pageFromLocation();
  syncVisiblePage();
}

async function confirmDraftSaved(): Promise<boolean> {
  // 首页尚未打开工作区时没有本页待写内容；已打开后即使隐藏也必须等待它落盘。
  if (workspace.value === null) return true;
  const result = await workspace.value.flushDraft();
  if (!result.ok) loginNotice.value = result.message;
  return result.ok;
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
      window.sessionStorage.setItem(loginReturnPageKey, page.value);
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

onMounted(() => {
  window.addEventListener("popstate", onLocationChanged);
  window.addEventListener("hashchange", onLocationChanged);
  window.addEventListener("pageshow", onPageShow);
});
onUnmounted(() => {
  window.removeEventListener("popstate", onLocationChanged);
  window.removeEventListener("hashchange", onLocationChanged);
  window.removeEventListener("pageshow", onPageShow);
});
</script>

<template>
  <main class="app-shell" :class="{ 'home-page': page === 'home' || !canEnter }">
    <header class="page-header">
      <div class="brand-navigation">
        <a v-if="canEnter" class="brand" href="/" aria-label="Hako 首页" :aria-disabled="navigationBusy" @click="navigate($event, 'home')"
          >hako<span class="brand-dot">.</span></a
        >
        <span v-else class="brand" aria-label="Hako">hako<span class="brand-dot">.</span></span>
        <span v-if="page === 'home' || !canEnter" class="header-note">个人应用</span>
        <a v-else class="back-link" href="/" :aria-disabled="navigationBusy" @click="navigate($event, 'home')">
          <span aria-hidden="true">←</span> 返回首页
        </a>
      </div>
      <AuthStatus v-if="canEnter" :auth="auth" :notice="loginNotice" :busy="navigationBusy" @login="login" @logout="logout" @retry="refreshAuth" />
    </header>

    <LoginPage v-if="!canEnter" ref="loginPage" :auth="loginPageAuth" :notice="loginNotice" :busy="navigationBusy" @login="login" @retry="refreshAuth" />

    <div v-if="canEnter" class="page-heading">
      <p class="eyebrow">{{ page === "home" ? "A LITTLE SPACE FOR EVERYDAY" : "ONE CAR, EVERY JOURNEY" }}</p>
      <h1 ref="pageHeading" tabindex="-1">{{ page === "home" ? "收好日常的小事。" : "加油记录" }}</h1>
      <p class="intro">
        {{ page === "home" ? "Hako 是你的个人应用，先从记录每一次加油开始。" : "把每次加油，记清楚。记录与草稿保存在此浏览器。" }}
      </p>
    </div>

    <section v-if="canEnter && page === 'home'" aria-labelledby="features-title" class="features">
      <h2 id="features-title">你的功能</h2>
      <a class="feature-card" href="/#refueling" aria-labelledby="refueling-entry-title" :aria-disabled="navigationBusy" @click="navigate($event, 'refueling')">
        <span class="feature-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 11h10M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9l-4-4M19 6v4h3" />
          </svg>
        </span>
        <span class="feature-copy">
          <span id="refueling-entry-title" class="feature-title">加油记录</span>
          <span class="feature-description">记下加油花费，查看本机记录。</span>
          <span class="feature-action">进入加油记录 <span aria-hidden="true">→</span></span>
        </span>
      </a>
      <p class="device-note">数据仅保存在此设备的当前浏览器，暂不支持云端同步与备份。</p>
    </section>

    <!-- 首次进入才挂载，之后只隐藏：表单、待写草稿与 Web Locks 随页面继续存活。 -->
    <RefuelingWorkspace v-if="workspaceOpened" v-show="canEnter && page === 'refueling'" ref="workspace" :locked="loginInProgress || !canEnter" :navigating-for-login="loginPhase === 'navigating'" />

    <p v-if="canEnter && registrationError" class="warning">{{ registrationError }}</p>
    <p v-else-if="canEnter && offlineReady" class="offline-label">离线页面已准备好</p>
    <p v-if="canEnter && needRefresh" class="warning">新版本已就绪。请保存所有窗口中的输入，再关闭并重新打开 Hako。</p>
  </main>
</template>

<style scoped>
.app-shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: 30px 28px 40px;
}
.home-page {
  max-width: 880px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--line);
}
.brand-navigation {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-shrink: 0;
}
.brand {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-size: 30px;
  font-weight: 750;
  letter-spacing: -1.5px;
  color: var(--ink);
  text-decoration: none;
}
.brand-dot {
  color: var(--accent);
}
.header-note {
  font-size: 12px;
  color: var(--muted);
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  color: var(--accent);
  font-size: 14px;
  text-underline-offset: 5px;
}
.page-heading {
  margin: 38px 0 26px;
}
.home-page .page-heading {
  margin: 52px 0 32px;
}
.page-heading h1 {
  width: fit-content;
  margin: 12px 0;
  font-size: clamp(27px, 4vw, 36px);
  font-weight: 550;
  letter-spacing: -0.8px;
}
.page-heading h1:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 6px;
  border-radius: 2px;
}
.intro {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.9;
}
.features h2 {
  margin: 30px 0 14px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
}
.feature-card {
  display: flex;
  align-items: flex-start;
  gap: 22px;
  padding: 30px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
  color: var(--ink);
  text-decoration: none;
}
.feature-card:hover {
  border-color: var(--accent);
}
a[aria-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
}
.feature-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  border-radius: 12px;
  background: #eef3ec;
  color: var(--accent);
}
.feature-icon svg {
  width: 27px;
  height: 27px;
}
.feature-copy {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.feature-title {
  font-size: 22px;
  font-weight: 550;
}
.feature-description {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.8;
}
.feature-action {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
}
.device-note {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.9;
}
.offline-label {
  color: var(--accent);
  font-size: 12px;
  margin-top: 24px;
}
@media (max-width: 760px) {
  .app-shell {
    padding: 20px 16px 32px;
  }
  .page-header {
    padding-bottom: 18px;
  }
  .brand-navigation {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }
  .page-heading,
  .home-page .page-heading {
    margin: 32px 0 24px;
  }
  .feature-card {
    gap: 16px;
    padding: 24px 20px;
  }
  .feature-icon {
    width: 44px;
    height: 44px;
  }
}
</style>
