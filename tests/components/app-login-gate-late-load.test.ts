// 未登录门禁迟到加载回归（LD-R1）：门禁页在会话已离开登录呈现之后才解析完成，
// 不得抢回焦点；回到登录呈现时（定义已缓存，同步挂载）仍按既有 watcher 聚焦。
// 与同目录 app-login-gate-focus-readiness.test.ts 分成两个文件：Vue 的
// defineAsyncComponent 会缓存已解析组件，受控异步时序只在每个测试文件的首次解析成立。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, shallowRef } from "vue";
import App from "../../src/App.vue";
import { createMinimalHostRenderer, createMinimalHostRoot, type MinimalHostNode } from "../helpers/minimal-host";
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

function setAuth(status: string): void {
  observed.auth.value = { accountId: null, status, message: "", loggingIn: false, loggingOut: false };
}

function hasLoginTitle(root: MinimalHostNode): boolean {
  if (root.props.id === "login-title") return true;
  return root.children.some((child) => hasLoginTitle(child));
}

beforeEach(() => {
  observed.auth = shallowRef({ accountId: null, status: "anonymous", message: "", loggingIn: false, loggingOut: false });
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

describe("未登录门禁的迟到加载", () => {
  it("离开登录呈现后解析完成的门禁页不抢焦点；回到登录呈现仍会聚焦", async () => {
    const renderer = createMinimalHostRenderer();
    const root = createMinimalHostRoot();
    const app = renderer.createApp(App);
    app.mount(root);
    cleanups.push(() => app.unmount());
    await flush();

    // 门禁页已发起加载但尚未就绪。
    expect(gate.instance.pendingCount()).toBe(1);
    expect(gate.instance.focusCalls()).toBe(0);

    // 会话先离开登录呈现（暂不可确认），随后动态导入才完成。
    setAuth("unavailable");
    await flush();
    gate.instance.release();
    await waitFor(() => gate.instance.resolveCount() === 1);
    await flush();
    await flush();

    expect(hasLoginTitle(root)).toBe(false);
    expect(gate.instance.focusCalls()).toBe(0);

    // 回到登录呈现：定义已缓存，门禁页同步挂载，既有 watcher 依旧聚焦标题。
    setAuth("anonymous");
    await flush();
    await flush();
    expect(hasLoginTitle(root)).toBe(true);
    expect(gate.instance.focusCalls()).toBe(1);
  });
});
