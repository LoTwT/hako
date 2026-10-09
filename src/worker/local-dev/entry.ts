// dev:local 专用的 Worker 入口（组合根）：与生产入口 src/worker/index.ts 同构，
// 但把 /api/auth/local/* 交给本地认证适配层，并在进入既有 /api 路由前完成本地来源映射。
// 只有 `cf dev --mode local-dev` 的配置使用本入口；生产入口不引用本地适配层，
// 生产构建产物不包含这些模块。
//
// 合成身份来自配置绑定 HAKO_LOCAL_DEVELOPMENT（cloudflare.config.ts 的
// localDevelopmentWorker 用共享常量声明），因此本地 `.dev.vars` 或环境变量都无法把
// 真实 owner 或生产 origin 带进 dev:local；本入口不读取 HAKO_OWNER_SUBJECT Secret。
// 本模块刻意不导入 src/shared/local-development.ts：该模块属于 Cloudflare 配置与
// Vite 配置的模块图，Worker 运行时再次加载它会让开发服务器无法启动。
//
// 这里导出的是生产 Durable Object 类本身（无测试钩子），本地数据落在独立持久目录。

import { handleApiRequest, isApiPath } from "../api";
import { createLocalDevelopmentAuthAdapter } from "./routes";
import type { LocalDevelopmentAuthEnvironment, LocalDevelopmentConfiguration } from "./routes";

export { HakoAccountDurableObject } from "../account-durable-object";

/**
 * 本地开发 Worker 只声明实际使用的绑定；登录配置与 owner 主体由适配层从
 * HAKO_LOCAL_DEVELOPMENT 注入合成值，不读取任何 Secret。
 */
type LocalDevelopmentWorkerEnvironment =
  Pick<Env, "ASSETS" | "HAKO_ACCOUNT" | "HAKO_BACKUPS" | "HAKO_LOCAL_DEVELOPMENT">;

/** 缺绑定或结构损坏时快速失败：dev:local 不允许在没有合成身份的情况下继续。 */
function requireLocalDevelopmentConfiguration(
  env: LocalDevelopmentWorkerEnvironment,
): LocalDevelopmentConfiguration {
  const configuration = env.HAKO_LOCAL_DEVELOPMENT;
  if (configuration === undefined || configuration === null) {
    throw new Error("dev:local 缺少 HAKO_LOCAL_DEVELOPMENT 配置绑定（见 cloudflare.config.ts）");
  }
  return {
    host: configuration.host,
    origin: configuration.origin,
    sessionCookieName: configuration.sessionCookieName,
    authPaths: configuration.authPaths,
    internalLogin: {
      origin: configuration.login.origin,
      issuer: configuration.login.issuer,
      clientId: configuration.login.clientId,
      resource: configuration.login.resource,
      ownerSubject: configuration.ownerSubject,
    },
  };
}

/** 桥接既有路由读取的登录环境：固定合成部署值与合成 owner 主体。 */
function localDevelopmentAuthEnvironment(
  env: LocalDevelopmentWorkerEnvironment,
  configuration: LocalDevelopmentConfiguration,
): LocalDevelopmentAuthEnvironment {
  return {
    HAKO_ACCOUNT: env.HAKO_ACCOUNT,
    HAKO_LOGIN: {
      origin: configuration.internalLogin.origin,
      issuer: configuration.internalLogin.issuer,
      clientId: configuration.internalLogin.clientId,
      resource: configuration.internalLogin.resource,
    },
    HAKO_OWNER_SUBJECT: configuration.internalLogin.ownerSubject,
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!isApiPath(pathname)) return env.ASSETS.fetch(request);
    const configuration = requireLocalDevelopmentConfiguration(env);
    const adapter = createLocalDevelopmentAuthAdapter(configuration);
    const environment = localDevelopmentAuthEnvironment(env, configuration);
    if (adapter.isAuthPath(pathname)) {
      return await adapter.handleAuthRequest(request, environment);
    }
    const normalized = adapter.normalizeApiRequest(request);
    if (!normalized.ok) return normalized.response;
    return await handleApiRequest(normalized.request, environment);
  },
} satisfies ExportedHandler<LocalDevelopmentWorkerEnvironment>;
