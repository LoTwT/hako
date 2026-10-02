// API 响应工具：/api 与 /api/* 的响应统一不进入任何缓存。

/** API 响应统一不进入任何缓存。 */
export const NO_STORE_CACHE_CONTROL = "no-store";

/** JSON 响应；headers 值为数组时按同名多值追加（如多个 Set-Cookie）。 */
export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string | string[]> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: buildHeaders({ "Content-Type": "application/json", ...headers }),
  });
}

/** 最小 HTML 响应；只由服务端生成静态文本，不包含请求内容。 */
export function htmlResponse(
  body: string,
  status: number,
  headers: Record<string, string | string[]> = {},
): Response {
  return new Response(body, {
    status,
    headers: buildHeaders({ "Content-Type": "text/html; charset=utf-8", ...headers }),
  });
}

function buildHeaders(input: Record<string, string | string[]>): Headers {
  const headers = new Headers({ "Cache-Control": NO_STORE_CACHE_CONTROL });
  for (const [name, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}
