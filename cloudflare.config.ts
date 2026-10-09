import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };
import * as localDevelopmentEntrypoint from "./src/worker/local-dev/entry.ts" with { type: "cf-worker" };
import {
  LOCAL_DEVELOPMENT_BACKUP_BUCKET_NAME,
  LOCAL_DEVELOPMENT_LOGIN_DEPLOYMENT,
  LOCAL_DEVELOPMENT_MODE,
  LOCAL_DEVELOPMENT_OWNER_SUBJECT,
  LOCAL_DEVELOPMENT_WORKER_CONFIGURATION,
  LOCAL_DEVELOPMENT_WORKER_NAME,
} from "./src/shared/local-development.ts";

// Cloudflare 配置的唯一入口。登录协议合同以 docs/specs/eruoo-login-integration.md 为权威来源：
// 正式 origin、issuer、client 与 resource 使用第 3 节确认的值；owner 主体由后端 Secret 输入。
// 本地开发登录使用下面的 localDevelopmentWorker，只有显式 `--mode local-dev` 才会选中；
// 默认构建、生产预览与部署入口只使用生产 Worker，本地认证适配层不进入生产产物。
// 本地开发登录的启动方式、测试身份与数据位置见 docs/local-validation.md「本地查看」。
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
    // 独立备份的私有 R2 Standard 桶绑定（备份合同见 docs/specs/backup.md）。
    // 仅作为代码配置；真实资源创建与开通状态留待发布准备核实。
    // 本地开发始终使用隔离的本地模拟存储，不访问远端 R2。
    HAKO_BACKUPS: bindings.r2({
      name: "hako-backups-production",
      dev: { remote: false },
    }),
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

// 本地开发 Worker（pnpm dev:local）：合成身份与本地模拟存储。
// 绑定名与生产一致（类型生成按配置中的所有 worker 合并，缺一个会削弱生产 Env 类型），
// 但值全部是固定合成值：没有真实 owner Secret，也没有可用的真实 OIDC 登录路径。
// 不声明正式域名与 workers.dev，即使被误用也不会得到真实 origin 的入口。
const localDevelopmentBaseWorker = defineWorker({
  name: LOCAL_DEVELOPMENT_WORKER_NAME,
  compatibilityDate: "2026-10-01",
  entrypoint: localDevelopmentEntrypoint,
  exports: {
    HakoAccountDurableObject: exports.durableObject({ storage: "sqlite" }),
  },
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api", "/api/*"],
  },
  workersDev: false,
  env: {
    ASSETS: bindings.assets(),
    HAKO_LOGIN: bindings.json({ ...LOCAL_DEVELOPMENT_LOGIN_DEPLOYMENT }),
    // 合成主体是普通文本绑定（不是 Secret）：dev:local 不要求、也不读取真实 owner。
    // 入口只从 HAKO_LOCAL_DEVELOPMENT 读合成身份，本地 .dev.vars 无法覆盖它。
    HAKO_OWNER_SUBJECT: bindings.text(LOCAL_DEVELOPMENT_OWNER_SUBJECT),
    // 本地适配层的全部校验参数与合成身份（来源、Host、端点、会话标识名、身份键）。
    HAKO_LOCAL_DEVELOPMENT: bindings.json({ ...LOCAL_DEVELOPMENT_WORKER_CONFIGURATION }),
    // 本地模拟 R2：dev:local 的备份/恢复只写独立持久目录，不访问远端桶。
    HAKO_BACKUPS: bindings.r2({
      name: LOCAL_DEVELOPMENT_BACKUP_BUCKET_NAME,
      dev: { remote: false },
    }),
  },
});

const localDevelopmentWorker = defineWorker({
  ...localDevelopmentBaseWorker,
  env: {
    ...localDevelopmentBaseWorker.env,
    HAKO_ACCOUNT: bindings.durableObject({
      worker: localDevelopmentBaseWorker,
      exportName: "HakoAccountDurableObject",
    }),
  },
});

export default defineConfig((context) => ({
  worker: context.mode === LOCAL_DEVELOPMENT_MODE ? localDevelopmentWorker : hakoWorker,
}));
