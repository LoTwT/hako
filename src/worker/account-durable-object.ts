// 账号级 SQLite Durable Object：持久保存登录事务、会话、账号文档、文档代次、
// 独立备份状态与恢复回执。SQL 与规则在 auth/account-state.ts、sync/、backup/ 和
// restore/ 中，实现与测试共用同一份逻辑；本类只负责把逻辑接到 Durable Object
// 运行时并按 RPC 合同暴露。

import { DurableObject } from "cloudflare:workers";
import { HakoAccountState } from "./auth/account-state";
import type {
  ConsumedLoginTransaction,
  ConsumeLoginTransactionInput,
  FinalizeLoginTransactionInput,
  HakoSessionRecord,
  LoginTransactionInput,
  RenewedHakoSession,
} from "./auth/account-state";
import type {
  BootstrapRefuelingInput,
  BootstrapRefuelingResult,
  CancelRestorePreviewResult,
  CreateRestorePreviewInput,
  CreateRestorePreviewResult,
  ListRefuelingBackupsInput,
  ListRefuelingBackupsResult,
  ReadBackupStatusResult,
  ReadHakoSessionInput,
  ReadRefuelingSnapshotInput,
  ReadRefuelingSnapshotResult,
  ReadRestorePreviewInput,
  ReadRestorePreviewSnapshotResult,
  ReadRestoreReceiptInput,
  ReadRestoreReceiptResult,
  RenewHakoSessionInput,
  RevokeHakoSessionInput,
  SubmitRestoreInput,
  SubmitRestoreResult,
  SyncRefuelingInput,
  SyncRefuelingResult,
} from "./auth/account-rpc";
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_TTL_MS } from "./auth/session-policy";
import { AccountSync } from "./sync/account-sync";
import { AccountDocuments, GenerationStateUnavailableError } from "./sync/account-documents";
import { initializeWorkerLoro } from "./sync/loro-runtime";
import { BackupEngine, type BackupSchedulePolicy } from "./backup/backup-engine";
import { PRODUCTION_BACKUP_SCHEDULE } from "./backup/backup-schedule";
import { BackupStore } from "./backup/backup-store";
import { R2BackupObjectStore } from "./backup/backup-object-store";
import { RestoreService } from "./restore/restore-service";
import { RestoreStore } from "./restore/restore-store";
import { RestorePreviewStore } from "./restore/restore-preview-store";

export class HakoAccountDurableObject extends DurableObject<Env> {
  private readonly accountState: HakoAccountState;
  private readonly accountSync: AccountSync;
  private readonly backupEngine: BackupEngine;
  private readonly restoreService: RestoreService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 构造只做幂等建表与补列；不依据 getAlarm()==null 初始化或修复任何任务，
    // 也不在只读请求里启动备份（运行中的 alarm 也可能读到 null）。
    this.accountState = new HakoAccountState(ctx.storage);
    const documents = new AccountDocuments(ctx.storage);
    const restoreStore = new RestoreStore(ctx.storage);
    const previewStore = new RestorePreviewStore(ctx.storage);
    this.backupEngine = new BackupEngine({
      storage: ctx.storage,
      objectStore: new R2BackupObjectStore(env.HAKO_BACKUPS),
      snapshotSource: documents,
      schedule: this.resolveBackupSchedule(),
      now: () => Date.now(),
      // 脱敏事件日志：只记 backupId、大小、耗时与错误码，不记快照、身份或 Cookie。
      log: (event) => console.info(JSON.stringify(event)),
    });
    this.accountSync = new AccountSync(ctx.storage, this.accountState, documents, this.backupEngine);
    this.restoreService = new RestoreService(
      ctx.storage,
      this.accountState,
      documents,
      restoreStore,
      previewStore,
      new BackupStore(ctx.storage),
      new R2BackupObjectStore(env.HAKO_BACKUPS),
      this.backupEngine,
      this.resolveBackupSchedule(),
      () => Date.now(),
    );
  }

  /** 生产固定节奏；仅隔离测试子类覆盖以加速，持久语义不变。 */
  protected resolveBackupSchedule(): BackupSchedulePolicy {
    return PRODUCTION_BACKUP_SCHEDULE;
  }

  /** 唯一 alarm：按优先级推进冻结任务 > 未收尾清理 > 窗口到期捕获。 */
  async alarm(): Promise<void> {
    initializeWorkerLoro();
    await this.backupEngine.onAlarm(Date.now());
    await this.ctx.storage.sync();
  }

  async createLoginTransaction(input: LoginTransactionInput): Promise<void> {
    this.accountState.createLoginTransaction(input);
  }

  async consumeLoginTransaction(
    input: ConsumeLoginTransactionInput,
  ): Promise<ConsumedLoginTransaction | null> {
    return this.accountState.consumeLoginTransaction(input);
  }

  async finalizeLoginTransaction(input: FinalizeLoginTransactionInput): Promise<boolean> {
    return this.accountState.finalizeLoginTransaction(input);
  }

  async revokeEnvironmentTransactions(environmentId: string): Promise<void> {
    this.accountState.revokeEnvironmentTransactions(environmentId);
  }

  async readSession(input: ReadHakoSessionInput): Promise<HakoSessionRecord | null> {
    return this.accountState.readSession(input);
  }

  async readAccountId(input: ReadHakoSessionInput): Promise<string | null> {
    const accountId = this.accountSync.readAccountId({ ...input, nowMs: Date.now() });
    await this.ctx.storage.sync();
    return accountId;
  }

  /** 幂等 bootstrap：短事务内初始化/读取代次；并发调用复用同一 G0。 */
  async bootstrapRefueling(input: BootstrapRefuelingInput): Promise<BootstrapRefuelingResult> {
    try {
      // bootstrap 为 async（事务在 Promise 内提交）：必须先等事务完成再
      // storage.sync，否则同步发生在提交之前，破坏「提交后等待 sync」的持久
      // 确认语义（与 syncRefueling 的顺序一致）。
      const result = await this.accountSync.bootstrap({ ...input, nowMs: Date.now() });
      await this.ctx.storage.sync();
      return result;
    } catch (error) {
      if (error instanceof GenerationStateUnavailableError) return { ok: false, error: "generation_state_unavailable" };
      throw error;
    }
  }

  /** 只读当前快照：重验会话、只查已有映射；不续期、不初始化、不上传。 */
  async readRefuelingSnapshot(input: ReadRefuelingSnapshotInput): Promise<ReadRefuelingSnapshotResult> {
    try {
      return this.accountSync.readSnapshot({ ...input, nowMs: Date.now() });
    } catch (error) {
      if (error instanceof GenerationStateUnavailableError) return { ok: false, error: "generation_state_unavailable" };
      throw error;
    }
  }

  async syncRefueling(input: SyncRefuelingInput): Promise<SyncRefuelingResult> {
    // RPC 到达时重验会话。授权、代次、合并、待备责任与续期在同一个 storage.transaction 内，
    // 相互之间不等待 R2 等外部 I/O；SQL 与 alarm 安排共同提交或回滚。
    initializeWorkerLoro();
    const result = await this.accountSync.exchange({ ...input, nowMs: Date.now() });
    await this.ctx.storage.sync();
    return result;
  }

  /**
   * B 的恢复提交（§7.3）：入口查重 → 事务外完整验证 → 唯一切换事务 → 失败出口
   * 短裁决。committed 与 not_committed 均在事务结束且 await storage.sync() 成功后
   * 返回；sync 失败进入只查回执的确认裁决，其持久确认也失败则 unknown。
   */
  async submitRestore(input: SubmitRestoreInput): Promise<SubmitRestoreResult> {
    // 提交路径要重新分析目标/当前快照（全新 Loro 导入）：冷启动进程同样必须就绪。
    initializeWorkerLoro();
    const result = await this.restoreService.submit(input);
    if (!result.ok || (result.outcome !== "committed" && result.outcome !== "not_committed")) return result;
    try {
      await this.ctx.storage.sync();
    } catch {
      // 持久确认失败：短裁决只重查回执（committed 优先）；无回执一律 unknown，
      // 不做预览删除或终态判定——原事务持久性未知，请求可能仍可执行。
      try {
        const adjudicated = await this.restoreService.adjudicateAfterSyncFailure(input);
        await this.ctx.storage.sync();
        return adjudicated;
      } catch {
        return { ok: true, outcome: "unknown" };
      }
    }
    return result;
  }

  /** 回执只读查询；不存在返回 receipt=null（HTTP 404）。 */
  async readRestoreReceipt(input: ReadRestoreReceiptInput): Promise<ReadRestoreReceiptResult> {
    return this.restoreService.read(input);
  }

  /** 已核对的备份列表：只读；不初始化、不续期、不进行 R2 写删。 */
  async listRefuelingBackups(input: ListRefuelingBackupsInput): Promise<ListRefuelingBackupsResult> {
    initializeWorkerLoro();
    return await this.restoreService.listBackups(input);
  }

  /** 创建固定预览：R2 验证在 DO 事务外；持久成功（storage.sync）后才返回 previewId。 */
  async createRestorePreview(input: CreateRestorePreviewInput): Promise<CreateRestorePreviewResult> {
    initializeWorkerLoro();
    const result = await this.restoreService.createPreview(input);
    if (result.ok) await this.ctx.storage.sync();
    return result;
  }

  /** 只读返回固定目标 snapshot 及其摘要；不消费、不续期。 */
  async readRestorePreviewSnapshot(input: ReadRestorePreviewInput): Promise<ReadRestorePreviewSnapshotResult> {
    initializeWorkerLoro();
    return this.restoreService.readPreviewSnapshot(input);
  }

  /** 取消预览：只删除仍匹配且未消费的本账号预览；持久确认后才返回。 */
  async cancelRestorePreview(input: ReadRestorePreviewInput): Promise<CancelRestorePreviewResult> {
    const result = await this.restoreService.cancelPreview(input);
    if (result.ok) await this.ctx.storage.sync();
    return result;
  }

  /** 只读备份状态：重验会话、只查已有映射；不续期、不写 Cookie、不初始化、不上传。 */
  async readBackupStatus(input: ReadHakoSessionInput): Promise<ReadBackupStatusResult> {
    initializeWorkerLoro();
    if (this.accountState.readSession(input) === null) {
      return { ok: false, error: "unauthorized" };
    }
    const accountId = this.accountSync.findExistingAccountId({ ...input, nowMs: Date.now() });
    return { ok: true, status: await this.backupEngine.readStatusSnapshot(accountId) };
  }

  async renewSessionIfDue(input: RenewHakoSessionInput): Promise<RenewedHakoSession | null> {
    // 期限规则集中在 auth/session-policy.ts；调用方只提供会话、身份与当前时间。
    return this.accountState.renewSessionIfDue({
      sessionHash: input.sessionHash,
      identity: input.identity,
      nowMs: input.nowMs,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
  }

  async revokeSession(input: RevokeHakoSessionInput): Promise<void> {
    this.accountState.revokeSession(input);
  }
}
