import { defineConfig } from "vitest/config";

export default defineConfig({
  // 组件接线测试（需要 SFC 编译）由 vitest.components.config.ts 单独承载。
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/components/**"],
  },
});
