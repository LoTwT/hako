// 未登录门禁接线回归（LD-R1）：真实编译 App.vue，未登录入口以受控异步组件替代
// （与 dev:local 的动态导入同样的时序），会话状态用受控桩驱动。覆盖：门禁页异步
// 就绪后，App 在当前登录呈现补一次标题聚焦。迟到的门禁页不抢焦点见同目录
// app-login-gate-late-load.test.ts；真实动态导入路径由浏览器证据覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, shallowRef } from "vue";
import App from "../../src/App.vue";
import { createMinimalHostRenderer, createMinimalHostRoot } from "../helpers/minimal-host";
import type { ControllableLoginGate } from "../helpers/controllable-login-gate";

const gate = vi.hoisted(() => ({ instance: null as unknown as ControllableLoginGate }));

vi.mock("../../src/ui/login-gate", async () => {
  const { createControllableLoginGate } = await import("../helpers/controllable-login-gate");
  gate.instance = createControllableLoginGate();
  return { LoginGateComponent: gate.instance.component };
});

vi.mock("virtual:pwa-register/vue", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useRegisterSW: () => ({ offlineReady: sr(false), needRefresh: sr(false) }) };
});

vi.mock("../../src/ui/appearance", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useAppearance: () => ({ appearance: sr("system"), systemDark: sr(false), setAppearance() {}, dispose() {} }) };
});

vi.mock("../../src/composables/useAuthSession", async () => {
  const { shallowRef: sr } = await import("vue");
  return {
    useAuthSession: () => ({
      auth: observed.auth,
      authenticatedAccountLabel: sr("已登录 · eruoo"),
      localDevelopment: false,
      refresh: async () => undefined,
      login: vi.fn(),
      logout: vi.fn(),
      recheckRejectedSession: vi.fn(),
    }),
  };
});

const observed = vi.hoisted(() => ({
  auth: null as unknown as { value: { accountId: string | null; status: string; message: string; loggingIn: boolean; loggingOut: boolean } },
}));

const cleanups: (() => void)[] = [];

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

beforeEach(() => {
  observed.auth = shallowRef({ accountId: null, status: "anonymous", message: "", loggingIn: false, loggingOut: false });
  // App 的门禁编排读取本机地址、历史与媒体查询：提供与既有组件测试一致的受控全局。
  vi.stubGlobal("window", {
    location: { hash: "#login", assign: vi.fn() },
    history: { replaceState: vi.fn(), pushState: vi.fn(), back: vi.fn() },
    scrollTo() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("document", { title: "", visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe("未登录门禁的异步就绪聚焦", () => {
  it("异步门禁页就绪且仍为登录呈现时补一次标题聚焦", async () => {
    const renderer = createMinimalHostRenderer();
    const root = createMinimalHostRoot();
    const app = renderer.createApp(App);
    app.mount(root);
    cleanups.push(() => app.unmount());
    await flush();

    // 动态导入未完成：门禁页未挂载，也没有标题聚焦。
    expect(gate.instance.pendingCount()).toBe(1);
    expect(gate.instance.resolveCount()).toBe(0);
    expect(gate.instance.focusCalls()).toBe(0);

    gate.instance.release();
    await waitFor(() => gate.instance.resolveCount() === 1);
    await flush();
    expect(gate.instance.focusCalls()).toBe(1);
  });
});
