import { LoroDoc } from "loro-crdt/web";
import { exportSyncSnapshot, importSyncSnapshot } from "../../data/sync-document";
import type { AccountStateRow, AccountStateStorage, HakoIdentity } from "../auth/account-state";

interface AccountIdRow extends AccountStateRow { account_id: string }
interface SnapshotChunkRow extends AccountStateRow { snapshot: ArrayBuffer }
const CHUNK_BYTES = 512 * 1024;

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

  /** 同步段内读取、合并和切换所有分块；不把失败候选留在实例内存。 */
  merge(accountId: string, incoming: Uint8Array): Uint8Array {
    return this.storage.transactionSync(() => {
      const candidate = new LoroDoc();
      const remote = new LoroDoc();
      try {
        // 独立校验提交的完整副本，不能靠现有文档掩盖缺依赖/非法记录。
        importSyncSnapshot(remote, incoming);
        const chunks = this.storage.sql.exec<SnapshotChunkRow>(
          "SELECT snapshot FROM refueling_snapshots WHERE account_id = ? ORDER BY chunk_index", accountId,
        ).toArray();
        if (chunks.length) {
          const bytes = chunks.map((row) => new Uint8Array(row.snapshot));
          const stored = new Uint8Array(bytes.reduce((total, part) => total + part.byteLength, 0));
          let offset = 0;
          for (const part of bytes) { stored.set(part, offset); offset += part.byteLength; }
          importSyncSnapshot(candidate, stored);
        }
        const previous = candidate.version();
        try {
          importSyncSnapshot(candidate, incoming);
          const merged = exportSyncSnapshot(candidate);
          const version = candidate.version();
          try {
            if (!chunks.length || version.compare(previous) !== 0) {
              this.storage.sql.exec("DELETE FROM refueling_snapshots WHERE account_id = ?", accountId);
              for (let offset = 0; offset < merged.byteLength; offset += CHUNK_BYTES) {
                this.storage.sql.exec("INSERT INTO refueling_snapshots VALUES (?, ?, ?)",
                  accountId, offset / CHUNK_BYTES, merged.slice(offset, offset + CHUNK_BYTES).buffer);
              }
            }
          } finally { version.free(); }
          return merged;
        } finally { previous.free(); }
      } finally {
        remote.free();
        candidate.free();
      }
    });
  }
}
