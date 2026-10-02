import { describe, expect, it } from "vitest";
import { handleApiRequest, isApiPath } from "../src/worker/api";
import type { AuthEnvironment } from "../src/worker/auth/routes";

const WEB_ORIGIN = "https://hako.eruoo.me";

function testEnvironment(): AuthEnvironment {
  return {
    HAKO_LOGIN: {
      origin: WEB_ORIGIN,
      issuer: "https://auth.eruoo.me",
      clientId: "hako-web",
      resource: "https://auth.eruoo.me/api",
    },
    HAKO_OWNER_SUBJECT: "synthetic-owner-subject",
    HAKO_ACCOUNT: {
      getByName: () => {
        throw new Error("该用例不应访问账号状态");
      },
    },
  };
}

describe("isApiPath", () => {
  it.each([
    ["/api", true],
    ["/api/", true],
    ["/api/health", true],
    ["/api/auth/callback", true],
    ["/api/deep/nested/path", true],
    ["/", false],
    ["/apifoo", false],
    ["/apifoo/health", false],
    ["/favicon.ico", false],
  ])("%s → %s", (pathname, expected) => {
    expect(isApiPath(pathname)).toBe(expected);
  });
});

describe("handleApiRequest /api/health", () => {
  it("GET 返回简单健康状态", async () => {
    const response = await handleApiRequest(
      new Request(`${WEB_ORIGIN}/api/health`),
      testEnvironment(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("HEAD 返回同样头部且无响应体", async () => {
    const response = await handleApiRequest(
      new Request(`${WEB_ORIGIN}/api/health`, { method: "HEAD" }),
      testEnvironment(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s 返回 405 与 Allow", async (method) => {
    const response = await handleApiRequest(
      new Request(`${WEB_ORIGIN}/api/health`, { method }),
      testEnvironment(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });
});

describe("handleApiRequest 未知 API 路径", () => {
  it.each([
    `${WEB_ORIGIN}/api`,
    `${WEB_ORIGIN}/api/`,
    `${WEB_ORIGIN}/api/unknown`,
    `${WEB_ORIGIN}/api/auth/complete`,
    `${WEB_ORIGIN}/api/auth/unknown`,
  ])("%s 返回 JSON 404", async (url) => {
    const response = await handleApiRequest(new Request(url), testEnvironment());
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "not_found" });
    // API 未知路径不得回退到首页：响应必须是 JSON 错误，不是 HTML 页面。
    expect(body).not.toMatch(/<(!doctype|html)/i);
  });

  it("未知 API 路径对任意 HTTP 方法都返回 JSON 404", async () => {
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      const response = await handleApiRequest(
        new Request(`${WEB_ORIGIN}/api/unknown`, { method }),
        testEnvironment(),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("认证端点的 API 边界", () => {
  it.each([
    [`${WEB_ORIGIN}/api/auth/login`, "GET", "POST"],
    [`${WEB_ORIGIN}/api/auth/logout`, "GET", "POST"],
    [`${WEB_ORIGIN}/api/auth/session`, "POST", "GET"],
    [`${WEB_ORIGIN}/api/auth/callback`, "POST", "GET"],
  ])("%s 的 %s 返回 405 与 Allow: %s", async (url, method, allow) => {
    const response = await handleApiRequest(
      new Request(url, { method }),
      testEnvironment(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(allow);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });

  it("缺少事务 Cookie 的回调安全失败且不回退首页", async () => {
    const response = await handleApiRequest(
      new Request(`${WEB_ORIGIN}/api/auth/callback?code=x&state=y`),
      testEnvironment(),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).toContain('data-hako-callback-status="invalid_login_transaction"');
    // 结果页只允许一个固定同源返回入口，不加载脚本或第三方资源
    expect(body).toContain('<a href="/">返回 Hako</a>');
    expect(body.match(/href=/g)).toHaveLength(1);
    expect(body).not.toMatch(/<script|src=|url\(|@import/i);
  });

  it("无 Cookie 的会话读取返回未认证", async () => {
    const response = await handleApiRequest(
      new Request(`${WEB_ORIGIN}/api/auth/session`),
      testEnvironment(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ authenticated: false });
  });

  it("无 Cookie 的会话读取不访问账号状态、不写 Cookie", async () => {
    let storageCalls = 0;
    const environment = testEnvironment();
    const response = await handleApiRequest(
      new Request(`${WEB_ORIGIN}/api/auth/session`),
      {
        ...environment,
        HAKO_ACCOUNT: {
          getByName: () => {
            storageCalls += 1;
            throw new Error("缺少会话 Cookie 时不应访问账号状态");
          },
        },
      },
    );
    expect(response.status).toBe(200);
    expect(storageCalls).toBe(0);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.json()).toEqual({ authenticated: false });
  });
});

describe("API 分流不依赖请求头", () => {
  it("任意 Host 的 /api 请求行为一致，配置不从请求推导", async () => {
    const formal = await handleApiRequest(new Request(`${WEB_ORIGIN}/api/health`), testEnvironment());
    const forged = await handleApiRequest(
      new Request("https://attacker.example/api/health"),
      testEnvironment(),
    );
    expect(formal.status).toBe(200);
    expect(forged.status).toBe(200);
    expect(await formal.json()).toEqual(await forged.json());

    const formalCallback = await handleApiRequest(
      new Request(`${WEB_ORIGIN}/api/auth/callback`),
      testEnvironment(),
    );
    const forgedCallback = await handleApiRequest(
      new Request("https://attacker.example/api/auth/callback"),
      testEnvironment(),
    );
    expect(formalCallback.status).toBe(400);
    expect(forgedCallback.status).toBe(400);
    expect(formalCallback.headers.get("Content-Type")).toContain("text/html");
    expect(forgedCallback.headers.get("Content-Type")).toContain("text/html");
  });
});
