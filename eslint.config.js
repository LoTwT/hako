// @ts-check

import { defineFlatConfig } from "@ayingott/eslint-config"

export default defineFlatConfig([{ ignores: ["**/src-tauri/**"] }], {
  prettier: true,
  vue: true,
  unocss: false,
  react: false,
})
