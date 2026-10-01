// 同源 Worker 的 API 路由。所有 /api 与 /api/* 请求（含页面导航）都由本模块处理，
// 不回落到 SPA 首页；非 API 请求由静态资产承载（cloudflare.config.ts 的
// assets.runWorkerFirst 保证本 Worker 只收到 /api 与 /api/*）。

/** API 响应统一不进入任何缓存。 */
const API_CACHE_CONTROL = "no-store";

/** 健康检查路径。 */
export const HEALTH_CHECK_PATH = "/api/health";

/** 健康检查支持的请求方法。 */
const HEALTH_CHECK_ALLOWED_METHODS = ["GET", "HEAD"] as const;

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": API_CACHE_CONTROL,
      ...headers,
    },
  });
}

/** 判断路径是否属于 API 命名空间：裸 /api 与 /api/*。 */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function healthResponse(requestMethod: string): Response {
  if (requestMethod === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": API_CACHE_CONTROL,
      },
    });
  }
  return jsonResponse({ status: "ok" }, 200);
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405, {
    Allow: HEALTH_CHECK_ALLOWED_METHODS.join(", "),
  });
}

function apiNotFound(): Response {
  return jsonResponse({ error: "not_found" }, 404);
}

/**
 * 处理 API 请求。仅依据请求的 pathname 与 method 分流；
 * 不读取 Host、Origin 等请求头来推导任何配置值。
 */
export function handleApiRequest(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === HEALTH_CHECK_PATH) {
    if ((HEALTH_CHECK_ALLOWED_METHODS as readonly string[]).includes(request.method)) {
      return healthResponse(request.method);
    }
    return methodNotAllowed();
  }
  // PR1 不提供登录或会话接口；/api/auth/callback 等 API 未知路径一律返回 JSON 404。
  return apiNotFound();
}
