import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

// Cloudflare 配置的唯一入口。登录协议合同以 docs/specs/eruoo-login-integration.md 为权威来源：
// 正式 origin、issuer、client 与 resource 使用第 3 节确认的值；owner 主体由后端 Secret 输入。
export default defineConfig({
  worker: {
    name: "hako",
    compatibilityDate: "2026-10-01",
    entrypoint,
    assets: {
      // 未命中静态资产的路径回退到 SPA 首页；/api 与 /api/* 由 runWorkerFirst
      // 优先进入 Worker，包括页面导航，不会被 SPA 回退吃掉。
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api", "/api/*"],
    },
    domains: ["hako.eruoo.me"],
    workersDev: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true },
      traces: { enabled: true },
    },
    env: {
      // 静态资产 Fetcher 绑定，作为非 API 请求的后备（当前路由约定下不会走到）。
      ASSETS: bindings.assets(),
      HAKO_LOGIN: bindings.json({
        origin: "https://hako.eruoo.me",
        issuer: "https://auth.eruoo.me",
        clientId: "hako-web",
        resource: "https://auth.eruoo.me/api",
      }),
      // 真实 owner 主体只通过部署 Secret（或本地 .dev.vars）输入，
      // 不进入前端、日志、公共配置或文档。
      HAKO_OWNER_SUBJECT: bindings.secret(),
    },
  },
});
