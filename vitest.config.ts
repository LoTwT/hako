import { defineConfig } from "vitest/config";
import { LOCAL_DEVELOPMENT_AUTH_PATHS } from "./src/shared/local-development.ts";

export default defineConfig({
  // 与 vite.config.ts 相同的构建标志：测试默认不是本地开发构建，
  // 但路径注入沿用同一权威常量，避免测试与实现各写一份。
  define: {
    __HAKO_LOCAL_DEV__: JSON.stringify(false),
    __HAKO_LOCAL_DEV_AUTH_PATHS__: JSON.stringify(LOCAL_DEVELOPMENT_AUTH_PATHS),
  },
  // 组件接线测试（需要 SFC 编译）由 vitest.components.config.ts 单独承载。
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/components/**"],
  },
});
