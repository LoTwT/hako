// @ts-check

import { defineConfig } from "@ayingott/eslint-config"

export default defineConfig({
  vue: true,
  typescript: true,
  tailwindcss: false,

  ignores: ["**/src-tauri/**"],
})
