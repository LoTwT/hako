// 独立备份的持久状态层：与既有会话同库、独立表的增量建表与全部读写。
// 本层只做 SQL，不拥有事务边界，也不做任何 R2 I/O；事务边界由引擎与同步段维护。
// 表结构按账号（account_id）隔离；同一 DO 中的不同账号互不可见对方的备份状态。
//
// 代次兼容基础（A）的增量：
// - 冻结任务在捕获时固定源代次、格式版本与代次来源；升级前已冻结的旧任务
//   这些字段为 NULL，按 legacy 来源生成 v1，不能在重试时改贴新标签。
// - 完成缓存保存对应代次信息、捕获时间、reason 与快照哈希；旧缓存缺失的
//   展示字段保持 NULL，不猜测、不为展示改写旧对象。
// - 游标记录最新完成版本的有效源代次：覆盖判断要求代次与历史摘要都匹配，
//   v1 完成按固定 legacyGeneration 解释（读取侧合成，不改写旧行）。

import type {
  AccountStateRow,
  AccountStateSqlStorage,
  AccountStateStorage,
} from "../auth/account-state";
import {
  parseGenerationOrigin,
  serializeGenerationOrigin,
  type GenerationOrigin,
} from "../../shared/document-generation";
import type { BackupCaptureReason } from "./backup-format";

const CHUNK_BYTES = 512 * 1024;

export interface BackupCursorState {
  accountId: string;
  streamId: string;
  createdAtMs: number;
  /** 服务端历史序号；仅在提交成功的同步事务内递增。 */
  currentRevision: number;
  /** 当前 revision 对应源版本的持久提交时间；启用前基线没有已知时间。 */
  lastCommitAtMs: number | null;
  latestCompletedRevision: number | null;
  latestCompletedHistorySha256: string | null;
  /** 最新完成版本的有效源代次；v1 完成行保持 NULL（读取侧按 legacy 绑定解释）。 */
  latestCompletedGeneration: string | null;
  pendingRevision: number | null;
  pendingFirstRevision: number | null;
  pendingFirstAtMs: number | null;
  windowDueAtMs: number | null;
  cleanupAttemptCount: number;
  cleanupNextAttemptAtMs: number | null;
  blockedError: string | null;
  /**
   * 有界失败下限（持久）：无法持久化新重试责任时的最早 alarm 时间。
   * 跨引擎重建仍约束重排，防止过期旧责任被重设成过去/立即 alarm。
   */
  retryFloorAtMs: number | null;
}

export interface FrozenBackupTask {
  accountId: string;
  streamId: string;
  revision: number;
  reason: BackupCaptureReason;
  capturedAtMs: number;
  sourceCommittedAtMs: number | null;
  previousCompletedRevision: number | null;
  firstPendingRevision: number | null;
  /** 捕获时固定的源代次；NULL 表示升级前冻结的 legacy 任务（按 v1 完成）。 */
  sourceGeneration: string | null;
  /** 捕获时固定的包格式版本；NULL 表示 legacy 任务（生成 v1）。 */
  formatVersion: number | null;
  /** 捕获时固定的代次来源；NULL 表示 legacy 任务。 */
  generationOrigin: GenerationOrigin | null;
  /** null 表示尚未完成哈希与 manifest 固化（captured 阶段）。 */
  manifestJson: string | null;
  bundleSha256: string | null;
  snapshotSha256: string | null;
  snapshotBytes: number | null;
  historySha256: string | null;
  recordCount: number | null;
  bundleKey: string | null;
  markerKey: string | null;
  attemptCount: number;
  nextAttemptAtMs: number | null;
}

export interface BackupCompletionRecord {
  accountId: string;
  revision: number;
  streamId: string;
  bundleKey: string;
  bundleBytes: number;
  bundleSha256: string;
  historySha256: string;
  recordCount: number;
  completedAtMs: number;
  /** 任务携带的源代次；NULL 为 v1 完成行（按 legacy 绑定解释，不改写旧行）。 */
  sourceGeneration: string | null;
  /** 任务携带的包格式版本；NULL 为旧缓存行（展示时保持未知，不猜测）。 */
  formatVersion: number | null;
  /** 任务携带的代次来源；NULL 为旧缓存行。 */
  generationOrigin: GenerationOrigin | null;
  /** 任务捕获时间；旧缓存行缺失时保持 NULL。 */
  capturedAtMs: number | null;
  /** 任务 reason；旧缓存行缺失时保持 NULL。 */
  reason: BackupCaptureReason | null;
  /** 快照 SHA-256；旧缓存行缺失时保持 NULL。 */
  snapshotSha256: string | null;
}

export interface BackupPrunePlanEntry {
  accountId: string;
  revision: number;
  bundleKey: string;
  markerKey: string;
  markerDeleted: boolean;
}

export interface BackupRetentionResponsibility {
  accountId: string;
  pendingRevision: number;
  registeredAtMs: number;
}

interface CursorRow extends AccountStateRow {
  account_id: string;
  stream_id: string;
  created_at: number;
  current_revision: number;
  last_commit_at: number | null;
  latest_completed_revision: number | null;
  latest_completed_history_sha256: string | null;
  latest_completed_generation: string | null;
  pending_revision: number | null;
  pending_first_revision: number | null;
  pending_first_at: number | null;
  window_due_at: number | null;
  cleanup_attempt_count: number;
  cleanup_next_attempt_at: number | null;
  blocked_error: string | null;
  retry_floor_at: number | null;
}

interface TaskRow extends AccountStateRow {
  account_id: string;
  stream_id: string;
  revision: number;
  reason: string;
  captured_at: number;
  source_committed_at: number | null;
  previous_completed_revision: number | null;
  first_pending_revision: number | null;
  source_generation: string | null;
  format_version: number | null;
  generation_origin: string | null;
  manifest_json: string | null;
  bundle_sha256: string | null;
  snapshot_sha256: string | null;
  snapshot_bytes: number | null;
  history_sha256: string | null;
  record_count: number | null;
  bundle_key: string | null;
  marker_key: string | null;
  attempt_count: number;
  next_attempt_at: number | null;
}

interface CompletionRow extends AccountStateRow {
  account_id: string;
  revision: number;
  stream_id: string;
  bundle_key: string;
  bundle_bytes: number;
  bundle_sha256: string;
  history_sha256: string;
  record_count: number;
  completed_at: number;
  source_generation: string | null;
  format_version: number | null;
  generation_origin: string | null;
  captured_at: number | null;
  reason: string | null;
  snapshot_sha256: string | null;
}

interface PrunePlanRow extends AccountStateRow {
  account_id: string;
  revision: number;
  bundle_key: string;
  marker_key: string;
  marker_deleted: number;
}

interface RetentionRow extends AccountStateRow {
  account_id: string;
  pending_revision: number;
  registered_at: number;
}

/** 构造函数只做幂等建表；只读状态请求不初始化或修复任何任务。 */
export class BackupStore {
  readonly sql: AccountStateSqlStorage;

  constructor(storage: AccountStateStorage) {
    this.sql = storage.sql;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_cursor (
      account_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      current_revision INTEGER NOT NULL,
      last_commit_at INTEGER,
      latest_completed_revision INTEGER,
      latest_completed_history_sha256 TEXT,
      latest_completed_generation TEXT,
      pending_revision INTEGER,
      pending_first_revision INTEGER,
      pending_first_at INTEGER,
      window_due_at INTEGER,
      cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
      cleanup_next_attempt_at INTEGER,
      blocked_error TEXT,
      retry_floor_at INTEGER
    )`);
    ensureColumn(storage, "backup_cursor", "latest_completed_generation", "TEXT");
    ensureColumn(storage, "backup_cursor", "retry_floor_at", "INTEGER");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_frozen_task (
      account_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      reason TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      source_committed_at INTEGER,
      previous_completed_revision INTEGER,
      first_pending_revision INTEGER,
      source_generation TEXT,
      format_version INTEGER,
      generation_origin TEXT,
      manifest_json TEXT,
      bundle_sha256 TEXT,
      snapshot_sha256 TEXT,
      snapshot_bytes INTEGER,
      history_sha256 TEXT,
      record_count INTEGER,
      bundle_key TEXT,
      marker_key TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER
    )`);
    ensureColumn(storage, "backup_frozen_task", "source_generation", "TEXT");
    ensureColumn(storage, "backup_frozen_task", "format_version", "INTEGER");
    ensureColumn(storage, "backup_frozen_task", "generation_origin", "TEXT");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_frozen_task_chunks (
      account_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk BLOB NOT NULL,
      PRIMARY KEY (account_id, chunk_index)
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_completions (
      account_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      stream_id TEXT NOT NULL,
      bundle_key TEXT NOT NULL,
      bundle_bytes INTEGER NOT NULL,
      bundle_sha256 TEXT NOT NULL,
      history_sha256 TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      source_generation TEXT,
      format_version INTEGER,
      generation_origin TEXT,
      captured_at INTEGER,
      reason TEXT,
      snapshot_sha256 TEXT,
      PRIMARY KEY (account_id, revision)
    )`);
    ensureColumn(storage, "backup_completions", "source_generation", "TEXT");
    ensureColumn(storage, "backup_completions", "format_version", "INTEGER");
    ensureColumn(storage, "backup_completions", "generation_origin", "TEXT");
    ensureColumn(storage, "backup_completions", "captured_at", "INTEGER");
    ensureColumn(storage, "backup_completions", "reason", "TEXT");
    ensureColumn(storage, "backup_completions", "snapshot_sha256", "TEXT");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_retention_check (
      account_id TEXT PRIMARY KEY,
      pending_revision INTEGER NOT NULL,
      registered_at INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS backup_prune_plan (
      account_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      bundle_key TEXT NOT NULL,
      marker_key TEXT NOT NULL,
      marker_deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, revision)
    )`);
  }

  listAccountIds(): string[] {
    return this.sql.exec<CursorRow & AccountStateRow>("SELECT account_id FROM backup_cursor")
      .toArray().map((row) => row.account_id);
  }

  /**
   * 本 DO 当前可达的账号：仅以身份映射（account_data_ids）为准。
   * 只有身份映射能解释「同一 DO 的其他账号」（多身份合法共存）；仅有备份
   * 游标而无映射的账号是映射丢失后的孤儿状态，其 R2 前缀对新序列不可解释。
   */
  listKnownAccountIds(): Set<string> {
    const known = new Set<string>();
    for (const row of this.sql.exec<AccountStateRow & { account_id: string }>(
      "SELECT account_id FROM account_data_ids",
    ).toArray()) {
      known.add(row.account_id);
    }
    return known;
  }

  getCursor(accountId: string): BackupCursorState | null {
    const row = this.sql.exec<CursorRow>(
      "SELECT * FROM backup_cursor WHERE account_id = ?", accountId,
    ).toArray()[0];
    if (row === undefined) return null;
    return {
      accountId: row.account_id,
      streamId: row.stream_id,
      createdAtMs: row.created_at,
      currentRevision: row.current_revision,
      lastCommitAtMs: row.last_commit_at,
      latestCompletedRevision: row.latest_completed_revision,
      latestCompletedHistorySha256: row.latest_completed_history_sha256,
      latestCompletedGeneration: row.latest_completed_generation,
      pendingRevision: row.pending_revision,
      pendingFirstRevision: row.pending_first_revision,
      pendingFirstAtMs: row.pending_first_at,
      windowDueAtMs: row.window_due_at,
      cleanupAttemptCount: row.cleanup_attempt_count,
      cleanupNextAttemptAtMs: row.cleanup_next_attempt_at,
      blockedError: row.blocked_error,
      retryFloorAtMs: row.retry_floor_at,
    };
  }

  /** 首次启用：创建 stream 游标。调用方保证外层事务。 */
  createCursor(state: {
    accountId: string;
    streamId: string;
    createdAtMs: number;
    currentRevision: number;
    lastCommitAtMs: number | null;
    pendingRevision: number | null;
    pendingFirstRevision: number | null;
    pendingFirstAtMs: number | null;
    windowDueAtMs: number | null;
  }): void {
    this.sql.exec(
      `INSERT INTO backup_cursor
         (account_id, stream_id, created_at, current_revision, last_commit_at,
          latest_completed_revision, latest_completed_history_sha256, latest_completed_generation,
          pending_revision, pending_first_revision, pending_first_at, window_due_at,
          cleanup_attempt_count, cleanup_next_attempt_at, blocked_error)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 0, NULL, NULL)`,
      state.accountId,
      state.streamId,
      state.createdAtMs,
      state.currentRevision,
      state.lastCommitAtMs,
      state.pendingRevision,
      state.pendingFirstRevision,
      state.pendingFirstAtMs,
      state.windowDueAtMs,
    );
  }

  /** 历史推进：递增 revision，更新待备责任；窗口锚定在首次未覆盖变化。 */
  advanceCursorForHistory(accountId: string, newRevision: number, committedAtMs: number, pending: {
    revision: number;
    firstRevision: number;
    firstAtMs: number;
    dueAtMs: number;
  }): void {
    this.sql.exec(
      `UPDATE backup_cursor SET
         current_revision = ?, last_commit_at = ?,
         pending_revision = ?, pending_first_revision = ?, pending_first_at = ?, window_due_at = ?
       WHERE account_id = ?`,
      newRevision,
      committedAtMs,
      pending.revision,
      pending.firstRevision,
      pending.firstAtMs,
      pending.dueAtMs,
      accountId,
    );
  }

  /**
   * 恢复切换的 revision 递增：占用一个新 revision（即使选中快照的历史向量更小），
   * 不开启待备窗口——该 revision 由切换事务冻结的恢复基线任务承担；后续普通编辑
   * 另外登记待备责任。调用方保证同一事务内已核对无待备区间。
   */
  advanceRevisionForRestore(accountId: string, newRevision: number, committedAtMs: number): void {
    this.sql.exec(
      `UPDATE backup_cursor SET
         current_revision = ?, last_commit_at = ?,
         pending_revision = NULL, pending_first_revision = NULL, pending_first_at = NULL, window_due_at = NULL,
         retry_floor_at = NULL
       WHERE account_id = ?`,
      newRevision,
      committedAtMs,
      accountId,
    );
  }

  clearPendingIfCovered(accountId: string, coveredThroughRevision: number): void {
    this.sql.exec(
      `UPDATE backup_cursor SET pending_revision = NULL, pending_first_revision = NULL,
         pending_first_at = NULL, window_due_at = NULL
       WHERE account_id = ? AND pending_revision IS NOT NULL AND pending_revision <= ?`,
      accountId,
      coveredThroughRevision,
    );
  }

  /** 完成确认：更新最新完成版本与有效源代次（v1 完成行传 null，读取侧按 legacy 绑定解释）。 */
  markCompleted(accountId: string, revision: number, historySha256: string, generation: string | null): void {
    this.sql.exec(
      `UPDATE backup_cursor SET latest_completed_revision = ?, latest_completed_history_sha256 = ?,
         latest_completed_generation = ?, retry_floor_at = NULL
       WHERE account_id = ?`,
      revision,
      historySha256,
      generation,
      accountId,
    );
  }

  registerRetention(accountId: string, pendingRevision: number, registeredAtMs: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO backup_retention_check VALUES (?, ?, ?)",
      accountId,
      pendingRevision,
      registeredAtMs,
    );
  }

  getRetention(accountId: string): BackupRetentionResponsibility | null {
    const row = this.sql.exec<RetentionRow>(
      "SELECT * FROM backup_retention_check WHERE account_id = ?", accountId,
    ).toArray()[0];
    if (row === undefined) return null;
    return { accountId: row.account_id, pendingRevision: row.pending_revision, registeredAtMs: row.registered_at };
  }

  settleRetention(accountId: string): void {
    this.sql.exec("DELETE FROM backup_retention_check WHERE account_id = ?", accountId);
    this.clearRetryFloor(accountId);
  }

  recordCleanupAttempt(accountId: string, attemptCount: number, nextAttemptAtMs: number): void {
    this.sql.exec(
      "UPDATE backup_cursor SET cleanup_attempt_count = ?, cleanup_next_attempt_at = ?, retry_floor_at = NULL WHERE account_id = ?",
      attemptCount,
      nextAttemptAtMs,
      accountId,
    );
  }

  settleCleanupAttempts(accountId: string): void {
    this.sql.exec(
      "UPDATE backup_cursor SET cleanup_attempt_count = 0, cleanup_next_attempt_at = NULL, retry_floor_at = NULL WHERE account_id = ?",
      accountId,
    );
  }

  setBlocked(accountId: string, errorCode: string): void {
    this.sql.exec("UPDATE backup_cursor SET blocked_error = ? WHERE account_id = ?", errorCode, accountId);
  }

  /** 持久化有界失败下限：调用方自行包事务；失败由引擎兜底（内存下限）。 */
  setRetryFloor(accountId: string, floorAtMs: number): void {
    this.sql.exec("UPDATE backup_cursor SET retry_floor_at = ? WHERE account_id = ?", floorAtMs, accountId);
  }

  /** 进度写入（新的未来责任/完成/结清）即解除有界失败下限。 */
  clearRetryFloor(accountId: string): void {
    this.sql.exec("UPDATE backup_cursor SET retry_floor_at = NULL WHERE account_id = ?", accountId);
  }

  getTask(accountId: string): FrozenBackupTask | null {
    const row = this.sql.exec<TaskRow>(
      "SELECT * FROM backup_frozen_task WHERE account_id = ?", accountId,
    ).toArray()[0];
    if (row === undefined) return null;
    return {
      accountId: row.account_id,
      streamId: row.stream_id,
      revision: row.revision,
      reason: parseCaptureReason(row.reason),
      capturedAtMs: row.captured_at,
      sourceCommittedAtMs: row.source_committed_at,
      previousCompletedRevision: row.previous_completed_revision,
      firstPendingRevision: row.first_pending_revision,
      sourceGeneration: row.source_generation,
      formatVersion: row.format_version === 1 || row.format_version === 2 ? row.format_version : null,
      generationOrigin: row.generation_origin === null ? null : parseGenerationOrigin(safeJsonParse(row.generation_origin)),
      manifestJson: row.manifest_json,
      bundleSha256: row.bundle_sha256,
      snapshotSha256: row.snapshot_sha256,
      snapshotBytes: row.snapshot_bytes,
      historySha256: row.history_sha256,
      recordCount: row.record_count,
      bundleKey: row.bundle_key,
      markerKey: row.marker_key,
      attemptCount: row.attempt_count,
      nextAttemptAtMs: row.next_attempt_at,
    };
  }

  insertTask(task: {
    accountId: string;
    streamId: string;
    revision: number;
    reason: BackupCaptureReason;
    capturedAtMs: number;
    sourceCommittedAtMs: number | null;
    previousCompletedRevision: number | null;
    firstPendingRevision: number | null;
    /** 捕获时固定的源代次/格式/来源；legacy 任务（升级前冻结）传 null。 */
    sourceGeneration: string | null;
    formatVersion: number | null;
    generationOrigin: GenerationOrigin | null;
  }): void {
    this.sql.exec(
      `INSERT INTO backup_frozen_task
         (account_id, stream_id, revision, reason, captured_at, source_committed_at,
          previous_completed_revision, first_pending_revision,
          source_generation, format_version, generation_origin,
          manifest_json, bundle_sha256, snapshot_sha256, snapshot_bytes,
          history_sha256, record_count, bundle_key, marker_key,
          attempt_count, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`,
      task.accountId,
      task.streamId,
      task.revision,
      task.reason,
      task.capturedAtMs,
      task.sourceCommittedAtMs,
      task.previousCompletedRevision,
      task.firstPendingRevision,
      task.sourceGeneration,
      task.formatVersion,
      task.generationOrigin === null ? null : serializeGenerationOrigin(task.generationOrigin),
    );
  }

  /**
   * 恢复基线任务在切换事务内创建后的首次发布时间（恢复设计 §7.3）：初始化
   * attemptCount = 0、nextAttemptAt = switchedAt + 窗口时间；切换时待备区间为空，
   * 该 revision 由冻结任务承担，后续普通编辑另外登记待备责任。
   */
  scheduleRestoreBaselineTask(accountId: string, firstAttemptAtMs: number): void {
    this.sql.exec(
      "UPDATE backup_frozen_task SET next_attempt_at = ? WHERE account_id = ? AND attempt_count = 0",
      firstAttemptAtMs,
      accountId,
    );
  }

  markTaskPrepared(accountId: string, prepared: {
    manifestJson: string;
    bundleSha256: string;
    snapshotSha256: string;
    snapshotBytes: number;
    historySha256: string;
    recordCount: number;
    bundleKey: string;
    markerKey: string;
    attemptCount: number;
    nextAttemptAtMs: number;
  }): void {
    this.sql.exec(
      `UPDATE backup_frozen_task SET
         manifest_json = ?, bundle_sha256 = ?, snapshot_sha256 = ?, snapshot_bytes = ?,
         history_sha256 = ?, record_count = ?, bundle_key = ?, marker_key = ?,
         attempt_count = ?, next_attempt_at = ?
       WHERE account_id = ? AND manifest_json IS NULL`,
      prepared.manifestJson,
      prepared.bundleSha256,
      prepared.snapshotSha256,
      prepared.snapshotBytes,
      prepared.historySha256,
      prepared.recordCount,
      prepared.bundleKey,
      prepared.markerKey,
      prepared.attemptCount,
      prepared.nextAttemptAtMs,
      accountId,
    );
    this.clearRetryFloor(accountId);
  }

  recordTaskAttempt(accountId: string, attemptCount: number, nextAttemptAtMs: number): void {
    this.sql.exec(
      "UPDATE backup_frozen_task SET attempt_count = ?, next_attempt_at = ? WHERE account_id = ?",
      attemptCount,
      nextAttemptAtMs,
      accountId,
    );
    this.clearRetryFloor(accountId);
  }

  deleteTask(accountId: string): void {
    this.sql.exec("DELETE FROM backup_frozen_task WHERE account_id = ?", accountId);
    this.sql.exec("DELETE FROM backup_frozen_task_chunks WHERE account_id = ?", accountId);
  }

  /** 捕获事务内把当前主快照按块复制为冻结字节；不做 JS 层整包拼接。 */
  copyMainSnapshotIntoTask(accountId: string): void {
    this.sql.exec(
      `INSERT INTO backup_frozen_task_chunks (account_id, chunk_index, chunk)
       SELECT ?, chunk_index, snapshot FROM refueling_snapshots WHERE account_id = ?`,
      accountId,
      accountId,
    );
  }

  /** 启用基线：把合并前的既有快照字节写入冻结任务。 */
  writeTaskChunksFromBytes(accountId: string, snapshot: Uint8Array): void {
    for (let offset = 0; offset < snapshot.byteLength; offset += CHUNK_BYTES) {
      this.sql.exec(
        "INSERT INTO backup_frozen_task_chunks VALUES (?, ?, ?)",
        accountId,
        Math.floor(offset / CHUNK_BYTES),
        snapshot.slice(offset, offset + CHUNK_BYTES).buffer,
      );
    }
  }

  readTaskSnapshot(accountId: string): Uint8Array | null {
    return readChunkedSnapshot(this.sql, "backup_frozen_task_chunks", accountId);
  }

  taskSnapshotBytes(accountId: string): number {
    const row = this.sql.exec<AccountStateRow & { total: number | null }>(
      "SELECT SUM(LENGTH(chunk)) AS total FROM backup_frozen_task_chunks WHERE account_id = ?",
      accountId,
    ).toArray()[0];
    return row?.total ?? 0;
  }

  upsertCompletion(record: BackupCompletionRecord): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO backup_completions
         (account_id, revision, stream_id, bundle_key, bundle_bytes, bundle_sha256,
          history_sha256, record_count, completed_at,
          source_generation, format_version, generation_origin, captured_at, reason, snapshot_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.accountId,
      record.revision,
      record.streamId,
      record.bundleKey,
      record.bundleBytes,
      record.bundleSha256,
      record.historySha256,
      record.recordCount,
      record.completedAtMs,
      record.sourceGeneration,
      record.formatVersion,
      record.generationOrigin === null ? null : serializeGenerationOrigin(record.generationOrigin),
      record.capturedAtMs,
      record.reason,
      record.snapshotSha256,
    );
  }

  listCompletions(accountId: string): BackupCompletionRecord[] {
    return this.sql.exec<CompletionRow>(
      "SELECT * FROM backup_completions WHERE account_id = ? ORDER BY revision DESC",
      accountId,
    ).toArray().map(mapCompletionRow);
  }

  getCompletion(accountId: string, revision: number): BackupCompletionRecord | null {
    const row = this.sql.exec<CompletionRow>(
      "SELECT * FROM backup_completions WHERE account_id = ? AND revision = ?",
      accountId, revision,
    ).toArray()[0];
    if (row === undefined) return null;
    return mapCompletionRow(row);
  }

  deleteCompletion(accountId: string, revision: number): void {
    this.sql.exec(
      "DELETE FROM backup_completions WHERE account_id = ? AND revision = ?",
      accountId,
      revision,
    );
  }

  insertPrunePlanEntry(entry: BackupPrunePlanEntry): void {
    this.sql.exec(
      "INSERT INTO backup_prune_plan VALUES (?, ?, ?, ?, ?)",
      entry.accountId,
      entry.revision,
      entry.bundleKey,
      entry.markerKey,
      entry.markerDeleted ? 1 : 0,
    );
  }

  listPrunePlan(accountId: string): BackupPrunePlanEntry[] {
    return this.sql.exec<PrunePlanRow>(
      "SELECT * FROM backup_prune_plan WHERE account_id = ? ORDER BY revision ASC",
      accountId,
    ).toArray().map((row) => ({
      accountId: row.account_id,
      revision: row.revision,
      bundleKey: row.bundle_key,
      markerKey: row.marker_key,
      markerDeleted: row.marker_deleted !== 0,
    }));
  }

  markPruneMarkerDeleted(accountId: string, revision: number): void {
    this.sql.exec(
      "UPDATE backup_prune_plan SET marker_deleted = 1 WHERE account_id = ? AND revision = ?",
      accountId,
      revision,
    );
  }

  deletePrunePlanEntry(accountId: string, revision: number): void {
    this.sql.exec(
      "DELETE FROM backup_prune_plan WHERE account_id = ? AND revision = ?",
      accountId,
      revision,
    );
  }
}

function mapCompletionRow(row: CompletionRow): BackupCompletionRecord {
  return {
    accountId: row.account_id,
    revision: row.revision,
    streamId: row.stream_id,
    bundleKey: row.bundle_key,
    bundleBytes: row.bundle_bytes,
    bundleSha256: row.bundle_sha256,
    historySha256: row.history_sha256,
    recordCount: row.record_count,
    completedAtMs: row.completed_at,
    sourceGeneration: row.source_generation,
    formatVersion: row.format_version,
    generationOrigin: row.generation_origin === null ? null : parseGenerationOrigin(safeJsonParse(row.generation_origin)),
    capturedAtMs: row.captured_at,
    reason: row.reason === null ? null : parseCaptureReason(row.reason),
    snapshotSha256: row.snapshot_sha256,
  };
}

function parseCaptureReason(reason: string): BackupCaptureReason {
  if (reason === "baseline" || reason === "history-change" || reason === "restore-baseline") return reason;
  return "history-change";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readChunkedSnapshot(
  sql: AccountStateSqlStorage,
  table: "backup_frozen_task_chunks" | "refueling_snapshots",
  accountId: string,
): Uint8Array | null {
  const rows = sql.exec<AccountStateRow & { chunk: ArrayBuffer }>(
    `SELECT chunk FROM ${table} WHERE account_id = ? ORDER BY chunk_index`,
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

/** 幂等补列：既有库升级新列（与 auth/account-state 的迁移方式一致）。 */
function ensureColumn(storage: AccountStateStorage, table: string, column: string, definition: string): void {
  const columns = storage.sql.exec<AccountStateRow & { name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (columns.some((entry) => entry.name === column)) return;
  storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
