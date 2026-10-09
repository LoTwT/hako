// dev:local 本地登录适配层的行为测试：真实 SQLite 账号状态（node:sqlite，
// 与 Durable Object 共用 src/worker/auth/account-state.ts 的逻辑）+ 真实 /api 路由。
// 覆盖：精确 Host/来源校验、真实本地会话的建立/读取/撤销、浏览器本地专用标识到
// 生产会话 Cookie 的映射、二进制正文与账号/代次响应头合同。
//
// 运行配置使用测试自有值：验证适配层完全按注入配置工作，而不是硬编码某组常量。
// dev:local 入口与共享常量之间的接线由真实浏览器验证（见 docs/local-validation.md）。

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest } from "../src/worker/api";
import { createLocalDevelopmentAuthAdapter } from "../src/worker/local-dev/routes";
import type {
  LocalDevelopmentAuthEnvironment,
  LocalDevelopmentConfiguration,
} from "../src/worker/local-dev/routes";
import { createLocalDevelopmentSession } from "../src/worker/local-dev/synthetic-session";
import { createTestAccount } from "./helpers/account-state-sqlite";
import type { TestAccount } from "./helpers/account-state-sqlite";
import { initializeTestLoro } from "./helpers/sync-fixtures";

const TEST_HOST = "127.0.0.1:1422";
const TEST_ORIGIN = "http://127.0.0.1:1422";
const TEST_INTERNAL_ORIGIN = "https://hako-local-dev.invalid";
const TEST_COOKIE_NAME = "hako_local_dev_session";
const TEST_IDENTITY = {
  issuer: "https://hako-local-dev-issuer.invalid",
  subject: "local-development-synthetic-owner",
};

function testConfiguration(): LocalDevelopmentConfiguration {
  return {
    host: TEST_HOST,
    origin: TEST_ORIGIN,
    sessionCookieName: TEST_COOKIE_NAME,
    authPaths: {
      login: "/api/auth/local/login",
      session: "/api/auth/local/session",
      logout: "/api/auth/local/logout",
    },
    internalLogin: {
      origin: TEST_INTERNAL_ORIGIN,
      issuer: TEST_IDENTITY.issuer,
      clientId: "hako-local-dev-web",
      resource: "https://hako-local-dev-issuer.invalid/api",
      ownerSubject: TEST_IDENTITY.subject,
    },
  };
}

let testAccount: TestAccount;

beforeAll(initializeTestLoro);
beforeEach(() => {
  testAccount = createTestAccount();
});

function environment(): LocalDevelopmentAuthEnvironment {
  return {
    HAKO_ACCOUNT: { getByName: () => testAccount.account },
    // 既有业务路由从 HAKO_LOGIN 读取内部固定来源与身份键（dev:local 入口注入同一组合成值）。
    HAKO_LOGIN: {
      origin: TEST_INTERNAL_ORIGIN,
      issuer: TEST_IDENTITY.issuer,
      clientId: "hako-local-dev-web",
      resource: "https://hako-local-dev-issuer.invalid/api",
    },
    HAKO_OWNER_SUBJECT: TEST_IDENTITY.subject,
  };
}

interface RequestOptions {
  method?: string;
  origin?: string | null;
  host?: string | null;
  cookie?: string | null;
  path?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
}

function localRequest(options: RequestOptions = {}): Request {
  const headers = new Headers(options.headers ?? {});
  const host = options.host === undefined ? TEST_HOST : options.host;
  if (host !== null) headers.set("Host", host);
  const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
  if (origin !== null) headers.set("Origin", origin);
  if (options.cookie !== undefined && options.cookie !== null) headers.set("Cookie", options.cookie);
  return new Request(`${TEST_ORIGIN}${options.path ?? "/api/auth/local/session"}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  });
}

/** 从 Set-Cookie 提取本地会话标识的完整 Cookie 对与属性。 */
function setCookieOf(response: Response): string {
  const setCookie = response.headers.getSetCookie()[0];
  if (setCookie === undefined) throw new Error("响应没有 Set-Cookie");
  return setCookie;
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

async function login(): Promise<{ response: Response; cookie: string }> {
  const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
  const response = await adapter.handleAuthRequest(
    localRequest({ method: "POST", path: "/api/auth/local/login" }),
    environment(),
  );
  return { response, cookie: cookiePair(setCookieOf(response)) };
}

describe("本地开发登录端点", () => {
  it("登录建立真实本地会话并返回随机标识与账号", async () => {
    const { response, cookie } = await login();
    expect(response.status).toBe(200);
    const body = await response.json() as { authenticated: boolean; accountId: string };
    expect(body.authenticated).toBe(true);
    expect(body.accountId).toMatch(/^[0-9a-f-]{36}$/);

    const setCookie = setCookieOf(response);
    expect(setCookie.startsWith(`${TEST_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    // 本地专用标识不设 Secure（HTTP 本地开发），也不使用生产 __Host- 名称。
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain("__Host-");
    // 浏览器保存期限与生产一致：一次保留到会话绝对上限。
    expect(setCookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);

    // 服务端只保存哈希：Cookie 里的随机凭据不是账号标识。
    const token = cookie.slice(cookie.indexOf("=") + 1);
    expect(token).not.toBe(body.accountId);
    expect(token.length).toBeGreaterThanOrEqual(32);

    // 同一凭据可读取会话：登录、读取命中同一份 DO 会话。
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const session = await adapter.handleAuthRequest(
      localRequest({ cookie, path: "/api/auth/local/session" }),
      environment(),
    );
    expect(await session.json()).toEqual({ authenticated: true, accountId: body.accountId });
  });

  it("未登录与未知凭据都返回未认证，且不改写浏览器标识", async () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const anonymous = await adapter.handleAuthRequest(
      localRequest({ path: "/api/auth/local/session" }),
      environment(),
    );
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ authenticated: false });
    expect(anonymous.headers.getSetCookie()).toEqual([]);

    const forged = await adapter.handleAuthRequest(
      localRequest({ cookie: `${TEST_COOKIE_NAME}=forged-token-value`, path: "/api/auth/local/session" }),
      environment(),
    );
    expect(forged.status).toBe(200);
    expect(await forged.json()).toEqual({ authenticated: false });
    expect(forged.headers.getSetCookie()).toEqual([]);
  });

  it("其他身份的会话不能作为本地测试账号读取", async () => {
    const otherIdentity = { issuer: TEST_IDENTITY.issuer, subject: "other-synthetic-subject" };
    const created = await createLocalDevelopmentSession(testAccount.account, otherIdentity, Date.now());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const response = await adapter.handleAuthRequest(
      localRequest({ cookie: `${TEST_COOKIE_NAME}=${created.token}`, path: "/api/auth/local/session" }),
      environment(),
    );
    expect(await response.json()).toEqual({ authenticated: false });
  });

  it("退出撤销服务端会话并清除浏览器标识", async () => {
    const { cookie } = await login();
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const logout = await adapter.handleAuthRequest(
      localRequest({ method: "POST", cookie, path: "/api/auth/local/logout" }),
      environment(),
    );
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ authenticated: false });
    expect(setCookieOf(logout)).toContain(`Max-Age=0`);

    // 旧凭据在服务端已失效：重放同一 Cookie 不再建立登录状态。
    const replay = await adapter.handleAuthRequest(
      localRequest({ cookie, path: "/api/auth/local/session" }),
      environment(),
    );
    expect(await replay.json()).toEqual({ authenticated: false });
  });

  it("方法不允许时返回 405 与 Allow", async () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const wrongMethod = await adapter.handleAuthRequest(
      localRequest({ method: "GET", path: "/api/auth/local/login" }),
      environment(),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");

    const unknownPath = await adapter.handleAuthRequest(
      localRequest({ path: "/api/auth/local/unknown" }),
      environment(),
    );
    expect(unknownPath.status).toBe(404);
  });
});

describe("本地开发的 Host 与来源校验", () => {
  it("拒绝非本地 Host 与任何其他来源", async () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const environmentValue = environment();

    const foreignHost = await adapter.handleAuthRequest(
      localRequest({ host: "hako.eruoo.me", path: "/api/auth/local/session" }),
      environmentValue,
    );
    expect(foreignHost.status).toBe(403);
    expect(await foreignHost.json()).toEqual({ error: "host_not_allowed" });

    for (const origin of ["https://hako.eruoo.me", "http://localhost:1422", "http://127.0.0.1:1420"]) {
      const rejected = await adapter.handleAuthRequest(
        localRequest({ origin, path: "/api/auth/local/session" }),
        environmentValue,
      );
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({ error: "origin_not_allowed" });
    }
  });

  it("状态变更必须有精确来源，读取可以不携带来源", async () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const environmentValue = environment();

    const missingOrigin = await adapter.handleAuthRequest(
      localRequest({ method: "POST", origin: null, path: "/api/auth/local/login" }),
      environmentValue,
    );
    expect(missingOrigin.status).toBe(403);
    expect(await missingOrigin.json()).toEqual({ error: "origin_not_allowed" });

    const readWithoutOrigin = await adapter.handleAuthRequest(
      localRequest({ origin: null, path: "/api/auth/local/session" }),
      environmentValue,
    );
    expect(readWithoutOrigin.status).toBe(200);
    expect(await readWithoutOrigin.json()).toEqual({ authenticated: false });
  });

  it("既有 /api 路由的入口适配沿用同一校验", () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());

    const foreignOrigin = adapter.normalizeApiRequest(localRequest({ method: "POST", origin: "https://example.invalid" }));
    expect(foreignOrigin.ok).toBe(false);
    if (foreignOrigin.ok) return;
    expect(foreignOrigin.response.status).toBe(403);
    expect(foreignOrigin.response.headers.get("Cache-Control")).toBe("no-store");

    const missingHost = adapter.normalizeApiRequest(localRequest({ host: null }));
    expect(missingHost.ok).toBe(false);

    const writeWithoutOrigin = adapter.normalizeApiRequest(localRequest({ method: "POST", origin: null }));
    expect(writeWithoutOrigin.ok).toBe(false);
  });
});

describe("既有 /api 路由的入口适配", () => {
  it("本地标识映射为生产会话 Cookie 名，其他 Cookie 保留", () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const normalized = adapter.normalizeApiRequest(
      localRequest({ cookie: `theme=dark; ${TEST_COOKIE_NAME}=local-token; kept=1`, path: "/api/sync/refueling" }),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const cookie = normalized.request.headers.get("Cookie") ?? "";
    expect(cookie).toContain("__Host-hako_session=local-token");
    expect(cookie).toContain("theme=dark");
    expect(cookie).toContain("kept=1");
    expect(cookie).not.toContain(TEST_COOKIE_NAME);
  });

  it("loopback 来源映射为内部固定来源；无来源读取保持无来源", () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const write = adapter.normalizeApiRequest(localRequest({ method: "POST" }));
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.request.headers.get("Origin")).toBe(TEST_INTERNAL_ORIGIN);

    const read = adapter.normalizeApiRequest(localRequest({ origin: null }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.request.headers.get("Origin")).toBeNull();

    const noCookie = adapter.normalizeApiRequest(localRequest({ path: "/api/health" }));
    expect(noCookie.ok).toBe(true);
    if (!noCookie.ok) return;
    expect(noCookie.request.headers.get("Cookie")).toBeNull();
  });

  it("方法、地址与二进制正文保持不变", async () => {
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const payload = new Uint8Array([0, 1, 2, 250, 255, 13, 10, 0]);
    const normalized = adapter.normalizeApiRequest(
      localRequest({
        method: "POST",
        path: "/api/sync/refueling",
        cookie: `${TEST_COOKIE_NAME}=local-token`,
        headers: { "Content-Type": "application/octet-stream" },
        body: payload as unknown as BodyInit,
      }),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.request.method).toBe("POST");
    expect(new URL(normalized.request.url).pathname).toBe("/api/sync/refueling");
    expect(normalized.request.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await normalized.request.arrayBuffer())).toEqual(payload);
  });

  it("经适配层进入真实业务路由：bootstrap 与快照沿用账号/代次合同", async () => {
    const { response: loginResponse, cookie } = await login();
    const accountId = (await loginResponse.json() as { accountId: string }).accountId;
    const adapter = createLocalDevelopmentAuthAdapter(testConfiguration());
    const environmentValue = environment();

    const bootstrap = adapter.normalizeApiRequest(localRequest({
      method: "POST",
      path: "/api/sync/refueling/bootstrap",
      cookie,
      headers: { "X-Hako-Account": accountId, "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    const bootstrapResponse = await handleApiRequest(bootstrap.request, environmentValue);
    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(bootstrapResponse.headers.get("X-Hako-Account")).toBe(accountId);
    const bootstrapBody = await bootstrapResponse.json() as { documentGeneration: string };
    expect(bootstrapBody.documentGeneration).toMatch(/^[0-9a-f-]{36}$/);

    // 尚无主文档：只读快照返回 204，代次与账号响应头仍然有效。
    const snapshot = adapter.normalizeApiRequest(localRequest({
      method: "GET",
      path: "/api/sync/refueling",
      cookie,
      headers: {
        "X-Hako-Account": accountId,
        "X-Hako-Sync-Protocol": "2",
      },
    }));
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const snapshotResponse = await handleApiRequest(snapshot.request, environmentValue);
    expect(snapshotResponse.status).toBe(204);
    expect(snapshotResponse.headers.get("X-Hako-Account")).toBe(accountId);
    expect(snapshotResponse.headers.get("X-Hako-Document-Generation")).toBe(bootstrapBody.documentGeneration);

    // 未登录（无本地标识）时业务路由仍然拒绝：401 unauthorized。
    const anonymous = adapter.normalizeApiRequest(localRequest({
      method: "GET",
      path: "/api/sync/refueling",
      headers: { "X-Hako-Account": accountId, "X-Hako-Sync-Protocol": "2" },
    }));
    expect(anonymous.ok).toBe(true);
    if (!anonymous.ok) return;
    expect((await handleApiRequest(anonymous.request, environmentValue)).status).toBe(401);
  });
});
