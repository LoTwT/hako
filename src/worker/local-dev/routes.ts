// 本地开发登录适配层（只有 dev:local 的独立 Worker 入口加载；生产入口不引用本模块）。
//
// 职责与边界：
// - 精确校验 Host 与来源：唯一允许的来源由配置给出，跨来源请求直接拒绝，
//   不从请求推导信任，不设置任何 CORS 头；
// - 用既有认证 DO 的登录事务合同建立「本地测试账号」的真实本地会话
//   （见 ./synthetic-session.ts），登录、读取、刷新与退出命中同一份 DO 会话；
// - 既有 /api 路由的入口适配：浏览器本地专用会话标识映射为生产会话 Cookie 名，
//   loopback 来源映射为内部固定来源，使同步、备份、恢复沿用与生产完全相同的
//   处理函数与合同（含账号/代次响应头与二进制正文）。
//
// 生产 Cookie 策略（__Host-/Secure/HttpOnly/SameSite/Path）、固定 origin/issuer/
// client/owner 校验、/api/auth 路由与生产 Worker 入口都不因本地开发而改动。
//
// 本模块不导入共享常量：运行配置由入口注入（见 ./entry.ts 与 src/shared/local-development.ts），
// 因此可以直接用测试自有配置验证校验与映射行为。

import { jsonResponse } from "../http";
import { readCookieValue } from "../auth/cookies";
import { HAKO_ACCOUNT_OBJECT_NAME } from "../auth/account-rpc";
import { SESSION_COOKIE_NAME, resolveSessionExpiry } from "../auth/session-policy";
import { hashSecret } from "../auth/secrets";
import type { HakoIdentity } from "../auth/account-state";
import { createLocalDevelopmentSession } from "./synthetic-session";

/** 本地开发登录端点路径。 */
export interface LocalDevelopmentAuthPaths {
  readonly login: string;
  readonly session: string;
  readonly logout: string;
}

/** dev:local 适配层的运行配置；值由 Worker 入口从 HAKO_LOCAL_DEVELOPMENT 绑定注入。 */
export interface LocalDevelopmentConfiguration {
  /** 唯一允许的 Host，精确匹配。 */
  readonly host: string;
  /** 唯一允许的浏览器来源，精确匹配；写入必须携带它。 */
  readonly origin: string;
  /**
   * 进入既有路由时使用的内部固定部署值与身份键：与生产的 HAKO_LOGIN 同构，
   * 但值全部是固定合成值（既有路由按它校验来源与校验会话身份）。
   */
  readonly internalLogin: {
    readonly origin: string;
    readonly issuer: string;
    readonly clientId: string;
    readonly resource: string;
    readonly ownerSubject: string;
  };
  /** 浏览器本地专用会话标识名。 */
  readonly sessionCookieName: string;
  readonly authPaths: LocalDevelopmentAuthPaths;
}

/** 既有认证与业务路由读取的环境（与 AuthEnvironment 结构兼容）。 */
export interface LocalDevelopmentAuthEnvironment {
  readonly HAKO_ACCOUNT: {
    getByName(name: string): Parameters<typeof createLocalDevelopmentSession>[0];
  };
  readonly HAKO_LOGIN: unknown;
  readonly HAKO_OWNER_SUBJECT: string;
}

export interface LocalDevelopmentHandlerDependencies {
  /** 可控时钟；默认使用运行时时钟。 */
  now?: () => number;
}

/** 既有 /api 路由入口适配的结果：可继续处理的请求，或直接拒绝的响应。 */
export type LocalDevelopmentRequestResult =
  | { ok: true; request: Request }
  | { ok: false; response: Response };

/** dev:local 适配层：路径判定、既有路由的入口适配与本地登录端点。 */
export interface LocalDevelopmentAuthAdapter {
  isAuthPath(pathname: string): boolean;
  normalizeApiRequest(request: Request): LocalDevelopmentRequestResult;
  handleAuthRequest(
    request: Request,
    environment: LocalDevelopmentAuthEnvironment,
    dependencies?: LocalDevelopmentHandlerDependencies,
  ): Promise<Response>;
}

/** 本地测试账号的固定身份键：DO 会话按 (issuer, subject) 校验。 */
export function localDevelopmentIdentity(configuration: LocalDevelopmentConfiguration): HakoIdentity {
  return {
    issuer: configuration.internalLogin.issuer,
    subject: configuration.internalLogin.ownerSubject,
  };
}

export function createLocalDevelopmentAuthAdapter(
  configuration: LocalDevelopmentConfiguration,
): LocalDevelopmentAuthAdapter {
  const stateChangingMethods: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

  /**
   * 请求前置校验：Host 必须精确等于本地开发 Host；来源要么缺失（合法导航/读取），
   * 要么精确等于本地开发来源。来源不一致（含其他 loopback 端口与远端地址）直接拒绝，
   * 状态变更方法必须有来源。
   */
  function rejectDisallowedRequest(request: Request): Response | null {
    if (request.headers.get("Host") !== configuration.host) {
      return jsonResponse({ error: "host_not_allowed" }, 403);
    }
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== configuration.origin) {
      return jsonResponse({ error: "origin_not_allowed" }, 403);
    }
    if (origin === null && stateChangingMethods.includes(request.method)) {
      return jsonResponse({ error: "origin_not_allowed" }, 403);
    }
    return null;
  }

  /** 保留其他 Cookie，只把本地会话标识改写为既有路由读取的生产 Cookie 名。 */
  function mapSessionCookie(request: Request, sessionToken: string): string {
    const others = (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !part.startsWith(`${configuration.sessionCookieName}=`));
    return [...others, `${SESSION_COOKIE_NAME}=${sessionToken}`].join("; ");
  }

  /**
   * 本地专用会话标识属性：HttpOnly、SameSite=Lax、Path=/，不设 Secure 与
   * `__Host-` 前缀（HTTP 本地开发无法使用）。它不是生产 Cookie，只有本地适配层读写。
   */
  function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
    return `${configuration.sessionCookieName}=${token}`
      + `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
  }

  function methodNotAllowed(allowedMethods: readonly string[]): Response {
    return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: allowedMethods.join(", ") });
  }

  function account(environment: LocalDevelopmentAuthEnvironment) {
    return environment.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
  }

  // -------------------------------------------------------------------------
  // POST /api/auth/local/login：建立本地测试账号的真实本地会话。
  // -------------------------------------------------------------------------

  async function handleLogin(
    request: Request,
    environment: LocalDevelopmentAuthEnvironment,
    now: () => number,
  ): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const rejection = rejectDisallowedRequest(request);
    if (rejection !== null) return rejection;

    const nowMs = now();
    const result = await createLocalDevelopmentSession(account(environment), localDevelopmentIdentity(configuration), nowMs);
    if (!result.ok) {
      // 只记录原因码；本地会话失败不含任何凭据，可安全写入服务端日志。
      console.error(JSON.stringify({ event: "local_development_session_failed", reason: result.reason }));
      return jsonResponse({ error: "local_session_unavailable" }, 503);
    }
    const { absoluteExpiresAtMs } = resolveSessionExpiry(nowMs);
    return jsonResponse({ authenticated: true, accountId: result.accountId }, 200, {
      "Set-Cookie": serializeSessionCookie(result.token, Math.floor((absoluteExpiresAtMs - nowMs) / 1000)),
    });
  }

  // -------------------------------------------------------------------------
  // GET /api/auth/local/session：读取本地测试账号会话；读取不续期、不改写标识。
  // -------------------------------------------------------------------------

  async function handleSession(
    request: Request,
    environment: LocalDevelopmentAuthEnvironment,
    now: () => number,
  ): Promise<Response> {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const rejection = rejectDisallowedRequest(request);
    if (rejection !== null) return rejection;

    const sessionToken = readCookieValue(request, configuration.sessionCookieName);
    if (sessionToken === undefined) return jsonResponse({ authenticated: false }, 200);
    // 与生产一致：会话必须与固定身份匹配；读取失败不改写浏览器标识。
    const accountId = await account(environment).readAccountId({
      sessionHash: await hashSecret(sessionToken),
      identity: localDevelopmentIdentity(configuration),
      nowMs: now(),
    });
    if (accountId === null) return jsonResponse({ authenticated: false }, 200);
    return jsonResponse({ authenticated: true, accountId }, 200);
  }

  // -------------------------------------------------------------------------
  // POST /api/auth/local/logout：撤销当前本地会话，不清本机业务数据。
  // -------------------------------------------------------------------------

  async function handleLogout(
    request: Request,
    environment: LocalDevelopmentAuthEnvironment,
    now: () => number,
  ): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const rejection = rejectDisallowedRequest(request);
    if (rejection !== null) return rejection;

    const sessionToken = readCookieValue(request, configuration.sessionCookieName);
    if (sessionToken !== undefined) {
      await account(environment).revokeSession({ sessionHash: await hashSecret(sessionToken), nowMs: now() });
    }
    return jsonResponse({ authenticated: false }, 200, { "Set-Cookie": serializeSessionCookie("", 0) });
  }

  return {
    isAuthPath(pathname: string): boolean {
      return pathname === configuration.authPaths.login
        || pathname === configuration.authPaths.session
        || pathname === configuration.authPaths.logout;
    },

    normalizeApiRequest(request: Request): LocalDevelopmentRequestResult {
      const rejection = rejectDisallowedRequest(request);
      if (rejection !== null) return { ok: false, response: rejection };

      const headers = new Headers(request.headers);
      const sessionToken = readCookieValue(request, configuration.sessionCookieName);
      if (sessionToken !== undefined) headers.set("Cookie", mapSessionCookie(request, sessionToken));
      // 来源已在上一步核对为唯一允许值；写入必须具备该来源，缺失时保持缺失交由
      // 既有路由按各自语义拒绝，不替调用方补一个可信来源。
      if (request.headers.get("Origin") === configuration.origin) {
        headers.set("Origin", configuration.internalLogin.origin);
      }
      return { ok: true, request: new Request(request, { headers }) };
    },

    async handleAuthRequest(
      request: Request,
      environment: LocalDevelopmentAuthEnvironment,
      dependencies: LocalDevelopmentHandlerDependencies = {},
    ): Promise<Response> {
      const { pathname } = new URL(request.url);
      const now = dependencies.now ?? Date.now;
      switch (pathname) {
        case configuration.authPaths.login:
          return await handleLogin(request, environment, now);
        case configuration.authPaths.session:
          return await handleSession(request, environment, now);
        case configuration.authPaths.logout:
          return await handleLogout(request, environment, now);
        default:
          return jsonResponse({ error: "not_found" }, 404);
      }
    },
  };
}
