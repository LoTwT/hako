// eruoo OIDC 出站接线（discovery、JWKS、token、UserInfo），使用成熟库
// oauth4webapi 完成协议与 ID token 校验，不自写 JWT/OIDC 校验器。
//
// 协议权威来源：docs/specs/eruoo-login-integration.md 第 4 节。固定可信 issuer 的
// metadata 与端点会被核对；出站请求只允许固定 issuer origin 和明确端点，不转发浏览器
// Cookie 或 Origin。真实线上可达性（含 Service Binding 方案）尚未验证，这里交付的是
// 普通公开 HTTPS 路径。

import * as oauth from "oauth4webapi";
import type { HakoLoginConfig } from "../login-config";
import { constantTimeEqual } from "./secrets";

/** 规格第 4 节固定的 discovery 路径。 */
export const OIDC_DISCOVERY_PATHS = ["/.well-known/openid-configuration"] as const;

/** 规格第 4 节固定的协议端点路径，metadata 必须与这些值精确一致。 */
export const OIDC_AUTHORIZATION_ENDPOINT_PATH = "/api/auth/oauth2/authorize";
export const OIDC_TOKEN_ENDPOINT_PATH = "/api/auth/oauth2/token";
export const OIDC_USERINFO_ENDPOINT_PATH = "/api/auth/oauth2/userinfo";
export const OIDC_JWKS_ENDPOINT_PATH = "/api/auth/jwks";

const OIDC_ENDPOINT_PATHS = [
  OIDC_AUTHORIZATION_ENDPOINT_PATH,
  OIDC_TOKEN_ENDPOINT_PATH,
  OIDC_USERINFO_ENDPOINT_PATH,
  OIDC_JWKS_ENDPOINT_PATH,
] as const;

/** 出站请求的实现；生产使用全局 fetch，测试与未来 Service Binding 适配可替换。 */
export type OidcOutboundFetch = (url: string, options: RequestInit) => Promise<Response>;

export interface OidcOutboundTransport {
  fetch: OidcOutboundFetch;
}

export type OidcLoginFailureReason =
  | "authorization_declined"
  | "authorization_code_rejected"
  | "invalid_authorization_response"
  | "identity_verification_failed"
  | "owner_mismatch"
  | "identity_service_unavailable";

/** 登录失败的协议语义；路由层据此选择响应，不向调用方泄露协议细节。 */
export class OidcLoginFailure extends Error {
  constructor(
    readonly reason: OidcLoginFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OidcLoginFailure";
  }
}

export interface ValidatedAuthorizationServer {
  metadata: oauth.AuthorizationServer;
  /** 只允许固定 issuer origin 与已核对端点的出站实现。 */
  restrictedFetch: OidcOutboundFetch;
}

/** 创建只允许固定 issuer origin 与给定路径的出站实现。 */
export function createRestrictedOidcFetch(
  config: HakoLoginConfig,
  transport: OidcOutboundTransport,
  allowedPaths: readonly string[],
): OidcOutboundFetch {
  const issuerOrigin = new URL(config.issuer).origin;
  const allowed = new Set(allowedPaths);
  return async (url, options) => {
    const target = new URL(url);
    if (target.origin !== issuerOrigin || !allowed.has(target.pathname)) {
      // 不转发浏览器 Cookie 或 Origin，也不允许固定 origin 之外的任何目标。
      throw new Error(
        `OIDC 出站目标不在固定 issuer origin 与明确端点白名单内：${target.origin}${target.pathname}`,
      );
    }
    return transport.fetch(target.href, options);
  };
}

/** 读取并校验固定 issuer 的 discovery metadata；失败归类为身份服务不可用或配置错误。 */
export async function discoverAuthorizationServer(
  config: HakoLoginConfig,
  transport: OidcOutboundTransport,
  signal?: AbortSignal,
): Promise<ValidatedAuthorizationServer> {
  const issuer = new URL(config.issuer);
  const discoveryFetch = createRestrictedOidcFetch(config, transport, OIDC_DISCOVERY_PATHS);
  let metadata: oauth.AuthorizationServer;
  try {
    const response = await oauth.discoveryRequest(issuer, {
      [oauth.customFetch]: discoveryFetch,
      signal,
    });
    metadata = await oauth.processDiscoveryResponse(issuer, response);
  } catch (error) {
    throw new OidcLoginFailure("identity_service_unavailable", "读取 OIDC discovery 失败", {
      cause: error,
    });
  }
  assertAuthorizationServerMetadata(metadata, config);
  return {
    metadata,
    restrictedFetch: createRestrictedOidcFetch(config, transport, OIDC_ENDPOINT_PATHS),
  };
}

/**
 * 核对 metadata 与端点：固定 issuer、必须声明授权响应 iss 参数与 S256 PKCE，
 * 端点必须是固定 issuer origin 下的既定路径，不接受 metadata 指向其他主机。
 */
function assertAuthorizationServerMetadata(
  metadata: oauth.AuthorizationServer,
  config: HakoLoginConfig,
): void {
  if (metadata.issuer !== config.issuer) {
    throw new OidcLoginFailure("identity_service_unavailable", "OIDC issuer 与固定配置不一致");
  }
  if (metadata.authorization_response_iss_parameter_supported !== true) {
    throw new OidcLoginFailure(
      "identity_service_unavailable",
      "OIDC discovery 未声明支持授权响应 iss 参数",
    );
  }
  if (metadata.code_challenge_methods_supported?.includes("S256") !== true) {
    throw new OidcLoginFailure("identity_service_unavailable", "OIDC discovery 未声明支持 S256 PKCE");
  }
  if (metadata.response_types_supported?.includes("code") !== true) {
    throw new OidcLoginFailure("identity_service_unavailable", "OIDC discovery 未声明 code 响应类型");
  }
  if (
    metadata.response_modes_supported !== undefined &&
    !metadata.response_modes_supported.includes("query")
  ) {
    throw new OidcLoginFailure("identity_service_unavailable", "OIDC discovery 未声明 query 响应模式");
  }
  if (
    metadata.token_endpoint_auth_methods_supported !== undefined &&
    !metadata.token_endpoint_auth_methods_supported.includes("none")
  ) {
    throw new OidcLoginFailure("identity_service_unavailable", "OIDC discovery 未声明 none 客户端认证");
  }
  assertFixedEndpoint(metadata.authorization_endpoint, config, OIDC_AUTHORIZATION_ENDPOINT_PATH);
  assertFixedEndpoint(metadata.token_endpoint, config, OIDC_TOKEN_ENDPOINT_PATH);
  assertFixedEndpoint(metadata.userinfo_endpoint, config, OIDC_USERINFO_ENDPOINT_PATH);
  assertFixedEndpoint(metadata.jwks_uri, config, OIDC_JWKS_ENDPOINT_PATH);
}

function assertFixedEndpoint(value: string | undefined, config: HakoLoginConfig, expectedPath: string): void {
  if (value === undefined) {
    throw new OidcLoginFailure("identity_service_unavailable", `OIDC metadata 缺少端点 ${expectedPath}`);
  }
  const url = new URL(value);
  if (url.origin !== new URL(config.issuer).origin || url.pathname !== expectedPath || url.search !== "") {
    throw new OidcLoginFailure(
      "identity_service_unavailable",
      `OIDC metadata 端点与固定合同不一致：${expectedPath}`,
    );
  }
}

/** 授权请求参数；state/nonce/verifier 每次登录独立生成。 */
export interface AuthorizationRequestInput {
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** 组装顶层 GET 授权地址：none + PKCE S256、openid profile、既定 resource、query 响应模式。 */
export function buildAuthorizationUrl(
  metadata: oauth.AuthorizationServer,
  config: HakoLoginConfig,
  input: AuthorizationRequestInput,
): string {
  const endpoint = metadata.authorization_endpoint;
  if (endpoint === undefined) {
    throw new OidcLoginFailure("identity_service_unavailable", "OIDC metadata 缺少授权端点");
  }
  const url = new URL(endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("resource", config.resource);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

export interface CompleteOidcLoginInput {
  config: HakoLoginConfig;
  authorizationServer: ValidatedAuthorizationServer;
  callbackParameters: URLSearchParams;
  expectedState: string;
  expectedNonce: string;
  codeVerifier: string;
  signal?: AbortSignal;
}

export interface CompletedOidcLogin {
  /** 已验证的固定 owner 主体（iss + sub 身份键中的 sub）。 */
  subject: string;
}

/**
 * 完成回调：校验 state/iss 与重复参数，兑换授权码（none + PKCE），
 * 验证 ID token 签名、全部适用 claims 与固定 owner，再用 access token 读取 UserInfo
 * 并核对 sub。任何一步失败都不建立会话，网络兑换结果不明时不重试。
 */
export async function completeOidcLogin(input: CompleteOidcLoginInput): Promise<CompletedOidcLogin> {
  const { config, authorizationServer } = input;
  const { metadata, restrictedFetch } = authorizationServer;
  const client: oauth.Client = { client_id: config.clientId };
  const requestOptions = { [oauth.customFetch]: restrictedFetch, signal: input.signal };

  let callbackParameters: URLSearchParams;
  try {
    // 校验 state、授权响应 iss、重复 singleton 参数；error 响应会抛出。
    callbackParameters = oauth.validateAuthResponse(
      metadata,
      client,
      input.callbackParameters,
      input.expectedState,
    );
  } catch (error) {
    throw classifyCallbackValidationError(error);
  }

  let tokenResponse: oauth.TokenEndpointResponse;
  let tokenHttpResponse: Response;
  try {
    tokenHttpResponse = await oauth.authorizationCodeGrantRequest(
      metadata,
      client,
      oauth.None(),
      callbackParameters,
      config.redirectUri,
      input.codeVerifier,
      {
        ...requestOptions,
        additionalParameters: { resource: config.resource },
      },
    );
    tokenResponse = await oauth.processAuthorizationCodeResponse(metadata, client, tokenHttpResponse, {
      expectedNonce: input.expectedNonce,
      requireIdToken: true,
    });
  } catch (error) {
    throw classifyOidcError(error, "authorization_code_rejected");
  }

  let claims: oauth.IDToken;
  try {
    // 直接与 TLS 端点通信时签名校验不是库的默认行为，这里显式要求验证签名。
    await oauth.validateApplicationLevelSignature(metadata, tokenHttpResponse, requestOptions);
    const validatedClaims = oauth.getValidatedIdTokenClaims(tokenResponse);
    if (validatedClaims === undefined) {
      throw new OidcLoginFailure("identity_verification_failed", "token 响应缺少 ID token");
    }
    claims = validatedClaims;
    await assertIdTokenClaims(claims, tokenResponse, config);
  } catch (error) {
    throw classifyOidcError(error, "identity_verification_failed");
  }

  if (claims.sub !== config.ownerSubject) {
    throw new OidcLoginFailure("owner_mismatch", "登录身份不是固定 owner");
  }

  let userInfo: oauth.UserInfoResponse;
  try {
    const response = await oauth.userInfoRequest(metadata, client, tokenResponse.access_token, requestOptions);
    userInfo = await oauth.processUserInfoResponse(metadata, client, claims.sub, response);
  } catch (error) {
    throw classifyOidcError(error, "identity_verification_failed");
  }
  if (userInfo.sub !== claims.sub) {
    throw new OidcLoginFailure("identity_verification_failed", "UserInfo sub 与 ID token 不一致");
  }

  return { subject: claims.sub };
}

/** claims 中需要调用方补充核对的部分（iss、azp、at_hash）。 */
async function assertIdTokenClaims(
  claims: oauth.IDToken,
  tokenResponse: oauth.TokenEndpointResponse,
  config: HakoLoginConfig,
): Promise<void> {
  if (claims.iss !== config.issuer) {
    throw new OidcLoginFailure("identity_verification_failed", "ID token issuer 与固定配置不一致");
  }
  if (claims.azp !== undefined && claims.azp !== config.clientId) {
    throw new OidcLoginFailure("identity_verification_failed", "ID token azp 与 client 不一致");
  }
  if (claims.at_hash !== undefined) {
    // 库负责非对称签名与 claims；at_hash 按 OIDC Core 3.1.3.6 由调用方核对。
    const hashName = atHashAlgorithmName(readJwtHeaderAlgorithm(tokenResponse.id_token ?? ""));
    const digest = await crypto.subtle.digest(hashName, new TextEncoder().encode(tokenResponse.access_token));
    const expected = toBase64Url(new Uint8Array(digest).slice(0, digest.byteLength / 2));
    if (!constantTimeEqual(expected, String(claims.at_hash))) {
      throw new OidcLoginFailure("identity_verification_failed", "ID token at_hash 与 access token 不一致");
    }
  }
}

function atHashAlgorithmName(algorithm: string): "SHA-256" | "SHA-384" | "SHA-512" {
  switch (algorithm) {
    case "RS256":
    case "PS256":
    case "ES256":
      return "SHA-256";
    case "RS384":
    case "PS384":
    case "ES384":
      return "SHA-384";
    case "RS512":
    case "PS512":
    case "ES512":
    case "EdDSA":
    case "Ed25519":
      return "SHA-512";
    default:
      throw new OidcLoginFailure("identity_verification_failed", `不支持的 ID token 签名算法：${algorithm}`);
  }
}

/** 只读取受保护头以决定 at_hash 的哈希算法；签名本身由成熟库验证。 */
function readJwtHeaderAlgorithm(idToken: string): string {
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    throw new OidcLoginFailure("identity_verification_failed", "ID token 格式无效");
  }
  const header = JSON.parse(atob(segments[0].replaceAll("-", "+").replaceAll("_", "/")));
  if (typeof header?.alg !== "string") {
    throw new OidcLoginFailure("identity_verification_failed", "ID token 缺少签名算法");
  }
  return header.alg;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 回调参数校验阶段的错误分类：这里是协议响应本身的问题，不是 ID token 校验。 */
function classifyCallbackValidationError(error: unknown): OidcLoginFailure {
  if (error instanceof OidcLoginFailure) return error;
  if (error instanceof oauth.AuthorizationResponseError) {
    return new OidcLoginFailure("authorization_declined", "授权响应返回错误", { cause: error });
  }
  if (isAbortError(error) || error instanceof TypeError) {
    return new OidcLoginFailure("identity_service_unavailable", "身份服务不可用", { cause: error });
  }
  const upstreamStatus = upstreamResponseStatus(error);
  if (upstreamStatus !== undefined && upstreamStatus >= 500) {
    return new OidcLoginFailure("identity_service_unavailable", "身份服务返回错误", { cause: error });
  }
  return new OidcLoginFailure("invalid_authorization_response", "授权响应校验失败", { cause: error });
}

/** 协议错误分类：网络与依赖失败与服务端协议/校验失败分开。 */
function classifyOidcError(error: unknown, fallback: OidcLoginFailureReason): OidcLoginFailure {
  if (error instanceof OidcLoginFailure) return error;
  if (error instanceof oauth.AuthorizationResponseError) {
    return new OidcLoginFailure("authorization_declined", "授权响应返回错误", { cause: error });
  }
  if (isAbortError(error) || error instanceof TypeError) {
    return new OidcLoginFailure("identity_service_unavailable", "身份服务不可用", { cause: error });
  }
  const upstreamStatus = upstreamResponseStatus(error);
  if (upstreamStatus !== undefined && upstreamStatus >= 500) {
    return new OidcLoginFailure("identity_service_unavailable", "身份服务返回错误", { cause: error });
  }
  if (isIdTokenVerificationError(error)) {
    return new OidcLoginFailure("identity_verification_failed", "ID token 校验失败", { cause: error });
  }
  if (error instanceof oauth.ResponseBodyError) {
    return new OidcLoginFailure("authorization_code_rejected", "令牌端点拒绝兑换", { cause: error });
  }
  if (upstreamStatus !== undefined) {
    return new OidcLoginFailure("identity_verification_failed", "身份服务拒绝请求", { cause: error });
  }
  return new OidcLoginFailure(fallback, "OIDC 校验失败", { cause: error });
}

/** 库在 ID token claims 校验失败时使用的错误码（签名失败在专用步骤内分类）。 */
const ID_TOKEN_VERIFICATION_ERROR_CODES = new Set<string>([
  oauth.JWT_CLAIM_COMPARISON,
  oauth.JWT_TIMESTAMP_CHECK,
  oauth.KEY_SELECTION,
]);

function isIdTokenVerificationError(error: unknown): boolean {
  return (
    error instanceof oauth.OperationProcessingError &&
    typeof error.code === "string" &&
    ID_TOKEN_VERIFICATION_ERROR_CODES.has(error.code)
  );
}

/** 取库错误中携带的上游 HTTP 状态；无状态（纯协议失败）时返回 undefined。 */
function upstreamResponseStatus(error: unknown): number | undefined {
  if (error instanceof oauth.ResponseBodyError) return error.response?.status;
  if (error instanceof oauth.OperationProcessingError && error.cause instanceof Response) {
    return error.cause.status;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
