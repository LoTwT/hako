// 受控未登录门禁组件（组件测试共享）：与 dev:local 的本地登录页同样的时序——
// 动态导入解析前门禁页保持未挂载，解析由测试释放；实例暴露 focusHeading 并可计数。
//
// Vue 的 defineAsyncComponent 会在首次解析后缓存组件定义，因此受控实例必须按测试
// 文件创建（vitest 默认按文件隔离模块）：同一文件内只有第一次解析是异步的。

import { defineAsyncComponent, defineComponent, h, type Component } from "vue";

export interface ControllableLoginGate {
  readonly component: Component;
  /** 尚未解析的加载请求数。 */
  pendingCount(): number;
  /** 已解析次数（每次调用 loader 计一次）。 */
  resolveCount(): number;
  /** 已发生的标题聚焦调用次数。 */
  focusCalls(): number;
  /** 释放当前所有待解析的加载请求（模拟动态导入完成）。 */
  release(): void;
}

/** 动态导入解析结果的最小形态（Vue 依 __esModule 解包 default）。 */
interface LoadedComponentModule {
  readonly __esModule: true;
  readonly default: Component;
}

export function createControllableLoginGate(): ControllableLoginGate {
  const state = { pending: [] as (() => void)[], resolves: 0, focusCalls: 0 };
  const component = defineAsyncComponent(() => new Promise<LoadedComponentModule>((resolve) => {
    state.pending.push(() => {
      state.resolves += 1;
      resolve({
        // 与真实动态导入一致：ES 模块形态（Vue 据此解包 default）。
        __esModule: true as const,
        default: defineComponent({
          name: "ControllableLoginGatePage",
          props: { notice: { type: String, default: "" }, busy: { type: Boolean, default: false } },
          setup(_props, { expose }) {
            expose({
              focusHeading: () => {
                state.focusCalls += 1;
              },
            });
            return () => h("section", { id: "login-title", class: "programmatic-focus-heading" }, "门禁页");
          },
        }),
      });
    });
  }));
  return {
    component,
    pendingCount: () => state.pending.length,
    resolveCount: () => state.resolves,
    focusCalls: () => state.focusCalls,
    release: () => {
      for (const release of state.pending.splice(0)) release();
    },
  };
}
