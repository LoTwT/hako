// PR2 登录后端协议与失败路径测试：真实 oauth4webapi 对受控 OIDC 提供方走完整
// 授权码 + PKCE + ID token 签名 + UserInfo 流程，路由层使用真实 Worker 处理函数，
// 账号状态使用真实 SQLite（node:sqlite）。
// 覆盖：正常往返、固定 owner、错误 state/iss/aud/azp/sub/nonce/签名/过期、错误 PKCE、
// UserInfo 不一致或不可用、重复参数、回调重放、缺或错误事务 Cookie、转发到其他环境、
// 取消、事务过期与并发完成。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest } from "../src/worker/api";
import type { AuthEnvironment, AuthHandlerDependencies } from "../src/worker/auth/routes";
import { createTestAccount } from "./helpers/account-state-sqlite";
import type { TestAccount } from "./helpers/account-state-sqlite";
import {
  MOCK_CLIENT_ID,
  MOCK_ISSUER,
  MOCK_RESOURCE,
  MOCK_WEB_ORIGIN,
  OidcMockProvider,
} from "./helpers/oidc-provider-mock";
import type { AuthorizationResponseOptions } from "./helpers/oidc-provider-mock";

const OWNER_SUBJECT = "synthetic-owner-subject";
const CLOCK_START_MS = Date.parse("2026-10-02T00:00:00.000Z");
const SESSION_COOKIE_NAME = "__Host-hako_session";
const LOGIN_COOKIE_NAME = "__Host-hako_login";

let provider: OidcMockProvider;
let testAccount: TestAccount;
let nowMs: number;

beforeEach(async () => {
  provider = new OidcMockProvider(OWNER_SUBJECT);
  await provider.start();
  testAccount = createTestAccount();
  nowMs = CLOCK_START_MS;
});

afterEach(async () => {
  await provider.stop();
});

function environment(): AuthEnvironment {
  return {
    HAKO_LOGIN: {
      origin: MOCK_WEB_ORIGIN,
      issuer: MOCK_ISSUER,
      clientId: MOCK_CLIENT_ID,
      resource: MOCK_RESOURCE,
    },
    HAKO_OWNER_SUBJECT: OWNER_SUBJECT,
    HAKO_ACCOUNT: { getByName: () => testAccount.account },
  };
}

function dependencies(): AuthHandlerDependencies {
  return { now: () => nowMs, transport: provider.transport };
}

function loginRequest(origin: string | null = MOCK_WEB_ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.Origin = origin;
  return new Request("https://hako.eruoo.me/api/auth/login", { method: "POST", headers });
}

function callbackRequest(url: URL | string, cookie: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.Cookie = cookie;
  return new Request(url, { headers });
}

function cookiePair(setCookie: string | null | undefined): string {
  if (setCookie === null || setCookie === undefined) throw new Error("缺少 Set-Cookie");
  return setCookie.split(";")[0];
}

function setCookiesOf(response: Response): string[] {
  return response.headers.getSetCookie();
}

function findSetCookie(response: Response, name: string): string | null {
  for (const value of setCookiesOf(response)) {
    if (value.startsWith(`${name}=`)) return value;
  }
  return null;
}

async function startLogin(
  origin: string | null = MOCK_WEB_ORIGIN,
  loginCookie?: string,
): Promise<{
  response: Response;
  authorizationUrl: string;
  loginCookie: string;
}> {
  const request = loginRequest(origin);
  if (loginCookie !== undefined) {
    request.headers.set("Cookie", loginCookie);
  }
  const response = await handleApiRequest(request, environment(), dependencies());
  if (response.status !== 200) throw new Error(`登录发起失败：${response.status}`);
  const body = (await response.json()) as { authorizationUrl: string };
  const setCookie = findSetCookie(response, LOGIN_COOKIE_NAME);
  return { response, authorizationUrl: body.authorizationUrl, loginCookie: cookiePair(setCookie) };
}

/**
 * 受控出站：token 请求到达后先停住，直到 release() 被调用，
 * 用于构造“OIDC 兑换在途”窗口并验证退出/重新发起的并发行为。
 */
function createTokenGate(): {
  transport: { fetch: (url: string, options: RequestInit) => Promise<Response> };
  waitUntilTokenRequest: () => Promise<void>;
  release: () => void;
} {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return {
    transport: {
      fetch: async (url, options) => {
        if (url.includes("/api/auth/oauth2/token")) {
          markEntered();
          await gate;
        }
        return provider.transport.fetch(url, options);
      },
    },
    waitUntilTokenRequest: () => entered,
    release: () => releaseGate(),
  };
}

function countSessions(): number {
  const rows = testAccount.database
    .prepare("SELECT COUNT(*) AS count FROM sessions")
    .all() as Array<{ count: number }>;
  return rows[0].count;
}

async function completeLogin(options: {
  authorizationUrl: string;
  loginCookie: string | null;
  responseOptions?: AuthorizationResponseOptions;
}): Promise<{ response: Response; callbackUrl: URL }> {
  const { callbackUrl } = provider.createAuthorizationResponse(
    options.authorizationUrl,
    options.responseOptions ?? {},
  );
  const response = await handleApiRequest(
    callbackRequest(callbackUrl, options.loginCookie),
    environment(),
    dependencies(),
  );
  return { response, callbackUrl };
}

async function readSession(cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.Cookie = cookie;
  return handleApiRequest(
    new Request("https://hako.eruoo.me/api/auth/session", { headers }),
    environment(),
    dependencies(),
  );
}

async function logout(cookie: string | null, origin: string | null = MOCK_WEB_ORIGIN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.Cookie = cookie;
  if (origin !== null) headers.Origin = origin;
  return handleApiRequest(
    new Request("https://hako.eruoo.me/api/auth/logout", { method: "POST", headers }),
    environment(),
    dependencies(),
  );
}

describe("POST /api/auth/login", () => {
  it("创建登录事务并返回顶层授权地址，Cookie 属性符合合同", async () => {
    const { response, authorizationUrl, loginCookie } = await startLogin();
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${MOCK_ISSUER}/api/auth/oauth2/authorize`);
    expect(url.searchParams.get("client_id")).toBe(MOCK_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("redirect_uri")).toBe(`${MOCK_WEB_ORIGIN}/api/auth/callback`);
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("resource")).toBe(MOCK_RESOURCE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 授权地址不得携带 PKCE verifier 或任何令牌
    expect(authorizationUrl).not.toContain("code_verifier");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const setCookie = findSetCookie(response, LOGIN_COOKIE_NAME);
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Domain");
    expect(setCookie).toContain("Max-Age=600");
    expect(loginCookie).toMatch(/^__Host-hako_login=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // 服务端只保存 state 与事务凭据的哈希
    const rows = testAccount.database
      .prepare("SELECT state_hash, completion_secret_hash FROM login_transactions")
      .all() as Array<{ state_hash: string; completion_secret_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].state_hash).not.toContain(url.searchParams.get("state") ?? "x");
    expect(rows[0].completion_secret_hash).not.toContain(loginCookie.split(".")[1]);
  });

  it("重复发起使同一环境旧事务失效", async () => {
    const first = await startLogin();
    const second = await handleApiRequest(
      callbackRequest("https://hako.eruoo.me/api/auth/login", first.loginCookie),
      environment(),
      dependencies(),
    );
    expect(second.status).toBe(405);
    const third = await handleApiRequest(
      new Request("https://hako.eruoo.me/api/auth/login", {
        method: "POST",
        headers: { Origin: MOCK_WEB_ORIGIN, Cookie: first.loginCookie },
      }),
      environment(),
      dependencies(),
    );
    expect(third.status).toBe(200);
    const rows = testAccount.database
      .prepare("SELECT environment_id FROM login_transactions")
      .all() as Array<{ environment_id: string }>;
    expect(rows).toHaveLength(1);
    // 旧 state 的授权回调无法再完成
    const old = await completeLogin({ authorizationUrl: first.authorizationUrl, loginCookie: first.loginCookie });
    expect(old.response.status).toBe(400);
  });

  it("缺少或错误 Origin 一律拒绝且不创建事务", async () => {
    for (const origin of [null, "https://evil.example"]) {
      const response = await handleApiRequest(loginRequest(origin), environment(), dependencies());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "origin_not_allowed" });
      expect(findSetCookie(response, LOGIN_COOKIE_NAME)).toBeNull();
    }
    const rows = testAccount.database.prepare("SELECT COUNT(*) AS count FROM login_transactions").all() as Array<{ count: number }>;
    expect(rows[0].count).toBe(0);
  });

  it("缺少 owner Secret 时配置错误，不建立登录事务", async () => {
    const env = environment();
    const response = await handleApiRequest(
      loginRequest(),
      { ...env, HAKO_OWNER_SUBJECT: undefined },
      dependencies(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "configuration_error" });
  });

  it("discovery 不可用时返回身份服务不可用", async () => {
    provider.behavior.discoveryStatus = 500;
    const response = await handleApiRequest(loginRequest(), environment(), dependencies());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "identity_service_unavailable" });
  });

  it("metadata 不符合固定合同时拒绝发起登录", async () => {
    provider.behavior.metadataOverrides = { authorization_response_iss_parameter_supported: false };
    const response = await handleApiRequest(loginRequest(), environment(), dependencies());
    expect(response.status).toBe(503);
  });

  it("metadata 端点指向其他主机时拒绝发起登录", async () => {
    provider.behavior.metadataOverrides = { token_endpoint: "https://evil.example/token" };
    const response = await handleApiRequest(loginRequest(), environment(), dependencies());
    expect(response.status).toBe(503);
  });
});

describe("GET /api/auth/callback 正常路径", () => {
  it("完成登录、建立会话并只保存会话凭据哈希", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { response } = await completeLogin({ authorizationUrl, loginCookie });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-hako-callback-status="completed"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    // 回调响应不得包含 code/state/token 等凭据
    expect(html).not.toContain("mock-access-");
    expect(html).not.toContain("code=");

    const sessionSetCookie = findSetCookie(response, SESSION_COOKIE_NAME);
    expect(sessionSetCookie).not.toBeNull();
    expect(sessionSetCookie).toContain("Path=/");
    expect(sessionSetCookie).toContain("Secure");
    expect(sessionSetCookie).toContain("HttpOnly");
    expect(sessionSetCookie).toContain("SameSite=Lax");
    expect(sessionSetCookie).not.toContain("Domain");
    // 180 天 = 15552000 秒
    expect(sessionSetCookie).toContain("Max-Age=15552000");
    // 事务 Cookie 被清除
    const clearedLogin = findSetCookie(response, LOGIN_COOKIE_NAME);
    expect(clearedLogin).toContain("Max-Age=0");

    const sessionCookie = cookiePair(sessionSetCookie);
    const sessionToken = sessionCookie.split("=")[1];
    const stored = testAccount.database
      .prepare("SELECT session_hash, subject FROM sessions")
      .all() as Array<{ session_hash: string; subject: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].subject).toBe(OWNER_SUBJECT);
    expect(stored[0].session_hash).not.toBe(sessionToken);
    expect(JSON.stringify(stored[0])).not.toContain(sessionToken);

    // token 请求形状：none + PKCE + resource，无 client secret
    expect(provider.lastTokenRequest?.grant_type).toBe("authorization_code");
    expect(provider.lastTokenRequest?.client_id).toBe(MOCK_CLIENT_ID);
    expect(provider.lastTokenRequest?.resource).toBe(MOCK_RESOURCE);
    expect(provider.lastTokenRequest?.code_verifier).toMatch(/^[A-Za-z0-9_~.\-]{43,128}$/);
    expect(provider.lastTokenRequest).not.toHaveProperty("client_secret");
    // UserInfo 使用 Bearer 传递，不转发浏览器 Cookie
    expect(provider.lastUserInfoAuthorization).toMatch(/^Bearer mock-access-/);
    // 出站请求不转发浏览器的 Cookie/Origin/Referer，也不带任何浏览器凭据
    for (const headers of [provider.lastTokenRequestHeaders, provider.lastUserInfoRequestHeaders]) {
      expect(headers).not.toHaveProperty("cookie");
      expect(headers).not.toHaveProperty("origin");
      expect(headers).not.toHaveProperty("referer");
    }
    expect(provider.lastTokenRequestHeaders["content-type"]).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(provider.lastUserInfoRequestHeaders.accept).toContain("application/json");

    const sessionResponse = await readSession(sessionCookie);
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ authenticated: true });
    expect(sessionResponse.headers.get("Cache-Control")).toBe("no-store");

    // GET 状态读取不续期
    const before = testAccount.database
      .prepare("SELECT renewed_at FROM sessions")
      .all() as Array<{ renewed_at: number }>;
    expect(before[0].renewed_at).toBe(CLOCK_START_MS);
  });

  it("缺少 at_hash 时仍可登录", async () => {
    provider.behavior.atHash = "omit";
    const { authorizationUrl, loginCookie } = await startLogin();
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    expect(response.status).toBe(200);
  });

  it("退出使当前会话失效并清除 Cookie，不再返回 authenticated", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    const sessionCookie = cookiePair(findSetCookie(response, SESSION_COOKIE_NAME));

    const logoutResponse = await logout(sessionCookie);
    expect(logoutResponse.status).toBe(200);
    expect(await logoutResponse.json()).toEqual({ authenticated: false });
    expect(findSetCookie(logoutResponse, SESSION_COOKIE_NAME)).toContain("Max-Age=0");

    const after = await readSession(sessionCookie);
    expect(await after.json()).toEqual({ authenticated: false });
    expect(findSetCookie(after, SESSION_COOKIE_NAME)).toContain("Max-Age=0");
    expect(await readSession(null).then((r) => r.json())).toEqual({ authenticated: false });
  });

  it("退出使该环境未完成事务失效", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const logoutResponse = await logout(loginCookie);
    expect(logoutResponse.status).toBe(200);
    const rows = testAccount.database
      .prepare("SELECT COUNT(*) AS count FROM login_transactions")
      .all() as Array<{ count: number }>;
    expect(rows[0].count).toBe(0);

    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    expect(response.status).toBe(400);
  });

  it("等待 OIDC 兑换期间退出登录，回调不能建立会话", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { callbackUrl } = provider.createAuthorizationResponse(authorizationUrl);
    const gate = createTokenGate();
    const callbackPromise = handleApiRequest(callbackRequest(callbackUrl, loginCookie), environment(), {
      now: () => nowMs,
      transport: gate.transport,
    });
    await gate.waitUntilTokenRequest();
    expect(await countSessions()).toBe(0);

    const logoutResponse = await logout(loginCookie);
    expect(logoutResponse.status).toBe(200);
    gate.release();

    const response = await callbackPromise;
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-hako-callback-status="invalid_login_transaction"');
    expect(findSetCookie(response, SESSION_COOKIE_NAME)).toBeNull();
    expect(await countSessions()).toBe(0);
  });

  it("等待 OIDC 兑换期间重新发起登录，旧回调不能建立会话", async () => {
    const first = await startLogin();
    const { callbackUrl } = provider.createAuthorizationResponse(first.authorizationUrl);
    const gate = createTokenGate();
    const callbackPromise = handleApiRequest(callbackRequest(callbackUrl, first.loginCookie), environment(), {
      now: () => nowMs,
      transport: gate.transport,
    });
    await gate.waitUntilTokenRequest();

    // 同一浏览器环境重新发起登录
    const second = await startLogin(MOCK_WEB_ORIGIN, first.loginCookie);
    gate.release();

    const superseded = await callbackPromise;
    expect(superseded.status).toBe(400);
    expect(await superseded.text()).toContain('data-hako-callback-status="invalid_login_transaction"');
    expect(findSetCookie(superseded, SESSION_COOKIE_NAME)).toBeNull();
    expect(await countSessions()).toBe(0);

    // 新事务仍可正常完成
    const { response: completed } = await completeLogin({
      authorizationUrl: second.authorizationUrl,
      loginCookie: second.loginCookie,
    });
    expect(completed.status).toBe(200);
    expect(findSetCookie(completed, SESSION_COOKIE_NAME)).not.toBeNull();
  });

  it("固定 owner 变化后旧会话不再被视为已登录", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    const sessionCookie = cookiePair(findSetCookie(response, SESSION_COOKIE_NAME));

    const changedEnvironment = { ...environment(), HAKO_OWNER_SUBJECT: "another-owner" };
    const read = await handleApiRequest(
      new Request("https://hako.eruoo.me/api/auth/session", { headers: { Cookie: sessionCookie } }),
      changedEnvironment,
      dependencies(),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ authenticated: false });
    expect(findSetCookie(read, SESSION_COOKIE_NAME)).toContain("Max-Age=0");
  });

  it("缺少 owner 配置时带会话 Cookie 的状态读取返回配置错误", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    const sessionCookie = cookiePair(findSetCookie(response, SESSION_COOKIE_NAME));

    const read = await handleApiRequest(
      new Request("https://hako.eruoo.me/api/auth/session", { headers: { Cookie: sessionCookie } }),
      { ...environment(), HAKO_OWNER_SUBJECT: undefined },
      dependencies(),
    );
    expect(read.status).toBe(503);
    expect(await read.json()).toEqual({ error: "configuration_error" });
    expect(read.headers.get("Cache-Control")).toBe("no-store");
  });

  it("退出要求精确 Origin", async () => {
    for (const origin of [null, "https://evil.example"]) {
      const response = await logout(null, origin);
      expect(response.status).toBe(403);
    }
  });
});

describe("GET /api/auth/callback 失败路径", () => {
  async function expectFailedLogin(
    options: {
      authorizationUrl: string;
      loginCookie: string | null;
      responseOptions?: AuthorizationResponseOptions;
    },
    expectedStatus: number,
    expectedMarker: string,
  ): Promise<void> {
    const before = testAccount.database
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .all() as Array<{ count: number }>;
    const { response } = await completeLogin(options);
    expect(response.status).toBe(expectedStatus);
    const html = await response.text();
    expect(html).toContain(`data-hako-callback-status="${expectedMarker}"`);
    expect(html).not.toMatch(/<script|src=|href=/);
    expect(findSetCookie(response, SESSION_COOKIE_NAME)).toBeNull();
    const after = testAccount.database
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .all() as Array<{ count: number }>;
    expect(after[0].count).toBe(before[0].count);
  }

  it("缺少事务 Cookie", async () => {
    const { authorizationUrl } = await startLogin();
    await expectFailedLogin(
      { authorizationUrl, loginCookie: null },
      400,
      "invalid_login_transaction",
    );
  });

  it("state 与事务不匹配", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const callbackUrl = new URL(`${MOCK_WEB_ORIGIN}/api/auth/callback`);
    callbackUrl.searchParams.set("code", "unknown-code");
    callbackUrl.searchParams.set("state", "not-the-transaction-state");
    callbackUrl.searchParams.set("iss", MOCK_ISSUER);
    const response = await handleApiRequest(
      callbackRequest(callbackUrl, loginCookie),
      environment(),
      dependencies(),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-hako-callback-status="invalid_login_transaction"');
    expect(findSetCookie(response, SESSION_COOKIE_NAME)).toBeNull();

    // 错误 state 不消耗原事务；同环境继续用正确 state 仍可完成
    const { response: completed } = await completeLogin({ authorizationUrl, loginCookie });
    expect(completed.status).toBe(200);
  });

  it("其他环境的事务 Cookie 不能领取会话", async () => {
    const first = await startLogin();
    const other = await handleApiRequest(
      new Request("https://hako.eruoo.me/api/auth/login", {
        method: "POST",
        headers: { Origin: MOCK_WEB_ORIGIN },
      }),
      environment(),
      dependencies(),
    );
    const otherCookie = cookiePair(findSetCookie(other, LOGIN_COOKIE_NAME));
    await expectFailedLogin(
      { authorizationUrl: first.authorizationUrl, loginCookie: otherCookie },
      400,
      "invalid_login_transaction",
    );
  });

  it("回调重放不能建立第二个会话", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const first = await completeLogin({ authorizationUrl, loginCookie });
    expect(first.response.status).toBe(200);
    expect(findSetCookie(first.response, SESSION_COOKIE_NAME)).not.toBeNull();

    const replay = await handleApiRequest(
      callbackRequest(first.callbackUrl, loginCookie),
      environment(),
      dependencies(),
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('data-hako-callback-status="invalid_login_transaction"');
    expect(findSetCookie(replay, SESSION_COOKIE_NAME)).toBeNull();
    const count = testAccount.database
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .all() as Array<{ count: number }>;
    expect(count[0].count).toBe(1);
  });

  it("并发完成只允许一个请求建立会话", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { callbackUrl } = provider.createAuthorizationResponse(authorizationUrl);
    const [first, second] = await Promise.all([
      handleApiRequest(callbackRequest(callbackUrl, loginCookie), environment(), dependencies()),
      handleApiRequest(callbackRequest(callbackUrl, loginCookie), environment(), dependencies()),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const count = testAccount.database
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .all() as Array<{ count: number }>;
    expect(count[0].count).toBe(1);
  });

  it("事务过期后迟到回调不能恢复登录", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    nowMs = CLOCK_START_MS + 10 * 60 * 1000 + 1;
    await expectFailedLogin(
      { authorizationUrl, loginCookie },
      400,
      "invalid_login_transaction",
    );
  });

  it("缺少 state 参数", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    await expectFailedLogin(
      { authorizationUrl, loginCookie, responseOptions: { omitState: true } },
      400,
      "invalid_login_transaction",
    );
  });

  it("用户取消（error=access_denied）", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    await expectFailedLogin(
      {
        authorizationUrl,
        loginCookie,
        responseOptions: { omitCode: true, extraParameters: { error: "access_denied" } },
      },
      400,
      "authorization_declined",
    );
  });

  it("重复的 code 参数", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { callbackUrl } = provider.createAuthorizationResponse(authorizationUrl);
    callbackUrl.searchParams.append("code", "duplicate-code");
    const response = await handleApiRequest(
      callbackRequest(callbackUrl, loginCookie),
      environment(),
      dependencies(),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-hako-callback-status="invalid_authorization_response"');
    expect(findSetCookie(response, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("重复的 state 参数", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    const { callbackUrl } = provider.createAuthorizationResponse(authorizationUrl);
    const state = callbackUrl.searchParams.get("state") ?? "";
    callbackUrl.searchParams.append("state", state);
    const response = await handleApiRequest(
      callbackRequest(callbackUrl, loginCookie),
      environment(),
      dependencies(),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-hako-callback-status="invalid_authorization_response"');
    expect(findSetCookie(response, SESSION_COOKIE_NAME)).toBeNull();
    expect(await countSessions()).toBe(0);
  });

  it.each([
    ["错误的 iss 参数", { iss: "https://evil.example" }],
    ["缺少 iss 参数", { omitIss: true }],
  ])("%s", async (_name, responseOptions) => {
    const { authorizationUrl, loginCookie } = await startLogin();
    await expectFailedLogin(
      { authorizationUrl, loginCookie, responseOptions },
      400,
      "invalid_authorization_response",
    );
  });

  it("错误的 nonce", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.idTokenClaimsOverrides = { nonce: "wrong-nonce" };
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "identity_verification_failed");
  });

  it("错误的 audience", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.idTokenClaimsOverrides = { aud: "other-client" };
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "identity_verification_failed");
  });

  it("多 audience 且缺少 azp", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.idTokenClaimsOverrides = { aud: [MOCK_CLIENT_ID, "other-client"] };
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "identity_verification_failed");
  });

  it("错误的 azp", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.azp = "other-client";
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "identity_verification_failed");
  });

  it("错误的 at_hash", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.atHash = "wrong";
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "identity_verification_failed");
  });

  it("过期 ID token", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.idTokenClaimsOverrides = { exp: Math.floor(CLOCK_START_MS / 1000) - 3600 };
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "identity_verification_failed");
  });

  it("非 owner 身份", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.idTokenClaimsOverrides = { sub: "another-user" };
    provider.behavior.userInfo.sub = "another-user";
    await expectFailedLogin({ authorizationUrl, loginCookie }, 403, "owner_mismatch");
  });

  it("不受信任的 ID token 签名", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.signWithUntrustedKey = true;
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "identity_verification_failed");
  });

  it("PKCE verifier 与 challenge 不符", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    // 直接改写事务中的 verifier，模拟 PKCE 校验失败的兑换
    testAccount.database
      .prepare("UPDATE login_transactions SET code_verifier = ?")
      .run("wrong-verifier-wrong-verifier-wrong-verifier-0");
    await expectFailedLogin({ authorizationUrl, loginCookie }, 400, "invalid_authorization_response");
  });
});

describe("UserInfo 与依赖失败", () => {
  it("UserInfo sub 与 ID token 不一致", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.userInfo.sub = "another-user";
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-hako-callback-status="identity_verification_failed"');
  });

  it("UserInfo 不可用时不建立会话并提示服务不可用", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.userInfo.status = 500;
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('data-hako-callback-status="identity_service_unavailable"');
    expect(findSetCookie(response, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("令牌端点故障不建立会话", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.tokenEndpointError = { status: 500, body: { error: "server_error" } };
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    expect(response.status).toBe(503);
    expect(findSetCookie(response, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("令牌端点拒绝（invalid_grant）不建立会话", async () => {
    const { authorizationUrl, loginCookie } = await startLogin();
    provider.behavior.tokenEndpointError = { status: 400, body: { error: "invalid_grant" } };
    const { response } = await completeLogin({ authorizationUrl, loginCookie });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-hako-callback-status="invalid_authorization_response"');
  });
});
