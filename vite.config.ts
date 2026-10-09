import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { cloudflare } from "@cloudflare/vite-plugin";
import { getWorkerAssetsDir } from "@cloudflare/build-output-utils";
import {
  LOCAL_DEVELOPMENT_AUTH_PATHS,
  LOCAL_DEVELOPMENT_MODE,
  LOCAL_DEVELOPMENT_ORIGIN,
  LOCAL_DEVELOPMENT_STATE_DIRECTORY,
} from "./src/shared/local-development.ts";

const host = process.env.TAURI_DEV_HOST;

// 本地开发登录（pnpm dev:local）只由显式 `--mode local-dev` 打开：该模式把客户端
// 标志、开发端口与 DO/R2 持久目录换成隔离的本地开发值；其余模式（含默认 production
// 构建与生产预览）保持既有行为，不载入本地登录相关模块。
const localDevelopmentOrigin = new URL(LOCAL_DEVELOPMENT_ORIGIN);

// Cloudflare Vite 插件把 client 构建输出固定到 Build Output 的资源目录
// （forceBuildOutputDirs），Worker 产物在独立的 bundle 目录。
// PWA 用官方路径函数显式对齐同一资源目录，Service Worker 只覆盖 client 产物，
// 旧 dist 或 Worker 产物不会进入预缓存；显式传入也避免 PWA 依赖
// configResolved 的环境求值顺序来推断输出目录。
const projectRoot = import.meta.dirname;
const clientAssetsDirectory = getWorkerAssetsDir(projectRoot);

// vite-plugin-pwa 1.3.0 未适配 Vite Environment API，其 build 插件会在
// Worker（ssr）环境的 generateBundle 里向 Worker bundle 发射 manifest.webmanifest
// 与 registerSW.js。PWA 插件保持全局（transformIndexHtml 依赖全局管线注入
// manifest link），由本插件在非 client 环境的构建中移除误发射的前端文件，
// 保证 Worker bundle 只包含 Worker 代码与 Cloudflare 插件自身的构建清单。
function isolateWorkerBundleFromPwaPlugin(): Plugin {
  return {
    name: "hako-worker-bundle-pwa-isolation",
    enforce: "post",
    apply: "build",
    generateBundle(_, bundle) {
      if (this.environment?.name === "client") return;
      delete bundle["manifest.webmanifest"];
      delete bundle["registerSW.js"];
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const localDevelopment = mode === LOCAL_DEVELOPMENT_MODE;
  return {
    plugins: [
      vue(),
      // @ayingott/theme 的 CSS-first 主题需要 Tailwind v4 编译 @theme/@utility
      // 等指令；仅使用主题语义变量与 focus-ring/touch-target 原语。
      tailwindcss(),
      // dev:local 的 DO 与模拟 R2 状态写入独立目录，不与其他开发模式共用持久数据。
      localDevelopment
        ? cloudflare({ persistState: { path: LOCAL_DEVELOPMENT_STATE_DIRECTORY } })
        : cloudflare(),
      VitePWA({
        registerType: "prompt",
        outDir: clientAssetsDirectory,
        manifest: {
          name: "Hako",
          short_name: "Hako",
          description: "把日常的小事收好，先从记录每一次加油开始。",
          lang: "zh-CN",
          start_url: "/",
          display: "standalone",
          theme_color: "#faf8f4",
          background_color: "#faf8f4",
          icons: [
            {
              src: "/hako-app-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/hako-app-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/hako-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          skipWaiting: false,
          clientsClaim: false,
          // 品牌与应用图标为 PNG/ICO，纳入预缓存；主题字体 woff2（7.5MB+）超过
          // 5MB 上限，走 HTTP 缓存（font-display: swap），不进入 SW 预缓存。
          globPatterns: ["**/*.{js,css,html,wasm,svg,png,ico}"],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          // 裸 /api 与 /api/* 都是服务端接口，导航回退不得接管（会绕过 Worker 的 API 404）。
          navigateFallbackDenylist: [/^\/api(?:\/|$)/],
        },
      }),
      // 必须排在 VitePWA 之后：在其 generateBundle 发射文件后再从 Worker bundle 移除。
      isolateWorkerBundleFromPwaPlugin(),
    ],
    build: { target: "es2022" },

    // 客户端构建标志：本地开发登录 UI 与客户端适配层只在 dev:local 载入
    // （其他模式下 __HAKO_LOCAL_DEV__ 替换为 false，动态导入分支不会进入产物）。
    // 端点路径来自共享常量模块，浏览器侧不直接导入该模块，只读取此标志。
    define: {
      __HAKO_LOCAL_DEV__: JSON.stringify(localDevelopment),
      __HAKO_LOCAL_DEV_AUTH_PATHS__: JSON.stringify(LOCAL_DEVELOPMENT_AUTH_PATHS),
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available；
    //    dev:local 改用独立 loopback 来源（与生产及旧普通开发源的浏览器存储隔离），
    //    并关闭开发服务器的 CORS 反射：本地适配层只接受唯一来源，不开放跨来源读取。
    server: {
      port: localDevelopment ? Number(localDevelopmentOrigin.port) : 1420,
      strictPort: true,
      host: localDevelopment ? localDevelopmentOrigin.hostname : host || false,
      cors: localDevelopment ? false : undefined,
      hmr: localDevelopment || !host
        ? undefined
        : {
            protocol: "ws",
            host,
            port: 1421,
          },
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
