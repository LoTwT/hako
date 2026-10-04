// 独立备份对 R2 的唯一访问层：条件创建、有界读回与严格分页列表。
// 只依赖 Workers R2 绑定的实际返回合同：
// - 条件 `put` 在前置条件失败时返回 null 且不写入（不能当成功）；
// - `get` 返回带 body 的对象或 null；读取前先检查对象长度，不做无界缓冲；
// - `list` 严格按 truncated/cursor 翻页，不能按返回条数猜测是否结束；
// - `delete` 完成即强一致，失败抛错；结果未知时由调用方重查同一精确 key。
// ETag 不作为内容哈希使用，只用于“仅当不存在”条件。

import { MAX_BUNDLE_BYTES, MAX_MARKER_BYTES } from "./backup-format";

/** R2 绑定的结构子集；生产绑定与此结构兼容，测试用同形实现注入故障。 */
export interface BackupObjectBucket {
  put(
    key: string,
    value: Uint8Array,
    options: { onlyIf: { etagDoesNotMatch: "*" }; sha256: string },
  ): Promise<object | null>;
  get(key: string): Promise<BackupObjectBodyLike | null>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

export interface BackupObjectBodyLike {
  readonly size: number;
  bytes(): Promise<Uint8Array>;
}

/** 包与标记各自的读回上限由调用方传入；本层不做任何额外缓冲。 */
export class R2BackupObjectStore {
  constructor(private readonly bucket: BackupObjectBucket) {}

  /** 条件创建：true=已写入；false=对象已存在（前置条件失败，未覆盖）；I/O 失败抛错。 */
  async conditionalCreate(key: string, bytes: Uint8Array, sha256Hex: string): Promise<boolean> {
    const written = await this.bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: sha256Hex });
    return written !== null;
  }

  /** 有界读取：null=不存在；"too_large"=长度超限；否则返回完整字节。 */
  async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null | "too_large"> {
    const object = await this.bucket.get(key);
    if (object === null) return null;
    if (object.size > maxBytes) return "too_large";
    return await object.bytes();
  }

  async getBundle(key: string): Promise<Uint8Array | null | "too_large"> {
    return await this.getBounded(key, MAX_BUNDLE_BYTES);
  }

  async getMarker(key: string): Promise<Uint8Array | null | "too_large"> {
    return await this.getBounded(key, MAX_MARKER_BYTES);
  }

  /** 列出前缀下的全部对象 key；严格处理分页。 */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
      for (const object of page.objects) keys.push(object.key);
      if (!page.truncated) break;
      cursor = page.cursor;
      if (cursor === undefined) throw new Error("r2_list_missing_cursor");
    } while (cursor !== undefined);
    return keys;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
