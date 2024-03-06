import { URL, fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import Vue from "@vitejs/plugin-vue"
import { internalIpV4 } from "internal-ip"
import Unocss from "unocss/vite"
import Components from "unplugin-vue-components/vite"
import AutoImport from "unplugin-auto-import/vite"
import VueRouter from "unplugin-vue-router/vite"
import {
  VueRouterAutoImports,
  getPascalCaseRouteName,
} from "unplugin-vue-router"
import VueMacros from "unplugin-vue-macros/vite"

const mobile = !!/android|ios/.test(process.env.TAURI_ENV_PLATFORM)

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    VueRouter({
      extensions: [".vue"],
      dts: "src/typed-router.d.ts",
      getRouteName: (routeNode) => {
        const name = getPascalCaseRouteName(routeNode)
        return name === "Root" ? "Home" : name
      },
    }),
    VueMacros({
      plugins: {
        vue: Vue(),
      },
    }),
    Unocss(),
    AutoImport({
      imports: [
        "vue",
        "@vueuse/core",
        VueRouterAutoImports,
        {
          // add any other imports you were relying on
          "vue-router/auto": ["useLink"],
        },
      ],
      dts: "src/auto-imports.d.ts",
      dirs: ["src/composables"],
      vueTemplate: true,
    }),
    Components({
      extensions: ["vue"],
      include: [/\.vue$/, /\.vue\?vue/],
      dts: "src/components.d.ts",
    }),
  ],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: mobile ? "0.0.0.0" : false,
    hmr: mobile
      ? {
          protocol: "ws",
          host: await internalIpV4(),
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}))
