// 同源 Worker 的 API 路由。所有 /api 与 /api/* 请求（含页面导航）都由本模块处理，
// 不回落到 SPA 首页；非 API 请求由静态资产承载（cloudflare.config.ts 的
// assets.runWorkerFirst 保证本 Worker 只收到 /api 与 /api/*）。
// 登录接口见 auth/routes.ts；API 响应统一 no-store（http.ts）。

import { handleAuthRequest } from "./auth/routes";
import type { AuthEnvironment, AuthHandlerDependencies } from "./auth/routes";
import { jsonResponse } from "./http";

/** 健康检查路径。 */
export const HEALTH_CHECK_PATH = "/api/health";

/** 健康检查支持的请求方法。 */
const HEALTH_CHECK_ALLOWED_METHODS = ["GET", "HEAD"] as const;

/** 认证接口命名空间；具体端点由 auth/routes.ts 分发。 */
const AUTH_NAMESPACE_PREFIX = "/api/auth";

/** 判断路径是否属于 API 命名空间：裸 /api 与 /api/*。 */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function healthResponse(requestMethod: string): Response {
  if (requestMethod === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return jsonResponse({ status: "ok" }, 200);
}

/**
 * 处理 API 请求。仅依据请求的 pathname 与 method 分流；
 * 不读取 Host、Origin 等请求头来推导任何配置值。
 */
export async function handleApiRequest(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthHandlerDependencies = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === HEALTH_CHECK_PATH) {
    if ((HEALTH_CHECK_ALLOWED_METHODS as readonly string[]).includes(request.method)) {
      return healthResponse(request.method);
    }
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      Allow: HEALTH_CHECK_ALLOWED_METHODS.join(", "),
    });
  }
  if (pathname === AUTH_NAMESPACE_PREFIX || pathname.startsWith(`${AUTH_NAMESPACE_PREFIX}/`)) {
    return handleAuthRequest(request, env, dependencies);
  }
  // 其余未知 API 路径一律返回 JSON 404，不回落首页。
  return jsonResponse({ error: "not_found" }, 404);
}
