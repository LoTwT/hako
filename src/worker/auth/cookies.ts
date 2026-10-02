// 登录事务与本应用会话的 Cookie 读写。
// 两种 Cookie 都是 Secure、HttpOnly、SameSite=Lax、Path=/，不设置 Domain；
// `__Host-` 前缀在浏览器侧强制同样的属性。Cookie 值本身是随机凭据，
// 服务端只保存其哈希。

import { LOGIN_TRANSACTION_COOKIE_NAME, SESSION_COOKIE_NAME } from "./session-policy";

/** 读取请求 Cookie 中的单个值；不存在或格式异常时返回 undefined。 */
export function readCookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export function readSessionCookie(request: Request): string | undefined {
  return readCookieValue(request, SESSION_COOKIE_NAME);
}

export function readLoginTransactionCookie(request: Request): string | undefined {
  return readCookieValue(request, LOGIN_TRANSACTION_COOKIE_NAME);
}

export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes(maxAgeSeconds)}`;
}

export function clearSessionCookie(): string {
  return serializeSessionCookie("", 0);
}

export function serializeLoginTransactionCookie(value: string, maxAgeSeconds: number): string {
  return `${LOGIN_TRANSACTION_COOKIE_NAME}=${value}; ${cookieAttributes(maxAgeSeconds)}`;
}

export function clearLoginTransactionCookie(): string {
  return serializeLoginTransactionCookie("", 0);
}

function cookieAttributes(maxAgeSeconds: number): string {
  return `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

/** 发起环境凭据的格式：环境标识 + 每次登录独立生成的事务凭据，都用 base64url 编码。 */
const LOGIN_COOKIE_PATTERN = /^([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]{20,128})$/;

export interface LoginTransactionCookieValue {
  environmentId: string;
  completionSecret: string;
}

export function parseLoginTransactionCookie(value: string | undefined): LoginTransactionCookieValue | null {
  if (value === undefined) return null;
  const match = LOGIN_COOKIE_PATTERN.exec(value);
  if (match === null) return null;
  return { environmentId: match[1], completionSecret: match[2] };
}

export function formatLoginTransactionCookieValue(value: LoginTransactionCookieValue): string {
  return `${value.environmentId}.${value.completionSecret}`;
}
