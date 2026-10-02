// Hako 认证后端路由：POST /api/auth/login、GET /api/auth/callback、
// GET /api/auth/session、POST /api/auth/logout。
//
// 边界（PR2）：这里只提供登录后端与回调收尾的最小安全响应，登录 UI、草稿保护与
// 返回恢复属于 PR3；隔离环境的 8 位完成码后备交互尚未确认，本次不实现
// /api/auth/complete，普通同环境路径之外的调用一律安全失败。
// 协议权威来源：docs/specs/eruoo-login-integration.md 第 3、4、6 节。

import * as oauth from "oauth4webapi";
import { jsonResponse, htmlResponse } from "../http";
import { readLoginConfig } from "../login-config";
import type { LoginConfigEnvironment } from "../login-config";
import { HAKO_ACCOUNT_OBJECT_NAME } from "./account-rpc";
import type { HakoAccountBinding, HakoAccountStub } from "./account-rpc";
import {
  clearLoginTransactionCookie,
  clearSessionCookie,
  formatLoginTransactionCookieValue,
  parseLoginTransactionCookie,
  readLoginTransactionCookie,
  readSessionCookie,
  serializeLoginTransactionCookie,
  serializeSessionCookie,
} from "./cookies";
import { buildAuthorizationUrl, completeOidcLogin, discoverAuthorizationServer, OidcLoginFailure } from "./oidc";
import type { OidcLoginFailureReason, OidcOutboundTransport } from "./oidc";
import { LOGIN_TRANSACTION_TTL_MS, resolveSessionExpiry } from "./session-policy";
import { generateEnvironmentId, generateSecretToken, hashSecret } from "./secrets";

export const AUTH_LOGIN_PATH = "/api/auth/login";
export const AUTH_CALLBACK_PATH = "/api/auth/callback";
export const AUTH_SESSION_PATH = "/api/auth/session";
export const AUTH_LOGOUT_PATH = "/api/auth/logout";

/** 单次回调允许的 OIDC 出站总时长。 */
const OIDC_REQUEST_TIMEOUT_MS = 10_000;

export interface AuthEnvironment extends LoginConfigEnvironment {
  readonly HAKO_ACCOUNT: HakoAccountBinding;
}

export interface AuthHandlerDependencies {
  /** 可控时钟；默认使用运行时时钟。 */
  now?: () => number;
  /** 出站实现；默认全局 fetch（普通公开 HTTPS 路径）。 */
  transport?: OidcOutboundTransport;
}

/** 处理整个 /api/auth 命名空间；未知路径返回 JSON 404。 */
export async function handleAuthRequest(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthHandlerDependencies = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const now = dependencies.now ?? Date.now;
  const transport = dependencies.transport ?? { fetch: (url, options) => fetch(url, options) };
  switch (pathname) {
    case AUTH_LOGIN_PATH:
      return handleLoginRequest(request, env, now, transport);
    case AUTH_CALLBACK_PATH:
      return handleCallbackRequest(request, env, now, transport);
    case AUTH_SESSION_PATH:
      return handleSessionRequest(request, env, now);
    case AUTH_LOGOUT_PATH:
      return handleLogoutRequest(request, env, now);
    default:
      return jsonResponse({ error: "not_found" }, 404);
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/login：创建短期登录事务并返回顶层授权地址。
// ---------------------------------------------------------------------------

async function handleLoginRequest(
  request: Request,
  env: AuthEnvironment,
  now: () => number,
  transport: OidcOutboundTransport,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const loginConfig = readLoginConfig(env);
  if (!loginConfig.ok) return jsonResponse({ error: "configuration_error" }, 503);
  const config = loginConfig.config;
  // 状态变更端点校验精确 Origin；不匹配或缺失都拒绝。
  if (request.headers.get("Origin") !== config.origin) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }

  const existingEnvironment = parseLoginTransactionCookie(readLoginTransactionCookie(request));
  const environmentId = existingEnvironment?.environmentId ?? generateEnvironmentId();
  const nowMs = now();
  const signal = AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS);

  let authorizationServer;
  try {
    authorizationServer = await discoverAuthorizationServer(config, transport, signal);
  } catch {
    return jsonResponse({ error: "identity_service_unavailable" }, 503);
  }

  // 每次登录独立生成 state/nonce/verifier 与环境凭据；同一环境的旧事务先失效。
  const state = generateSecretToken();
  const nonce = generateSecretToken();
  const completionSecret = generateSecretToken();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  await accountStub(env).createLoginTransaction({
    environmentId,
    stateHash: await hashSecret(state),
    completionSecretHash: await hashSecret(completionSecret),
    nonce,
    codeVerifier,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + LOGIN_TRANSACTION_TTL_MS,
  });

  const authorizationUrl = buildAuthorizationUrl(authorizationServer.metadata, config, {
    state,
    nonce,
    codeChallenge,
  });
  return jsonResponse({ authorizationUrl }, 200, {
    "Set-Cookie": serializeLoginTransactionCookie(
      formatLoginTransactionCookieValue({ environmentId, completionSecret }),
      LOGIN_TRANSACTION_TTL_MS / 1000,
    ),
  });
}

// ---------------------------------------------------------------------------
// GET /api/auth/callback：唯一 OAuth 回调；回调收尾的最小安全响应。
// ---------------------------------------------------------------------------

async function handleCallbackRequest(
  request: Request,
  env: AuthEnvironment,
  now: () => number,
  transport: OidcOutboundTransport,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const callbackUrl = new URL(request.url);
  const loginConfig = readLoginConfig(env);
  if (!loginConfig.ok) {
    return callbackResponse("configuration_error", [clearLoginTransactionCookie()]);
  }
  const config = loginConfig.config;

  // 发起环境绑定：必须同时匹配事务 Cookie 与 state，且事务只能消费一次。
  const transactionCookie = parseLoginTransactionCookie(readLoginTransactionCookie(request));
  const state = callbackUrl.searchParams.get("state");
  if (transactionCookie === null || state === null) {
    return callbackResponse("invalid_login_transaction", [clearLoginTransactionCookie()]);
  }
  const account = accountStub(env);
  const consumed = await account.consumeLoginTransaction({
    stateHash: await hashSecret(state),
    environmentId: transactionCookie.environmentId,
    completionSecretHash: await hashSecret(transactionCookie.completionSecret),
    nowMs: now(),
  });
  const clearTransaction = [clearLoginTransactionCookie()];
  if (consumed === null) {
    return callbackResponse("invalid_login_transaction", clearTransaction);
  }

  const signal = AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS);
  let completed;
  try {
    const authorizationServer = await discoverAuthorizationServer(config, transport, signal);
    completed = await completeOidcLogin({
      config,
      authorizationServer,
      callbackParameters: callbackUrl.searchParams,
      expectedState: state,
      expectedNonce: consumed.nonce,
      codeVerifier: consumed.codeVerifier,
      signal,
    });
  } catch (error) {
    const reason = error instanceof OidcLoginFailure ? error.reason : "identity_service_unavailable";
    return callbackResponse(callbackOutcomeForFailure(reason), clearTransaction);
  }

  // 先持久保存会话，再发 Cookie：完成登录在 DO 内是“删除事务 + 插入会话”的同一事务。
  // 退出或同环境重新发起会删除该事务，因此等待 OIDC 响应期间被取代的登录不会建立会话。
  const sessionToken = generateSecretToken();
  const nowMs = now();
  const { expiresAtMs, absoluteExpiresAtMs } = resolveSessionExpiry(nowMs);
  const finalized = await account.finalizeLoginTransaction({
    stateHash: await hashSecret(state),
    environmentId: transactionCookie.environmentId,
    nowMs,
    session: {
      sessionHash: await hashSecret(sessionToken),
      issuer: config.issuer,
      subject: completed.subject,
      createdAtMs: nowMs,
      expiresAtMs,
      absoluteExpiresAtMs,
    },
  });
  if (!finalized) {
    return callbackResponse("invalid_login_transaction", clearTransaction);
  }
  return callbackResponse("completed", [
    clearLoginTransactionCookie(),
    serializeSessionCookie(sessionToken, Math.floor((expiresAtMs - nowMs) / 1000)),
  ]);
}

type CallbackOutcome =
  | "completed"
  | "authorization_declined"
  | "invalid_login_transaction"
  | "invalid_authorization_response"
  | "identity_verification_failed"
  | "owner_mismatch"
  | "identity_service_unavailable"
  | "configuration_error";

function callbackOutcomeForFailure(reason: OidcLoginFailureReason): CallbackOutcome {
  switch (reason) {
    case "authorization_declined":
      return "authorization_declined";
    case "authorization_code_rejected":
    case "invalid_authorization_response":
      return "invalid_authorization_response";
    case "identity_verification_failed":
      return "identity_verification_failed";
    case "owner_mismatch":
      return "owner_mismatch";
    case "identity_service_unavailable":
      return "identity_service_unavailable";
  }
}

const CALLBACK_PAGES: Record<CallbackOutcome, { status: number; message: string }> = {
  completed: { status: 200, message: "登录已完成，可以返回 Hako 继续使用。" },
  authorization_declined: { status: 400, message: "授权未完成或已取消，请返回 Hako 重新登录。" },
  invalid_login_transaction: { status: 400, message: "登录请求已过期或无效，请返回 Hako 重新登录。" },
  invalid_authorization_response: { status: 400, message: "登录响应校验未通过，请返回 Hako 重新登录。" },
  identity_verification_failed: { status: 400, message: "登录身份校验未通过，请返回 Hako 重新登录。" },
  owner_mismatch: { status: 403, message: "当前登录身份不是这台 Hako 的 owner。" },
  identity_service_unavailable: { status: 503, message: "身份服务暂时不可用，请稍后返回 Hako 重试。" },
  configuration_error: { status: 503, message: "Hako 登录配置无效，暂时无法登录。" },
};

/**
 * 回调收尾页面：只包含服务端生成的静态文本与固定同源“返回 Hako”入口，
 * 不加载第三方资源、不回退首页，不包含 code/state/token 或任何凭据；
 * no-store 与 Referrer-Policy:no-referrer 由响应头保证。
 */
function callbackResponse(outcome: CallbackOutcome, setCookies: string[]): Response {
  const page = CALLBACK_PAGES[outcome];
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>Hako 登录</title>`,
    "</head>",
    "<body>",
    `<p data-hako-callback-status="${outcome}">${page.message}</p>`,
    '<p><a href="/">返回 Hako</a></p>',
    "</body>",
    "</html>",
  ].join("");
  return htmlResponse(html, page.status, {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Set-Cookie": setCookies,
  });
}

// ---------------------------------------------------------------------------
// GET /api/auth/session：读取登录状态；状态读取不续期。
// ---------------------------------------------------------------------------

async function handleSessionRequest(
  request: Request,
  env: AuthEnvironment,
  now: () => number,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const sessionToken = readSessionCookie(request);
  if (sessionToken === undefined) return jsonResponse({ authenticated: false }, 200);
  // 会话必须与固定 issuer 和固定 owner 主体匹配；缺少有效登录配置时无法校验身份。
  const loginConfig = readLoginConfig(env);
  if (!loginConfig.ok) return jsonResponse({ error: "configuration_error" }, 503);
  const session = await accountStub(env).readSession({
    sessionHash: await hashSecret(sessionToken),
    identity: {
      issuer: loginConfig.config.issuer,
      subject: loginConfig.config.ownerSubject,
    },
    nowMs: now(),
  });
  if (session === null) {
    return jsonResponse({ authenticated: false }, 200, { "Set-Cookie": clearSessionCookie() });
  }
  return jsonResponse({ authenticated: true }, 200);
}

// ---------------------------------------------------------------------------
// POST /api/auth/logout：撤销当前会话与该环境未完成事务，不清本机业务数据。
// ---------------------------------------------------------------------------

async function handleLogoutRequest(
  request: Request,
  env: AuthEnvironment,
  now: () => number,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const loginConfig = readLoginConfig(env);
  if (!loginConfig.ok) return jsonResponse({ error: "configuration_error" }, 503);
  if (request.headers.get("Origin") !== loginConfig.config.origin) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }

  const account = accountStub(env);
  const nowMs = now();
  const sessionToken = readSessionCookie(request);
  if (sessionToken !== undefined) {
    await account.revokeSession({ sessionHash: await hashSecret(sessionToken), nowMs });
  }
  const transactionCookie = parseLoginTransactionCookie(readLoginTransactionCookie(request));
  if (transactionCookie !== null) {
    await account.revokeEnvironmentTransactions(transactionCookie.environmentId);
  }
  return jsonResponse({ authenticated: false }, 200, {
    "Set-Cookie": [clearSessionCookie(), clearLoginTransactionCookie()],
  });
}

// ---------------------------------------------------------------------------

function accountStub(env: AuthEnvironment): HakoAccountStub {
  return env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
}

function methodNotAllowed(allowedMethods: readonly string[]): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: allowedMethods.join(", ") });
}
