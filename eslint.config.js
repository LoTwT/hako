// @ts-check

import { defineConfig } from "@ayingott/eslint-config"

export default defineConfig({
  typescript: true,
  vue: true,

  ignores: ["**/src-tauri/**"],
})
