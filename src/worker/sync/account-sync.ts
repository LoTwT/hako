import { InvalidSyncDocument } from "../../data/sync-document";
import type { AccountDurableStorage, HakoAccountState } from "../auth/account-state";
import type { ReadHakoSessionInput, SyncRefuelingInput, SyncRefuelingResult } from "../auth/account-rpc";
import type { BootstrapRefuelingInput, BootstrapRefuelingResult, ReadRefuelingSnapshotInput, ReadRefuelingSnapshotResult } from "../auth/account-rpc";
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_TTL_MS } from "../auth/session-policy";
import type { BackupEngine } from "../backup/backup-engine";
import { AccountDocuments, GenerationStateUnavailableError } from "./account-documents";

/**
 * DO 的同步段：授权、代次检查、合并、待备责任与续期在外层 storage.transaction 内执行，
 * SQL 与 alarm 安排共同提交或回滚；类型错误先让外层事务完整回滚，再映射为既有失败响应。
 * 提交后由运行时包装等待 storage.sync()，协议 2 的持久确认语义不变。
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

  /**
   * 幂等 bootstrap：短事务内重验会话、解析账号并执行受控代次初始化。
   * 会话/账号复核、head 插入与 legacy 分块标签绑定在同一显式可回滚事务内：
   * 任一 SQL 失败（如绑定触发器中止）时 head 与映射一起回滚，不留下半完成状态；
   * 异常在事务回滚后才映射为失败结果。不接受业务快照、不执行恢复、不等待 R2、
   * 不续期；并发调用复用已提交的同一个 G0。
   */
  async bootstrap(input: BootstrapRefuelingInput): Promise<BootstrapRefuelingResult> {
    try {
      return await this.storage.transaction(async () => this.runBootstrap(input));
    } catch (error) {
      if (error instanceof GenerationStateUnavailableError) return { ok: false, error: "generation_state_unavailable" };
      throw error;
    }
  }

  private runBootstrap(input: BootstrapRefuelingInput): BootstrapRefuelingResult {
    const accountId = this.readAccountId(input);
    if (accountId === null) return { ok: false, error: "unauthorized" };
    if (accountId !== input.expectedAccountId) return { ok: false, error: "account_changed" };
    const head = this.documents.ensureDocumentGeneration(accountId, input.nowMs);
    return {
      ok: true,
      accountId,
      documentGeneration: head.currentGeneration,
      legacyGeneration: head.legacyGeneration,
      origin: head.origin,
      snapshotAvailable: this.documents.hasSnapshot(accountId),
      // A 不提供恢复切换；B 部署后改为 true，不新增运行时开关。
      restoreWritesAvailable: false,
    };
  }

  /**
   * 只读当前快照：重验会话但不续期、不创建映射、不初始化任何状态。
   * 没有主文档时返回 snapshot=null（HTTP 204），bootstrap 的代次信息仍有效。
   */
  readSnapshot(input: ReadRefuelingSnapshotInput): ReadRefuelingSnapshotResult {
    try {
      if (this.sessions.readSession(input) === null) return { ok: false, error: "unauthorized" };
      const accountId = this.documents.findAccountId(input.identity);
      if (accountId === null || accountId !== input.expectedAccountId) {
        return { ok: false, error: "account_changed" };
      }
      const head = this.documents.readDocumentHead(accountId);
      if (head === null) return { ok: false, error: "generation_state_unavailable" };
      return {
        ok: true,
        accountId,
        documentGeneration: head.currentGeneration,
        revision: this.backups.currentRevision(accountId),
        snapshot: this.documents.readSnapshotBytesForGeneration(accountId, head.currentGeneration),
      };
    } catch (error) {
      if (error instanceof GenerationStateUnavailableError) return { ok: false, error: "generation_state_unavailable" };
      throw error;
    }
  }

  async exchange(input: SyncRefuelingInput): Promise<SyncRefuelingResult> {
    try {
      return await this.storage.transaction(async () => this.runExchange(input));
    } catch (error) {
      // 外层事务已完整回滚（包括本段内已写的任何状态），这里只做既有失败映射。
      if (error instanceof InvalidSyncDocument) return { ok: false, error: "invalid_document" };
      if (error instanceof GenerationStateUnavailableError) return { ok: false, error: "generation_state_unavailable" };
      if (error instanceof Error && error.message === "document_too_large") return { ok: false, error: "document_too_large" };
      throw error;
    }
  }

  private async runExchange(input: SyncRefuelingInput): Promise<SyncRefuelingResult> {
    const accountId = this.readAccountId(input);
    if (accountId === null) return { ok: false, error: "unauthorized" };
    if (accountId !== input.expectedAccountId) return { ok: false, error: "account_changed" };
    // 受控且幂等：合法旧代次/缺 head 在同一事务内判定，不把缺失元数据当新账号。
    const head = this.documents.ensureDocumentGeneration(accountId, input.nowMs);
    if (head.currentGeneration !== input.documentGeneration) {
      // 合法但非当前代次：拒绝合并并附当前代次元数据，不附业务快照。
      return {
        ok: false,
        error: "document_generation_changed",
        currentGeneration: head.currentGeneration,
        legacyGeneration: head.legacyGeneration,
        revision: this.backups.currentRevision(accountId),
      };
    }
    // 启用前已有文档时，需要携带合并前快照在同一提交冻结为基线。
    const needsPreMergeSnapshot = this.backups.needsPreMergeSnapshotForEnablement(accountId);
    const outcome = this.documents.merge(accountId, head.currentGeneration, input.snapshot, { capturePreMergeSnapshot: needsPreMergeSnapshot });
    await this.backups.onSuccessfulMerge(accountId, {
      historyAdvanced: outcome.historyAdvanced,
      documentCreated: outcome.documentCreated,
      preMergeSnapshot: outcome.preMergeSnapshot,
      mergedSnapshot: outcome.snapshot,
    }, input.nowMs);
    this.sessions.renewSessionIfDue({
      ...input, sessionTtlMs: SESSION_TTL_MS, renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    return {
      ok: true,
      accountId,
      documentGeneration: head.currentGeneration,
      revision: this.backups.currentRevision(accountId),
      snapshot: outcome.snapshot,
    };
  }
}
