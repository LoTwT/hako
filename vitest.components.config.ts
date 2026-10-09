import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { LOCAL_DEVELOPMENT_AUTH_PATHS } from "./src/shared/local-development.ts";

/**
 * 组件接线测试配置：真实编译 SFC。vitest 的 node 环境默认按 SSR 请求 SFC
 * 变换，而本组测试使用自定义客户端 renderer 挂载，因此强制客户端编译
 * （ssr: false）。与主测试配置分开维护：主配置覆盖数据/Worker/编排层，
 * 本配置覆盖 .vue 组件的事件接线与草稿上下文绑定；两组共同构成
 * `pnpm run test` 门禁。
 */
const plugin = vue();
const transform = plugin.transform as { handler: (...args: unknown[]) => unknown };
const original = transform.handler as (code: string, id: string, options: { ssr?: boolean }) => unknown;
transform.handler = function (code: string, id: string, options: { ssr?: boolean }) {
  return original.call(this, code, id, { ...options, ssr: false });
};

export default defineConfig({
  plugins: [plugin],
  // 与 vite.config.ts 相同的构建标志：组件测试默认不是本地开发构建。
  define: {
    __HAKO_LOCAL_DEV__: JSON.stringify(false),
    __HAKO_LOCAL_DEV_AUTH_PATHS__: JSON.stringify(LOCAL_DEVELOPMENT_AUTH_PATHS),
  },
  test: { environment: "node", include: ["tests/components/**/*.test.ts"] },
});
