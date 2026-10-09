// 本地开发登录（`pnpm dev:local`）的共享常量：本模块是唯一权威来源，
// 由 Node 侧运行配置（vite.config.ts，经构建标志注入浏览器）、dev:local 的
// 独立 Worker 入口（src/worker/local-dev/entry.ts）共用，避免端口、来源与
// 路径各自漂移。
//
// 模块归属说明：本文件同时属于 Node 侧 TypeScript 项目（tsconfig.node.json）
// 与 Worker 项目（tsconfig.worker.json）；浏览器侧不直接导入，而是读取
// vite.config.ts 注入的 `__HAKO_LOCAL_DEV_AUTH_PATHS__` 构建标志。
//
// 这些值只描述隔离的本地开发环境：不对应任何真实 origin、issuer 或身份，也不进入
// 生产的固定登录配置、owner Secret 或 Cookie 策略（权威说明见 docs/local-validation.md）。

/** 本地开发登录使用的配置模式；只有显式 `--mode local-dev` 才启用。 */
export const LOCAL_DEVELOPMENT_MODE = "local-dev";

/** 本地开发服务唯一的来源与 Host：绑定 loopback，精确匹配，不从请求推导。 */
export const LOCAL_DEVELOPMENT_ORIGIN = "http://127.0.0.1:1422";
export const LOCAL_DEVELOPMENT_HOST = "127.0.0.1:1422";

/**
 * 浏览器本地专用会话标识：只有本地适配层读写。HTTP 本地开发不设 Secure，
 * 因此也不使用 `__Host-` 前缀；生产 `__Host-hako_session` 策略不因此改变。
 */
export const LOCAL_DEVELOPMENT_SESSION_COOKIE_NAME = "hako_local_dev_session";

/** 本地开发登录端点；只由 dev:local 的独立 Worker 入口提供。 */
export const LOCAL_DEVELOPMENT_AUTH_PATHS = {
  login: "/api/auth/local/login",
  session: "/api/auth/local/session",
  logout: "/api/auth/local/logout",
} as const;

/** 本地开发持久目录（相对项目根）：与普通 `pnpm dev` 的 `.cloudflare/state` 隔离。 */
export const LOCAL_DEVELOPMENT_STATE_DIRECTORY = ".cloudflare/local-dev-state";

/** 本地开发 Worker 与本地模拟 R2 桶名：与生产 Worker/桶不同名。 */
export const LOCAL_DEVELOPMENT_WORKER_NAME = "hako-local-dev";
export const LOCAL_DEVELOPMENT_BACKUP_BUCKET_NAME = "hako-backups-local-dev";

/**
 * 稳定合成身份与内部固定部署值。`.invalid` 是保留顶级域，不会解析到任何真实服务；
 * 这些值只由本地适配层注入既有路由，使同步、备份与恢复沿用生产处理函数。
 */
export const LOCAL_DEVELOPMENT_LOGIN_DEPLOYMENT = {
  origin: "https://hako-local-dev.invalid",
  issuer: "https://hako-local-dev-issuer.invalid",
  clientId: "hako-local-dev-web",
  resource: "https://hako-local-dev-issuer.invalid/api",
} as const;

/** 本地测试账号的合成 owner 主体；不是真实身份，也不来自任何 Secret。 */
export const LOCAL_DEVELOPMENT_OWNER_SUBJECT = "local-development-synthetic-owner";

/**
 * dev:local Worker 的配置绑定值（cloudflare.config.ts 的 HAKO_LOCAL_DEVELOPMENT）。
 * 本地 Worker 入口从该绑定读取全部合成值与校验参数，因此本模块不属于 Worker
 * 模块图（既有 Cloudflare 配置与 Vite 配置的模块图不能被 Worker 运行时再次加载）；
 * 绑定值由配置侧注入，本地 `.dev.vars` 无法改动身份。
 */
export const LOCAL_DEVELOPMENT_WORKER_CONFIGURATION = {
  host: LOCAL_DEVELOPMENT_HOST,
  origin: LOCAL_DEVELOPMENT_ORIGIN,
  internalOrigin: LOCAL_DEVELOPMENT_LOGIN_DEPLOYMENT.origin,
  sessionCookieName: LOCAL_DEVELOPMENT_SESSION_COOKIE_NAME,
  login: LOCAL_DEVELOPMENT_LOGIN_DEPLOYMENT,
  ownerSubject: LOCAL_DEVELOPMENT_OWNER_SUBJECT,
  authPaths: LOCAL_DEVELOPMENT_AUTH_PATHS,
} as const;
