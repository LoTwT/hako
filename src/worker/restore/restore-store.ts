// 恢复回执的持久状态层：只保存成功切换回执，与切换同事务提交（B 实现）；
// A 只读取与查重。不存业务字段或凭据；回执长期保留，不随备份 30 份裁剪。

import type { AccountStateRow, AccountStateStorage } from "../auth/account-state";
import type { BackupReference } from "../../shared/document-generation";
import type { RestoreReceipt } from "../../shared/restore-protocol";

interface ReceiptRow extends AccountStateRow {
  account_id: string;
  request_id: string;
  request_fingerprint: string;
  previous_generation: string;
  new_generation: string;
  previous_revision: number;
  new_revision: number;
  source_backup: string;
  protection_backup: string;
  baseline_pending: number;
  committed_at_ms: number;
}

/** 回执写入的完整输入；B 的切换事务在 storage.sync() 前调用。 */
export interface RestoreReceiptInput {
  accountId: string;
  requestId: string;
  requestFingerprint: string;
  previousGeneration: string;
  newGeneration: string;
  previousRevision: number;
  newRevision: number;
  sourceBackup: BackupReference;
  protectionBackup: BackupReference;
  baselinePending: boolean;
  committedAtMs: number;
}

/** 构造函数只做幂等建表；A 的恢复端点不写任何回执状态。 */
export class RestoreStore {
  private readonly sql: AccountStateStorage["sql"];

  constructor(storage: AccountStateStorage) {
    this.sql = storage.sql;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS refueling_restore_receipts (
      account_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      previous_generation TEXT NOT NULL,
      new_generation TEXT NOT NULL,
      previous_revision INTEGER NOT NULL,
      new_revision INTEGER NOT NULL,
      source_backup TEXT NOT NULL,
      protection_backup TEXT NOT NULL,
      baseline_pending INTEGER NOT NULL,
      committed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (account_id, request_id)
    )`);
  }

  /** 插入成功回执；同 (accountId, requestId) 已存在时抛错，由调用方先查重保证幂等。 */
  insertReceipt(input: RestoreReceiptInput): void {
    this.sql.exec(
      `INSERT INTO refueling_restore_receipts
         (account_id, request_id, request_fingerprint, previous_generation, new_generation,
          previous_revision, new_revision, source_backup, protection_backup,
          baseline_pending, committed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.accountId,
      input.requestId,
      input.requestFingerprint,
      input.previousGeneration,
      input.newGeneration,
      input.previousRevision,
      input.newRevision,
      serializeBackupReference(input.sourceBackup),
      serializeBackupReference(input.protectionBackup),
      input.baselinePending ? 1 : 0,
      input.committedAtMs,
    );
  }

  findReceipt(accountId: string, requestId: string): RestoreReceipt | null {
    const row = this.sql.exec<ReceiptRow>(
      "SELECT * FROM refueling_restore_receipts WHERE account_id = ? AND request_id = ?",
      accountId, requestId,
    ).toArray()[0];
    if (row === undefined) return null;
    let sourceBackup: BackupReference;
    let protectionBackup: BackupReference;
    try {
      sourceBackup = JSON.parse(row.source_backup) as BackupReference;
      protectionBackup = JSON.parse(row.protection_backup) as BackupReference;
    } catch {
      // 回执行损坏属于不可解释状态：按不存在处理并保留原行，不猜测内容。
      return null;
    }
    return {
      requestId: row.request_id,
      requestFingerprint: row.request_fingerprint,
      previousGeneration: row.previous_generation,
      newGeneration: row.new_generation,
      previousRevision: row.previous_revision,
      newRevision: row.new_revision,
      sourceBackup,
      protectionBackup,
      baselinePending: row.baseline_pending !== 0,
      committedAtMs: row.committed_at_ms,
    };
  }
}

function serializeBackupReference(reference: BackupReference): string {
  return JSON.stringify({
    backupStreamId: reference.backupStreamId,
    revision: reference.revision,
    bundleSha256: reference.bundleSha256,
  });
}
