// 恢复服务（B 版本，恢复设计 §7）：
// - 列表：只读核对 R2 完成标记清单（有界分页）与完成缓存镜像；分页不全、未知
//   序号、陌生 stream、缓存不一致或超出正常完成标记数都不形成可确认列表。
// - 预览：精确备份引用 → 标记与包完整读回验证（复用备份验证器）→ 目标暂存到
//   唯一 preview（512 KiB 分块、15 分钟、不续期）。R2 读取与哈希/Loro 分析都在
//   事务外；保存前在事务内重验会话、当前主版本（字节比较）与预览替换条件，
//   迟到请求不能覆盖较新预览。
// - 提交：入口先鉴权并按 requestId 查回执（早于代次变化检查），再完整重新验证
//   暂存目标、当前主快照与保护包；最终在唯一 storage.transaction 内重新鉴权、
//   查重并复核全部条件与主表原字节（字节比较），然后创建新 UUID 代次、替换
//   快照、revision+1、冻结 restore-baseline、写回执、消费 preview 并安排
//   alarm——任一写入失败整体回滚。全部已鉴权/正文绑定失败出口执行短裁决
//   （重新鉴权、查回执、持久条件判定）：committed 优先，只有持久失去资格才
//   not_committed，否则 unknown。
//
// A 的回退兼容（§7.6）：回执表、请求指纹与三个 outcome 的解释不变；A 只做
// 查重的提交路径读取同一回执表。B 不引入 A 无法读取的回执或本机 schema。

import type { AccountDurableStorage, HakoAccountState } from "../auth/account-state";
import type { AccountDocuments, DocumentGenerationHead } from "../sync/account-documents";
import { GenerationStateUnavailableError } from "../sync/account-documents";
import type {
  CancelRestorePreviewResult,
  CreateRestorePreviewInput,
  CreateRestorePreviewResult,
  ListRefuelingBackupsInput,
  ListRefuelingBackupsResult,
  ReadRestorePreviewInput,
  ReadRestorePreviewSnapshotResult,
  ReadRestoreReceiptInput,
  ReadRestoreReceiptResult,
  SubmitRestoreInput,
  SubmitRestoreResult,
} from "../auth/account-rpc";
import type { RestoreStore } from "./restore-store";
import type { RestorePreviewStore, StoredRestorePreview } from "./restore-preview-store";
import type { RestorePreviewDescriptor, RestoreReceipt, RestoreRequestBody } from "../../shared/restore-protocol";
import { RESTORE_PREVIEW_TTL_MS } from "../../shared/restore-protocol";
import { BackupStore, type BackupCompletionRecord, type BackupCursorState } from "../backup/backup-store";
import { R2BackupObjectStore } from "../backup/backup-object-store";
import type { BackupSchedulePolicy } from "../backup/backup-schedule";
import {
  analyzeBackupSnapshot,
  BackupVerificationError,
  buildCompletionMarker,
  verifyCompletedBackup,
  verifyMarkerContent,
} from "../backup/backup-verify";
import {
  BACKUP_DOCUMENT_TYPE,
  BACKUP_ENVIRONMENT,
  BACKUP_FORMAT_VERSION_V2,
  BackupFormatError,
  accountDocumentPrefix,
  commitMarkerKey,
  parseCommitMarkerKey,
  parseManifest,
  serializeManifest,
  sha256Hex,
  type BackupManifest,
} from "../backup/backup-format";

/** 恢复切换事务内重排唯一 alarm 的能力；由 BackupEngine 实现（同一事务边界）。 */
export interface RestoreAlarmScheduler {
  rescheduleAlarmWithinTransaction(nowMs: number): Promise<void>;
  /**
   * 保护等待的有效可行动时间（§7.2，只读）：责任优先级 + 持久失败下限；
   * blocked 或无责任为 null。预览与只读状态共用，客户端不得凭窗口时间推算。
   */
  nextProtectionActionAtMs(accountId: string | null, nowMs: number): number | null;
}

/** 列表读取的固定分页参数：单页 32、最多 32 页；超出即报告读取不完整。 */
const LIST_PAGE_SIZE = 32;
const LIST_MAX_PAGES = 32;

interface CurrentDocumentState {
  head: DocumentGenerationHead;
  cursor: BackupCursorState;
  snapshot: Uint8Array;
  snapshotSha256: string;
  historySha256: string;
}

export class RestoreService {
  constructor(
    private readonly storage: AccountDurableStorage,
    private readonly sessions: HakoAccountState,
    private readonly documents: AccountDocuments,
    private readonly receipts: RestoreStore,
    private readonly previews: RestorePreviewStore,
    private readonly backupStore: BackupStore,
    private readonly objectStore: R2BackupObjectStore,
    private readonly alarms: RestoreAlarmScheduler,
    private readonly schedule: BackupSchedulePolicy,
    private readonly now: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // 鉴权与账号解析（所有入口共用）。
  // -------------------------------------------------------------------------

  private resolveAccount(
    input: { sessionHash: string; identity: { issuer: string; subject: string } },
    expectedAccountId: string,
  ): { ok: true; accountId: string } | { ok: false; error: "unauthorized" | "account_changed" } {
    if (this.sessions.readSession({ sessionHash: input.sessionHash, identity: input.identity, nowMs: this.now() }) === null) {
      return { ok: false, error: "unauthorized" };
    }
    const accountId = this.documents.findAccountId(input.identity);
    if (accountId === null || accountId !== expectedAccountId) return { ok: false, error: "account_changed" };
    return { ok: true, accountId };
  }

  // -------------------------------------------------------------------------
  // 列表（§7.1）：R2 标记清单与完成缓存完整核对；只读，不加载完整包。
  // -------------------------------------------------------------------------

  async listBackups(input: ListRefuelingBackupsInput): Promise<ListRefuelingBackupsResult> {
    const account = this.resolveAccount(input, input.expectedAccountId);
    if (!account.ok) return { ok: false, error: account.error };
    const accountId = account.accountId;
    let head: DocumentGenerationHead | null;
    try {
      head = this.documents.readDocumentHead(accountId);
    } catch {
      return { ok: false, error: "generation_state_unavailable" };
    }
    const cursor = this.backupStore.getCursor(accountId);
    if (cursor === null) {
      // 无备份流：未初始化。仅映射无数据的新账号 head 也为 null，同样归入未初始化。
      return {
        ok: true,
        initialized: false,
        currentGeneration: head?.currentGeneration ?? null,
        legacyGeneration: head?.legacyGeneration ?? null,
        currentRevision: null,
        versions: [],
      };
    }
    if (head === null) {
      // 有备份序列却无代次 head（v1 时代未升级账号）：代次状态不可解释，先正常同步。
      return { ok: false, error: "generation_state_unavailable" };
    }
    // 列表扫描账号文档前缀（标记 + 包对象）：陌生 stream、未知序号与游离对象都
    // 会出现在该前缀下，不能只看当前 stream 的 commits/。与预览、提交共用同一
    // 有界解释规则（explainBackupSequence），列表不是唯一门禁。
    const sequence = await this.explainBackupSequence(accountId);
    if (!sequence.ok) return { ok: false, error: sequence.error };
    const completions = this.backupStore.listCompletions(accountId);
    const planRevisions = new Set(this.backupStore.listPrunePlan(accountId).map((entry) => entry.revision));
    const versions = completions.map((completion, index) => ({
      backupStreamId: completion.streamId,
      revision: completion.revision,
      bundleSha256: completion.bundleSha256,
      completedAtMs: completion.completedAtMs,
      capturedAtMs: completion.capturedAtMs,
      recordCount: completion.recordCount,
      formatVersion: completion.formatVersion,
      effectiveSourceGeneration: completion.sourceGeneration ?? head.legacyGeneration,
      generationOrigin: completion.generationOrigin,
      reason: completion.reason,
      restoreBaseline: completion.reason === "restore-baseline",
      snapshotSha256: completion.snapshotSha256,
      // 清理中的版本（在裁剪计划内或超出最近保留数）不可作为新的可选目标。
      selectable: index < this.schedule.retentionCount && !planRevisions.has(completion.revision),
    }));
    return {
      ok: true,
      initialized: true,
      currentGeneration: head.currentGeneration,
      legacyGeneration: head.legacyGeneration,
      currentRevision: cursor.currentRevision,
      versions,
    };
  }

  /**
   * 有界、完整的序列解释与归属核对（§7.1/§4.3/§10.2）：列表、预览与提交共用。
   * 扫描账号文档前缀，要求每个对象都能由完成缓存、裁剪计划或在途冻结任务解释；
   * 陌生 stream、未知序号、游离对象、分页不完整或缓存/标记镜像不一致都拒绝。
   * 只读且不修复任何映射——管理员归属修复是独立事件流程，不能靠删除/重建解锁。
   */
  private async explainBackupSequence(accountId: string): Promise<{ ok: true } | { ok: false; error: "restore_unavailable" | "backup_invalid" }> {
    const cursor = this.backupStore.getCursor(accountId);
    if (cursor === null) return { ok: false, error: "backup_invalid" };
    const documentPrefix = `${accountDocumentPrefix(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE)}/`;
    let listed: { keys: string[]; truncated: boolean };
    try {
      listed = await this.objectStore.listKeysBounded(documentPrefix, { pageSize: LIST_PAGE_SIZE, maxPages: LIST_MAX_PAGES });
    } catch {
      return { ok: false, error: "restore_unavailable" };
    }
    if (listed.truncated) {
      // 到达读取上限：报告读取不完整，不能截断后声称已核对整个序列。
      return { ok: false, error: "restore_unavailable" };
    }
    const completions = this.backupStore.listCompletions(accountId);
    const plan = this.backupStore.listPrunePlan(accountId);
    const task = this.backupStore.getTask(accountId);
    // 可解释键集合：完成缓存与裁剪计划的标记/包，以及在途冻结任务自己已写入的
    // 对象（写后丢失确认）。在途任务的 revision 不是完成版本。
    const explainableKeys = new Set<string>();
    const explainableRevisions = new Set<number>();
    for (const completion of completions) {
      explainableRevisions.add(completion.revision);
      explainableKeys.add(commitMarkerKey(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, completion.streamId, completion.revision));
      explainableKeys.add(completion.bundleKey);
    }
    for (const entry of plan) {
      explainableKeys.add(entry.markerKey);
      explainableKeys.add(entry.bundleKey);
    }
    if (task !== null) {
      explainableRevisions.add(task.revision);
      explainableKeys.add(commitMarkerKey(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, task.streamId, task.revision));
      if (task.bundleKey !== null) explainableKeys.add(task.bundleKey);
    }
    const markerRevisions = new Set<number>();
    let markerCount = 0;
    for (const key of listed.keys) {
      if (!explainableKeys.has(key)) {
        // 陌生 stream、未知序号或不可解释的游离对象：序列不可解释。
        return { ok: false, error: "backup_invalid" };
      }
      const parsed = parseCommitMarkerKey(key);
      if (parsed !== null) {
        if (parsed.streamId !== cursor.streamId
          || parsed.environment !== BACKUP_ENVIRONMENT
          || parsed.accountId !== accountId
          || parsed.documentType !== BACKUP_DOCUMENT_TYPE
          || !explainableRevisions.has(parsed.revision)) {
          return { ok: false, error: "backup_invalid" };
        }
        markerCount += 1;
        markerRevisions.add(parsed.revision);
      }
    }
    // 正常最多允许保留数+1 个完成标记（清理中的临时状态），超出即不可解释。
    if (markerCount > this.schedule.retentionCount + 1) {
      return { ok: false, error: "backup_invalid" };
    }
    // 镜像核对：完成缓存中的版本必须有标记，除非缺失可由当前裁剪计划解释。
    for (const completion of completions) {
      if (!markerRevisions.has(completion.revision) && !plan.some((entry) => entry.revision === completion.revision)) {
        return { ok: false, error: "backup_invalid" };
      }
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 预览（§7.1/§4.2）：R2 验证与哈希在事务外，写入前在事务内重验替换条件。
  // -------------------------------------------------------------------------

  async createPreview(input: CreateRestorePreviewInput): Promise<CreateRestorePreviewResult> {
    const account = this.resolveAccount(input, input.expectedAccountId);
    if (!account.ok) return { ok: false, error: account.error };
    const accountId = account.accountId;
    let head: DocumentGenerationHead | null;
    try {
      head = this.documents.readDocumentHead(accountId);
    } catch {
      return { ok: false, error: "generation_state_unavailable" };
    }
    const cursor = this.backupStore.getCursor(accountId);
    if (cursor === null) return { ok: false, error: "backup_not_found" };
    if (head === null) return { ok: false, error: "generation_state_unavailable" };
    // 恢复写入入口同样要求完整可解释的序列（§7.1/§4.3）：列表不是唯一门禁，
    // 已有列表/预览之后出现的未知对象同样阻止新预览。
    const sequence = await this.explainBackupSequence(accountId);
    if (!sequence.ok) return { ok: false, error: sequence.error };
    // 精确备份引用：必须与完成缓存条目完全匹配；不接受任意对象键或外部 URL。
    const completion = this.backupStore.getCompletion(accountId, input.revision);
    if (completion === null
      || completion.streamId !== input.backupStreamId
      || completion.bundleSha256 !== input.bundleSha256
      || completion.streamId !== cursor.streamId) {
      return { ok: false, error: "backup_not_found" };
    }
    const completions = this.backupStore.listCompletions(accountId);
    const selectableIndex = completions.findIndex((entry) => entry.revision === input.revision);
    const inCleanup = selectableIndex >= this.schedule.retentionCount
      || this.backupStore.listPrunePlan(accountId).some((entry) => entry.revision === input.revision);
    if (selectableIndex < 0 || inCleanup) {
      // 清理中的版本不可新选；不在最近保留数内同样不可选。
      return { ok: false, error: "backup_not_found" };
    }
    let replacesPreviewId: string | null;
    try {
      replacesPreviewId = this.previews.get(accountId)?.previewId ?? null;
    } catch {
      return { ok: false, error: "restore_unavailable" };
    }
    // 一致读取当前主版本（短事务读字节，哈希与 Loro 分析在事务外）。
    let current: CurrentDocumentState | null;
    try {
      current = await this.readCurrentDocumentState(accountId, head);
    } catch (error) {
      if (error instanceof GenerationStateUnavailableError) return { ok: false, error: "generation_state_unavailable" };
      return { ok: false, error: "restore_unavailable" };
    }
    if (current === null) {
      // 无主文档：当前版本不存在，没有可保护的恢复前状态。
      return { ok: false, error: "backup_not_ready" };
    }
    // 事务外完整读回目标标记与包（R2、哈希与全新 Loro 导入）。
    const read = await this.readAndVerifyCompletion(accountId, completion);
    if (!read.ok) return { ok: false, error: read.error };
    // 完整状态与历史均相同：无需恢复，不生成预览、新代次或备份。
    if (read.manifest.snapshotSha256 === current.snapshotSha256
      && read.manifest.historyVersionSha256 === current.historySha256) {
      return { ok: false, error: "no_restore_change" };
    }
    const previewId = crypto.randomUUID();
    const nowMs = this.now();
    const expiresAtMs = nowMs + RESTORE_PREVIEW_TTL_MS;
    const descriptor: RestorePreviewDescriptor = {
      previewId,
      expiresAtMs,
      createdAtMs: nowMs,
      target: {
        backupStreamId: completion.streamId,
        revision: completion.revision,
        bundleSha256: completion.bundleSha256,
        snapshotSha256: read.manifest.snapshotSha256,
        historySha256: read.manifest.historyVersionSha256,
        recordCount: read.manifest.recordCount,
        capturedAtMs: completion.capturedAtMs,
      },
      expected: {
        generation: current.head.currentGeneration,
        revision: current.cursor.currentRevision,
        snapshotSha256: current.snapshotSha256,
        historySha256: current.historySha256,
      },
      protection: this.describeProtection(accountId, current),
    };
    try {
      await this.storage.transaction(async () => {
        // 保存前重验会话、当前主版本（字节比较，不做哈希）与预览替换条件。
        const accountNow = this.resolveAccount(input, input.expectedAccountId);
        if (!accountNow.ok) throw new PreviewAbortError(accountNow.error);
        const previewNow = this.previews.get(accountId);
        if ((previewNow?.previewId ?? null) !== replacesPreviewId) {
          // 尚在外部读取中的请求必须比较开始时的 preview 版本，不能覆盖较新预览。
          throw new PreviewAbortError("preview_replaced");
        }
        const stateNow = this.readCurrentSnapshotWithin(accountId, current!.head.currentGeneration);
        if (stateNow === null
          || stateNow.head.currentGeneration !== current!.head.currentGeneration
          || stateNow.cursor.currentRevision !== current!.cursor.currentRevision
          || !bytesEqual(stateNow.snapshot, current!.snapshot)) {
          throw new PreviewAbortError("source_changed");
        }
        this.previews.replace({
          accountId,
          previewId,
          backupStreamId: completion.streamId,
          revision: completion.revision,
          bundleSha256: completion.bundleSha256,
          targetSnapshotSha256: read.manifest.snapshotSha256,
          targetHistorySha256: read.manifest.historyVersionSha256,
          targetRecordCount: read.manifest.recordCount,
          targetCapturedAtMs: completion.capturedAtMs,
          targetManifestJson: new TextDecoder().decode(serializeManifest(read.manifest)),
          expectedGeneration: current!.head.currentGeneration,
          expectedRevision: current!.cursor.currentRevision,
          expectedSnapshotSha256: current!.snapshotSha256,
          expectedHistorySha256: current!.historySha256,
          createdAtMs: nowMs,
          expiresAtMs,
          targetSnapshot: read.snapshot,
        });
      });
    } catch (error) {
      if (error instanceof PreviewAbortError) return { ok: false, error: error.code };
      return { ok: false, error: "restore_unavailable" };
    }
    return { ok: true, preview: descriptor };
  }

  readPreviewSnapshot(input: ReadRestorePreviewInput): ReadRestorePreviewSnapshotResult {
    const account = this.resolveAccount(input, input.expectedAccountId);
    if (!account.ok) return { ok: false, error: account.error };
    try {
      const preview = this.previews.get(account.accountId);
      if (preview === null || preview.previewId !== input.previewId) {
        return { ok: false, error: "preview_not_found" };
      }
      const snapshot = this.previews.readSnapshot(account.accountId);
      if (snapshot === null) return { ok: false, error: "preview_not_found" };
      return { ok: true, snapshot, preview: previewDescriptorFrom(preview) };
    } catch {
      return { ok: false, error: "restore_unavailable" };
    }
  }

  async cancelPreview(input: ReadRestorePreviewInput): Promise<CancelRestorePreviewResult> {
    const account = this.resolveAccount(input, input.expectedAccountId);
    if (!account.ok) return { ok: false, error: account.error };
    const accountId = account.accountId;
    try {
      let cancelled = false;
      await this.storage.transaction(async () => {
        // 事务内重验会话后删除；只删除仍匹配且未消费的本账号预览，不动回执。
        const accountNow = this.resolveAccount(input, input.expectedAccountId);
        if (!accountNow.ok) throw new PreviewAbortError(accountNow.error);
        const preview = this.previews.get(accountId);
        if (preview === null || preview.previewId !== input.previewId) return;
        this.previews.delete(accountId);
        cancelled = true;
      });
      return { ok: true, cancelled };
    } catch (error) {
      if (error instanceof PreviewAbortError) {
        return { ok: false, error: error.code === "unauthorized" ? "unauthorized" : "account_changed" };
      }
      return { ok: false, error: "restore_unavailable" };
    }
  }

  // -------------------------------------------------------------------------
  // 提交（§7.3）：入口查重 → 事务外完整验证 → 唯一切换事务 → 失败出口短裁决。
  // -------------------------------------------------------------------------

  async submit(input: SubmitRestoreInput): Promise<SubmitRestoreResult> {
    const account = this.resolveAccount(input, input.expectedAccountId);
    if (!account.ok) return { ok: false, error: account.error };
    const accountId = account.accountId;
    const body = input.body;

    // 1) 入口查回执：早于「当前代次已变化」检查；不泄露另一请求的成功。
    const entryReceipt = this.receipts.findReceipt(accountId, body.requestId);
    if (entryReceipt !== null) {
      return entryReceipt.requestFingerprint === input.requestFingerprint
        ? { ok: true, outcome: "committed", receipt: entryReceipt }
        : { ok: true, outcome: "request_id_conflict" };
    }

    // 2) 预览读取：缺失/替换/过期分别进入裁决（过期在裁决事务内删除后判终态）。
    let preview: StoredRestorePreview | null;
    try {
      preview = this.previews.get(accountId);
    } catch {
      return await this.adjudicate(input, "restore_unavailable");
    }
    if (preview === null || preview.previewId !== body.previewId) {
      return await this.adjudicate(input, "preview_replaced");
    }
    // 固定正文必须与预览逐字段绑定（§7.3）：不匹配的请求永远不能执行该预览；
    // 执行与失格裁决共用同一资格判断，不能先判不执行、随后仍然执行。
    if (!fixedRequestMatchesPreview(body, preview)) {
      return await this.adjudicate(input, "source_changed");
    }
    if (preview.expiresAtMs <= this.now()) {
      return await this.adjudicate(input, "preview_expired");
    }
    // 序列解释门禁（§7.1/§4.3）：未知对象、读取失败/不完整或归属不可解释时
    // 不继续提交；这不构成永久失格（外部原因解除后同一请求仍可重试）。
    const sequence = await this.explainBackupSequence(accountId);
    if (!sequence.ok) return await this.adjudicate(input, sequence.error);

    // 3) 事务外完整重新验证暂存目标：哈希、全新 Loro 导入、历史摘要与记录数。
    let targetSnapshot: Uint8Array;
    try {
      const stagedSnapshot = this.previews.readSnapshot(accountId);
      if (stagedSnapshot === null) return await this.adjudicate(input, "backup_invalid");
      targetSnapshot = stagedSnapshot;
      const stagedSha256 = await sha256Hex(stagedSnapshot);
      if (stagedSha256 !== preview.targetSnapshotSha256) {
        return await this.adjudicate(input, "backup_invalid");
      }
      const stagedAnalysis = await analyzeBackupSnapshot(targetSnapshot);
      if (stagedAnalysis.historyVersionSha256 !== preview.targetHistorySha256
        || stagedAnalysis.recordCount !== preview.targetRecordCount) {
        return await this.adjudicate(input, "backup_invalid");
      }
      const manifest = parseManifest(new TextEncoder().encode(preview.targetManifestJson));
      if (manifest.snapshotSha256 !== preview.targetSnapshotSha256
        || manifest.historyVersionSha256 !== preview.targetHistorySha256) {
        return await this.adjudicate(input, "backup_invalid");
      }
    } catch (error) {
      if (error instanceof BackupFormatError) return await this.adjudicate(input, "backup_invalid");
      return await this.adjudicate(input, "restore_unavailable");
    }

    // 4) 当前主快照读取与预览条件核对（哈希在事务外；字节供最终事务精确比较）。
    let current: CurrentDocumentState | null;
    try {
      const head = this.documents.readDocumentHead(accountId);
      if (head === null) return await this.adjudicate(input, "generation_state_unavailable");
      current = await this.readCurrentDocumentState(accountId, head);
    } catch (error) {
      if (error instanceof GenerationStateUnavailableError) return await this.adjudicate(input, "generation_state_unavailable");
      return await this.adjudicate(input, "restore_unavailable");
    }
    if (current === null) return await this.adjudicate(input, "restore_unavailable");
    if (current.head.currentGeneration !== preview.expectedGeneration
      || current.cursor.currentRevision !== preview.expectedRevision
      || current.snapshotSha256 !== preview.expectedSnapshotSha256
      || current.historySha256 !== preview.expectedHistorySha256) {
      return await this.adjudicate(input, "source_changed");
    }

    // 5) 保护门禁与保护包完整读回（§7.2）：不提前备份重试、不新增第二个发布者。
    const gateCode = this.checkProtectionGate(current.cursor, this.now());
    if (gateCode !== null) return await this.adjudicate(input, gateCode);
    const protectionRevision = current.cursor.latestCompletedRevision;
    const protection = protectionRevision === null
      ? null
      : this.backupStore.getCompletion(accountId, protectionRevision);
    if (protection === null) {
      // 当前版本没有完成备份覆盖：等待正常备份，不提供跳过入口。
      return await this.adjudicate(input, "backup_not_ready");
    }
    const protectionGeneration = protection.sourceGeneration ?? current.head.legacyGeneration;
    if (protectionGeneration !== current.head.currentGeneration) {
      // 最新完成版本不属于当前代次：不能作为恢复前保护。
      return await this.adjudicate(input, "backup_not_ready");
    }
    let protectionManifest: BackupManifest;
    try {
      const read = await this.readAndVerifyCompletion(accountId, protection);
      if (!read.ok) return await this.adjudicate(input, read.error);
      protectionManifest = read.manifest;
    } catch {
      return await this.adjudicate(input, "restore_unavailable");
    }
    // 保护包的快照哈希必须与当前持久主快照一致（摘要匹配不足以单独授权）。
    if (protectionManifest.snapshotSha256 !== current.snapshotSha256) {
      return await this.adjudicate(input, "backup_not_ready");
    }

    // 6) 唯一切换事务：全部复核通过后原子写入；任一写入失败整体回滚。
    try {
      const outcome = await this.storage.transaction(async () => this.runSwitchTransaction(
        input, accountId, preview!, current!, protection, targetSnapshot,
      ));
      if (outcome.kind === "committed") return { ok: true, outcome: "committed", receipt: outcome.receipt };
      if (outcome.kind === "conflict") return { ok: true, outcome: "request_id_conflict" };
      if (outcome.kind === "expired_deleted") return { ok: true, outcome: "not_committed", reason: "preview_expired" };
      return await this.adjudicate(input, outcome.code);
    } catch {
      // SQL/写入失败：事务已整体回滚；短裁决决定终态，不能直接宣称未执行。
      return await this.adjudicate(input, "restore_unavailable");
    }
  }

  /** 回执只读查询（A 合同不变）：不存在返回 receipt=null，不证明请求未提交。 */
  read(input: ReadRestoreReceiptInput): ReadRestoreReceiptResult {
    const account = this.resolveAccount(input, input.expectedAccountId);
    if (!account.ok) return { ok: false, error: account.error };
    return { ok: true, receipt: this.receipts.findReceipt(account.accountId, input.requestId) };
  }

  /**
   * storage.sync() 失败后的确认裁决（DO 包装层调用）：只重查回执——committed 优先；
   * 无回执一律 unknown。不做预览删除或终态判定：原事务的持久性未知，请求可能仍可执行。
   */
  async adjudicateAfterSyncFailure(input: SubmitRestoreInput): Promise<SubmitRestoreResult> {
    try {
      return await this.storage.transaction(async () => {
        const account = this.resolveAccount(input, input.expectedAccountId);
        if (!account.ok) return { ok: false, error: account.error } as SubmitRestoreResult;
        const receipt = this.receipts.findReceipt(account.accountId, input.body.requestId);
        if (receipt !== null) {
          return receipt.requestFingerprint === input.requestFingerprint
            ? { ok: true, outcome: "committed", receipt } as SubmitRestoreResult
            : { ok: true, outcome: "request_id_conflict" } as SubmitRestoreResult;
        }
        return { ok: true, outcome: "unknown" } as SubmitRestoreResult;
      });
    } catch {
      return { ok: true, outcome: "unknown" };
    }
  }

  // -------------------------------------------------------------------------
  // 唯一切换事务（§7.3 步骤 4-5）：复核全部为字节/SQL 比较，无哈希与外部 I/O。
  // -------------------------------------------------------------------------

  private async runSwitchTransaction(
    input: SubmitRestoreInput,
    accountId: string,
    preview: StoredRestorePreview,
    verified: CurrentDocumentState,
    protection: BackupCompletionRecord,
    targetSnapshot: Uint8Array,
  ): Promise<
    | { kind: "committed"; receipt: RestoreReceipt }
    | { kind: "conflict" }
    | { kind: "expired_deleted" }
    | { kind: "reject"; code: string }
  > {
    const body = input.body;
    const nowMs = this.now();
    // 事务内重新鉴权。
    const account = this.resolveAccount(input, input.expectedAccountId);
    if (!account.ok) return { kind: "reject", code: account.error };
    // 事务内重新查重：并发同 ID 调用可能已提交。
    const receipt = this.receipts.findReceipt(accountId, body.requestId);
    if (receipt !== null) {
      if (receipt.requestFingerprint === input.requestFingerprint) return { kind: "committed", receipt };
      return { kind: "conflict" };
    }
    // 预览复核：仍匹配、未消费且未过期；过期在同一事务内删除并返回终态。
    const previewNow = this.previews.get(accountId);
    if (previewNow === null || previewNow.previewId !== body.previewId) {
      return { kind: "reject", code: "preview_replaced" };
    }
    // 事务内再次核对固定正文与预览的绑定（与入口、裁决同一资格判断）。
    if (!fixedRequestMatchesPreview(body, previewNow)) {
      return { kind: "reject", code: "source_changed" };
    }
    if (previewNow.expiresAtMs <= nowMs) {
      this.previews.delete(accountId);
      return { kind: "expired_deleted" };
    }
    // 版本复核：当前代次与 revision 与预览绑定一致。
    let head: DocumentGenerationHead | null;
    try {
      head = this.documents.readDocumentHead(accountId);
    } catch {
      return { kind: "reject", code: "generation_state_unavailable" };
    }
    const cursor = this.backupStore.getCursor(accountId);
    if (head === null || cursor === null) return { kind: "reject", code: "restore_unavailable" };
    if (head.currentGeneration !== preview.expectedGeneration
      || cursor.currentRevision !== preview.expectedRevision) {
      return { kind: "reject", code: "source_changed" };
    }
    // 主表字节与事务外读取并验证的字节完全一致（迟到内存目标不能提交）。
    let bytesNow: Uint8Array | null;
    try {
      bytesNow = this.documents.readSnapshotBytesForGeneration(accountId, head.currentGeneration);
    } catch {
      return { kind: "reject", code: "generation_state_unavailable" };
    }
    if (bytesNow === null || !bytesEqual(bytesNow, verified.snapshot)) {
      return { kind: "reject", code: "source_changed" };
    }
    // 保护门禁复核：blocked、冻结任务、待备、清理与失败下限全部空闲。
    const gateCode = this.checkProtectionGate(cursor, nowMs);
    if (gateCode !== null) return { kind: "reject", code: gateCode };
    // 保护完成记录与读回引用未改变。
    const protectionNow = cursor.latestCompletedRevision === null
      ? null
      : this.backupStore.getCompletion(accountId, cursor.latestCompletedRevision);
    if (protectionNow === null
      || protectionNow.revision !== protection.revision
      || protectionNow.bundleSha256 !== protection.bundleSha256
      || (protectionNow.sourceGeneration ?? head.legacyGeneration) !== head.currentGeneration) {
      return { kind: "reject", code: "backup_not_ready" };
    }

    // 全部条件满足：执行切换。以下任一写入失败则整个事务回滚。
    const previousGeneration = head.currentGeneration;
    const previousRevision = cursor.currentRevision;
    const newRevision = previousRevision + 1;
    const origin = {
      kind: "restore" as const,
      requestId: body.requestId,
      previousGeneration,
      targetBackup: {
        backupStreamId: preview.backupStreamId,
        revision: preview.revision,
        bundleSha256: preview.bundleSha256,
      },
      protectionBackup: {
        backupStreamId: protection.streamId,
        revision: protection.revision,
        bundleSha256: protection.bundleSha256,
      },
    };
    const newHead = this.documents.switchDocumentGeneration(accountId, origin, nowMs);
    this.documents.replaceMainSnapshot(accountId, newHead.currentGeneration, targetSnapshot);
    this.backupStore.advanceRevisionForRestore(accountId, newRevision, nowMs);
    this.backupStore.insertTask({
      accountId,
      streamId: cursor.streamId,
      revision: newRevision,
      reason: "restore-baseline",
      capturedAtMs: nowMs,
      sourceCommittedAtMs: nowMs,
      previousCompletedRevision: cursor.latestCompletedRevision,
      firstPendingRevision: null,
      sourceGeneration: newHead.currentGeneration,
      formatVersion: BACKUP_FORMAT_VERSION_V2,
      generationOrigin: origin,
    });
    // 恢复基线：attemptCount=0、首次发布固定在切换后窗口时间（生产 30 秒）。
    this.backupStore.scheduleRestoreBaselineTask(accountId, nowMs + this.schedule.windowMs);
    this.backupStore.writeTaskChunksFromBytes(accountId, targetSnapshot);
    const committedReceipt: RestoreReceipt = {
      requestId: body.requestId,
      requestFingerprint: input.requestFingerprint,
      previousGeneration,
      newGeneration: newHead.currentGeneration,
      previousRevision,
      newRevision,
      sourceBackup: origin.targetBackup,
      protectionBackup: origin.protectionBackup,
      // 提交时新代次的恢复基线备份尚未完成（首次发布安排在切换后 30 秒）。
      baselinePending: true,
      committedAtMs: nowMs,
    };
    this.receipts.insertReceipt({ accountId, ...committedReceipt });
    this.previews.delete(accountId);
    // 消费 preview 与安排 alarm 在同一事务内：任一写入失败整体回滚。
    await this.alarms.rescheduleAlarmWithinTransaction(nowMs);
    return { kind: "committed", receipt: committedReceipt };
  }

  // -------------------------------------------------------------------------
  // 短裁决事务（§7.3 请求结果裁决）：重新鉴权、查回执、持久条件判定。
  // -------------------------------------------------------------------------

  private async adjudicate(input: SubmitRestoreInput, failCode: string): Promise<SubmitRestoreResult> {
    const body = input.body;
    try {
      const outcome = await this.storage.transaction(async () => {
        const nowMs = this.now();
        // 会话失效不泄露回执：先鉴权再读回执。
        const account = this.resolveAccount(input, input.expectedAccountId);
        if (!account.ok) return { status: "auth_error", error: account.error } as const;
        // committed 优先：并发同 ID 调用可能已提交。
        const receipt = this.receipts.findReceipt(account.accountId, body.requestId);
        if (receipt !== null) {
          return receipt.requestFingerprint === input.requestFingerprint
            ? { status: "committed", receipt } as const
            : { status: "conflict" } as const;
        }
        // 持久条件判定：原 previewId 已不存在或被另一 ID 替换。
        const preview = this.previews.get(account.accountId);
        if (preview === null || preview.previewId !== body.previewId) {
          return { status: "not_committed", reason: "preview_replaced" } as const;
        }
        // 固定正文与预览逐字段绑定（与执行路径同一资格判断）：不匹配永远不能执行。
        if (!fixedRequestMatchesPreview(body, preview)) {
          return { status: "not_committed", reason: "source_changed" } as const;
        }
        // 到期预览在同一事务内删除匹配 ID 与暂存；删除失败整体回滚 → unknown。
        if (preview.expiresAtMs <= nowMs) {
          this.previews.delete(account.accountId);
          return { status: "not_committed", reason: "preview_expired" } as const;
        }
        // 有效、未回退的代次/单调 revision 已越过原预览绑定的版本。
        let head: DocumentGenerationHead | null = null;
        try {
          head = this.documents.readDocumentHead(account.accountId);
        } catch {
          head = null;
        }
        const cursor = this.backupStore.getCursor(account.accountId);
        if (head !== null && cursor !== null
          && (head.currentGeneration !== preview.expectedGeneration
            || cursor.currentRevision > preview.expectedRevision)) {
          return { status: "not_committed", reason: "source_changed" } as const;
        }
        // 单纯哈希不符、R2 故障、blocked、备份未就绪、revision 未推进或状态归属
        // 不可证明：保留 unknown，不伪造终态。
        return { status: "unknown", code: failCode } as const;
      });
      switch (outcome.status) {
        case "auth_error": return { ok: false, error: outcome.error };
        case "committed": return { ok: true, outcome: "committed", receipt: outcome.receipt };
        case "conflict": return { ok: true, outcome: "request_id_conflict" };
        case "not_committed": return { ok: true, outcome: "not_committed", reason: outcome.reason };
        case "unknown": return { ok: true, outcome: "unknown", errorCode: outcome.code };
      }
    } catch {
      // 裁决事务自身失败：unknown。
      return { ok: true, outcome: "unknown", errorCode: failCode };
    }
  }

  // -------------------------------------------------------------------------
  // 共用读取与门禁。
  // -------------------------------------------------------------------------

  /**
   * 一致读取当前主文档状态：短事务内读 head/游标/主快照字节，事务外完成哈希与
   * 全新 Loro 分析。无主文档返回 null；代次标签不可解释抛 GenerationStateUnavailableError。
   */
  private async readCurrentDocumentState(accountId: string, head: DocumentGenerationHead): Promise<CurrentDocumentState | null> {
    const state = this.readCurrentSnapshotWithin(accountId, head.currentGeneration);
    if (state === null) return null;
    const snapshotSha256 = await sha256Hex(state.snapshot);
    const analysis = await analyzeBackupSnapshot(state.snapshot);
    return {
      head: state.head,
      cursor: state.cursor,
      snapshot: state.snapshot,
      snapshotSha256,
      historySha256: analysis.historyVersionSha256,
    };
  }

  /**
   * 事务内的纯 SQL 一致读取（可在调用方事务内嵌套）：head、游标与主快照字节。
   * head 读取抛 GenerationStateUnavailableError 时向上传播。
   */
  private readCurrentSnapshotWithin(accountId: string, expectedGeneration: string): { head: DocumentGenerationHead; cursor: BackupCursorState; snapshot: Uint8Array } | null {
    const head = this.documents.readDocumentHead(accountId);
    if (head === null) throw new GenerationStateUnavailableError("head_missing_during_restore_read");
    const cursor = this.backupStore.getCursor(accountId);
    if (cursor === null) throw new Error("backup_cursor_missing");
    const snapshot = this.documents.readSnapshotBytesForGeneration(accountId, expectedGeneration);
    if (snapshot === null) return null;
    return { head, cursor, snapshot };
  }

  /**
   * 保护门禁（§7.2）：blocked、冻结任务、待备版本、保留检查、裁剪计划或尚未到期的
   * 失败下限都会阻止最终确认；返回对应错误码，空闲返回 null。
   * 存在待备变化时等待原 30 秒窗口及正常 alarm，不提前失败重试。
   */
  private checkProtectionGate(cursor: BackupCursorState, nowMs: number): string | null {
    if (cursor.blockedError !== null) return "backup_blocked";
    if (cursor.pendingRevision !== null) return "backup_not_ready";
    const task = this.backupStore.getTask(cursor.accountId);
    if (task !== null) return "backup_not_ready";
    if (this.backupStore.getRetention(cursor.accountId) !== null
      || this.backupStore.listPrunePlan(cursor.accountId).length > 0) {
      return "backup_not_ready";
    }
    if (cursor.retryFloorAtMs !== null && cursor.retryFloorAtMs > nowMs) return "backup_not_ready";
    return null;
  }

  /**
   * 完整读回一个完成版本的标记与包（恢复预览与保护验证共用）：标记内容与完成缓存
   * 核对，包按共享验证器核对（哈希、归属、格式、快照、全新 Loro 导入、摘要与计数）。
   * 验证失败返回错误码；R2 I/O 异常向上抛出（调用方按可重试失败处理）。
   */
  private async readAndVerifyCompletion(
    accountId: string,
    completion: BackupCompletionRecord,
  ): Promise<{ ok: true; manifest: BackupManifest; snapshot: Uint8Array } | { ok: false; error: "backup_invalid" }> {
    const markerKey = commitMarkerKey(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, completion.streamId, completion.revision);
    const markerBytes = await this.objectStore.getMarker(markerKey);
    if (markerBytes === null || markerBytes === "too_large") return { ok: false, error: "backup_invalid" };
    try {
      verifyMarkerContent({ bytes: markerBytes, expectedMarker: buildCompletionMarker(completion) });
    } catch (error) {
      if (error instanceof BackupVerificationError) return { ok: false, error: "backup_invalid" };
      throw error;
    }
    const bundleBytes = await this.objectStore.getBundle(completion.bundleKey);
    if (bundleBytes === null || bundleBytes === "too_large") return { ok: false, error: "backup_invalid" };
    try {
      const read = await verifyCompletedBackup({
        bytes: bundleBytes,
        expected: {
          environment: BACKUP_ENVIRONMENT,
          accountId,
          documentType: BACKUP_DOCUMENT_TYPE,
          streamId: completion.streamId,
          revision: completion.revision,
          bundleSha256: completion.bundleSha256,
          bundleBytes: completion.bundleBytes,
          formatVersion: completion.formatVersion,
          historySha256: completion.historySha256,
          recordCount: completion.recordCount,
          snapshotSha256: completion.snapshotSha256,
        },
      });
      return { ok: true, manifest: read.manifest, snapshot: read.snapshot };
    } catch (error) {
      if (error instanceof BackupVerificationError) return { ok: false, error: "backup_invalid" };
      throw error;
    }
  }

  /** 预览响应的保护等待描述（只读元数据；最终 POST 仍必须完整保护读回）。 */
  private describeProtection(accountId: string, current: CurrentDocumentState): RestorePreviewDescriptor["protection"] {
    const cursor = current.cursor;
    const task = this.backupStore.getTask(accountId);
    const protectionRevision = cursor.latestCompletedRevision;
    // 有效可行动时间与唯一 alarm 同源（责任优先级 + 持久失败下限）；blocked
    // 表示自动推进已停止、无责任表示没有自动计划——两者都不承诺自动恢复时间。
    const nextAttemptAtMs = this.alarms.nextProtectionActionAtMs(accountId, this.now());
    if (cursor.blockedError !== null) {
      return { covered: false, waitingReason: "backup_blocked", nextAttemptAtMs, protectionRevision };
    }
    if (task !== null) return { covered: false, waitingReason: "backup_task_in_progress", nextAttemptAtMs, protectionRevision };
    if (this.backupStore.getRetention(accountId) !== null
      || this.backupStore.listPrunePlan(accountId).length > 0) {
      return { covered: false, waitingReason: "cleanup_pending", nextAttemptAtMs, protectionRevision };
    }
    if (cursor.pendingRevision !== null) {
      return { covered: false, waitingReason: "pending_backup_window", nextAttemptAtMs, protectionRevision };
    }
    const covered = cursor.latestCompletedRevision !== null
      && cursor.latestCompletedHistorySha256 === current.historySha256
      && (cursor.latestCompletedGeneration ?? current.head.legacyGeneration) === current.head.currentGeneration;
    if (!covered) return { covered: false, waitingReason: "coverage_mismatch", nextAttemptAtMs: null, protectionRevision };
    return { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision };
  }
}

/** 存储行 → 预览描述符（快照读取响应；保护状态不再重算，由创建响应提供）。 */
function previewDescriptorFrom(preview: StoredRestorePreview): RestorePreviewDescriptor {
  return {
    previewId: preview.previewId,
    expiresAtMs: preview.expiresAtMs,
    createdAtMs: preview.createdAtMs,
    target: {
      backupStreamId: preview.backupStreamId,
      revision: preview.revision,
      bundleSha256: preview.bundleSha256,
      snapshotSha256: preview.targetSnapshotSha256,
      historySha256: preview.targetHistorySha256,
      recordCount: preview.targetRecordCount,
      capturedAtMs: preview.targetCapturedAtMs,
    },
    expected: {
      generation: preview.expectedGeneration,
      revision: preview.expectedRevision,
      snapshotSha256: preview.expectedSnapshotSha256,
      historySha256: preview.expectedHistorySha256,
    },
    protection: { covered: false, waitingReason: "protection_state_not_recomputed", nextAttemptAtMs: null, protectionRevision: null },
  };
}

/** 固定请求与预览的逐字段绑定（§7.3）：目标引用与预期源条件必须完全一致。 */
function fixedRequestMatchesPreview(body: RestoreRequestBody, preview: StoredRestorePreview): boolean {
  return body.backupStreamId === preview.backupStreamId
    && body.revision === preview.revision
    && body.bundleSha256 === preview.bundleSha256
    && body.expectedGeneration === preview.expectedGeneration
    && body.expectedRevision === preview.expectedRevision
    && body.expectedSnapshotSha256 === preview.expectedSnapshotSha256;
}

/** 预览写入事务的受控中止：条件不满足时回滚整个事务并映射为固定错误码。 */
class PreviewAbortError extends Error {
  constructor(readonly code: "unauthorized" | "account_changed" | "preview_replaced" | "source_changed") {
    super(`restore_preview_aborted: ${code}`);
    this.name = "PreviewAbortError";
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
