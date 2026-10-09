// 本地开发登录客户端测试：以受控 fetch 验证端点注入、in-place 登录完成方式
// （登录响应建立会话 + 随后会话读取校正）、失败路径与退出。
// 端点使用测试自有路径，证明适配层完全按注入值工作。

import { describe, expect, it } from "vitest";
import { createLocalDevelopmentAuthSessionClient } from "../src/domain/auth/local-development-session-client";
import type { LocalDevelopmentAuthPaths } from "../src/domain/auth/local-development-session-client";

const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000aa";

/** 测试自有端点：不复用共享常量，验证客户端只依赖注入值。 */
const TEST_PATHS: LocalDevelopmentAuthPaths = {
  login: "/api/auth/local-test/login",
  session: "/api/auth/local-test/session",
  logout: "/api/auth/local-test/logout",
};

interface Call {
  url: string;
  method: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetchStub(
  handler: (call: Call) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, method: init?.method ?? "GET" };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

function createClient(fetchImplementation: typeof fetch) {
  return createLocalDevelopmentAuthSessionClient({ fetch: fetchImplementation, authPaths: TEST_PATHS });
}

describe("本地开发登录客户端", () => {
  it("登录在本次请求内建立会话：不跳转，状态由会话读取确认", async () => {
    let authenticated = false;
    const { fetch, calls } = createFetchStub((call) => {
      if (call.url.endsWith(TEST_PATHS.login)) {
        authenticated = true;
        return jsonResponse({ authenticated: true, accountId: ACCOUNT_ID });
      }
      return jsonResponse(authenticated ? { authenticated: true, accountId: ACCOUNT_ID } : { authenticated: false });
    });
    const client = createClient(fetch);

    await client.refresh();
    expect(client.current.status).toBe("anonymous");
    expect(client.current.message).toContain("本地开发环境");

    const result = await client.login();
    expect(result).toEqual({ ok: true, authorizationUrl: "", message: expect.any(String), redirect: false });
    expect(client.current.status).toBe("authenticated");
    expect(client.current.accountId).toBe(ACCOUNT_ID);
    expect(client.current.message).toContain("本地测试账号");
    // 登录响应之后仍以会话端点确认；命令与观察都打到注入的本地端点。
    expect(calls.map((call) => call.url)).toEqual([
      TEST_PATHS.session,
      TEST_PATHS.login,
      TEST_PATHS.session,
    ]);
  });

  it("登录失败不进入登录状态，也不要求跳转", async () => {
    const { fetch } = createFetchStub(() => jsonResponse({ error: "local_session_unavailable" }, 503));
    const client = createClient(fetch);
    const result = await client.login();
    expect(result.ok).toBe(false);
    expect(result.redirect).toBe(false);
    expect(result.message).toContain("本地 Worker");
    expect(client.current.status).not.toBe("authenticated");
    expect(client.current.accountId).toBeNull();
  });

  it("登录响应缺少合法账号标识时不放行", async () => {
    const { fetch } = createFetchStub(() => jsonResponse({ authenticated: true, accountId: "raw-subject" }));
    const client = createClient(fetch);
    const result = await client.login();
    expect(result.ok).toBe(false);
    expect(client.current.status).toBe("unavailable");
    expect(client.current.accountId).toBeNull();
  });

  it("退出使用本地端点并回到未登录", async () => {
    const { fetch, calls } = createFetchStub((call) => call.url.endsWith(TEST_PATHS.logout)
      ? jsonResponse({ authenticated: false })
      : jsonResponse({ authenticated: true, accountId: ACCOUNT_ID }));
    const client = createClient(fetch);
    await client.refresh();
    expect(client.current.status).toBe("authenticated");

    const result = await client.logout();
    expect(result.ok).toBe(true);
    expect(client.current.status).toBe("anonymous");
    expect(client.current.message).toContain("已退出本地测试账号");
    expect(calls.at(-1)).toEqual({ url: TEST_PATHS.logout, method: "POST" });
  });

  it("离线时不发起本地登录请求", async () => {
    const { fetch, calls } = createFetchStub(() => jsonResponse({ authenticated: false }));
    const client = createLocalDevelopmentAuthSessionClient({
      fetch,
      authPaths: TEST_PATHS,
      isOnline: () => false,
    });
    const result = await client.login();
    expect(result.ok).toBe(false);
    expect(result.redirect).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
