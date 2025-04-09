import process from "node:process"

const host = process.env.TAURI_DEV_HOST

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2024-11-01",
  devtools: { enabled: true },

  hooks: {
    "vite:extend": function ({ config }) {
      if (config.server && config.server.hmr && config.server.hmr !== true) {
        config.server.hmr.port = 3000
      }
    },
  },

  ssr: false,
  // Enables the development server to be discoverable by other devices when running on iOS physical devices
  devServer: {
    host: host || undefined,
  },
  vite: {
    // Better support for Tauri CLI output
    clearScreen: false,
    // Enable environment variables
    // Additional environment variables can be found at
    // https://v2.tauri.app/reference/environment-variables/
    envPrefix: ["VITE_", "TAURI_"],
    server: {
      // Tauri requires a consistent port
      strictPort: true,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // tell vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  },
})
