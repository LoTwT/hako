// 应用外框与独立启动状态的 App 编排测试：真实编译 App.vue、真实 useAuthSession 与
// AuthSessionClient，会话请求由受控 fetch 驱动；工作区以最小桩替代（挂载/卸载与
// visible 属性可观察），不冒充真实浏览器。覆盖：未知状态先显示外框与启动等待且不
// 改地址/标题、有效响应进入目标、未登录登录入口与返回线索、暂不可确认与离线重试、
// 暖页面后台检查不闪 loading、失效/缓存恢复/同步拒绝关闭门禁且不销毁隐藏工作区、
// 草稿落盘失败阻止登录、退出入口、以及按钮/锚点数量与标题焦点。合成 pageshow 只
// 验证事件分支接线，不代表真实 bfcache 行为。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderer, nextTick } from "vue";

const workspaceMock = vi.hoisted(() => ({
  mounts: [] as string[],
  unmounts: [] as string[],
  flushOk: true,
  flushCalls: 0,
  props: null as Record<string, unknown> | null,
}));

vi.mock("virtual:pwa-register/vue", async () => {
  const { shallowRef } = await import("vue");
  return { useRegisterSW: () => ({ offlineReady: shallowRef(false), needRefresh: shallowRef(false) }) };
});

vi.mock("../../src/components/refueling/AccountWorkspace.vue", async () => {
  const { defineComponent, h, onUnmounted } = await import("vue");
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
        workspaceMock.props = props as unknown as Record<string, unknown>;
        onUnmounted(() => workspaceMock.unmounts.push(props.accountId));
        expose({
          saving: false,
          flushDraft: async () => {
            workspaceMock.flushCalls += 1;
            return workspaceMock.flushOk
              ? { ok: true, message: "" }
              : { ok: false, message: "草稿尚未保存到本机，请先处理保存问题再登录。" };
          },
          // 合成工作区的同步端点拒绝，用于验证 App 的重新确认接线。
          rejectSession: () => emit("sessionRejected"),
        });
        // 模拟真实工作区的私密内容：仅可见时渲染文本（隐藏实例保留但不露出）。
        return () => h("div", props.visible ? "加油记录" : "");
      },
    }),
  };
});

import App from "../../src/App.vue";

// 忠实的最小宿主（与其他组件测试同构，另记录属性、文本与焦点）：Vue 卸载 fragment
// 依赖 nextSibling 沿兄弟链收敛，no-op 宿主会死循环；v-show 需要 element.style。
interface HostNode {
  kind: "root" | "element" | "text" | "comment";
  tag: string | null;
  text: string | null;
  props: Record<string, unknown>;
  children: HostNode[];
  parent: HostNode | null;
  style: Record<string, string>;
  focusCount: number;
  focus: (options?: unknown) => void;
}

function createHostNode(kind: HostNode["kind"], tag: string | null, text: string | null): HostNode {
  const node: HostNode = {
    kind,
    tag,
    text,
    props: {},
    children: [],
    parent: null,
    style: {},
    focusCount: 0,
    focus: () => {
      node.focusCount += 1;
    },
  };
  return node;
}

function hostChildListOf(node: HostNode): HostNode[] {
  if (!Array.isArray(node.children)) node.children = [];
  return node.children;
}

function detachHostNode(node: HostNode): void {
  const parent = node.parent;
  if (parent === null) return;
  const siblings = hostChildListOf(parent);
  const index = siblings.indexOf(node);
  if (index >= 0) siblings.splice(index, 1);
  node.parent = null;
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) {
    node.props[key] = next;
  },
  insert(child, parent, anchor = null) {
    detachHostNode(child);
    const siblings = hostChildListOf(parent);
    const index = anchor === null ? -1 : siblings.indexOf(anchor);
    siblings.splice(index < 0 ? siblings.length : index, 0, child);
    child.parent = parent;
  },
  remove(child) {
    detachHostNode(child);
  },
  createElement(tag) {
    return createHostNode("element", tag, null);
  },
  createText(text) {
    return createHostNode("text", null, text);
  },
  createComment(text) {
    return createHostNode("comment", null, text);
  },
  // App 的功能图标经静态提升为静态 vnode（createStaticVNode）：记录原始标记，
  // 文本收集时去掉标签只比较可见文字。
  insertStaticContent(content, parent, anchor = null) {
    const node = createHostNode("element", "#static", String(content));
    detachHostNode(node);
    const siblings = hostChildListOf(parent);
    const index = anchor === null ? -1 : siblings.indexOf(anchor);
    siblings.splice(index < 0 ? siblings.length : index, 0, node);
    node.parent = parent;
    return [node, node];
  },
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    for (const child of hostChildListOf(node)) child.parent = null;
    node.children = [];
    node.text = text;
  },
  parentNode(node) {
    return node.parent;
  },
  nextSibling(node) {
    const parent = node.parent;
    if (parent === null) return null;
    const siblings = hostChildListOf(parent);
    const index = siblings.indexOf(node);
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1]! : null;
  },
});

// ---------------------------------------------------------------------------
// 浏览器桩与受控会话请求
// ---------------------------------------------------------------------------

interface PendingRequest {
  url: string;
  method: string;
  resolve: (response: Response) => void;
}

const requests: PendingRequest[] = [];
const windowListeners = new Map<string, Array<(event: unknown) => void>>();
const documentListeners = new Map<string, Array<(event: unknown) => void>>();
const storage = new Map<string, string>();
const location = { hash: "", assign: vi.fn() };
const history = { replaceState: vi.fn(), pushState: vi.fn(), back: vi.fn() };
const documentStub = { title: "", visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() };

function installBrowserStubs(): void {
  requests.length = 0;
  windowListeners.clear();
  documentListeners.clear();
  storage.clear();
  location.hash = "";
  location.assign.mockClear();
  history.replaceState.mockClear();
  history.pushState.mockClear();
  history.back.mockClear();
  documentStub.title = "";
  documentStub.visibilityState = "visible";
  documentStub.addEventListener.mockImplementation((type: string, listener: (event: unknown) => void) => {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
  });
  vi.stubGlobal("window", {
    location,
    history,
    scrollTo: vi.fn(),
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return await new Promise<Response>((resolve) => {
      requests.push({ url, method: init?.method ?? "GET", resolve });
    });
  }) as typeof fetch);
}

function emitWindow(type: string, event: unknown): void {
  for (const listener of windowListeners.get(type) ?? []) listener(event);
}

function emitDocument(type: string): void {
  for (const listener of documentListeners.get(type) ?? []) listener({});
}

function respond(response: Response): void {
  const pending = requests.shift();
  if (!pending) throw new Error("没有待响应的请求");
  pending.resolve(response);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sessionBody(authenticated: boolean, accountId: string | null = null): Response {
  return jsonResponse(authenticated ? { authenticated: true, accountId } : { authenticated: false });
}

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";

// ---------------------------------------------------------------------------
// 渲染树查询与挂载
// ---------------------------------------------------------------------------

function allNodes(root: HostNode): HostNode[] {
  const nodes: HostNode[] = [];
  const walk = (node: HostNode) => {
    nodes.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return nodes;
}

function visibleText(root: HostNode): string {
  return allNodes(root).map((node) => node.text === null ? "" : node.tag === "#static" ? node.text.replace(/<[^>]*>/g, " ") : node.text).join(" ");
}

function findButton(root: HostNode, label: string): HostNode {
  const found = allNodes(root).find((node) => node.kind === "element" && node.tag === "button" && buttonText(node).trim() === label);
  if (!found) throw new Error(`未找到按钮：${label}\n实际文本：${visibleText(root)}`);
  return found;
}

/** 按钮文本含图标等子节点：收集全部后代文字再比较（纯文本元素由宿主存于 text）。 */
function buttonText(node: HostNode): string {
  if (node.tag === "#static") return (node.text ?? "").replace(/<[^>]*>/g, " ");
  if (node.children.length === 0) return node.text ?? "";
  return node.children.map(buttonText).join("");
}

function countElements(root: HostNode, tag: string): number {
  return allNodes(root).filter((node) => node.kind === "element" && node.tag === tag).length;
}

function click(node: HostNode): void {
  const handler = node.props.onClick;
  expect(typeof handler).toBe("function");
  (handler as (event: unknown) => void)({ button: 0 });
}

let root: HostNode;
let vm: { $: { setupState: Record<string, unknown> } } | null = null;
let app: ReturnType<typeof renderer.createApp> | null = null;

function mountApp(): void {
  root = createHostNode("root", null, null);
  app = renderer.createApp(App);
  vm = app.mount(root) as unknown as { $: { setupState: Record<string, unknown> } };
}

function setupState(): Record<string, unknown> {
  if (!vm) throw new Error("应用尚未挂载");
  return vm.$.setupState;
}

beforeEach(() => {
  workspaceMock.mounts.length = 0;
  workspaceMock.unmounts.length = 0;
  workspaceMock.flushOk = true;
  workspaceMock.flushCalls = 0;
  workspaceMock.props = null;
  installBrowserStubs();
});

afterEach(() => {
  app?.unmount();
  app = null;
  vm = null;
  vi.unstubAllGlobals();
});

describe("应用外框与独立启动状态", () => {
  it("未知会话状态先在首页外框显示启动等待：无登录卡片与登录按钮，无业务内容，地址与标题保持目标", async () => {
    mountApp();
    await settle();

    const text = visibleText(root);
    expect(text).toContain("Hako");
    expect(text).toContain("正在打开…");
    expect(text).toContain("正在确认你的 Hako 会话，请稍候。");
    expect(text).not.toContain("登录后继续");
    expect(text).not.toContain("登录 eruoo");
    expect(text).not.toContain("我的工具");
    expect(text).not.toContain("加油记录");
    // 加载期间没有多余导航入口与可点操作。
    expect(countElements(root, "a")).toBe(0);
    expect(countElements(root, "button")).toBe(0);
    expect(documentStub.title).toBe("Hako");
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/");
    expect(requests.map((request) => request.url)).toEqual(["/api/auth/session"]);
    expect(workspaceMock.mounts).toEqual([]);
  });

  it("未知会话状态在加油目标先显示启动等待：地址与标题保持 /#refueling，确认后进入并挂载工作区", async () => {
    location.hash = "#refueling";
    mountApp();
    await settle();

    expect(visibleText(root)).toContain("正在打开…");
    expect(visibleText(root)).not.toContain("登录 eruoo");
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#refueling");
    expect(documentStub.title).toBe("加油记录 · Hako");
    expect(workspaceMock.mounts).toEqual([]);

    respond(sessionBody(true, ACCOUNT));
    await settle();

    const text = visibleText(root);
    expect(text).toContain("加油记录");
    expect(text).not.toContain("正在打开…");
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#refueling");
    expect(documentStub.title).toBe("加油记录 · Hako");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.props).toMatchObject({ accountId: ACCOUNT, opened: true, visible: true });
  });

  it("明确未登录：进入登录入口并保留返回目标线索，登录按钮接线发出登录请求", async () => {
    location.hash = "#refueling";
    mountApp();
    await settle();
    respond(sessionBody(false));
    await settle();

    const text = visibleText(root);
    expect(text).toContain("登录后继续");
    expect(text).toContain("登录 eruoo");
    expect(text).toContain("重新检查登录状态");
    expect(text).not.toContain("正在打开…");
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#login");
    expect(documentStub.title).toBe("登录 · Hako");
    expect(storage.get("hako:login-return-page")).toBe("refueling");
    expect(countElements(root, "a")).toBe(0);

    click(findButton(root, "登录 eruoo"));
    await settle();
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /api/auth/login"]);
    respond(jsonResponse({ authorizationUrl: "https://auth.eruoo.me/api/auth/oauth2/authorize?state=x" }));
    await settle();
    expect(location.assign).toHaveBeenCalledWith("https://auth.eruoo.me/api/auth/oauth2/authorize?state=x");
    expect(storage.get("hako:login-return-page")).toBe("refueling");
  });

  it("服务端异常：显示独立的暂不可确认状态与重试，不冒充未登录；重试成功回到原目标", async () => {
    location.hash = "#refueling";
    mountApp();
    await settle();
    respond(jsonResponse({ error: "server_error" }, 500));
    await settle();

    const text = visibleText(root);
    expect(text).toContain("暂时无法确认登录状态");
    expect(text).toContain("服务端暂时无法确认登录状态。本机记录与草稿已保留。");
    expect(text).not.toContain("登录 eruoo");
    expect(countElements(root, "button")).toBe(1);
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#refueling");
    expect(documentStub.title).toBe("加油记录 · Hako");

    click(findButton(root, "重试"));
    await settle();
    expect(requests.map((request) => request.url)).toEqual(["/api/auth/session"]);
    respond(sessionBody(true, ACCOUNT));
    await settle();

    expect(visibleText(root)).toContain("加油记录");
    expect(visibleText(root)).not.toContain("暂时无法确认登录状态");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.props).toMatchObject({ visible: true });
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#refueling");
  });

  it("离线：不发起会话请求，显示暂不可确认；联网重试成功后进入目标", async () => {
    const navigatorStub = { onLine: false };
    vi.stubGlobal("navigator", navigatorStub);
    mountApp();
    await settle();

    expect(requests).toEqual([]);
    const text = visibleText(root);
    expect(text).toContain("暂时无法确认登录状态");
    expect(text).toContain("本机记录与草稿已保留。");
    expect(text).not.toContain("登录 eruoo");

    navigatorStub.onLine = true;
    click(findButton(root, "重试"));
    await settle();
    expect(requests.map((request) => request.url)).toEqual(["/api/auth/session"]);
    respond(sessionBody(true, ACCOUNT));
    await settle();
    expect(visibleText(root)).toContain("我的工具");
    expect(documentStub.title).toBe("Hako");
  });

  it("已确认页面的后台检查：发起读取不闪等待状态，实际失效后关闭门禁并保留工作区实例", async () => {
    location.hash = "#refueling";
    mountApp();
    await settle();
    respond(sessionBody(true, ACCOUNT));
    await settle();
    expect(visibleText(root)).toContain("加油记录");

    // 页面重新可见触发的普通后台检查：读取在途时保持当前内容，不整页闪 loading。
    emitDocument("visibilitychange");
    await settle();
    expect(requests.map((request) => request.url)).toEqual(["/api/auth/session"]);
    expect(visibleText(root)).toContain("加油记录");
    expect(visibleText(root)).not.toContain("正在打开…");
    expect(workspaceMock.props).toMatchObject({ visible: true });

    // 结果实际失效：仍遵守门禁，但隐藏而非销毁已挂载的工作区。
    respond(sessionBody(false));
    await settle();
    expect(visibleText(root)).toContain("登录后继续");
    expect(visibleText(root)).not.toContain("加油记录");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.unmounts).toEqual([]);
    expect(workspaceMock.props).toMatchObject({ visible: false });

    // 重新确认有效后回到原目标，复用同一工作区实例。
    click(findButton(root, "重新检查登录状态"));
    await settle();
    respond(sessionBody(true, ACCOUNT));
    await settle();
    expect(visibleText(root)).toContain("加油记录");
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#refueling");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.props).toMatchObject({ visible: true });
  });

  it("缓存文档恢复（合成 pageshow 分支）：强制重新确认时使用启动呈现且不改地址，确认后恢复原内容", async () => {
    location.hash = "#refueling";
    mountApp();
    await settle();
    respond(sessionBody(true, ACCOUNT));
    await settle();

    // 普通 pageshow 不关闭门禁：组合层的返回监听会发起一次读取，但界面保持当前内容。
    emitWindow("pageshow", { persisted: false });
    await settle();
    expect(requests.map((request) => request.url)).toEqual(["/api/auth/session"]);
    expect(visibleText(root)).toContain("加油记录");
    expect(visibleText(root)).not.toContain("正在打开…");
    respond(sessionBody(true, ACCOUNT));
    await settle();
    expect(visibleText(root)).toContain("加油记录");

    // 缓存恢复：门禁关闭并复用启动等待呈现，旧内容不露出；App 与组合层的读取合并为一次请求。
    emitWindow("pageshow", { persisted: true });
    await settle();
    expect(requests.map((request) => request.url)).toEqual(["/api/auth/session"]);
    expect(visibleText(root)).toContain("正在打开…");
    expect(visibleText(root)).not.toContain("加油记录");
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#refueling");
    expect(documentStub.title).toBe("加油记录 · Hako");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.unmounts).toEqual([]);
    expect(workspaceMock.props).toMatchObject({ visible: false });

    respond(sessionBody(true, ACCOUNT));
    await settle();
    expect(visibleText(root)).toContain("加油记录");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.props).toMatchObject({ visible: true });
  });

  it("同步端点拒绝会话：关闭门禁显示启动等待，重新确认有效后恢复同一工作区", async () => {
    location.hash = "#refueling";
    mountApp();
    await settle();
    respond(sessionBody(true, ACCOUNT));
    await settle();

    const workspaces = setupState().workspaces as Array<{ rejectSession: () => void }>;
    expect(workspaces).toHaveLength(1);
    workspaces[0]!.rejectSession();
    await settle();

    expect(visibleText(root)).toContain("正在打开…");
    expect(visibleText(root)).not.toContain("加油记录");
    expect(requests.map((request) => request.url)).toEqual(["/api/auth/session"]);
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.unmounts).toEqual([]);
    expect(workspaceMock.props).toMatchObject({ visible: false });

    respond(sessionBody(true, ACCOUNT));
    await settle();
    expect(visibleText(root)).toContain("加油记录");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);
    expect(workspaceMock.props).toMatchObject({ visible: true });
  });

  it("草稿落盘失败阻止登录跳转：不发登录请求、不跳转，并显示可读提示", async () => {
    location.hash = "#refueling";
    mountApp();
    await settle();
    respond(sessionBody(true, ACCOUNT));
    await settle();

    emitDocument("visibilitychange");
    await settle();
    respond(sessionBody(false));
    await settle();
    expect(visibleText(root)).toContain("登录后继续");
    expect(workspaceMock.mounts).toEqual([ACCOUNT]);

    workspaceMock.flushOk = false;
    click(findButton(root, "登录 eruoo"));
    await settle();

    expect(workspaceMock.flushCalls).toBeGreaterThan(0);
    expect(requests).toEqual([]);
    expect(location.assign).not.toHaveBeenCalled();
    expect(visibleText(root)).toContain("草稿尚未保存到本机，请先处理保存问题再登录。");
    expect(visibleText(root)).toContain("登录后继续");
  });

  it("退出登录：经设置层退出后返回登录入口并保留返回线索，工作区保留实例", async () => {
    mountApp();
    await settle();
    respond(sessionBody(true, ACCOUNT));
    await settle();

    // 首页顶栏账号入口打开设置层（G4），退出登录位于设置层。
    click(findButton(root, "已登录 · eruoo"));
    await settle();
    expect(visibleText(root)).toContain("账号与外观");
    click(findButton(root, "退出登录"));
    await settle();
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /api/auth/logout"]);
    respond(jsonResponse({ authenticated: false }));
    await settle();

    expect(visibleText(root)).toContain("登录后继续");
    expect(history.replaceState.mock.calls.at(-1)?.[2]).toBe("/#login");
    expect(documentStub.title).toBe("登录 · Hako");
    expect(storage.get("hako:login-return-page")).toBe("home");
    // 本流程始终停留在首页：工作区从未挂载（其余用例覆盖实例保留）。
    expect(workspaceMock.mounts).toEqual([]);
    expect(workspaceMock.unmounts).toEqual([]);
  });

  it("可访问的状态与焦点：等待、暂不可确认与进入目标时焦点落在当前标题", async () => {
    mountApp();
    await settle();

    // 等待状态由 role=status 的可读说明与不吃焦点跳转的标题构成。
    const startupHeading = allNodes(root).find((node) => node.props.id === "startup-title");
    expect(startupHeading).toBeDefined();
    expect(startupHeading!.props.tabindex).toBe("-1");
    expect(allNodes(root).some((node) => node.props.role === "status")).toBe(true);

    respond(jsonResponse({ error: "server_error" }, 500));
    await settle();
    const unavailableHeading = allNodes(root).find((node) => node.props.id === "unavailable-title");
    expect(unavailableHeading).toBeDefined();
    expect(unavailableHeading!.focusCount).toBeGreaterThan(0);

    click(findButton(root, "重试"));
    await settle();
    respond(sessionBody(true, ACCOUNT));
    await settle();
    const pageHeading = allNodes(root).find((node) => node.kind === "element" && node.tag === "h1" && (node.text ?? "").includes("我的工具"));
    expect(pageHeading).toBeDefined();
    expect(pageHeading!.focusCount).toBeGreaterThan(0);
  });
});
