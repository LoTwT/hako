import { describe, expect, it } from "vitest";
import { handleApiRequest, isApiPath } from "../src/worker/api";

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
    const response = handleApiRequest(new Request("https://hako.eruoo.me/api/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("HEAD 返回同样头部且无响应体", async () => {
    const response = handleApiRequest(new Request("https://hako.eruoo.me/api/health", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s 返回 405 与 Allow", async (method) => {
    const response = handleApiRequest(new Request("https://hako.eruoo.me/api/health", { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });
});

describe("handleApiRequest 未知 API 路径", () => {
  it.each([
    "https://hako.eruoo.me/api",
    "https://hako.eruoo.me/api/",
    "https://hako.eruoo.me/api/unknown",
    "https://hako.eruoo.me/api/auth/callback",
    "https://hako.eruoo.me/api/auth/callback?code=x&state=y",
  ])("%s 返回 JSON 404", async (url) => {
    const response = handleApiRequest(new Request(url));
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "not_found" });
    // 回调不得回退到首页：响应必须是 JSON 错误，不是 HTML 页面。
    expect(body).not.toMatch(/<(!doctype|html)/i);
  });

  it("未知 API 路径对任意 HTTP 方法都返回 JSON 404", () => {
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      const response = handleApiRequest(new Request("https://hako.eruoo.me/api/unknown", { method }));
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("API 分流不依赖请求头", () => {
  it("任意 Host 的 /api 请求行为一致，配置不从请求推导", async () => {
    const formal = handleApiRequest(new Request("https://hako.eruoo.me/api/health"));
    const forged = handleApiRequest(new Request("https://attacker.example/api/health"));
    expect(formal.status).toBe(200);
    expect(forged.status).toBe(200);
    expect(await formal.json()).toEqual(await forged.json());

    const formalCallback = handleApiRequest(new Request("https://hako.eruoo.me/api/auth/callback"));
    const forgedCallback = handleApiRequest(new Request("https://attacker.example/api/auth/callback"));
    expect(formalCallback.status).toBe(404);
    expect(forgedCallback.status).toBe(404);
    expect(formalCallback.headers.get("Content-Type")).toBe("application/json");
    expect(forgedCallback.headers.get("Content-Type")).toBe("application/json");
  });
});
