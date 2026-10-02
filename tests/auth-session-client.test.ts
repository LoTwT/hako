// 认证状态客户端测试：以受控 fetch 验证 session 事实来源、登录地址校验、
// 退出失败不谎报、离线分类，以及较早的异步响应不能覆盖较新的退出/重登结果。

import { describe, expect, it } from "vitest";
import { AuthSessionClient, safeAuthorizationUrl } from "../src/domain/auth/session-client";

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

describe("AuthSessionClient", () => {
  it("以 session 响应决定登录状态", async () => {
    let authenticated = false;
    const { fetch } = createFetchStub(() => jsonResponse({ authenticated }));
    const client = new AuthSessionClient({ fetch });

    await client.refresh();
    expect(client.current.status).toBe("anonymous");

    authenticated = true;
    await client.refresh();
    expect(client.current.status).toBe("authenticated");
    expect(client.current.message).toContain("不会自动关联");
  });

  it("并发 refresh 合并为一次请求", async () => {
    const { fetch, calls } = createFetchStub(() => jsonResponse({ authenticated: false }));
    const client = new AuthSessionClient({ fetch });
    await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(calls).toHaveLength(1);
  });

  it("较早的会话响应不能覆盖较新的退出结果", async () => {
    let releaseSession!: (response: Response) => void;
    const sessionPending = new Promise<Response>((resolve) => {
      releaseSession = resolve;
    });
    const { fetch } = createFetchStub((call) =>
      call.url.endsWith("/api/auth/session") ? sessionPending : jsonResponse({ authenticated: false }),
    );
    const client = new AuthSessionClient({ fetch });

    const refresh = client.refresh();
    const logout = await client.logout();
    expect(logout.ok).toBe(true);
    expect(client.current.status).toBe("anonymous");

    // 迟到的会话响应（仍是登录中）不得把状态改回已登录
    releaseSession(jsonResponse({ authenticated: true }));
    await refresh;
    expect(client.current.status).toBe("anonymous");
  });

  it("可见性刷新不会取消在途登录，busy 状态会复位", async () => {
    let releaseLogin!: (response: Response) => void;
    const loginPending = new Promise<Response>((resolve) => {
      releaseLogin = resolve;
    });
    const { fetch } = createFetchStub((call) => {
      if (call.url.endsWith("/api/auth/login")) return loginPending;
      return jsonResponse({ authenticated: false });
    });
    const client = new AuthSessionClient({ fetch });

    const login = client.login();
    expect(client.current.loggingIn).toBe(true);
    // 页面重新可见时触发的只读刷新（此时仍是匿名）不能取消上面的登录命令
    await client.refresh();
    expect(client.current.loggingIn).toBe(true);

    releaseLogin(
      jsonResponse({ authorizationUrl: "https://auth.eruoo.me/authorize?state=x" }),
    );
    const result = await login;
    expect(result.ok).toBe(true);
    expect(result.authorizationUrl).toContain("https://auth.eruoo.me/");
    expect(client.current.loggingIn).toBe(false);
  });

  it("可见性刷新不会取消在途退出，也不覆盖其结果", async () => {
    let releaseLogout!: (response: Response) => void;
    const logoutPending = new Promise<Response>((resolve) => {
      releaseLogout = resolve;
    });
    const { fetch } = createFetchStub((call) => {
      if (call.url.endsWith("/api/auth/logout")) return logoutPending;
      return jsonResponse({ authenticated: true });
    });
    const client = new AuthSessionClient({ fetch });

    const logout = client.logout();
    expect(client.current.loggingOut).toBe(true);
    await client.refresh();
    expect(client.current.loggingOut).toBe(true);

    releaseLogout(jsonResponse({ authenticated: false }));
    const result = await logout;
    expect(result.ok).toBe(true);
    expect(client.current.loggingOut).toBe(false);
    expect(client.current.status).toBe("anonymous");
    // 退出过程中完成的只读刷新（已登录）不得把状态改回已登录
    expect(client.current.message).toContain("已退出");
  });

  it("登录失败时刷新也不会让 busy 停在准备中", async () => {
    let releaseLogin!: (response: Response) => void;
    const loginPending = new Promise<Response>((resolve) => {
      releaseLogin = resolve;
    });
    const { fetch } = createFetchStub((call) => {
      if (call.url.endsWith("/api/auth/login")) return loginPending;
      return jsonResponse({ authenticated: false });
    });
    const client = new AuthSessionClient({ fetch });

    const login = client.login();
    await client.refresh();
    releaseLogin(jsonResponse({ error: "identity_service_unavailable" }, 503));
    const result = await login;
    expect(result.ok).toBe(false);
    expect(client.current.loggingIn).toBe(false);
    expect(client.current.message).toContain("登录服务暂时不可用");
  });

  it("退出期间启动的刷新不能在退出完成后恢复已登录显示", async () => {
    let releaseLogout!: (response: Response) => void;
    let releaseRefresh!: (response: Response) => void;
    const logoutPending = new Promise<Response>((resolve) => {
      releaseLogout = resolve;
    });
    const refreshPending = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    const { fetch } = createFetchStub((call) =>
      call.url.endsWith("/api/auth/logout") ? logoutPending : refreshPending,
    );
    const client = new AuthSessionClient({ fetch });

    const logout = client.logout();
    // 退出生效前发起的读取（会拿到旧的“已登录”结果）
    const refresh = client.refresh();
    releaseLogout(jsonResponse({ authenticated: false }));
    await logout;
    expect(client.current.status).toBe("anonymous");

    releaseRefresh(jsonResponse({ authenticated: true }));
    await refresh;
    expect(client.current.status).toBe("anonymous");
    expect(client.current.message).toContain("已退出");
  });

  it("退出期间刷新所读到的 JSON 延迟返回时同样不覆盖结果", async () => {
    let releaseLogout!: (response: Response) => void;
    let releaseBody!: () => void;
    const logoutPending = new Promise<Response>((resolve) => {
      releaseLogout = resolve;
    });
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const lateJson = {
      ok: true,
      json: async () => {
        await bodyGate;
        return { authenticated: true };
      },
    } as unknown as Response;
    const { fetch } = createFetchStub((call) =>
      call.url.endsWith("/api/auth/logout") ? logoutPending : lateJson,
    );
    const client = new AuthSessionClient({ fetch });

    const logout = client.logout();
    const refresh = client.refresh();
    releaseLogout(jsonResponse({ authenticated: false }));
    await logout;
    // JSON 解析边界：即使响应体在退出完成后才解析出来，也不能改回已登录
    releaseBody();
    await refresh;
    expect(client.current.status).toBe("anonymous");
  });

  it("登录返回的授权地址必须可用且只允许 http(s) 本机开发地址", async () => {
    const { fetch, calls } = createFetchStub(() =>
      jsonResponse({ authorizationUrl: "https://auth.eruoo.me/api/auth/oauth2/authorize?state=x" }),
    );
    const client = new AuthSessionClient({ fetch });
    const result = await client.login();
    expect(result.ok).toBe(true);
    expect(result.authorizationUrl).toContain("https://auth.eruoo.me/");
    expect(calls[0]).toEqual({ url: "/api/auth/login", method: "POST" });
    // 登录完成前不预置为已登录
    expect(client.current.status).toBe("checking");
  });

  it.each([
    ["javascript:alert(1)", false],
    ["data:text/html,hi", false],
    ["http://evil.example/authorize", false],
    ["http://127.0.0.1:8787/authorize", true],
    ["http://localhost:8787/authorize", true],
    ["https://auth.eruoo.me/authorize", true],
    ["not a url", false],
  ])("safeAuthorizationUrl(%s) → %s", (value, expected) => {
    expect(safeAuthorizationUrl(value)).toBe(expected);
  });

  it("无效或异常的登录响应给出可读失败，不跳转", async () => {
    const invalid = createFetchStub(() => jsonResponse({ authorizationUrl: "javascript:alert(1)" }));
    const invalidClient = new AuthSessionClient({ fetch: invalid.fetch });
    expect((await invalidClient.login()).ok).toBe(false);
    expect(invalidClient.current.message).toContain("登录地址无效");

    const failing = createFetchStub(() => jsonResponse({ error: "configuration_error" }, 503));
    const failingClient = new AuthSessionClient({ fetch: failing.fetch });
    expect((await failingClient.login()).ok).toBe(false);
    expect(failingClient.current.message).toContain("暂时不可用");
  });

  it("退出失败时不谎报已退出", async () => {
    const { fetch } = createFetchStub((call) =>
      call.url.endsWith("/api/auth/logout")
        ? jsonResponse({ error: "server_error" }, 500)
        : jsonResponse({ authenticated: true }),
    );
    const client = new AuthSessionClient({ fetch });
    await client.refresh();
    const result = await client.logout();
    expect(result.ok).toBe(false);
    expect(client.current.status).toBe("authenticated");
    expect(client.current.message).toContain("仍可能处于登录状态");
  });

  it("离线时区分“暂不可确认”，不发起登录或假装退出", async () => {
    const { fetch, calls } = createFetchStub(() => jsonResponse({ authenticated: true }));
    const client = new AuthSessionClient({ fetch, isOnline: () => false });

    await client.refresh();
    expect(client.current.status).toBe("unavailable");

    const login = await client.login();
    expect(login.ok).toBe(false);
    const logout = await client.logout();
    expect(logout.ok).toBe(false);
    expect(client.current.message).toContain("服务端会话状态未改变");
    expect(calls).toHaveLength(0);
  });

  it("会话读取失败归为暂不可确认，不影响本地使用", async () => {
    const { fetch } = createFetchStub(() => {
      throw new TypeError("network down");
    });
    const client = new AuthSessionClient({ fetch });
    await client.refresh();
    expect(client.current.status).toBe("unavailable");
    expect(client.current.message).toContain("本机记录与草稿不受影响");
  });
});
