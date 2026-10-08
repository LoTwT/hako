import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { cloudflare } from "@cloudflare/vite-plugin";
import { getWorkerAssetsDir } from "@cloudflare/build-output-utils";

const host = process.env.TAURI_DEV_HOST;

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
export default defineConfig(async () => ({
  plugins: [
    vue(),
    // @ayingott/theme 的 CSS-first 主题需要 Tailwind v4 编译 @theme/@utility
    // 等指令；仅使用主题语义变量与 focus-ring/touch-target 原语。
    tailwindcss(),
    cloudflare(),
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

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
