// 恢复预览的持久状态层（恢复设计 §4.2）：每账号最多一个 preview，随机 previewId、
// 选中备份引用、预期当前版本、目标 manifest 原字节与按 512 KiB 分块的暂存快照。
// 与 preview 同事务替换或删除；构造只做幂等建表。previewId 仅由服务端生成，
// 已删除、替换或消费的 ID 永不重新创建（消费即删除行；新预览总是新随机 UUID）。

import type { AccountStateRow, AccountStateStorage } from "../auth/account-state";

const CHUNK_BYTES = 512 * 1024;

interface PreviewRow extends AccountStateRow {
  account_id: string;
  preview_id: string;
  backup_stream_id: string;
  revision: number;
  bundle_sha256: string;
  target_snapshot_sha256: string;
  target_history_sha256: string;
  target_record_count: number;
  target_captured_at_ms: number | null;
  target_manifest_json: string;
  expected_generation: string;
  expected_revision: number;
  expected_snapshot_sha256: string;
  expected_history_sha256: string;
  created_at_ms: number;
  expires_at_ms: number;
}

/** 已验证并暂存的恢复预览；读取后调用方自行核对过期与替换条件。 */
export interface StoredRestorePreview {
  accountId: string;
  previewId: string;
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
  targetSnapshotSha256: string;
  targetHistorySha256: string;
  targetRecordCount: number;
  targetCapturedAtMs: number | null;
  targetManifestJson: string;
  expectedGeneration: string;
  expectedRevision: number;
  expectedSnapshotSha256: string;
  expectedHistorySha256: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** 新预览的完整输入；由恢复服务在完成 R2 验证后于同一事务写入。 */
export interface RestorePreviewInput {
  accountId: string;
  previewId: string;
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
  targetSnapshotSha256: string;
  targetHistorySha256: string;
  targetRecordCount: number;
  targetCapturedAtMs: number | null;
  targetManifestJson: string;
  expectedGeneration: string;
  expectedRevision: number;
  expectedSnapshotSha256: string;
  expectedHistorySha256: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** 已验证的目标原始快照；按 512 KiB 分块暂存，上限 4 MiB 由调用方验证保证。 */
  targetSnapshot: Uint8Array;
}

export class RestorePreviewStore {
  private readonly sql: AccountStateStorage["sql"];

  constructor(storage: AccountStateStorage) {
    this.sql = storage.sql;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS refueling_restore_previews (
      account_id TEXT PRIMARY KEY,
      preview_id TEXT NOT NULL,
      backup_stream_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      bundle_sha256 TEXT NOT NULL,
      target_snapshot_sha256 TEXT NOT NULL,
      target_history_sha256 TEXT NOT NULL,
      target_record_count INTEGER NOT NULL,
      target_captured_at_ms INTEGER,
      target_manifest_json TEXT NOT NULL,
      expected_generation TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      expected_snapshot_sha256 TEXT NOT NULL,
      expected_history_sha256 TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS refueling_restore_preview_chunks (
      account_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk BLOB NOT NULL,
      PRIMARY KEY (account_id, chunk_index)
    )`);
  }

  /** 当前预览；无预览返回 null。行残缺（空串 manifest 等）视为状态不可解释并抛错。 */
  get(accountId: string): StoredRestorePreview | null {
    const row = this.sql.exec<PreviewRow>(
      "SELECT * FROM refueling_restore_previews WHERE account_id = ?",
      accountId,
    ).toArray()[0];
    if (row === undefined) return null;
    if (typeof row.target_manifest_json !== "string" || row.target_manifest_json === "") {
      throw new Error("restore_preview_row_unreadable");
    }
    return {
      accountId: row.account_id,
      previewId: row.preview_id,
      backupStreamId: row.backup_stream_id,
      revision: row.revision,
      bundleSha256: row.bundle_sha256,
      targetSnapshotSha256: row.target_snapshot_sha256,
      targetHistorySha256: row.target_history_sha256,
      targetRecordCount: row.target_record_count,
      targetCapturedAtMs: row.target_captured_at_ms,
      targetManifestJson: row.target_manifest_json,
      expectedGeneration: row.expected_generation,
      expectedRevision: row.expected_revision,
      expectedSnapshotSha256: row.expected_snapshot_sha256,
      expectedHistorySha256: row.expected_history_sha256,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
    };
  }

  /**
   * 原子替换预览：无条件覆盖本账号的既有未消费预览并重写暂存分块。
   * 迟到覆盖防护由调用方在事务内先核对「开始时的 previewId」；本层不做版本比较。
   */
  replace(input: RestorePreviewInput): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO refueling_restore_previews
         (account_id, preview_id, backup_stream_id, revision, bundle_sha256,
          target_snapshot_sha256, target_history_sha256, target_record_count, target_captured_at_ms,
          target_manifest_json, expected_generation, expected_revision,
          expected_snapshot_sha256, expected_history_sha256, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.accountId,
      input.previewId,
      input.backupStreamId,
      input.revision,
      input.bundleSha256,
      input.targetSnapshotSha256,
      input.targetHistorySha256,
      input.targetRecordCount,
      input.targetCapturedAtMs,
      input.targetManifestJson,
      input.expectedGeneration,
      input.expectedRevision,
      input.expectedSnapshotSha256,
      input.expectedHistorySha256,
      input.createdAtMs,
      input.expiresAtMs,
    );
    this.sql.exec("DELETE FROM refueling_restore_preview_chunks WHERE account_id = ?", input.accountId);
    for (let offset = 0; offset < input.targetSnapshot.byteLength; offset += CHUNK_BYTES) {
      this.sql.exec(
        "INSERT INTO refueling_restore_preview_chunks VALUES (?, ?, ?)",
        input.accountId,
        Math.floor(offset / CHUNK_BYTES),
        input.targetSnapshot.slice(offset, offset + CHUNK_BYTES).buffer,
      );
    }
  }

  /** 删除本账号预览与暂存（消费、取消或过期裁决）；与调用方事务同提交或回滚。 */
  delete(accountId: string): void {
    this.sql.exec("DELETE FROM refueling_restore_previews WHERE account_id = ?", accountId);
    this.sql.exec("DELETE FROM refueling_restore_preview_chunks WHERE account_id = ?", accountId);
  }

  /** 读取暂存的目标原始快照；无预览返回 null。 */
  readSnapshot(accountId: string): Uint8Array | null {
    const rows = this.sql.exec<AccountStateRow & { chunk: ArrayBuffer }>(
      "SELECT chunk FROM refueling_restore_preview_chunks WHERE account_id = ? ORDER BY chunk_index",
      accountId,
    ).toArray();
    if (rows.length === 0) return null;
    const parts = rows.map((row) => new Uint8Array(row.chunk));
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }
}
