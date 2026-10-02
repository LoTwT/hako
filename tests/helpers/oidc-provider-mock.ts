// 受控 OIDC 提供方：在本地 HTTP 上真实实现 discovery/JWKS/token/UserInfo，
// 用真实 ES256 签名产出可验证的 ID token，供 Worker 路由与 oauth4webapi 走完整协议。
// 测试通过 transport 把固定生产 issuer（https://auth.eruoo.me）重写到本机端口，
// 因此被测代码仍使用正式配置值与固定端点路径。

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign as signWithKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { OidcOutboundTransport } from "../../src/worker/auth/oidc";

export const MOCK_WEB_ORIGIN = "https://hako.eruoo.me";
export const MOCK_ISSUER = "https://auth.eruoo.me";
export const MOCK_CLIENT_ID = "hako-web";
export const MOCK_RESOURCE = "https://auth.eruoo.me/api";
export const MOCK_REDIRECT_URI = `${MOCK_WEB_ORIGIN}/api/auth/callback`;

const DISCOVERY_PATH = "/.well-known/openid-configuration";
const AUTHORIZATION_PATH = "/api/auth/oauth2/authorize";
const TOKEN_PATH = "/api/auth/oauth2/token";
const USERINFO_PATH = "/api/auth/oauth2/userinfo";
const JWKS_PATH = "/api/auth/jwks";

const ACCESS_TOKEN_TTL_SECONDS = 3600;
const ID_TOKEN_TTL_SECONDS = 600;

export interface MockTokenEndpointError {
  status: number;
  body: Record<string, unknown>;
}

/** 可在测试运行中修改的行为开关。 */
export interface MockOidcBehavior {
  discoveryStatus: number;
  metadataOverrides: Record<string, unknown>;
  jwksStatus: number;
  tokenEndpointError: MockTokenEndpointError | null;
  signWithUntrustedKey: boolean;
  idTokenClaimsOverrides: Record<string, unknown>;
  atHash: "correct" | "wrong" | "omit";
  azp: string | null;
  userInfo: {
    status: number;
    sub: string | null;
    name: string | null;
  };
}

interface PendingAuthorization {
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
  resource: string;
  state: string;
}

export interface AuthorizationResponseOptions {
  omitIss?: boolean;
  iss?: string;
  omitState?: boolean;
  omitCode?: boolean;
  extraParameters?: Record<string, string>;
}

export class OidcMockProvider {
  readonly behavior: MockOidcBehavior = {
    discoveryStatus: 200,
    metadataOverrides: {},
    jwksStatus: 200,
    tokenEndpointError: null,
    signWithUntrustedKey: false,
    idTokenClaimsOverrides: {},
    atHash: "correct",
    azp: null,
    userInfo: { status: 200, sub: null, name: "合成用户" },
  };

  /** 最近一次 token 请求的表单参数，用于断言请求形状。 */
  lastTokenRequest: Record<string, string> | null = null;
  /** 最近一次 token 请求的请求头（小写名），用于断言不转发浏览器凭据。 */
  lastTokenRequestHeaders: Record<string, string> = {};
  /** 最近一次 UserInfo 请求携带的 Authorization 头。 */
  lastUserInfoAuthorization: string | null = null;
  /** 最近一次 UserInfo 请求的请求头（小写名）。 */
  lastUserInfoRequestHeaders: Record<string, string> = {};

  private readonly trustedKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private readonly untrustedKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private readonly trustedKeyId = `mock-key-${randomUUID()}`;
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();
  private server: Server | null = null;
  private baseUrl = "";

  constructor(readonly ownerSubject: string) {}

  async start(port = 0): Promise<void> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("OIDC mock 未能监听端口");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** 把正式 issuer 上的出站请求重写到本机 mock；路径与 query 保持不变。 */
  get transport(): OidcOutboundTransport {
    return {
      fetch: (url, options) => {
        const target = new URL(url);
        return fetch(new URL(`${target.pathname}${target.search}`, this.baseUrl), options);
      },
    };
  }

  /**
   * 模拟授权端点：校验顶层授权请求参数并登记 code 与 PKCE challenge，
   * 返回回调地址（默认带 iss 与 state）。HTTP 路由与直接调用共用同一逻辑。
   */
  createAuthorizationResponse(
    authorizationUrl: string,
    options: AuthorizationResponseOptions = {},
  ): { callbackUrl: URL; code: string; authorizationParameters: URLSearchParams } {
    return this.registerAuthorization(new URL(authorizationUrl).searchParams, options);
  }

  private registerAuthorization(
    parameters: URLSearchParams,
    options: AuthorizationResponseOptions = {},
  ): { callbackUrl: URL; code: string; authorizationParameters: URLSearchParams } {
    if (parameters.get("client_id") !== MOCK_CLIENT_ID) throw new Error("授权请求 client_id 不符");
    if (parameters.get("response_type") !== "code") throw new Error("授权请求 response_type 不符");
    if (parameters.get("response_mode") !== "query") throw new Error("授权请求 response_mode 不符");
    if (parameters.get("redirect_uri") !== MOCK_REDIRECT_URI) throw new Error("授权请求 redirect_uri 不符");
    if (parameters.get("scope") !== "openid profile") throw new Error("授权请求 scope 不符");
    if (parameters.get("resource") !== MOCK_RESOURCE) throw new Error("授权请求 resource 不符");
    if (parameters.get("code_challenge_method") !== "S256") throw new Error("授权请求缺少 S256");
    const state = parameters.get("state");
    const nonce = parameters.get("nonce");
    const codeChallenge = parameters.get("code_challenge");
    if (state === null || nonce === null || codeChallenge === null) {
      throw new Error("授权请求缺少 state/nonce/code_challenge");
    }

    const code = randomUUID();
    this.pendingAuthorizations.set(code, {
      codeChallenge,
      nonce,
      redirectUri: parameters.get("redirect_uri") ?? "",
      resource: parameters.get("resource") ?? "",
      state,
    });

    const callbackUrl = new URL(MOCK_REDIRECT_URI);
    if (options.omitCode !== true) callbackUrl.searchParams.set("code", code);
    if (options.omitState !== true) callbackUrl.searchParams.set("state", state);
    if (options.omitIss !== true) callbackUrl.searchParams.set("iss", options.iss ?? MOCK_ISSUER);
    for (const [name, value] of Object.entries(options.extraParameters ?? {})) {
      callbackUrl.searchParams.set(name, value);
    }
    return { callbackUrl, code, authorizationParameters: parameters };
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: MOCK_ISSUER,
      authorization_endpoint: `${MOCK_ISSUER}${AUTHORIZATION_PATH}`,
      token_endpoint: `${MOCK_ISSUER}${TOKEN_PATH}`,
      userinfo_endpoint: `${MOCK_ISSUER}${USERINFO_PATH}`,
      jwks_uri: `${MOCK_ISSUER}${JWKS_PATH}`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      id_token_signing_alg_values_supported: ["ES256"],
      subject_types_supported: ["public"],
      scopes_supported: ["openid", "profile"],
      ...this.behavior.metadataOverrides,
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.baseUrl);
    try {
      if (request.method === "GET" && url.pathname === DISCOVERY_PATH) {
        this.respondJson(response, this.behavior.discoveryStatus, this.metadata());
        return;
      }
      if (request.method === "GET" && url.pathname === JWKS_PATH) {
        if (this.behavior.jwksStatus !== 200) {
          this.respondJson(response, this.behavior.jwksStatus, { error: "unavailable" });
          return;
        }
        this.respondJson(response, 200, { keys: [this.publicJwk()] });
        return;
      }
      if (request.method === "GET" && url.pathname === AUTHORIZATION_PATH) {
        const { callbackUrl } = this.registerAuthorization(url.searchParams);
        response.writeHead(302, { location: callbackUrl.href });
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === TOKEN_PATH) {
        await this.handleTokenRequest(request, response);
        return;
      }
      if (request.method === "GET" && url.pathname === USERINFO_PATH) {
        this.handleUserInfoRequest(request, response);
        return;
      }
      this.respondJson(response, 404, { error: "not_found" });
    } catch {
      this.respondJson(response, 500, { error: "mock_failure" });
    }
  }

  private async handleTokenRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBody(request);
    const parameters = new URLSearchParams(body);
    this.lastTokenRequest = Object.fromEntries(parameters.entries());
    this.lastTokenRequestHeaders = normalizeHeaders(request);

    const error = this.behavior.tokenEndpointError;
    if (error !== null) {
      this.respondJson(response, error.status, error.body);
      return;
    }

    const code = parameters.get("code") ?? "";
    const pending = this.pendingAuthorizations.get(code);
    const verifier = parameters.get("code_verifier") ?? "";
    const challengeMatches =
      pending !== undefined && (await pkceChallenge(verifier)) === pending.codeChallenge;
    if (
      pending === undefined ||
      !challengeMatches ||
      parameters.get("grant_type") !== "authorization_code" ||
      parameters.get("client_id") !== MOCK_CLIENT_ID ||
      parameters.get("redirect_uri") !== pending.redirectUri ||
      parameters.get("resource") !== pending.resource
    ) {
      this.respondJson(response, 400, { error: "invalid_grant" });
      return;
    }
    this.pendingAuthorizations.delete(code);

    const accessToken = `mock-access-${randomUUID()}`;
    const idToken = this.issueIdToken(accessToken, pending.nonce);
    this.respondJson(response, 200, {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: "openid profile",
      id_token: idToken,
    });
  }

  private handleUserInfoRequest(request: IncomingMessage, response: ServerResponse): void {
    this.lastUserInfoAuthorization = request.headers.authorization ?? null;
    this.lastUserInfoRequestHeaders = normalizeHeaders(request);
    const { status, sub, name } = this.behavior.userInfo;
    if (status !== 200) {
      this.respondJson(response, status, { error: "userinfo_unavailable" });
      return;
    }
    const payload: Record<string, unknown> = { sub: sub ?? this.ownerSubject };
    if (name !== null) payload.name = name;
    this.respondJson(response, 200, payload);
  }

  private issueIdToken(accessToken: string, nonce: string): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: MOCK_ISSUER,
      sub: this.ownerSubject,
      aud: MOCK_CLIENT_ID,
      iat: nowSeconds,
      exp: nowSeconds + ID_TOKEN_TTL_SECONDS,
      nonce,
      ...this.behavior.idTokenClaimsOverrides,
    };
    if (this.behavior.azp !== null) claims.azp = this.behavior.azp;
    if (this.behavior.atHash === "correct") claims.at_hash = atHash(accessToken);
    if (this.behavior.atHash === "wrong") claims.at_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const keyPair = this.behavior.signWithUntrustedKey ? this.untrustedKey : this.trustedKey;
    return signJwt(claims, keyPair.privateKey, this.trustedKeyId);
  }

  private publicJwk(): Record<string, unknown> {
    const jwk = this.trustedKey.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    return { ...jwk, kid: this.trustedKeyId, alg: "ES256", use: "sig" };
  }

  private respondJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}

function signJwt(claims: Record<string, unknown>, privateKey: KeyObject, keyId: string): string {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = signWithKey("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function atHash(accessToken: string): string {
  const digest = createHash("sha256").update(accessToken, "utf8").digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}

async function pkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return Buffer.from(digest).toString("base64url");
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** 请求头名转小写，便于断言出站请求形状。 */
function normalizeHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}
