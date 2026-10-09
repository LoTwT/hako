// 门禁页聚焦补偿回归（LD-R1）：本组测试真实编译并异步载入
// LocalDevelopmentLoginPage.vue（defineAsyncComponent + 受控加载闸门），宿主按
// App.vue 的门禁接线绑定（呈现变化时 focusNow + 就绪补偿），覆盖三条规则：
// 门禁页异步就绪且仍属登录呈现时补一次标题聚焦；迟到/已离开登录呈现不抢焦点；
// 同一实例不重复补偿。焦点用最小宿主的 focusCount 观测，不冒充真实浏览器
// （真实动态导入路径另由浏览器证据覆盖）。

import { afterEach, describe, expect, it } from "vitest";
import { defineAsyncComponent, defineComponent, h, nextTick, ref, shallowRef, watch, type Component, type Ref } from "vue";
import { createGateHeadingFocus, type GateHeadingPage } from "../../src/ui/gate-heading-focus";
import { createMinimalHostRenderer, createMinimalHostRoot, type MinimalHostNode } from "../helpers/minimal-host";

/** 受控加载闸门：解析前门禁页保持「未挂载」，与动态导入未完成时一致。 */
const gate = { pending: [] as (() => void)[] };

function releaseGateLoad(): void {
  const pending = gate.pending.splice(0);
  for (const release of pending) release();
}

/** 真实 SFC，但由测试控制解析时机；模块只在此处 import（受控异步边界）。 */
const LocalDevelopmentLoginPage = defineAsyncComponent(() => new Promise<{ default: Component }>((resolve) => {
  gate.pending.push(() => {
    void import("../../src/components/auth/LocalDevelopmentLoginPage.vue").then((module) => resolve(module as { default: Component }));
  });
}));

/** 与 App.vue 相同接线的宿主：呈现变化时 focusNow，就绪补偿由策略模块负责。 */
function createGateHost(presentation: Ref<"login" | "enter">) {
  const loginPage = shallowRef<GateHeadingPage | null>(null);
  const host = defineComponent({
    name: "GateHost",
    setup() {
      const gateHeading = createGateHeadingFocus(loginPage, () => presentation.value === "login");
      watch(presentation, (value) => {
        if (value === "login") gateHeading.focusNow();
      }, { flush: "post" });
      return () => (presentation.value === "login"
        ? h(LocalDevelopmentLoginPage, { ref: loginPage, notice: "", busy: false })
        : h("div", { id: "entered" }));
    },
  });
  return { host, loginPage };
}

function collectNodes(root: MinimalHostNode, predicate: (node: MinimalHostNode) => boolean): MinimalHostNode[] {
  const found: MinimalHostNode[] = [];
  const visit = (node: MinimalHostNode): void => {
    if (predicate(node)) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

function loginHeadingFocusCount(root: MinimalHostNode): number {
  return collectNodes(root, (node) => node.props.id === "login-title")
    .reduce((total, node) => total + node.focusCount, 0);
}

async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flush();
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  releaseGateLoad();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function mountHost(presentation: Ref<"login" | "enter">) {
  const { host } = createGateHost(presentation);
  const { createApp } = createMinimalHostRenderer();
  const root = createMinimalHostRoot();
  const app = createApp(host);
  app.mount(root);
  cleanups.push(() => app.unmount());
  return root;
}

describe("门禁页聚焦补偿（异步门禁页）", () => {
  it("门禁页异步就绪且仍属登录呈现时，标题取得程序焦点且只补偿一次", async () => {
    const presentation = ref<"login" | "enter">("login");
    const root = mountHost(presentation);
    await flush();

    // 动态导入未完成：门禁页尚未挂载，没有可聚焦的标题。
    expect(collectNodes(root, (node) => node.props.id === "login-title")).toHaveLength(0);
    expect(loginHeadingFocusCount(root)).toBe(0);

    releaseGateLoad();
    await waitFor(() => collectNodes(root, (node) => node.props.id === "login-title").length === 1);
    await waitFor(() => loginHeadingFocusCount(root) === 1);
    await flush();

    const headings = collectNodes(root, (node) => node.props.id === "login-title");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.focusCount).toBe(1);
    expect(headings[0]!.props.class).toContain("programmatic-focus-heading");
  });

  it("门禁页就绪前已离开登录呈现：迟到的组件不抢焦点", async () => {
    const presentation = ref<"login" | "enter">("login");
    const root = mountHost(presentation);
    await flush();

    // 会话先离开登录呈现，之后动态导入才完成。
    presentation.value = "enter";
    await flush();
    releaseGateLoad();
    // 给迟到的动态导入充分的解析时间，仍不得挂载门禁页或聚焦。
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flush();
    await flush();

    expect(collectNodes(root, (node) => node.props.id === "login-title")).toHaveLength(0);
    expect(loginHeadingFocusCount(root)).toBe(0);
    expect(collectNodes(root, (node) => node.props.id === "entered")).toHaveLength(1);
  });

  it("卸载后重新就绪：新实例再次补偿，同一实例不重复聚焦", async () => {
    const presentation = ref<"login" | "enter">("login");
    const root = mountHost(presentation);
    await flush();
    releaseGateLoad();
    await waitFor(() => loginHeadingFocusCount(root) === 1);

    // 离开登录呈现：门禁页卸载；再回到登录呈现：新实例挂载（定义已缓存，同步挂载）
    // 且呈现 watcher 已聚焦该实例，补偿不得重复调用。
    presentation.value = "enter";
    await flush();
    presentation.value = "login";
    await waitFor(() => collectNodes(root, (node) => node.props.id === "login-title").length === 1);
    await flush();
    expect(loginHeadingFocusCount(root)).toBe(1);
  });
});
