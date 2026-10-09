/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vue" />

/**
 * 本地开发登录构建标志：由 vite.config.ts 的 `define` 注入，只有
 * `pnpm dev:local`（`--mode local-dev`）为 true；其他构建替换为 false。
 */
declare const __HAKO_LOCAL_DEV__: boolean;

/** 本地开发登录端点路径（dev:local 构建注入；权威定义在 src/shared/local-development.ts）。 */
declare const __HAKO_LOCAL_DEV_AUTH_PATHS__: {
  readonly login: string;
  readonly session: string;
  readonly logout: string;
};

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
