// 独立备份引擎：最新待备游标 + 唯一冻结任务 + 单个 alarm 的生命周期状态机。
//
// 关键边界（备份合同 docs/specs/backup.md 的实现层）：
// - 同步事务内：历史推进时更新 revision 与待备责任，并安排必要 alarm；失败整体回滚。
// - 捕获事务：确认无冻结任务、无未收尾清理且窗口到期后，在同一短事务内复制主快照、
//   创建唯一冻结任务、清除其覆盖的待备责任并安排安全唤醒；随后才在事务外做哈希与 R2。
// - 每次 R2 尝试前：先持久递增尝试计数并安排安全重试，再做外部 I/O；新编辑不重置退避。
// - 确认事务：登记完成缓存、更新最新完成版本、释放冻结字节、登记「保留检查待完成」
//   责任并保留 alarm——即使尚未 LIST 或建立裁剪计划，重启后也必须先收尾再捕获下一版。
// - 每次 R2 生命周期（任务恢复、保留检查、裁剪重试）先核对 R2 最大已完成序号与归属；
//   恢复裁剪计划时同样核对完整应保留集合与完成缓存镜像，只有当前精确计划能解释的
//   待删标记缺失（含删除响应丢失）才可继续，其他缺失停止破坏性步骤。
// - 新序列启用检查覆盖同环境全部账号前缀：只有身份映射能解释「同一 DO 的其他
//   账号」；无映射的孤儿账号前缀（含仅映射丢失但游标仍在）不得把已有桶当空桶，
//   进入 ownership_conflict；已建立序列在任何新 PUT 之前核对完成标记镜像
//   （仅本任务自己的 revision 允许缺失）。
// - 覆盖核对有两个入口：空闲同步（对合并结果）与备份确认后（对当前主文档）——
//   部署回退窗口或冻结任务在途期间由旧代码写入的历史都会在成功同步/完成确认的
//   当下补登记为新的服务端 revision 并开启待备窗口，不依赖未来的前台访问；冻结
//   任务在途时以冻结历史为基准，登记不触碰冻结字节与重试计划。
// - 到期的重试/清理责任＝正当其时：alarm 设为当前时间并立即由处理器消费，普通
//   同步不得顺延到期重试；无法持久化新责任/blocked 的失败善后按有界失败下限兜底
//   （不早于下一档退避，且持久到 backup_cursor 跨引擎重建仍生效，进度写入即解除），
//   收尾调度不得覆盖成过去/立即 alarm 的循环。
// - 到期待备责任却无权威主文档 = 明确的 invalid_source_document：进入 blocked、
//   不虚构空基线、保留责任与已有备份；正常有效同步与其他账号不受影响。
// - 格式／归属／校验冲突进入 blocked：保留任务、旧备份与最新待备游标，停止自动 R2，
//   正常同步继续；任何调度自检不得解除 blocked。

import type { AccountDurableStorage } from "../auth/account-state";
import {
  BACKUP_DOCUMENT_TYPE,
  BACKUP_ENVIRONMENT,
  BACKUP_FORMAT_NAME,
  BACKUP_FORMAT_VERSION_V1,
  BACKUP_FORMAT_VERSION_V2,
  accountIdFromBackupKey,
  backupAccountsPrefix,
  bundleObjectKey,
  commitMarkerKey,
  accountDocumentPrefix,
  backupStreamPrefix,
  encodeBundle,
  parseCommitMarkerKey,
  serializeManifest,
  serializeMarker,
  sha256Hex,
  toIsoUtc,
  type BackupCaptureReason,
  type BackupCommitMarker,
  type BackupManifest,
  type BackupManifestV1,
  type BackupManifestV2,
} from "./backup-format";
import { R2BackupObjectStore } from "./backup-object-store";
import { backupRetryDelayMs, type BackupSchedulePolicy } from "./backup-schedule";
export type { BackupSchedulePolicy } from "./backup-schedule";
import { BackupStore, type BackupCompletionRecord, type BackupCursorState, type FrozenBackupTask } from "./backup-store";
import type { DocumentGenerationHead } from "../sync/account-documents";
import { GenerationStateUnavailableError } from "../sync/account-documents";
import {
  analyzeBackupSnapshot,
  buildCompletionMarker,
  verifyBundleReadBack,
  verifyMarkerContent,
  BackupVerificationError,
  type BackupBlockedCode,
} from "./backup-verify";

/**
 * 捕获时读取主文档快照与文档代次的来源；由账号文档层实现，与同步存储同库。
 * 捕获事务先调用 ensureDocumentGeneration（同一事务级初始化规则，与
 * bootstrap/同步一致）：head 缺失且状态不可解释时停止捕获进入 blocked。
 * snapshotGenerationExplainable 是捕获、同步/GET 与覆盖判断共享的分块来源
 * 核对：标签与 head 不一致或不可证明（非 legacy 边界的 NULL）时不发新对象。
 */
export interface BackupSnapshotSource {
  readSnapshotBytes(accountId: string): Uint8Array | null;
  hasSnapshot(accountId: string): boolean;
  ensureDocumentGeneration(accountId: string, nowMs: number): DocumentGenerationHead;
  readDocumentHead(accountId: string): DocumentGenerationHead | null;
  snapshotGenerationExplainable(accountId: string, expectedGeneration: string): boolean;
  /** 已持有 head 时只核对分块标签，避免重复读取 head。 */
  snapshotLabelsExplainable(accountId: string, expectedGeneration: string, head: DocumentGenerationHead): boolean;
}

export type BackupLogEvent = Record<string, string | number | boolean | null>;

export type BackupStatusState =
  | "uninitialized"
  | "pending"
  | "uploading"
  | "retrying"
  | "cleanup_pending"
  | "blocked"
  | "current_backed_up";

export interface BackupStatusSnapshot {
  initialized: boolean;
  state: BackupStatusState;
  currentRevision: number | null;
  /** 当前有效代次（head）；无 head 的未初始化账号为 null。 */
  currentGeneration: string | null;
  frozenTaskRevision: number | null;
  frozenTaskBytes: number | null;
  latestCompletedRevision: number | null;
  /** 最新完成版本的有效源代次；v1 完成按 legacy 绑定解释。 */
  latestCompletedGeneration: string | null;
  pendingFromRevision: number | null;
  pendingToRevision: number | null;
  pendingSinceMs: number | null;
  windowDueAtMs: number | null;
  nextAttemptAtMs: number | null;
  /**
   * 按责任优先级（冻结任务 > 未收尾清理 > 待备窗口）并由持久失败下限兜底的
   * 有效可行动时间（§7.2）：客户端展示「实际下次尝试」必须用该字段，不能用
   * 原始窗口时间自行推算。blocked（自动推进已停止）或无已登记责任时为 null。
   */
  nextActionAtMs: number | null;
  blockedError: string | null;
  cleanupPendingCount: number;
  currentBackedUp: boolean;
}

interface PreparedTaskFields {
  manifestJson: string;
  bundleSha256: string;
  snapshotSha256: string;
  snapshotBytes: number;
  historySha256: string;
  recordCount: number;
  bundleKey: string;
  markerKey: string;
}

interface TaskArtifacts {
  manifestJson: string;
  bundle: Uint8Array;
  bundleSha256: string;
  bundleKey: string;
  marker: BackupCommitMarker;
  markerBytes: Uint8Array;
  markerKey: string;
}

export class BackupEngine {
  private readonly store: BackupStore;
  private readonly storage: AccountDurableStorage;
  private readonly objectStore: R2BackupObjectStore;
  private readonly snapshotSource: BackupSnapshotSource;
  private readonly schedule: BackupSchedulePolicy;
  private readonly now: () => number;
  private readonly log: (event: BackupLogEvent) => void;
  /**
   * 有界失败下限（内存轨）：无法持久化新的重试责任时，按当前尝试计数直接安排的
   * 最早 alarm 时间。收尾调度不得用已过期的旧责任把它覆盖成过去/立即 alarm
   * （那会成为立即循环）。跨引擎重建/进程重启的持久保障在 backup_cursor.retry_floor_at
   * （见 rescheduleAlarmFromState 的 max 合成）；本内存轨仅兜底下限写入本身失败的情形。
   */
  private readonly boundedAlarmFloors = new Map<string, number>();

  constructor(options: {
    storage: AccountDurableStorage;
    objectStore: R2BackupObjectStore;
    snapshotSource: BackupSnapshotSource;
    schedule: BackupSchedulePolicy;
    now: () => number;
    log: (event: BackupLogEvent) => void;
  }) {
    this.storage = options.storage;
    this.store = new BackupStore(options.storage);
    this.objectStore = options.objectStore;
    this.snapshotSource = options.snapshotSource;
    this.schedule = options.schedule;
    this.now = options.now;
    this.log = options.log;
  }

  // -------------------------------------------------------------------------
  // 同步段集成：以下两个方法在同步的外层 storage.transaction 闭包内调用。
  // -------------------------------------------------------------------------

  /** 启用前已有服务端文档时，同一提交需要携带合并前快照冻结为基线。 */
  needsPreMergeSnapshotForEnablement(accountId: string): boolean {
    return this.store.getCursor(accountId) === null && this.snapshotSource.hasSnapshot(accountId);
  }

  /** 当前已持久的服务端 revision；游标尚未初始化时为 0（读取接口/同步响应使用）。 */
  currentRevision(accountId: string): number {
    return this.store.getCursor(accountId)?.currentRevision ?? 0;
  }

  /**
   * 成功合并后更新备份责任。必须在同步的外层事务内调用：
   * 无外层事务时写入不是原子的。没有新历史时按当前合并结果核对覆盖
   * （必要时补登记），不做其他变更。
   */
  async onSuccessfulMerge(accountId: string, outcome: {
    historyAdvanced: boolean;
    documentCreated: boolean;
    preMergeSnapshot: Uint8Array | null;
    mergedSnapshot: Uint8Array;
  }, nowMs: number): Promise<void> {
    const cursor = this.store.getCursor(accountId);
    if (cursor === null) {
      const streamId = crypto.randomUUID();
      if (outcome.documentCreated) {
        this.store.createCursor({
          accountId, streamId, createdAtMs: nowMs, currentRevision: 1, lastCommitAtMs: nowMs,
          pendingRevision: 1, pendingFirstRevision: 1, pendingFirstAtMs: nowMs,
          windowDueAtMs: nowMs + this.schedule.windowMs,
        });
        this.logEvent({ event: "backup_stream_enabled", streamId, baseline: "pending-capture" });
      } else {
        // 启用前已有文档：在同一提交冻结启用前快照为唯一基线任务；
        // 若本次输入还推进了历史，同时留下新版本的待备责任。
        // head 由同步段的 ensureDocumentGeneration 先行创建（legacy 分块已绑定 G0），
        // 新冻结任务按捕获时固定代次记录为 v2；启用基线同样先核对分块来源。
        const head = this.snapshotSource.readDocumentHead(accountId);
        if (head === null) throw new Error("backup_enablement_generation_missing");
        if (!this.snapshotSource.snapshotLabelsExplainable(accountId, head.currentGeneration, head)) {
          throw new GenerationStateUnavailableError("snapshot_generation_not_explainable");
        }
        const advanced = outcome.historyAdvanced;
        this.store.createCursor({
          accountId, streamId, createdAtMs: nowMs,
          currentRevision: advanced ? 2 : 1,
          lastCommitAtMs: advanced ? nowMs : null,
          pendingRevision: advanced ? 2 : null,
          pendingFirstRevision: advanced ? 2 : null,
          pendingFirstAtMs: advanced ? nowMs : null,
          windowDueAtMs: advanced ? nowMs + this.schedule.windowMs : null,
        });
        if (outcome.preMergeSnapshot === null) throw new Error("backup_enablement_premerge_missing");
        this.store.insertTask({
          accountId, streamId, revision: 1, reason: "baseline",
          capturedAtMs: nowMs, sourceCommittedAtMs: null,
          previousCompletedRevision: null, firstPendingRevision: null,
          sourceGeneration: head.currentGeneration,
          formatVersion: BACKUP_FORMAT_VERSION_V2,
          generationOrigin: head.origin,
        });
        this.store.writeTaskChunksFromBytes(accountId, outcome.preMergeSnapshot);
        this.logEvent({ event: "backup_stream_enabled", streamId, baseline: "frozen-premerge", snapshotBytes: outcome.preMergeSnapshot.byteLength });
      }
      await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
      return;
    }
    if (!outcome.historyAdvanced) {
      // 不认识备份的旧版本代码可能在不经过本 revision 计数器的情况下推进了主文档
      // （部署回退窗口）；空闲时核对当前合并结果是否已被最新完成备份覆盖，
      // 未覆盖则补登记待备责任，不能长期停留在 coverage_mismatch 观察态。
      await this.registerUncoveredHistory(accountId, outcome.mergedSnapshot, nowMs);
      return;
    }
    const newRevision = cursor.currentRevision + 1;
    this.store.advanceCursorForHistory(accountId, newRevision, nowMs, {
      revision: newRevision,
      firstRevision: cursor.pendingFirstRevision ?? newRevision,
      firstAtMs: cursor.pendingFirstAtMs ?? nowMs,
      dueAtMs: cursor.windowDueAtMs ?? (nowMs + this.schedule.windowMs),
    });
    // blocked 时不安排备份唤醒：新编辑不重置退避，也不解除 blocked。
    if (cursor.blockedError === null) {
      await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
    }
  }

  /**
   * 覆盖核对共用核心（两个入口共用：空闲同步对合并结果、备份确认后对当前主文档）：
   * 与「覆盖基准」的有效源代次与历史摘要都一致（旧代码在部署回退窗口或冻结任务
   * 在途期间写入、或主表被外部替换）时才算覆盖，否则把该未覆盖内容登记为新的
   * 服务端 revision 并开启待备窗口，在成功同步/完成确认的当下持久留下责任，不依赖
   * 未来的前台访问。覆盖基准取最近的待发布上界：冻结任务在途时用其冻结历史摘要
   * 与固定代次（登记不触碰冻结字节与重试计划），否则用最新完成备份的代次与摘要。
   * v1 完成行按固定 legacyGeneration 解释有效代次。已有待备或 blocked 时跳过；
   * 未准备的冻结任务（尚无摘要）无法比对，由确认后入口兜底；摘要分析失败不阻塞
   * 调用方，缺口仍可由只读状态观察。登记本身在独立事务中以新鲜读数防重复提交。
   */
  private async registerUncoveredHistory(
    accountId: string,
    snapshot: Uint8Array,
    nowMs: number,
  ): Promise<void> {
    const cursor = this.store.getCursor(accountId);
    if (cursor === null) return;
    if (cursor.blockedError !== null) return;
    if (cursor.pendingRevision !== null) return;
    const head = this.snapshotSource.readDocumentHead(accountId);
    if (head === null) return;
    const task = this.store.getTask(accountId);
    let expectedDigest: string | null;
    let expectedGeneration: string | null;
    if (task !== null) {
      // 冻结任务在途：以其冻结历史与固定代次为基准；登记为更新的 revision，不动任务本身。
      if (task.historySha256 === null) return;
      expectedDigest = task.historySha256;
      expectedGeneration = task.sourceGeneration ?? head.legacyGeneration;
    } else {
      if (cursor.latestCompletedRevision === null || cursor.latestCompletedHistorySha256 === null) return;
      expectedDigest = cursor.latestCompletedHistorySha256;
      // 不同代次即使历史摘要相同也不能互相确认覆盖。
      expectedGeneration = cursor.latestCompletedGeneration ?? head.legacyGeneration;
    }
    let covered: boolean;
    try {
      const analysis = await analyzeBackupSnapshot(snapshot);
      // 覆盖判断共享分块来源核对：不可证明属于当前代次的字节不能确认覆盖。
      const explainable = this.snapshotSource.snapshotLabelsExplainable(accountId, head.currentGeneration, head);
      covered = explainable && analysis.historyVersionSha256 === expectedDigest && expectedGeneration === head.currentGeneration;
    } catch {
      // 分析失败不阻塞调用方，但显式记录：覆盖责任不无声结束，由后续同步
      // 入口与只读状态继续观察。
      this.logEvent({ event: "backup_uncovered_analysis_failed", at: "sync" });
      return;
    }
    if (covered) return;
    const newRevision = cursor.currentRevision + 1;
    await this.storage.transaction(async () => {
      const fresh = this.store.getCursor(accountId);
      if (fresh === null || fresh.pendingRevision !== null) return;
      this.store.advanceCursorForHistory(accountId, newRevision, nowMs, {
        revision: newRevision,
        firstRevision: newRevision,
        firstAtMs: nowMs,
        dueAtMs: nowMs + this.schedule.windowMs,
      });
    });
    await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
    this.logEvent({ event: "backup_uncovered_history_registered", revision: newRevision });
  }

  // -------------------------------------------------------------------------
  // alarm 入口：优先级为 冻结任务 > 未收尾清理 > 窗口到期捕获。
  // -------------------------------------------------------------------------
  async onAlarm(nowMs: number): Promise<void> {
    for (const accountId of this.store.listAccountIds()) {
      const cursor = this.store.getCursor(accountId);
      if (cursor === null || cursor.blockedError !== null) continue;
      // 有界失败下限（持久 + 内存取大）：实际持久化失败产生的安全退避在到期前
      // 不得被执行——共享 alarm 为其他账号触发时也不提前本账号的任何自动推进
      // （任务重试、清理收尾、待捕获窗口 alike）。
      const failureFloor = this.effectiveFailureFloor(accountId, cursor);
      const blockedByFailureFloor = failureFloor > nowMs;
      const task = this.store.getTask(accountId);
      if (task !== null) {
        // 任务的重试时间未到时不做新尝试；等待中的待备变化也不能把故障重试提前。
        if ((task.nextAttemptAtMs ?? 0) <= nowMs && !blockedByFailureFloor) {
          await this.advanceTaskLifecycle(accountId, task, nowMs);
        }
        continue;
      }
      const hasCleanup = this.store.getRetention(accountId) !== null
        || this.store.listPrunePlan(accountId).length > 0;
      if (hasCleanup) {
        if ((cursor.cleanupNextAttemptAtMs ?? 0) <= nowMs && !blockedByFailureFloor) {
          await this.advanceCleanup(accountId, nowMs);
        }
        continue;
      }
      if (cursor.pendingRevision !== null && cursor.windowDueAtMs !== null && cursor.windowDueAtMs <= nowMs
        && !blockedByFailureFloor) {
        if (await this.tryCapture(accountId, nowMs)) {
          const captured = this.store.getTask(accountId);
          if (captured !== null) await this.advanceTaskLifecycle(accountId, captured, nowMs);
        }
        continue;
      }
    }
    // 收尾：短事务内重新读取最新持久状态决定唯一 alarm；无待备／清理工作时停止调度。
    await this.storage.transaction(async () => {
      await this.rescheduleAlarmFromState({ nowMs: this.now(), deleteWhenIdle: true });
    });
  }

  // -------------------------------------------------------------------------
  // 只读状态：不建映射、不续期、不初始化、不上传。
  // -------------------------------------------------------------------------

  /**
   * B 的恢复切换事务在提交前调用：按当前持久状态重排唯一 alarm（恢复基线任务的
   * 首次发布时间），与其他责任按既有优先级合并。必须在调用方的事务内执行。
   */
  async rescheduleAlarmWithinTransaction(nowMs: number): Promise<void> {
    await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
  }

  async readStatusSnapshot(accountId: string | null): Promise<BackupStatusSnapshot> {
    const uninitialized: BackupStatusSnapshot = {
      initialized: false, state: "uninitialized", currentRevision: null, currentGeneration: null,
      frozenTaskRevision: null, frozenTaskBytes: null, latestCompletedRevision: null,
      latestCompletedGeneration: null, pendingFromRevision: null,
      pendingToRevision: null, pendingSinceMs: null, windowDueAtMs: null, nextAttemptAtMs: null,
      nextActionAtMs: null, blockedError: null, cleanupPendingCount: 0, currentBackedUp: false,
    };
    if (accountId === null) return uninitialized;
    const cursor = this.store.getCursor(accountId);
    if (cursor === null) return uninitialized;
    // head 不可读（来源损坏等）时不猜测：状态只报告备份事实，代次字段为 null；
    // 真正的失败由同步/预览路径显式暴露。
    let head: DocumentGenerationHead | null = null;
    try { head = this.snapshotSource.readDocumentHead(accountId); } catch { head = null; }
    const task = this.store.getTask(accountId);
    const cleanupPendingCount = (this.store.getRetention(accountId) !== null ? 1 : 0)
      + this.store.listPrunePlan(accountId).length;
    const currentBackedUp = await this.computeCurrentBackedUp(accountId, cursor, head);
    let state: BackupStatusState;
    let blockedError = cursor.blockedError;
    if (cursor.blockedError !== null) state = "blocked";
    else if (cleanupPendingCount > 0) state = "cleanup_pending";
    else if (task !== null) state = task.attemptCount > 1 ? "retrying" : "uploading";
    else if (cursor.pendingRevision !== null) state = "pending";
    else if (currentBackedUp) state = "current_backed_up";
    else {
      // 无待备、无任务但当前版本没有已验证备份：覆盖缺口只报告，不持久。
      state = "blocked";
      blockedError = "coverage_mismatch";
    }
    return {
      initialized: true,
      state,
      currentRevision: cursor.currentRevision,
      currentGeneration: head?.currentGeneration ?? null,
      frozenTaskRevision: task?.revision ?? null,
      frozenTaskBytes: task !== null ? this.store.taskSnapshotBytes(accountId) : null,
      latestCompletedRevision: cursor.latestCompletedRevision,
      latestCompletedGeneration: cursor.latestCompletedGeneration ?? head?.legacyGeneration ?? null,
      pendingFromRevision: cursor.pendingFirstRevision,
      pendingToRevision: cursor.pendingRevision,
      pendingSinceMs: cursor.pendingFirstAtMs,
      windowDueAtMs: cursor.windowDueAtMs,
      nextAttemptAtMs: task?.nextAttemptAtMs ?? cursor.cleanupNextAttemptAtMs,
      nextActionAtMs: this.nextProtectionActionAtMs(accountId, this.now()),
      blockedError,
      cleanupPendingCount,
      currentBackedUp,
    };
  }

  /**
   * 保护等待的有效可行动时间（§7.2，只读）：与唯一 alarm 的计算共用同一优先级
   * （冻结任务 > 未收尾清理 > 待备窗口）并合入有界失败下限（持久值取较大者）。
   * blocked 表示自动推进已停止、无已登记责任表示没有自动计划——两者都返回
   * null，不虚报自动恢复时间。恢复预览与只读状态元数据共用本方法，避免客户端
   * 凭原始窗口时间猜测。
   */
  nextProtectionActionAtMs(accountId: string | null, nowMs: number): number | null {
    if (accountId === null) return null;
    const cursor = this.store.getCursor(accountId);
    if (cursor === null || cursor.blockedError !== null) return null;
    const floor = this.effectiveFailureFloor(accountId, cursor);
    const actionableAt = this.accountActionableAtMs(accountId, cursor, nowMs);
    if (actionableAt === null) return null;
    return floor > nowMs && actionableAt < floor ? floor : actionableAt;
  }

  /** 有界失败下限：持久值与内存值取大（跨引擎重建仍生效）。 */
  private effectiveFailureFloor(accountId: string, cursor: BackupCursorState): number {
    return Math.max(cursor.retryFloorAtMs ?? 0, this.boundedAlarmFloors.get(accountId) ?? 0);
  }

  // -------------------------------------------------------------------------
  // 捕获。
  // -------------------------------------------------------------------------

  private async tryCapture(accountId: string, nowMs: number): Promise<boolean> {
    try {
      return await this.captureTransaction(accountId, nowMs);
    } catch (error) {
      if (error instanceof GenerationStateUnavailableError) {
        // 捕获阶段的代次状态不可解释（head 缺失但已有现代代次痕迹等）：
        // 进入 blocked，保留责任与已有备份，停止本账号自动备份，不影响其他账号。
        await this.enterBlocked(accountId, "generation_state_unavailable", error.detail, null);
        return false;
      }
      if (!(error instanceof BackupVerificationError)) throw error;
      // 捕获阶段的确定性源文档故障：进入 blocked（事务已回滚，未写入任何捕获状态）。
      await this.enterBlocked(accountId, error.blockedCode, error.detail, null);
      return false;
    }
  }

  private async captureTransaction(accountId: string, nowMs: number): Promise<boolean> {
    return await this.storage.transaction(async () => {
      const cursor = this.store.getCursor(accountId);
      if (cursor === null || cursor.blockedError !== null) return false;
      if (this.store.getTask(accountId) !== null) return false;
      if (this.store.getRetention(accountId) !== null || this.store.listPrunePlan(accountId).length > 0) return false;
      if (cursor.pendingRevision === null || cursor.windowDueAtMs === null || cursor.windowDueAtMs > nowMs) return false;
      if (!this.snapshotSource.hasSnapshot(accountId)) {
        // 存在到期待备责任却无权威主文档（主表损坏或被错误维护）：明确的源文档故障。
        // 不虚构空基线；保留待备责任与已有备份，停止本账号自动备份。
        // blocked 不影响正常有效同步，也不解除其他账号的调度。
        throw new BackupVerificationError("invalid_source_document", "main_snapshot_missing_at_capture");
      }
      // 新捕获对有有效身份映射的账号调用同一事务级初始化规则：
      // head 缺失且状态不可解释时不捕获（blocked），不凭内存代次改写。
      const head = this.snapshotSource.ensureDocumentGeneration(accountId, nowMs);
      // 冻结前核对分块来源：每块标签必须可证明属于当前代次（或 legacy G0 回退
      // 窗口的全 NULL）。不可解释/混代时不发出新包与标记，保留责任进入 blocked。
      if (!this.snapshotSource.snapshotLabelsExplainable(accountId, head.currentGeneration, head)) {
        throw new GenerationStateUnavailableError("snapshot_generation_not_explainable");
      }
      const revision = cursor.currentRevision;
      const reason: BackupCaptureReason = cursor.latestCompletedRevision === null ? "baseline" : "history-change";
      this.store.insertTask({
        accountId,
        streamId: cursor.streamId,
        revision,
        reason,
        capturedAtMs: nowMs,
        sourceCommittedAtMs: cursor.lastCommitAtMs,
        previousCompletedRevision: cursor.latestCompletedRevision,
        firstPendingRevision: cursor.pendingFirstRevision,
        // 捕获时固定源代次、格式版本与代次来源；重试不读取当前代次改标签。
        sourceGeneration: head.currentGeneration,
        formatVersion: BACKUP_FORMAT_VERSION_V2,
        generationOrigin: head.origin,
      });
      this.store.copyMainSnapshotIntoTask(accountId);
      this.store.clearPendingIfCovered(accountId, revision);
      await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
      this.logEvent({ event: "backup_captured", backupId: backupId(cursor.streamId, revision), revision, reason });
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // 冻结任务生命周期：准备 → 序列核对 → 条件创建包 → 全包读回验证 →
  // 条件创建标记 → 读回标记 → 确认事务 → 保留检查收尾。
  // -------------------------------------------------------------------------

  private async advanceTaskLifecycle(
    accountId: string,
    task: FrozenBackupTask,
    nowMs: number,
  ): Promise<"confirmed" | "retrying" | "blocked"> {
    // 开始一次新的尝试：清除上一轮有界失败下限；若本轮持久化失败，善后会重新设置。
    this.boundedAlarmFloors.delete(accountId);
    const startedAtMs = this.now();
    try {
      let current = task;
      if (current.manifestJson === null) {
        const prepared = await this.prepareFrozenTask(current);
        const attempt = 1;
        await this.storage.transaction(async () => {
          this.store.markTaskPrepared(accountId, {
            ...prepared,
            attemptCount: attempt,
            nextAttemptAtMs: nowMs + backupRetryDelayMs(this.schedule, attempt),
          });
          await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
        });
        current = this.store.getTask(accountId) ?? current;
        this.logEvent({ event: "backup_prepared", backupId: backupId(current.streamId, current.revision), revision: current.revision, snapshotBytes: prepared.snapshotBytes });
      } else {
        // 恢复中断的生命周期：先持久本次尝试与安全重试，再做任何 R2 I/O。
        const attempt = current.attemptCount + 1;
        await this.storage.transaction(async () => {
          this.store.recordTaskAttempt(accountId, attempt, nowMs + backupRetryDelayMs(this.schedule, attempt));
          await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
        });
        current = this.store.getTask(accountId) ?? current;
        this.logEvent({ event: "backup_retry", backupId: backupId(current.streamId, current.revision), revision: current.revision, attempt });
      }
      const cursor = this.store.getCursor(accountId);
      if (cursor === null) throw new BackupVerificationError("sequence_conflict", "cursor_missing_during_task");
      // 序列防回退检查：R2 上可解释的已完成序号不能超出本地确认与冻结任务。
      await this.assertR2SequenceExplainable(accountId, cursor, current);
      const artifacts = this.buildTaskArtifacts(current);
      const ownership = {
        environment: BACKUP_ENVIRONMENT,
        accountId,
        documentType: BACKUP_DOCUMENT_TYPE,
        streamId: current.streamId,
        revision: current.revision,
      };
      // 1) 条件创建包：前置条件失败时读回核对，同内容幂等续行，不同内容为冲突。
      if (!await this.objectStore.conditionalCreate(artifacts.bundleKey, artifacts.bundle, artifacts.bundleSha256)) {
        const existing = await this.objectStore.getBundle(artifacts.bundleKey);
        if (existing === null) throw new Error("r2_bundle_vanished_after_precondition");
        if (existing === "too_large") throw new BackupVerificationError("content_conflict", "existing_bundle_too_large");
        await verifyBundleReadBack({
          bytes: existing, expectedBundleSha256: artifacts.bundleSha256,
          expectedManifestJson: artifacts.manifestJson, expectedOwnership: ownership,
        });
      }
      // 2) 无论刚写入还是已存在，都重新 GET 整包做完整读回验证。
      const readBack = await this.objectStore.getBundle(artifacts.bundleKey);
      if (readBack === null) throw new Error("r2_bundle_missing_after_put");
      if (readBack === "too_large") throw new BackupVerificationError("content_conflict", "bundle_too_large");
      await verifyBundleReadBack({
        bytes: readBack, expectedBundleSha256: artifacts.bundleSha256,
        expectedManifestJson: artifacts.manifestJson, expectedOwnership: ownership,
      });
      // 3) 条件创建完成标记；已存在时读回核对内容。
      const markerSha256 = await sha256Hex(artifacts.markerBytes);
      if (!await this.objectStore.conditionalCreate(artifacts.markerKey, artifacts.markerBytes, markerSha256)) {
        const existingMarker = await this.objectStore.getMarker(artifacts.markerKey);
        if (existingMarker === null) throw new Error("r2_marker_vanished_after_precondition");
        if (existingMarker === "too_large") throw new BackupVerificationError("content_conflict", "marker_too_large");
        verifyMarkerContent({ bytes: existingMarker, expectedMarker: artifacts.marker });
      }
      // 4) 读回标记并核对确定内容。
      const markerReadBack = await this.objectStore.getMarker(artifacts.markerKey);
      if (markerReadBack === null) throw new Error("r2_marker_missing_after_create");
      if (markerReadBack === "too_large") throw new BackupVerificationError("content_conflict", "marker_too_large");
      verifyMarkerContent({ bytes: markerReadBack, expectedMarker: artifacts.marker });
      // 5) 确认事务：同一事务释放冻结字节、登记完成与保留检查责任并保留 alarm。
      const completedAtMs = this.now();
      await this.storage.transaction(async () => {
        const freshTask = this.store.getTask(accountId);
        const freshCursor = this.store.getCursor(accountId);
        if (freshTask === null || freshCursor === null) return;
        if (freshCursor.latestCompletedRevision !== null && freshCursor.latestCompletedRevision >= freshTask.revision) {
          throw new BackupVerificationError("sequence_conflict", "completed_revision_regression");
        }
        // 完成缓存保存任务固定的代次信息、捕获时间、reason 与快照哈希；
        // v1 任务（升级前冻结）按 legacy 绑定解释有效代次（传 null，不改写语义）。
        // head 不可读时不阻塞确认：有效代次退化为未知，覆盖判断保守处理。
        const legacyGeneration = this.readHeadSafely(accountId)?.legacyGeneration ?? null;
        const effectiveGeneration = freshTask.sourceGeneration ?? legacyGeneration;
        this.store.upsertCompletion({
          accountId,
          revision: freshTask.revision,
          streamId: freshTask.streamId,
          bundleKey: freshTask.bundleKey ?? artifacts.bundleKey,
          bundleBytes: artifacts.bundle.byteLength,
          bundleSha256: freshTask.bundleSha256 ?? artifacts.bundleSha256,
          historySha256: freshTask.historySha256 ?? "",
          recordCount: freshTask.recordCount ?? 0,
          completedAtMs,
          sourceGeneration: freshTask.sourceGeneration,
          formatVersion: freshTask.formatVersion,
          generationOrigin: freshTask.generationOrigin,
          capturedAtMs: freshTask.capturedAtMs,
          reason: freshTask.reason,
          snapshotSha256: freshTask.snapshotSha256,
        });
        this.store.markCompleted(accountId, freshTask.revision, freshTask.historySha256 ?? "", effectiveGeneration);
        this.store.deleteTask(accountId);
        this.store.clearPendingIfCovered(accountId, freshTask.revision);
        this.store.registerRetention(accountId, freshTask.revision, completedAtMs);
        // 确认事务内一并完成覆盖核对：以刚完成任务的冻结历史与固定代次为基准，
        // 当前主文档未被覆盖（历史不同或代次不同——例如旧代次任务确认时主文档
        // 已是新代次）则在同一事务登记新的待备责任——确认与补登记原子提交，
        // 不存在「确认后、补登记前」的崩溃窗口（回滚则整个确认重做）。
        if (freshCursor.pendingRevision === null && freshCursor.blockedError === null
          && freshTask.historySha256 !== null) {
          const head = this.readHeadSafely(accountId);
          const mainSnapshot = this.snapshotSource.readSnapshotBytes(accountId);
          if (mainSnapshot !== null) {
            // 只吞摘要分析失败（不阻塞确认，但显式记录事件——不无声结束覆盖
            // 责任，缺口由下一次合格同步入口与只读状态继续兜底）；登记写入本身
            // 失败必须让整个确认事务回滚——确认与补登记要么原子同时提交，要么
            // 整体重做。分块来源不可证明属于当前代次时同样按未覆盖登记（捕获
            // 会在窗口到期时以真实原因 blocked，不发布不可解释来源的新对象）。
            let mainHistorySha256: string | null = null;
            let sourceExplainable = false;
            if (head !== null) {
              sourceExplainable = this.snapshotSource.snapshotLabelsExplainable(accountId, head.currentGeneration, head);
            }
            try {
              mainHistorySha256 = (await analyzeBackupSnapshot(mainSnapshot)).historyVersionSha256;
            } catch {
              mainHistorySha256 = null;
              this.logEvent({ event: "backup_uncovered_analysis_failed", at: "confirm" });
            }
            // 不同代次即使历史摘要相同也不能互相确认覆盖。
            const generationUncovered = head !== null && effectiveGeneration !== null
              && effectiveGeneration !== head.currentGeneration;
            if ((mainHistorySha256 !== null && (mainHistorySha256 !== freshTask.historySha256 || generationUncovered))
              || (mainHistorySha256 !== null && !sourceExplainable)) {
              const uncoveredRevision = freshCursor.currentRevision + 1;
              this.store.advanceCursorForHistory(accountId, uncoveredRevision, completedAtMs, {
                revision: uncoveredRevision,
                firstRevision: uncoveredRevision,
                firstAtMs: completedAtMs,
                dueAtMs: completedAtMs + this.schedule.windowMs,
              });
            }
          }
        }
        await this.rescheduleAlarmFromState({ nowMs: completedAtMs, deleteWhenIdle: false });
      });
      this.logEvent({
        event: "backup_completed",
        backupId: backupId(current.streamId, current.revision),
        revision: current.revision,
        bundleBytes: artifacts.bundle.byteLength,
        durationMs: this.now() - startedAtMs,
      });
      // 6) 同一生命周期的保留检查收尾；崩溃时由保留责任与 alarm 保证重启后先收尾。
      // （覆盖核对已在确认事务内原子完成，见上。）
      await this.advanceCleanup(accountId, this.now());
      return "confirmed";
    } catch (error) {
      if (error instanceof BackupVerificationError) {
        await this.enterBlocked(accountId, error.blockedCode, error.detail, currentBackupId(task));
        return "blocked";
      }
      // 可重试错误：确保安全重试已持久（尝试事务失败时其写入已回滚，这里补记）。
      await this.ensureRetryScheduled(accountId, error, currentBackupId(task));
      return "retrying";
    }
  }

  private async prepareFrozenTask(task: FrozenBackupTask): Promise<PreparedTaskFields> {
    const snapshot = this.store.readTaskSnapshot(task.accountId);
    if (snapshot === null) throw new BackupVerificationError("invalid_source_document", "frozen_snapshot_missing");
    const analysis = await analyzeBackupSnapshot(snapshot);
    const common = {
      format: BACKUP_FORMAT_NAME,
      environment: BACKUP_ENVIRONMENT,
      accountId: task.accountId,
      documentType: BACKUP_DOCUMENT_TYPE,
      backupStreamId: task.streamId,
      revision: task.revision,
      capturedAt: toIsoUtc(task.capturedAtMs),
      sourceCommittedAt: task.sourceCommittedAtMs === null ? null : toIsoUtc(task.sourceCommittedAtMs),
      previousCompletedRevision: task.previousCompletedRevision,
      firstPendingRevision: task.firstPendingRevision,
      businessSchema: "hako-refueling-records-v1",
      loroVersion: "1.16.3",
      snapshotMode: "snapshot",
      snapshotBytes: snapshot.byteLength,
      snapshotSha256: await sha256Hex(snapshot),
      historyVersionSha256: analysis.historyVersionSha256,
      recordCount: analysis.recordCount,
    } as const;
    // 升级前已冻结的任务（无捕获代次/格式字段）继续用 legacy 来源生成 v1；
    // 捕获时固定了代次的任务生成 v2。不能在重试时读取当前代次给旧快照贴新标签。
    // v2 任务的代次来源损坏/缺失时不允许降级为 v1 发布：格式与代次来源必须自洽，
    // 不可解释的任务进入 blocked，不发出新包或标记。
    if (task.formatVersion === BACKUP_FORMAT_VERSION_V2 && (task.sourceGeneration === null || task.generationOrigin === null)) {
      throw new BackupVerificationError("format_conflict", "v2_task_generation_metadata_unreadable");
    }
    const manifest: BackupManifest = task.formatVersion === BACKUP_FORMAT_VERSION_V2 && task.sourceGeneration !== null && task.generationOrigin !== null
      ? {
        ...common,
        formatVersion: BACKUP_FORMAT_VERSION_V2,
        sourceGeneration: { kind: "document-generation-v1", id: task.sourceGeneration },
        generationOrigin: task.generationOrigin,
        reason: task.reason,
        syncProtocol: 2,
      } satisfies BackupManifestV2
      : {
        ...common,
        formatVersion: BACKUP_FORMAT_VERSION_V1,
        sourceGeneration: { kind: "legacy-account-v1", id: task.accountId },
        // legacy 任务只承载既有 reason；restore-baseline 只可能出现在 v2 任务上。
        reason: task.reason === "restore-baseline" ? "history-change" : task.reason,
        syncProtocol: 1,
      } satisfies BackupManifestV1;
    const manifestBytes = serializeManifest(manifest);
    const manifestJson = new TextDecoder().decode(manifestBytes);
    const bundle = encodeBundle(manifestBytes, snapshot, manifest.formatVersion);
    const bundleSha256 = await sha256Hex(bundle);
    return {
      manifestJson,
      bundleSha256,
      snapshotSha256: manifest.snapshotSha256,
      snapshotBytes: manifest.snapshotBytes,
      historySha256: analysis.historyVersionSha256,
      recordCount: analysis.recordCount,
      bundleKey: bundleObjectKey(BACKUP_ENVIRONMENT, task.accountId, BACKUP_DOCUMENT_TYPE, task.streamId, task.revision, bundleSha256),
      markerKey: commitMarkerKey(BACKUP_ENVIRONMENT, task.accountId, BACKUP_DOCUMENT_TYPE, task.streamId, task.revision),
    };
  }

  private buildTaskArtifacts(task: FrozenBackupTask): TaskArtifacts {
    if (task.manifestJson === null || task.bundleSha256 === null || task.bundleKey === null || task.markerKey === null) {
      throw new Error("backup_task_not_prepared");
    }
    const snapshot = this.store.readTaskSnapshot(task.accountId);
    if (snapshot === null) throw new BackupVerificationError("invalid_source_document", "frozen_snapshot_missing");
    const manifestBytes = new TextEncoder().encode(task.manifestJson);
    // 已准备任务沿用原 manifest 字节；包与标记的格式版本以任务固定值为准。
    const formatVersion = task.formatVersion === BACKUP_FORMAT_VERSION_V2 ? BACKUP_FORMAT_VERSION_V2 : BACKUP_FORMAT_VERSION_V1;
    const bundle = encodeBundle(manifestBytes, snapshot, formatVersion);
    const marker: BackupCommitMarker = {
      format: BACKUP_FORMAT_NAME,
      formatVersion,
      environment: BACKUP_ENVIRONMENT,
      accountId: task.accountId,
      documentType: BACKUP_DOCUMENT_TYPE,
      backupStreamId: task.streamId,
      revision: task.revision,
      objectKey: task.bundleKey,
      bundleBytes: bundle.byteLength,
      bundleSha256: task.bundleSha256,
    };
    return {
      manifestJson: task.manifestJson,
      bundle,
      bundleSha256: task.bundleSha256,
      bundleKey: task.bundleKey,
      marker,
      markerBytes: serializeMarker(marker),
      markerKey: task.markerKey,
    };
  }

  // -------------------------------------------------------------------------
  // 序列防回退与归属检查：每次 R2 生命周期开始或恢复时执行。
  // -------------------------------------------------------------------------

  private async assertR2SequenceExplainable(
    accountId: string,
    cursor: BackupCursorState,
    task: FrozenBackupTask,
  ): Promise<void> {
    // 尚无任何完成记录 = 新序列首次接入：检查同环境下所有账号的键，
    // 不能因新生成了 streamId/accountId 就把已有桶当空桶；本任务自己已写入的
    // 包与标记（写后丢失响应、确认丢失）是可解释的。同一 DO 内的其他已知账号
    // （多身份映射）合法共存；本 DO 不认识的账号前缀意味着映射/状态丢失后重建，
    // 必须停止而不是静默另起新序列、遗弃旧账号的已有备份。
    if (cursor.latestCompletedRevision === null) {
      const accountsPrefix = backupAccountsPrefix(BACKUP_ENVIRONMENT);
      const keys = await this.objectStore.listKeys(accountsPrefix);
      const documentPrefix = `${accountDocumentPrefix(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE)}/`;
      const streamPrefix = `${backupStreamPrefix(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, cursor.streamId)}/`;
      const explainableKeys = new Set([task.bundleKey, task.markerKey]);
      const knownAccounts = this.store.listKnownAccountIds();
      for (const key of keys) {
        const ownerAccountId = accountIdFromBackupKey(key);
        if (ownerAccountId === accountId) {
          // 本账号其他文档类型的键（当前布局不存在）不在本序列核对范围。
          if (key.startsWith(documentPrefix)) {
            if (!key.startsWith(streamPrefix)) {
              throw new BackupVerificationError("ownership_conflict", "account_prefix_foreign_object");
            }
            if (!explainableKeys.has(key)) {
              throw new BackupVerificationError("sequence_conflict", "unexplained_object_under_new_stream");
            }
          }
          continue;
        }
        if (ownerAccountId === null || !knownAccounts.has(ownerAccountId)) {
          throw new BackupVerificationError("ownership_conflict", "unknown_account_prefix_in_bucket");
        }
      }
      return;
    }
    const revisions = await this.listExplainedMarkerRevisions(accountId, cursor, task.revision);
    if (revisions.length > 0 && revisions[0] > Math.max(cursor.latestCompletedRevision, task.revision)) {
      throw new BackupVerificationError("sequence_conflict", "marker_revision_ahead_of_local_state");
    }
    // 上传前的完成标记镜像核对：完成缓存中的版本必须仍有标记在 R2，
    // 只有本任务自己的 revision 允许缺失（首次创建尚未写入／重试幂等）。
    // 在任何新 PUT 之前阻断，而不是写入新包后才由保留检查发现。
    this.assertCompletionMarkerMirror(accountId, revisions, new Set([task.revision]));
  }

  /** 列出本序列 commits/ 下的完成标记序号（新到旧），不可解释的键或序号直接抛出冲突。 */
  private async listExplainedMarkerRevisions(
    accountId: string,
    cursor: BackupCursorState,
    extraExplainableRevision?: number,
  ): Promise<number[]> {
    const prefix = `${backupStreamPrefix(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, cursor.streamId)}/commits/`;
    const keys = await this.objectStore.listKeys(prefix);
    const explainable = new Set(this.store.listCompletions(accountId).map((entry) => entry.revision));
    if (extraExplainableRevision !== undefined) explainable.add(extraExplainableRevision);
    const revisions: number[] = [];
    for (const key of keys) {
      const parsed = parseCommitMarkerKey(key);
      if (parsed === null
        || parsed.environment !== BACKUP_ENVIRONMENT
        || parsed.accountId !== accountId
        || parsed.documentType !== BACKUP_DOCUMENT_TYPE
        || parsed.streamId !== cursor.streamId) {
        throw new BackupVerificationError("ownership_conflict", "unexplained_object_under_stream");
      }
      if (!explainable.has(parsed.revision)) {
        throw new BackupVerificationError("sequence_conflict", "unexplained_marker_revision");
      }
      revisions.push(parsed.revision);
    }
    return revisions.sort((left, right) => right - left);
  }

  // -------------------------------------------------------------------------
  // 保留检查与裁剪。
  // -------------------------------------------------------------------------

  private async advanceCleanup(accountId: string, nowMs: number): Promise<"settled" | "retrying" | "blocked"> {
    // 开始一次新的清理尝试：清除上一轮有界失败下限；若本轮持久化失败，善后会重新设置。
    this.boundedAlarmFloors.delete(accountId);
    try {
      // 先持久安排安全重试再做 R2 I/O（保留检查的 LIST 也是 R2 操作）。
      await this.storage.transaction(async () => {
        const cursor = this.store.getCursor(accountId);
        if (cursor === null) return;
        const attempt = cursor.cleanupAttemptCount + 1;
        this.store.recordCleanupAttempt(accountId, attempt, nowMs + backupRetryDelayMs(this.schedule, attempt));
        await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
      });
      const planEntries = this.store.listPrunePlan(accountId);
      if (planEntries.length > 0) return await this.executePrunePlan(accountId, planEntries);
      const retention = this.store.getRetention(accountId);
      if (retention === null) return "settled";
      const cursor = this.store.getCursor(accountId);
      if (cursor === null) throw new BackupVerificationError("sequence_conflict", "cursor_missing_during_cleanup");
      const markerRevisions = await this.listExplainedMarkerRevisions(accountId, cursor);
      // 完成缓存与 R2 标记互为镜像：缓存里有而标记不在 = 外部删除或元数据回退。
      this.assertCompletionMarkerMirror(accountId, markerRevisions, new Set());
      if (markerRevisions.length <= this.schedule.retentionCount) {
        // 集合已满足：短事务内重新读取最新状态后结清责任。
        await this.storage.transaction(async () => {
          const currentCursor = this.store.getCursor(accountId);
          if (currentCursor === null) return;
          if (this.store.getRetention(accountId) !== null && this.store.listPrunePlan(accountId).length === 0) {
            this.store.settleRetention(accountId);
          }
          this.store.settleCleanupAttempts(accountId);
          await this.rescheduleAlarmFromState({ nowMs: this.now(), deleteWhenIdle: true });
        });
        return "settled";
      }
      // 超出保留数量：先持久登记精确裁剪计划，再执行删除。
      const overflow = markerRevisions.slice(this.schedule.retentionCount);
      await this.storage.transaction(async () => {
        for (const revision of overflow) {
          const completion = this.store.getCompletion(accountId, revision);
          if (completion === null) throw new BackupVerificationError("sequence_conflict", "planned_revision_without_cache");
          this.store.insertPrunePlanEntry({
            accountId,
            revision,
            bundleKey: completion.bundleKey,
            markerKey: commitMarkerKey(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, completion.streamId, revision),
            markerDeleted: false,
          });
        }
        await this.rescheduleAlarmFromState({ nowMs: this.now(), deleteWhenIdle: false });
      });
      this.logEvent({ event: "backup_prune_planned", count: overflow.length });
      return await this.executePrunePlan(accountId, this.store.listPrunePlan(accountId));
    } catch (error) {
      if (error instanceof BackupVerificationError) {
        await this.enterBlocked(accountId, error.blockedCode, error.detail, null);
        return "blocked";
      }
      await this.ensureCleanupRetryScheduled(accountId, error);
      return "retrying";
    }
  }

  /** 恢复或执行裁剪：先重新核对 R2 序列与保留集合，旧验证结果不能无限期授权删除。 */
  private async executePrunePlan(
    accountId: string,
    planEntries: { accountId: string; revision: number; bundleKey: string; markerKey: string; markerDeleted: boolean }[],
  ): Promise<"settled" | "retrying" | "blocked"> {
    const cursor = this.store.getCursor(accountId);
    if (cursor === null) throw new BackupVerificationError("sequence_conflict", "cursor_missing_during_prune");
    // 1) 重新列出标记并计算当前保留集合。
    const markerRevisions = await this.listExplainedMarkerRevisions(accountId, cursor);
    // 1b) 恢复已有计划时同样核对完整应保留集合与完成缓存的镜像：缓存中的每个版本
    // 都必须有标记在 R2，除非其缺失可由当前精确计划解释（本计划已删标记，或标记
    // 删除已执行但响应丢失）。其他缺失 = 外部删除或元数据回退，必须停止一切破坏性
    // 步骤并保留计划与剩余对象；不能只核查 LIST 仍返回的部分。
    this.assertCompletionMarkerMirror(
      accountId,
      markerRevisions,
      new Set(planEntries.map((entry) => entry.revision)),
    );
    const keepRevisions = new Set(markerRevisions.slice(0, this.schedule.retentionCount));
    // 2) 删除前核查待保留对象：存在、长度及已存哈希与完成标记相符。
    for (const revision of keepRevisions) {
      const completion = this.store.getCompletion(accountId, revision);
      if (completion === null) throw new BackupVerificationError("sequence_conflict", "retained_revision_without_cache");
      await this.verifyRetainedObject(accountId, completion);
    }
    // 3) 逐版删除：先删完成标记、再删包；每步持久进展；中断由原计划继续清理。
    for (const entry of planEntries) {
      if (keepRevisions.has(entry.revision)) {
        // 保留集合缩小使该版重新进入最近 30 份：结清计划而不删除。
        await this.storage.transaction(async () => {
          this.store.deletePrunePlanEntry(accountId, entry.revision);
        });
        continue;
      }
      const completion = this.store.getCompletion(accountId, entry.revision);
      if (completion === null) {
        await this.storage.transaction(async () => {
          this.store.deletePrunePlanEntry(accountId, entry.revision);
        });
        continue;
      }
      if (!entry.markerDeleted) {
        await this.objectStore.delete(entry.markerKey);
        await this.storage.transaction(async () => {
          this.store.markPruneMarkerDeleted(accountId, entry.revision);
        });
      }
      await this.objectStore.delete(entry.bundleKey);
      await this.storage.transaction(async () => {
        this.store.deletePrunePlanEntry(accountId, entry.revision);
        this.store.deleteCompletion(accountId, entry.revision);
      });
    }
    // 4) 计划结清后重新列出标记确认集合已满足，再在同一短事务结清保留责任。
    const remainingMarkers = await this.listExplainedMarkerRevisions(accountId, cursor);
    await this.storage.transaction(async () => {
      const currentCursor = this.store.getCursor(accountId);
      if (currentCursor === null) return;
      if (this.store.listPrunePlan(accountId).length === 0 && remainingMarkers.length <= this.schedule.retentionCount) {
        this.store.settleRetention(accountId);
      }
      this.store.settleCleanupAttempts(accountId);
      await this.rescheduleAlarmFromState({ nowMs: this.now(), deleteWhenIdle: true });
    });
    this.logEvent({ event: "backup_pruned", count: planEntries.length, retained: keepRevisions.size });
    return "settled";
  }

  /**
   * 完成缓存与 R2 完成标记互为镜像：缓存中的版本必须有标记存在，
   * 除非其缺失可由当前精确裁剪计划解释（已删标记或删除响应丢失）。
   * 其他缺失视为外部删除或元数据回退，抛出 sequence_conflict。
   */
  private assertCompletionMarkerMirror(
    accountId: string,
    markerRevisions: number[],
    allowedMissingRevisions: Set<number>,
  ): void {
    const markerSet = new Set(markerRevisions);
    for (const completion of this.store.listCompletions(accountId)) {
      if (allowedMissingRevisions.has(completion.revision)) continue;
      if (!markerSet.has(completion.revision)) {
        throw new BackupVerificationError("sequence_conflict", "completion_without_marker");
      }
    }
  }

  private async verifyRetainedObject(accountId: string, completion: BackupCompletionRecord): Promise<void> {
    const markerKey = commitMarkerKey(
      BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, completion.streamId, completion.revision,
    );
    const markerBytes = await this.objectStore.getMarker(markerKey);
    if (markerBytes === null) throw new BackupVerificationError("retention_verify_failed", "retained_marker_missing");
    if (markerBytes === "too_large") throw new BackupVerificationError("retention_verify_failed", "retained_marker_too_large");
    verifyMarkerContent({ bytes: markerBytes, expectedMarker: buildCompletionMarker(completion) });
    const bundleBytes = await this.objectStore.getBundle(completion.bundleKey);
    if (bundleBytes === null) throw new BackupVerificationError("retention_verify_failed", "retained_bundle_missing");
    if (bundleBytes === "too_large") throw new BackupVerificationError("retention_verify_failed", "retained_bundle_too_large");
    if (bundleBytes.byteLength !== completion.bundleBytes) {
      throw new BackupVerificationError("retention_verify_failed", "retained_bundle_length_mismatch");
    }
    if (await sha256Hex(bundleBytes) !== completion.bundleSha256) {
      throw new BackupVerificationError("retention_verify_failed", "retained_bundle_hash_mismatch");
    }
  }

  /** head 读取的宽容包装：不可读时返回 null，不阻塞备份生命周期与只读状态。 */
  private readHeadSafely(accountId: string): DocumentGenerationHead | null {
    try {
      return this.snapshotSource.readDocumentHead(accountId);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // blocked 与可重试失败的善后。
  // -------------------------------------------------------------------------

  private async enterBlocked(
    accountId: string,
    code: BackupBlockedCode,
    detail: string,
    backupIdValue: string | null,
  ): Promise<void> {
    const nowMs = this.now();
    try {
      await this.storage.transaction(async () => {
        if (this.store.getCursor(accountId) === null) return;
        this.store.setBlocked(accountId, code);
        // blocked 账号不再贡献调度需求；其他账号照常。无任何需求时停止调度。
        await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: true });
      });
    } catch (error) {
      // 无法持久 blocked 时：按固定退避设置有界失败下限（持久 + 内存），防止
      // 收尾调度把「立即行动」的旧责任（过期窗口/过期重试）重设成过去/立即
      // alarm 的循环；下一次进入再尝试持久 blocked。
      const floor = nowMs + backupRetryDelayMs(this.schedule, 1);
      this.boundedAlarmFloors.set(accountId, floor);
      try {
        await this.storage.transaction(async () => {
          if (this.store.getCursor(accountId) !== null) {
            this.store.setRetryFloor(accountId, floor);
          }
        });
      } catch {
        // 下限写入失败由内存下限兜底。
      }
      this.logEvent({ event: "backup_blocked_persist_failed", errorCode: code, reason: describeError(error) });
      return;
    }
    this.logEvent({ event: "backup_blocked", backupId: backupIdValue, errorCode: code, detail });
  }

  private async ensureRetryScheduled(accountId: string, error: unknown, backupIdValue: string | null): Promise<void> {
    try {
      await this.storage.transaction(async () => {
        const task = this.store.getTask(accountId);
        const nowMs = this.now();
        // 无重试责任，或责任已过期（新责任持久化事务回滚后残留的旧值）：
        // 必须持久一个新的未来时间，不能沿用已到期值。
        if (task !== null && (task.nextAttemptAtMs === null || task.nextAttemptAtMs <= nowMs)) {
          const attempt = task.attemptCount + 1;
          this.store.recordTaskAttempt(accountId, attempt, nowMs + backupRetryDelayMs(this.schedule, attempt));
        }
        await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
      });
      this.logEvent({ event: "backup_retry_scheduled", backupId: backupIdValue, reason: describeError(error) });
    } catch (scheduleError) {
      // 无法持久新的安全责任：有界失败路径。绝不把已过期的旧责任重设为 alarm。
      await this.armBoundedFailureAlarm(accountId, "task");
    }
  }

  private async ensureCleanupRetryScheduled(accountId: string, error: unknown): Promise<void> {
    try {
      await this.storage.transaction(async () => {
        const cursor = this.store.getCursor(accountId);
        const nowMs = this.now();
        if (cursor !== null && (cursor.cleanupNextAttemptAtMs === null || cursor.cleanupNextAttemptAtMs <= nowMs)) {
          const attempt = cursor.cleanupAttemptCount + 1;
          this.store.recordCleanupAttempt(accountId, attempt, nowMs + backupRetryDelayMs(this.schedule, attempt));
        }
        await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
      });
      this.logEvent({ event: "backup_cleanup_retry_scheduled", reason: describeError(error) });
    } catch (scheduleError) {
      await this.armBoundedFailureAlarm(accountId, "cleanup");
    }
  }

  /**
   * 有界失败路径：重试责任无法持久化时，按当前持久尝试计数直接安排下一档退避的
   * 未来 alarm，并记录安全下限；后续任何基于持久旧值的收尾调度都不得早于该下限。
   */
  private async armBoundedFailureAlarm(accountId: string, responsibility: "task" | "cleanup"): Promise<void> {
    const nowMs = this.now();
    const attemptCount = responsibility === "task"
      ? (this.store.getTask(accountId)?.attemptCount ?? 0)
      : (this.store.getCursor(accountId)?.cleanupAttemptCount ?? 0);
    const floor = nowMs + backupRetryDelayMs(this.schedule, attemptCount + 1);
    this.boundedAlarmFloors.set(accountId, floor);
    // 尽力持久化下限（backup_cursor 与失败的任务写入不同表）：跨引擎重建后
    // 普通同步的重排仍受约束，不会把失败退避中的重试提前到立即执行。
    try {
      await this.storage.transaction(async () => {
        if (this.store.getCursor(accountId) !== null) {
          this.store.setRetryFloor(accountId, floor);
        }
      });
    } catch {
      // 下限写入也失败时由内存下限与已设置的 alarm 兜底。
    }
    this.logEvent({ event: "backup_retry_schedule_failed_bounded", responsibility, retryNotBeforeMs: floor });
    try {
      await this.rescheduleAlarmFromState({ nowMs, deleteWhenIdle: false });
    } catch {
      // 收尾调度会再次尝试；下限已持久/内存双轨，过期旧值不会覆盖成过去 alarm。
    }
  }

  // -------------------------------------------------------------------------
  // 唯一 alarm 的计算：待备、重试与清理共用，按阶段取最小时间；
  // 只依据事务内重新读取的持久状态，不使用 getAlarm() 推断。
  // -------------------------------------------------------------------------

  private async rescheduleAlarmFromState(options: { nowMs: number; deleteWhenIdle: boolean }): Promise<void> {
    // 与 onAlarm 相同的优先级选择每个账号的下一次可行动时间：
    // 冻结任务 > 未收尾清理 > 待备窗口。任务在途时待备窗口不可行动，
    // 不能按所有时间取最小值，否则会出现永远落在过去的 alarm 循环。
    let earliest: number | null = null;
    for (const accountId of this.store.listAccountIds()) {
      const cursor = this.store.getCursor(accountId);
      if (cursor === null || cursor.blockedError !== null) continue;
      // 有界失败下限取持久值与内存值的较大者：持久值跨引擎重建仍然生效
      // （重启后普通同步不得把失败退避中的重试提前到立即执行）。
      const floor = this.effectiveFailureFloor(accountId, cursor);
      if (floor !== 0 && floor <= options.nowMs) this.boundedAlarmFloors.delete(accountId);
      let actionableAt = this.accountActionableAtMs(accountId, cursor, options.nowMs);
      if (actionableAt !== null && floor > options.nowMs && actionableAt < floor) {
        // 有界失败下限：无法持久化新责任期间，不允许更早的自动重试。
        actionableAt = floor;
      }
      if (actionableAt !== null) earliest = minNullable(earliest, actionableAt);
    }
    if (earliest !== null) {
      await this.storage.setAlarm(Math.max(earliest, 0));
    } else if (options.deleteWhenIdle) {
      await this.storage.deleteAlarm();
    }
  }

  /**
   * 单账号下一次可行动时间。到期的重试/清理责任＝「正当其时」，alarm 设为当前
   * 时间并立即由处理器消费（新责任总是未来时间）；到期的待备窗口＝「立即补捕获」。
   * 不在此处对到期值重开退避档——那会让普通同步不断顺延到期重试。立即循环的
   * 防护完全由有界失败下限承担：只有持久化新责任失败的善后才强制 alarm 不早于
   * 下一档退避（见 armBoundedFailureAlarm 与 enterBlocked 的失败分支）。
   */
  private accountActionableAtMs(accountId: string, cursor: BackupCursorState, nowMs: number): number | null {
    const task = this.store.getTask(accountId);
    // 早于或等于当前时间的重试责任表示「重试正当其时」：alarm 立即触发，由处理器
    // 消费并持久新的未来责任。不能在这里把到期重试一律推迟一档退避——那会让
    // 持续编辑的普通同步不断顺延重试（到期后晚到 1 秒的同步也会把重试推后 5 分钟，
    // 任务与清理两条路径同样）。立即循环的防护完全由有界失败下限承担：只有
    // 「持久化新责任的事务失败」（armBoundedFailureAlarm / enterBlocked 善后）才
    // 强制 alarm 不早于按当前尝试计数重排的下一档退避。
    if (task !== null) {
      return task.nextAttemptAtMs !== null && task.nextAttemptAtMs > nowMs
        ? task.nextAttemptAtMs
        : nowMs;
    }
    const hasCleanup = this.store.getRetention(accountId) !== null
      || this.store.listPrunePlan(accountId).length > 0;
    if (hasCleanup) {
      return cursor.cleanupNextAttemptAtMs !== null && cursor.cleanupNextAttemptAtMs > nowMs
        ? cursor.cleanupNextAttemptAtMs
        : nowMs;
    }
    if (cursor.pendingRevision !== null && cursor.windowDueAtMs !== null) {
      // 到期窗口在 onAlarm 内当场尝试捕获：过期的窗口表示「立即补捕获」（窗口是
      // 延迟目标，不是完成时限），但不把早于当前时间的值设成 alarm。
      return Math.max(cursor.windowDueAtMs, nowMs);
    }
    return null;
  }

  // -------------------------------------------------------------------------

  private async computeCurrentBackedUp(accountId: string, cursor: BackupCursorState, head: DocumentGenerationHead | null): Promise<boolean> {
    if (cursor.latestCompletedRevision === null || cursor.latestCompletedHistorySha256 === null) return false;
    if (head === null) return false;
    const snapshot = this.snapshotSource.readSnapshotBytes(accountId);
    if (snapshot === null) return false;
    // 只读状态的覆盖结论同样要求分块来源可证明属于当前代次；不可解释时不报告已备份。
    if (!this.snapshotSource.snapshotLabelsExplainable(accountId, head.currentGeneration, head)) return false;
    try {
      const analysis = await analyzeBackupSnapshot(snapshot);
      // 有效源代次与历史摘要都匹配才算覆盖；不同代次即使摘要相同也不互相确认。
      // v1 完成行（latestCompletedGeneration 为 null）按固定 legacyGeneration 解释。
      const effectiveGeneration = cursor.latestCompletedGeneration ?? head.legacyGeneration;
      return analysis.historyVersionSha256 === cursor.latestCompletedHistorySha256
        && effectiveGeneration === head.currentGeneration;
    } catch {
      return false;
    }
  }

  private logEvent(event: BackupLogEvent): void {
    try {
      this.log(event);
    } catch {
      // 日志失败不影响备份生命周期。
    }
  }
}

function backupId(streamId: string, revision: number): string {
  return `${streamId}:${revision}`;
}

function currentBackupId(task: FrozenBackupTask): string {
  return backupId(task.streamId, task.revision);
}

function minNullable(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "unknown";
}
