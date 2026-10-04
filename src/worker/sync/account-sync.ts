import { InvalidSyncDocument } from "../../data/sync-document";
import type { AccountDurableStorage, HakoAccountState } from "../auth/account-state";
import type { ReadHakoSessionInput, SyncRefuelingInput, SyncRefuelingResult } from "../auth/account-rpc";
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_TTL_MS } from "../auth/session-policy";
import type { BackupEngine } from "../backup/backup-engine";
import { AccountDocuments } from "./account-documents";

/**
 * DO 的同步段：授权、合并、待备责任与续期在外层 storage.transaction 内执行，
 * SQL 与 alarm 安排共同提交或回滚；类型错误先让外层事务完整回滚，再映射为既有失败响应。
 * 提交后由运行时包装等待 storage.sync()，协议 1 的持久确认语义不变。
 */
export class AccountSync {
  constructor(
    private readonly storage: AccountDurableStorage,
    private readonly sessions: HakoAccountState,
    private readonly documents: AccountDocuments,
    private readonly backups: BackupEngine,
  ) {}

  readAccountId(input: ReadHakoSessionInput): string | null {
    if (this.sessions.readSession(input) === null) return null;
    return this.documents.resolveAccountId(input.identity);
  }

  /** 只读映射查询：无有效会话或映射时返回 null，不创建账号映射。 */
  findExistingAccountId(input: ReadHakoSessionInput): string | null {
    if (this.sessions.readSession(input) === null) return null;
    return this.documents.findAccountId(input.identity);
  }

  async exchange(input: SyncRefuelingInput): Promise<SyncRefuelingResult> {
    try {
      return await this.storage.transaction(async () => this.runExchange(input));
    } catch (error) {
      // 外层事务已完整回滚（包括本段内已写的任何状态），这里只做既有失败映射。
      if (error instanceof InvalidSyncDocument) return { ok: false, error: "invalid_document" };
      if (error instanceof Error && error.message === "document_too_large") return { ok: false, error: "document_too_large" };
      throw error;
    }
  }

  private async runExchange(input: SyncRefuelingInput): Promise<SyncRefuelingResult> {
    const accountId = this.readAccountId(input);
    if (accountId === null) return { ok: false, error: "unauthorized" };
    if (accountId !== input.expectedAccountId) return { ok: false, error: "account_changed" };
    // 启用前已有文档时，需要携带合并前快照在同一提交冻结为基线。
    const needsPreMergeSnapshot = this.backups.needsPreMergeSnapshotForEnablement(accountId);
    const outcome = this.documents.merge(accountId, input.snapshot, { capturePreMergeSnapshot: needsPreMergeSnapshot });
    await this.backups.onSuccessfulMerge(accountId, {
      historyAdvanced: outcome.historyAdvanced,
      documentCreated: outcome.documentCreated,
      preMergeSnapshot: outcome.preMergeSnapshot,
      mergedSnapshot: outcome.snapshot,
    }, input.nowMs);
    this.sessions.renewSessionIfDue({
      ...input, sessionTtlMs: SESSION_TTL_MS, renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    return { ok: true, accountId, snapshot: outcome.snapshot };
  }
}
