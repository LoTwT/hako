// HTTP 合同唯一实现；账号标识只是副本匹配条件，授权始终由服务端会话决定。
export const SYNC_PATH = "/api/sync/refueling";
export const SYNC_PROTOCOL = "1";
export const SYNC_CONTENT_TYPE = "application/octet-stream";
export const MAX_SYNC_BYTES = 4 * 1024 * 1024;

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** 不依赖 Content-Length；浏览器与 Worker 对流逐块限额。 */
export async function readSyncBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) throw new Error("empty_body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_SYNC_BYTES) throw new Error("document_too_large");
      chunks.push(next.value);
    }
    if (length === 0) throw new Error("empty_body");
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
