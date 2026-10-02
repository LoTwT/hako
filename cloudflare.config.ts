import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

// Cloudflare 配置的唯一入口。登录协议合同以 docs/specs/eruoo-login-integration.md 为权威来源：
// 正式 origin、issuer、client 与 resource 使用第 3 节确认的值；owner 主体由后端 Secret 输入。
const baseWorker = defineWorker({
  name: "hako",
  compatibilityDate: "2026-10-01",
  entrypoint,
  // 账号级 SQLite Durable Object：保存登录事务与本应用会话（PR2）。
  // cf 依据 exports 声明与 storage 引擎生成迁移，不另建 wrangler 配置。
  exports: {
    HakoAccountDurableObject: exports.durableObject({ storage: "sqlite" }),
  },
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
});

// 账号级状态绑定：实例名固定为 owner-account。绑定引用同一份 worker 定义（而不是名字字符串），
// 以便按 exports 推断 RPC 类型并生成迁移；分两步定义避免自引用推断循环。
const hakoWorker = defineWorker({
  ...baseWorker,
  env: {
    ...baseWorker.env,
    HAKO_ACCOUNT: bindings.durableObject({
      worker: baseWorker,
      exportName: "HakoAccountDurableObject",
    }),
  },
});

export default defineConfig({ worker: hakoWorker });
