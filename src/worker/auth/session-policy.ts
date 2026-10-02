// Hako 本应用会话与登录事务的时间参数。
// 协议与产品边界以 docs/specs/eruoo-login-integration.md 第 6.1、6.2 节为准：
// 这些天数是针对本人低频使用提出的建议值，不是浏览器保证，也不是安全标准推荐值；
// 采用文档建议作为本地实施参数，尚未完成产品/真机确认。集中定义以便可控时钟验证。

/** 登录事务有效期（规格建议 10 分钟）。 */
export const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;

/** 会话初次与续期有效期（规格建议 180 天）。 */
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** 续期频率：距上次成功续期至少 24 小时。 */
export const SESSION_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 自本次 OIDC 登录创建会话起的绝对有效期（规格建议 365 天）。 */
export const SESSION_ABSOLUTE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** 会话 Cookie：Secure、HttpOnly、SameSite=Lax、Path=/，不设置 Domain。
 * `__Host-` 前缀在浏览器侧强制同样的属性并避免同域其他主机写同名 Cookie。 */
export const SESSION_COOKIE_NAME = "__Host-hako_session";

/** 登录事务 Cookie：绑定发起登录的浏览器环境，仅在 10 分钟事务窗口内有效。 */
export const LOGIN_TRANSACTION_COOKIE_NAME = "__Host-hako_login";

/** 新会话的到期时间：当前时间加 180 天，同时不超过创建时间加 365 天。 */
export function resolveSessionExpiry(createdAtMs: number): {
  expiresAtMs: number;
  absoluteExpiresAtMs: number;
} {
  const absoluteExpiresAtMs = createdAtMs + SESSION_ABSOLUTE_TTL_MS;
  return {
    expiresAtMs: createdAtMs + SESSION_TTL_MS,
    absoluteExpiresAtMs,
  };
}
