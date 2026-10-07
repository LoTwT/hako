// 应用导航归属测试（父审第一轮修复 UI-R04/UI-R12 的回归）：真实编译 App.vue，
// AccountWorkspace 以受控桩替代（flush 可阻塞、visible 可观察），真实
// useAuthSession/AuthSessionClient，会话请求由受控 fetch 驱动。覆盖：
// 浏览器「后退后立刻前进」时迟到的草稿 flush 不得覆盖新目标地址（UI-R04）；
// 同一浏览器动作的 popstate+hashchange 配对事件串行处理、失败离开只恢复一次
// 地址（UI-R04）；跨大页切换才复位滚动、进入设置层不重复滚动（UI-R12）。
// 不冒充真实浏览器（边界见 docs/local-validation.md）。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";

const workspaceMock = vi.hoisted(() => ({
  mounts: [] as string[],
  unmounts: [] as string[],
  flushOk: true,
  pendingFlush: null as Promise<{ ok: boolean; message: string }> | null,
  flushCalls: 0,
  visible: false,
}));

vi.mock("virtual:pwa-register/vue", async () => {
  const { shallowRef } = await import("vue");
  return { useRegisterSW: () => ({ offlineReady: shallowRef(false), needRefresh: shallowRef(false) }) };
});

vi.mock("../../src/components/refueling/AccountWorkspace.vue", async () => {
  const { defineComponent, h, onMounted, onUnmounted, watch } = await import("vue");
  return {
    default: defineComponent({
      props: {
        accountId: { type: String, required: true },
        active: Boolean,
        opened: Boolean,
        visible: Boolean,
        navigatingForLogin: Boolean,
        route: { type: Object, default: null },
        appRoute: { type: Object, default: null },
        navigate: { type: Function, default: null },
        replaceRoute: { type: Function, default: null },
        backTo: { type: Function, default: null },
        openSettings: { type: Function, default: null },
      },
      emits: ["sessionRejected"],
      setup(props, { expose, emit }) {
        workspaceMock.mounts.push(props.accountId);
        onMounted(() => { workspaceMock.visible = props.visible; });
        watch(() => props.visible, (value) => { workspaceMock.visible = value; });
        onUnmounted(() => workspaceMock.unmounts.push(props.accountId));
        expose({
          saving: false,
          flushDraft: async () => {
            workspaceMock.flushCalls += 1;
            if (workspaceMock.pendingFlush !== null) return await workspaceMock.pendingFlush;
            return workspaceMock.flushOk
              ? { ok: true, message: "" }
              : { ok: false, message: "草稿尚未保存到本机，请先处理保存问题再登录。" };
          },
          rejectSession: () => emit("sessionRejected"),
        });
        return () => h("div", props.visible ? "加油记录" : "");
      },
    }),
  };
});

import App from "../../src/App.vue";
import { createMinimalHostRenderer, createMinimalHostRoot } from "../helpers/minimal-host";

const renderer = createMinimalHostRenderer();

// ---------------------------------------------------------------------------
// 浏览器桩与受控会话请求
// ---------------------------------------------------------------------------

interface PendingRequest {
  url: string;
  resolve: (response: Response) => void;
}

const requests: PendingRequest[] = [];
const location = { hash: "", assign: vi.fn() };
const scrollTo = vi.fn();
/** 与真实浏览器一致：pushState/replaceState 更新地址但不派发事件。 */
const history = {
  pushState: vi.fn((_data: unknown, _unused: string, href: string) => { location.hash = href.slice(href.indexOf("#")); }),
  replaceState: vi.fn((_data: unknown, _unused: string, href: string) => { location.hash = href.slice(href.indexOf("#")); }),
  back: vi.fn(),
};

function installBrowserStubs(): void {
  requests.length = 0;
  location.hash = "";
  location.assign.mockClear();
  history.pushState.mockClear();
  history.replaceState.mockClear();
  history.back.mockClear();
  scrollTo.mockClear();
  vi.stubGlobal("window", {
    location,
    history,
    scrollTo,
    sessionStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", { title: "", visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return await new Promise<Response>((resolve) => {
      requests.push({ url, resolve });
    });
  }) as typeof fetch);
}

function respond(response: Response): void {
  const pending = requests.shift();
  if (!pending) throw new Error("没有待响应的请求");
  pending.resolve(response);
}

function sessionBody(authenticated: boolean, accountId: string | null = null): Response {
  return new Response(JSON.stringify(authenticated ? { authenticated: true, accountId } : { authenticated: false }), { status: 200, headers: { "content-type": "application/json" } });
}

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------

let app: ReturnType<typeof renderer.createApp> | null = null;
let state: Record<string, (...args: unknown[]) => unknown> | null = null;

function mountApp(): void {
  app = renderer.createApp(App);
  const vm = app.mount(createMinimalHostRoot()) as unknown as { $: { setupState: Record<string, (...args: unknown[]) => unknown> } };
  state = vm.$.setupState;
}

function setupState(): Record<string, (...args: unknown[]) => unknown> {
  if (state === null) throw new Error("应用尚未挂载");
  return state;
}

function blockedFlush() {
  let release!: (result: { ok: boolean; message: string }) => void;
  workspaceMock.pendingFlush = new Promise((resolve) => { release = resolve; });
  return release;
}

async function openAuthenticatedEditor() {
  location.hash = "#refueling/new";
  mountApp(); await settle();
  respond(sessionBody(true, ACCOUNT)); await settle();
}

beforeEach(() => {
  workspaceMock.mounts.length = 0;
  workspaceMock.unmounts.length = 0;
  workspaceMock.flushOk = true;
  workspaceMock.pendingFlush = null;
  workspaceMock.flushCalls = 0;
  installBrowserStubs();
});

afterEach(() => {
  app?.unmount();
  app = null;
  state = null;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// UI-R04 导航归属
// ---------------------------------------------------------------------------

it("UI-R04 后退后立刻前进：迟到的旧 flush 不覆盖新目标，且配对事件只 flush 一次", async () => {
  await openAuthenticatedEditor();
  const release = blockedFlush();
  const current = setupState();
  // 浏览器后退到记录根页：离开编辑器需要先等待草稿落盘。
  location.hash = "#refueling";
  const back = (current.onLocationChanged as () => Promise<void>)();
  await nextTick();
  expect(workspaceMock.flushCalls).toBe(1);
  // 后退尚未落位时浏览器又前进回编辑器：最新意图是编辑器地址。
  location.hash = "#refueling/new";
  await (current.onLocationChanged as () => Promise<void>)();
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
  release({ ok: true, message: "" });
  await back;
  await settle();
  // 旧意图（回根页）不得覆盖新意图：目标仍是编辑器，且没有追加恢复历史的压栈。
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
  expect(history.pushState).not.toHaveBeenCalled();
});

it("UI-R04 popstate 与 hashchange 配对到达且 flush 失败：只恢复一次地址、不重复触发离开保护", async () => {
  await openAuthenticatedEditor();
  const release = blockedFlush();
  const current = setupState();
  history.pushState.mockClear();
  location.hash = "#refueling";
  // 同一次浏览器后退同时产生 popstate 与 hashchange：串行处理，flush 只发起一次。
  const first = (current.onLocationChanged as () => Promise<void>)();
  const second = (current.onLocationChanged as () => Promise<void>)();
  await nextTick();
  expect(workspaceMock.flushCalls).toBe(1);
  release({ ok: false, message: "草稿写入失败" });
  await Promise.all([first, second]);
  await settle();
  // 离开保护：地址推回编辑器且只推一次；目标路由保持在编辑器。
  expect(history.pushState.mock.calls.map((call) => call[2])).toEqual(["/#refueling/new"]);
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
});

it("UI-R04 会话失效后的浏览器导航不落位私有地址", async () => {
  await openAuthenticatedEditor();
  const current = setupState();
  // 工作区报告同步端点拒绝会话 → App 重新确认，会话已失效。
  const workspaces = current.workspaces as unknown as Array<{ rejectSession: () => void }>;
  workspaces[0]!.rejectSession();
  await settle();
  respond(sessionBody(false)); await settle();
  location.hash = "#refueling";
  await (current.onLocationChanged as () => Promise<void>)();
  await settle();
  // 门禁关闭：即使地址指向加油区，私有内容保持隐藏（目标地址仅作登录后的返回线索）。
  expect(workspaceMock.visible).toBe(false);
});

// ---------------------------------------------------------------------------
// UI-R12 滚动复位
// ---------------------------------------------------------------------------

it("UI-R12 跨大页切换复位滚动；进入设置层与同大页内导航不重复滚动", async () => {
  location.hash = "";
  mountApp(); await settle();
  respond(sessionBody(true, ACCOUNT)); await settle();
  const current = setupState();
  scrollTo.mockClear();
  // 首页 → 加油区（大页切换）：复位一次。
  await (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "records" } });
  await settle();
  expect(scrollTo).toHaveBeenCalledTimes(1);
  // 加油区内子页导航（记录根 → 统计）：不滚动。
  scrollTo.mockClear();
  await (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
  // 打开设置层（背景仍是加油区，不是大页切换）：不滚动。
  scrollTo.mockClear();
  await (current.navigate as (route: unknown) => Promise<void>)({ name: "settings" });
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// UI-R04 二轮：导航任务绑定账号；同路由的新意图作废在途任务
// ---------------------------------------------------------------------------

it("UI-R04 二轮：A 的导航等待 flush 期间会话切到 B——旧 A 任务按账号失效，不落位 B 的页面", async () => {
  await openAuthenticatedEditor();
  const release = blockedFlush();
  const current = setupState();
  // A 在编辑器中点击统计：离开加油区需要等待草稿 flush。
  const navigating = (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await nextTick();
  expect(workspaceMock.flushCalls).toBe(1);
  // flush 在途：工作区报告会话被同步端点拒绝，重新确认后会话切到 B
  // （A 的任务已不属于当前账号）。
  const workspaces = current.workspaces as unknown as Array<{ rejectSession: () => void }>;
  workspaces[0]!.rejectSession();
  await settle();
  respond(sessionBody(true, "00000000-0000-4000-8000-0000000000b1"));
  await settle();
  release({ ok: true, message: "" });
  await navigating;
  await settle();
  // 旧 A 意图失效：不 push 统计地址，目标仍是编辑器（B 登录后按其自身操作导航）。
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
  expect(history.pushState).not.toHaveBeenCalled();
});

it("UI-R04 二轮：目标相同的重复意图也作废等待中的旧任务（改选回当前页后旧导航不落位）", async () => {
  await openAuthenticatedEditor();
  const release = blockedFlush();
  const current = setupState();
  // 记录根页发起统计导航（flush 在途）。
  const navigating = (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await nextTick();
  expect(workspaceMock.flushCalls).toBe(1);
  // 用户改选回当前记录根页：目标不同的新意图使旧统计任务撤销（第二个导航同样
  // 等待草稿 flush，不提前 await，避免阻塞释放）。
  const reselecting = (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "records" } });
  await nextTick();
  expect(workspaceMock.flushCalls).toBe(2);
  release({ ok: true, message: "" });
  await Promise.all([navigating, reselecting]);
  await settle();
  // 迟到的统计导航不落位、不追加历史；较新的记录根页意图照常落位（一次 push）。
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "records" } });
  expect(history.pushState).toHaveBeenCalledTimes(1);
  expect(history.pushState).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/#refueling");
});

// ---------------------------------------------------------------------------
// 父审第三轮修复（UI-R04.1 生命周期归属 / R04.2 提示归属）
// ---------------------------------------------------------------------------

it("UI-R04.1：A 的导航等待 flush 期间会话 A→B→A——旧任务按生命周期失效", async () => {
  await openAuthenticatedEditor();
  const release = blockedFlush();
  const current = setupState();
  const navigating = (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await nextTick();
  expect(workspaceMock.flushCalls).toBe(1);
  // 会话依次变为 B、再变回 A（真实客户端经受控响应接受两次有效会话）。
  const workspaces = current.workspaces as unknown as Array<{ rejectSession: () => void }>;
  workspaces[0]!.rejectSession();
  await settle();
  respond(sessionBody(true, "00000000-0000-4000-8000-0000000000b1"));
  await settle();
  workspaces[0]!.rejectSession();
  await settle();
  respond(sessionBody(true, "00000000-0000-4000-8000-0000000000a1"));
  await settle();
  release({ ok: true, message: "" });
  await navigating;
  await settle();
  // 恢复同一 accountId 不重新授权旧任务：迟到导航不落位、不写历史。
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
  expect(history.pushState).not.toHaveBeenCalled();
});

it("UI-R04.2：旧 flush 失败不写给切换后的账号；当前账号自身的失败仍有可读提示", async () => {
  await openAuthenticatedEditor();
  const release = blockedFlush();
  const current = setupState();
  const navigating = (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await nextTick();
  // flush 在途：会话切到 B；A 的旧 flush 随后失败。
  const workspaces = current.workspaces as unknown as Array<{ rejectSession: () => void }>;
  workspaces[0]!.rejectSession();
  await settle();
  respond(sessionBody(true, "00000000-0000-4000-8000-0000000000b1"));
  await settle();
  release({ ok: false, message: "草稿尚未保存到本机，请先处理保存问题再登录。" });
  await navigating;
  await settle();
  // B 保持当前路由，且不出现 A 的旧失败提示（提示按任务归属发布）。
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
  expect(current.navigationNotice).toBe("");

  // 对照：当前账号自身的导航 flush 失败——可读提示保留。
  const release2 = blockedFlush();
  const navigating2 = (current.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await nextTick();
  release2({ ok: false, message: "草稿尚未保存到本机，请先处理保存问题再登录。" });
  await navigating2;
  await settle();
  expect(current.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
  expect(current.navigationNotice).toBe("草稿尚未保存到本机，请先处理保存问题再登录。");
});
