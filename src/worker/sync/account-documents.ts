import { LoroDoc } from "loro-crdt/web";
import { exportSyncSnapshot, importSyncSnapshot } from "../../data/sync-document";
import type { AccountStateRow, AccountStateStorage, HakoIdentity } from "../auth/account-state";

interface AccountIdRow extends AccountStateRow { account_id: string }
interface SnapshotChunkRow extends AccountStateRow { snapshot: ArrayBuffer }
const CHUNK_BYTES = 512 * 1024;

/** 合并结果；preMergeSnapshot 仅在启用基线需要时物化，避免每次同步复制整包。 */
export interface MergeOutcome {
  snapshot: Uint8Array;
  /** 合并前后 OpLog 版本向量是否推进（有已存储文档时才计算）。 */
  historyAdvanced: boolean;
  /** 本次是否首次持久保存服务端文档（空客户端快照也会创建）。 */
  documentCreated: boolean;
  preMergeSnapshot: Uint8Array | null;
}

/** 与既有会话同库、独立表；不迁移或删除登录事务/会话。 */
export class AccountDocuments {
  constructor(private readonly storage: AccountStateStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS account_data_ids (
      issuer TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (issuer, subject))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS refueling_snapshots (
      account_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, snapshot BLOB NOT NULL,
      PRIMARY KEY (account_id, chunk_index))`);
  }

  /** 仅在调用方刚验证有效会话后使用；随机 ID 不派生自真实 subject。 */
  resolveAccountId(identity: HakoIdentity): string {
    const existing = this.storage.sql.exec<AccountIdRow>(
      "SELECT account_id FROM account_data_ids WHERE issuer = ? AND subject = ?",
      identity.issuer, identity.subject,
    ).toArray()[0];
    if (existing) return existing.account_id;
    const accountId = crypto.randomUUID();
    this.storage.sql.exec("INSERT INTO account_data_ids VALUES (?, ?, ?)", identity.issuer, identity.subject, accountId);
    return accountId;
  }

  /** 只读身份映射查询；无映射时不创建，供只读状态接口使用。 */
  findAccountId(identity: HakoIdentity): string | null {
    return this.storage.sql.exec<AccountIdRow>(
      "SELECT account_id FROM account_data_ids WHERE issuer = ? AND subject = ?",
      identity.issuer, identity.subject,
    ).toArray()[0]?.account_id ?? null;
  }

  hasSnapshot(accountId: string): boolean {
    return this.storage.sql.exec<AccountStateRow>(
      "SELECT account_id FROM refueling_snapshots WHERE account_id = ? LIMIT 1",
      accountId,
    ).toArray().length > 0;
  }

  readSnapshotBytes(accountId: string): Uint8Array | null {
    const chunks = this.readSnapshotChunks(accountId);
    if (chunks === null) return null;
    return joinChunks(chunks);
  }

  /**
   * 同步段内读取、合并和切换所有分块。本方法不拥有事务边界：
   * 授权→合并→待备责任→续期由 AccountSync 的外层事务统一提交或回滚；
   * 不把失败候选留在实例内存。
   */
  merge(accountId: string, incoming: Uint8Array, options?: { capturePreMergeSnapshot?: boolean }): MergeOutcome {
    const candidate = new LoroDoc();
    const remote = new LoroDoc();
    try {
      // 独立校验提交的完整副本，不能靠现有文档掩盖缺依赖/非法记录。
      importSyncSnapshot(remote, incoming);
      const chunks = this.readSnapshotChunks(accountId);
      const documentExisted = chunks !== null;
      const preMergeSnapshot = options?.capturePreMergeSnapshot && documentExisted ? joinChunks(chunks) : null;
      if (documentExisted) importSyncSnapshot(candidate, joinChunks(chunks));
      const previous = candidate.version();
      try {
        importSyncSnapshot(candidate, incoming);
        const merged = exportSyncSnapshot(candidate);
        const version = candidate.version();
        try {
          const historyAdvanced = documentExisted && version.compare(previous) !== 0;
          if (!documentExisted || historyAdvanced) {
            this.storage.sql.exec("DELETE FROM refueling_snapshots WHERE account_id = ?", accountId);
            for (let offset = 0; offset < merged.byteLength; offset += CHUNK_BYTES) {
              this.storage.sql.exec("INSERT INTO refueling_snapshots VALUES (?, ?, ?)",
                accountId, offset / CHUNK_BYTES, merged.slice(offset, offset + CHUNK_BYTES).buffer);
            }
          }
          return { snapshot: merged, historyAdvanced, documentCreated: !documentExisted, preMergeSnapshot };
        } finally { version.free(); }
      } finally { previous.free(); }
    } finally {
      remote.free();
      candidate.free();
    }
  }

  private readSnapshotChunks(accountId: string): Uint8Array[] | null {
    const rows = this.storage.sql.exec<SnapshotChunkRow>(
      "SELECT snapshot FROM refueling_snapshots WHERE account_id = ? ORDER BY chunk_index", accountId,
    ).toArray();
    if (rows.length === 0) return null;
    return rows.map((row) => new Uint8Array(row.snapshot));
  }
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
