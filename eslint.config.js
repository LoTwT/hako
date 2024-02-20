// @ts-check

import { defineFlatConfig } from "@ayingott/eslint-config"

export default defineFlatConfig(
  [
    {
      rules: {
        "eslint-comments/no-unlimited-disable": "off",
      },
    },
    { ignores: ["**/src-tauri/**"] },
  ],
  {
    prettier: true,
    vue: true,
    unocss: true,
    react: false,
  },
)
