// 随机凭据生成与不可逆存储工具。
// 登录事务、会话凭据只以哈希形式进入服务端存储；解密或还原不是需求。

const SECRET_ENCODER = new TextEncoder();

/** 生成 base64url 编码的随机凭据（默认 32 字节，256 位熵）。 */
export function generateSecretToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** 生成短随机标识（环境标识用，仍不可猜测）。 */
export function generateEnvironmentId(): string {
  return generateSecretToken(16);
}

/** 服务端只保存凭据的 SHA-256 哈希（base64url），用于查找与比对。 */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", SECRET_ENCODER.encode(secret));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * 定长哈希的常数时间比较，避免通过响应时间区分前缀匹配程度。
 * 输入长度不同直接失败；长度本身不是秘密。
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = SECRET_ENCODER.encode(left);
  const rightBytes = SECRET_ENCODER.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index++) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
