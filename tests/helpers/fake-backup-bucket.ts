// 单元测试用合成 R2 桶：实现 BackupObjectBucket 的结构子集并模拟
// Workers R2 绑定的实际返回合同（条件创建返回 null、强一致读写、分页 list）。
// 支持按调用注入可重试故障、篡改在库对象与调用计数；不含任何真实网络 I/O。

import { createHash } from "node:crypto";
import type { BackupObjectBucket, BackupObjectBodyLike } from "../../src/worker/backup/backup-object-store";

interface StoredObject {
  bytes: Uint8Array;
}

export interface BucketFaultPlan {
  /**
   * put 故障：throw=请求失败未写入；throw_after_write=写入已生效但响应丢失，
   * 之后按同一精确 key 读回能核验到刚写入的内容。
   */
  put?: "throw" | "throw_after_write";
  get?: "throw";
  list?: "throw";
  delete?: "throw";
}

/** 故障条件：match 为 key 精确值或以 prefix: 开头的前缀；count 限制触发次数，skip 先放行的次数。 */
export interface BucketFault {
  match: string;
  count?: number;
  /** 匹配的前 skip 次调用不触发故障（用于命中生命周期中的第 N 次调用）。 */
  skip?: number;
  plan: BucketFaultPlan;
}

export class FakeBackupBucket implements BackupObjectBucket {
  private readonly objects = new Map<string, StoredObject>();
  private readonly faults: (BucketFault & { count: number; skipped: number })[] = [];
  readonly counters = { put: 0, get: 0, list: 0, listPages: 0, delete: 0, conditionalPutNull: 0 };

  constructor(private readonly listPageSize = 1000) {}

  addFault(fault: BucketFault): void {
    this.faults.push({ ...fault, count: fault.count ?? 1, skipped: 0 });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  storedKeys(): string[] {
    return [...this.objects.keys()].sort();
  }

  storedBytes(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }

  /** 直接篡改在库对象内容，模拟外部损坏。 */
  corruptObject(key: string, mutate: (bytes: Uint8Array) => Uint8Array): void {
    const stored = this.objects.get(key);
    if (stored === undefined) throw new Error(`fake_bucket_object_missing: ${key}`);
    stored.bytes = mutate(stored.bytes);
  }

  async put(
    key: string,
    value: Uint8Array,
    options: { onlyIf: { etagDoesNotMatch: "*" }; sha256: string },
  ): Promise<object | null> {
    this.counters.put += 1;
    this.consumeFault(key, "put", value);
    // 与真实 R2 一致：上传校验和不匹配时写入失败并抛错。
    if (sha256Hex(value) !== options.sha256) throw new Error("r2_checksum_mismatch");
    if (this.objects.has(key)) {
      this.counters.conditionalPutNull += 1;
      return null;
    }
    this.objects.set(key, { bytes: new Uint8Array(value) });
    return { key };
  }

  async get(key: string): Promise<BackupObjectBodyLike | null> {
    this.counters.get += 1;
    this.consumeFault(key, "get");
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    const bytes = new Uint8Array(stored.bytes);
    return { size: bytes.byteLength, bytes: async () => bytes };
  }

  async list(options: { prefix: string; cursor?: string }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }> {
    this.counters.list += 1;
    this.consumeFault(options.prefix, "list");
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const startIndex = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    const endIndex = Math.min(startIndex + this.listPageSize, keys.length);
    const page = keys.slice(startIndex, endIndex).map((key) => ({ key }));
    if (endIndex >= keys.length) return { objects: page, truncated: false };
    this.counters.listPages += 1;
    return { objects: page, truncated: true, cursor: String(endIndex) };
  }

  async delete(key: string): Promise<void> {
    this.counters.delete += 1;
    this.consumeFault(key, "delete");
    this.objects.delete(key);
  }

  private consumeFault(key: string, operation: keyof BucketFaultPlan, putValue?: Uint8Array): void {
    for (const fault of this.faults) {
      if (fault.plan[operation] === undefined) continue;
      const matches = fault.match.startsWith("prefix:")
        ? key.startsWith(fault.match.slice("prefix:".length))
        : key === fault.match;
      if (!matches || fault.count <= 0) continue;
      if (fault.skip !== undefined && fault.skipped < fault.skip) {
        fault.skipped += 1;
        continue;
      }
      fault.count -= 1;
      const mode = fault.plan[operation];
      if (operation === "put" && mode === "throw_after_write" && putValue !== undefined) {
        this.objects.set(key, { bytes: new Uint8Array(putValue) });
      }
      throw new Error(`r2_${operation}_injected_failure`);
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
