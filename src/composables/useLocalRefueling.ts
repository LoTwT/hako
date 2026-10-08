import { computed, onMounted, onUnmounted, readonly, shallowRef, watch } from "vue";
import {
  openLocalRefuelingV2,
  type GenerationReadResult,
  type GenerationWriteResult,
  type LocalRefuelingState,
  type LocalRefuelingV2Repository,
  type PendingRestoreIdentity,
  type RetainedGenerationSummary,
  type RetainedGenerationView,
} from "../data/local-refueling-v2";
import { accountStorageNamesV2 } from "../data/account-storage";
import { RefuelingSyncClient, type SyncStatus } from "../data/refueling-sync";
import { bootstrapRefueling, fetchRefuelingSnapshot, type BootstrapInfo } from "../data/refueling-server-api";
import {
  fingerprintRestoreRequest,
  notCommittedOutcome,
  outcomeFromCommittedReceipt,
  queryRestoreReceipt,
  submitRestoreRequest,
} from "../data/refueling-restore";
import type { RefuelingRecord, SavedRefuelingRecord } from "../domain/refueling/form";
import type { PendingRestoreRequest, RestoreOutcomeRecord, RestoreRequestBody } from "../data/refueling-restore";

/**
 * 代次工作流状态：
 * - opening：正在打开本机库/确认代次。
 * - active：本机工作区可用（generation 为工作区绑定代次）。serverConfirmed=false
 *   表示离线/服务暂不可用时按本机持久代次打开（既有离线能力），代次尚未经
 *   bootstrap 联网确认——回网后重判；同步上传由服务端 409 纠正漂移。
 * - protected：服务端（或本机共享控制）代次与本工作区不一致（账号数据已在另一处
 *   恢复/接收）；旧副本与草稿已保留，保存冻结，等待本人选择打开当前数据或查看
 *   保留副本。serverGeneration=null 表示尚需联网确认当前代次。
 * - failed：本机无可用数据且无法确认代次（全新浏览器或未升级的 v1 数据离线），
 *   可重试；本机数据保留。
 */
export type GenerationFlow =
  | { phase: "opening" }
  | { phase: "active"; generation: string; serverConfirmed: boolean }
  | {
    phase: "protected";
    localGeneration: string | null;
    serverGeneration: string | null;
    legacyGeneration: string | null;
    /**
     * 待确认恢复请求的回执查询状态；idle 表示无待确认请求。failed 表示回执
     * 已确认但本机终态落盘失败（原请求保留，未宣称任何结果，可重试）。
     */
    receipt: "idle" | "checking" | "unknown" | "committed" | "failed";
    message: string;
  }
  | { phase: "failed"; message: string };

/** 面板提交结果：服务端终态、待确认、本机保存门禁、请求已失效或本机终态落盘失败分别表达。 */
export type PanelSubmitOutcome =
  | { kind: "committed" }
  | { kind: "not_committed"; reason: string }
  | { kind: "conflict" }
  | { kind: "unknown"; errorCode: string | null }
  | { kind: "waiting_local_sync" }
  | { kind: "stale_request" }
  | { kind: "local-failed"; message: string }
  | { kind: "error"; message: string };

export function useLocalRefueling(options: { accountId: string; active: () => boolean; onSessionRejected: () => void }) {
  const records = shallowRef<SavedRefuelingRecord[]>([]);
  const ready = shallowRef(false);
  const saving = shallowRef(false);
  const error = shallowRef("");
  const persistent = shallowRef<boolean | null>(null);
  const pendingSync = shallowRef(false);
  const confirmed = shallowRef(false);
  const importedLegacyIds = shallowRef<string[]>([]);
  const syncStatus = shallowRef<SyncStatus>({ phase: "paused", message: "" });
  const generationFlow = shallowRef<GenerationFlow>({ phase: "opening" });
  const pendingRestore = shallowRef<PendingRestoreRequest | null>(null);
  const importConflicts = shallowRef<Record<string, string[]>>({});
  const migrationPending = shallowRef<string | null>(null);
  const controlLegacyGeneration = shallowRef<string | null>(null);
  const foregroundOnline = shallowRef(document.visibilityState === "visible" && navigator.onLine);
  const notice = computed(() => {
    if (!ready.value) return "正在打开账号的本机记录…";
    if (saving.value) return "正在保存到本机…";
    const flow = generationFlow.value;
    const offlineNote = flow.phase === "active" && !flow.serverConfirmed ? " · 代次待联网确认" : "";
    const local = pendingSync.value ? "已保存到本机 · 有待上传修改" : confirmed.value ? "本机版本已由服务端持久保存" : "本机副本尚未与服务端确认";
    return syncStatus.value.message ? `${local}${offlineNote} · ${syncStatus.value.message}` : `${local}${offlineNote}`;
  });
  let repository: LocalRefuelingV2Repository | undefined;
  let sync: RefuelingSyncClient | undefined;
  let channel: BroadcastChannel | undefined;
  let bootstrapInfo: BootstrapInfo | undefined;
  let disposed = false;
  let loadSequence = 0;
  let initializing: Promise<void> | undefined;
  let receiptChecking = false;
  /** 回执查询拥有的错误文本（归属具体请求）：成功后只清自己的错误，不动无关保存错误。 */
  let receiptQueryError = "";
  /** 查询完成时待确认已被更新请求取代：排队对当前新请求的跟进查询。 */
  let queuedFollowUpReceiptQuery = false;

  function describeError(value: unknown): string {
    if (value instanceof DOMException && value.name === "QuotaExceededError")
      return "本机存储空间不足，未保存成功。表单仍保留，请释放空间后重试。";
    return value instanceof Error ? `未完成本机操作：${value.message}。请保留表单后重试。` : "本机存储不可用，请保留表单后重试。";
  }
  function apply(state: LocalRefuelingState) {
    records.value = state.records;
    pendingSync.value = state.pendingSync;
    confirmed.value = state.confirmed;
    importedLegacyIds.value = state.importedLegacyIds;
  }
  function applyControlSnapshot(result: GenerationReadResult | GenerationWriteResult): void {
    pendingRestore.value = result.pendingRestore;
    // 冲突提示按当前代次仍存在的目标过滤：零/唯一存活目标不再显示为待核对
    // （历史证据仍在 control，导入路径按同一规则重判）。
    importConflicts.value = effectiveImportConflicts(result.importConflicts, result.records);
    if (result.legacyGeneration !== null) controlLegacyGeneration.value = result.legacyGeneration;
  }
  function notify() {
    try { channel?.postMessage("changed"); } catch { /* Focus refresh is the fallback. */ }
  }
  function updateSyncEnabled() {
    sync?.setEnabled(!disposed && options.active() && foregroundOnline.value && ready.value
      && generationFlow.value.phase === "active");
  }
  function setFlow(flow: GenerationFlow): void {
    generationFlow.value = flow;
    updateSyncEnabled();
  }

  /** 当前挂载工作区实例绑定的代次（AccountWorkspace 以此为挂载 key）。 */
  const workspaceGeneration = computed(() => {
    const flow = generationFlow.value;
    if (flow.phase === "active") return flow.generation;
    if (flow.phase === "protected") return flow.localGeneration ?? controlLegacyGeneration.value ?? null;
    return null;
  });

  /**
   * 区分三层代次（父审第二轮 R1/R2 修复基础）：
   * - 持久共享 activeGeneration（control，可被任何窗口推进）；
   * - 当前实例挂载工作区的固定代次（workspaceGeneration，key 卸载前不变）；
   * - 已确认的服务端目标（bootstrap/sync 元数据）。
   * 已有工作区的任何自动切换都必须先经旧草稿 flush 与本人接收（保护流程）；
   * 后台确认只能更新保护目标，不能替用户接收。
   */

  /** 进入保护流程：保留已挂载旧工作区（key 不变），保存冻结等待本人选择。 */
  function protectMountedWorkspace(serverGeneration: string | null, legacyGeneration: string | null, message: string): void {
    ready.value = true;
    setFlow({
      phase: "protected",
      localGeneration: workspaceGeneration.value,
      serverGeneration,
      legacyGeneration: legacyGeneration ?? controlLegacyGeneration.value,
      receipt: "idle",
      message,
    });
    void checkPendingRestoreReceipt();
  }

  /**
   * 按给定记录集过滤导入冲突：只有多个仍存在的目标才算当前冲突（零/唯一存活
   * 目标不再是多目标歧义；历史证据保留在 control，由导入路径按同一规则重判）。
   */
  function effectiveImportConflicts(conflicts: Record<string, string[]>, records: SavedRefuelingRecord[]): Record<string, string[]> {
    const existing = new Set(records.map((record) => record.id));
    return Object.fromEntries(
      Object.entries(conflicts)
        .map(([source, targets]) => [source, targets.filter((target) => existing.has(target))] as const)
        .filter(([, targets]) => targets.length > 1),
    );
  }

  /**
   * 重开时脱离旧同步客户端（停用 + 置空引用）：中途任何 setFlow/updateSyncEnabled
   * 都不能再启用绑定旧 repository 的实例；新客户端只绑定当前有效 repository。
   */
  function detachSyncClient(): void {
    sync?.setEnabled(false);
    sync = undefined;
  }

  /**
   * 为当前 repository 装配同步客户端（成功重开或保持旧实例的失败恢复时使用）。
   * 装配本身保证唯一：已有运行实例（必绑定当前 repository——旧实例只在重开
   * detach 时存在，此时引用已置空）不重复创建、不覆盖，成功/失败出口都不会
   * 留下第二个 enabled 客户端。
   */
  function attachSyncClient(): void {
    if (repository === undefined || sync !== undefined) return;
    sync = new RefuelingSyncClient({
      accountId: options.accountId, repository,
      generation: () => workspaceGeneration.value,
      onStatus: (status) => { syncStatus.value = status; },
      onPersisted: () => { notify(); void refresh(); },
      onSessionRejected: options.onSessionRejected,
      onGenerationChanged: (metadata) => {
        // 预览期间服务端推进：进入保护流程，不触发登录循环。
        const flow = generationFlow.value;
        const localGeneration = flow.phase === "active" ? flow.generation
          : flow.phase === "protected" ? flow.localGeneration : null;
        ready.value = true;
        setFlow({
          phase: "protected",
          localGeneration,
          serverGeneration: metadata.currentGeneration,
          legacyGeneration: metadata.legacyGeneration ?? bootstrapInfo?.legacyGeneration ?? controlLegacyGeneration.value,
          receipt: "idle",
          message: "账号数据已在另一处恢复。此设备原有记录和草稿已保留。",
        });
        void checkPendingRestoreReceipt();
      },
      onProtocolOutdated: () => {
        syncStatus.value = { phase: "failed", message: "应用版本过旧，已停止同步。请保存输入后更新应用；本机数据已保留。" };
      },
    });
    updateSyncEnabled();
  }

  /**
   * 代次绑定的刷新：读取工作区绑定代次的记录与同事务控制快照。共享控制已推进
   * （其他窗口接收了新代次）时进入保护流程，不能把新代次数据交给旧工作区的
   * 已保存判断；无 BroadcastChannel、锁等待中切换、旧窗口重新前台同样由此复核。
   */
  async function refresh() {
    if (!repository || saving.value) return;
    const sequence = ++loadSequence;
    const generation = workspaceGeneration.value;
    try {
      const result = await repository.readGenerationState(generation);
      if (!disposed && sequence === loadSequence) {
        apply(result);
        applyControlSnapshot(result);
        if (result.inactive) enterProtectedFromDrift(result.activeGeneration, result.legacyGeneration);
      }
    } catch (failure) { if (!disposed) error.value = describeError(failure); }
  }

  /** 本机共享控制被其他窗口推进后的本地保护转换（serverGeneration 取共享活动代次）。 */
  function enterProtectedFromDrift(activeGeneration: string | null, legacyGeneration: string | null): void {
    if (generationFlow.value.phase === "protected") return;
    protectMountedWorkspace(
      activeGeneration,
      legacyGeneration,
      "账号数据已在另一处更新。此设备原有记录和草稿已保留。",
    );
  }

  /**
   * 查询待确认恢复请求的回执（§7.6：先查回执再谈接收）。任何持久 pending 都
   * 可独立查询/确认——本机与服务端代次一致（active）时同样必须查询：B 的恢复
   * 可能已把本机接收为新代次但终态落盘失败，或另一窗口接收后仍保留 pending。
   * 查询成功先原子落盘终态；内存状态以重新读取的控制为准，迟到响应不能把
   * 更新的 pending 在内存里清掉。
   */
  async function checkPendingRestoreReceipt(): Promise<void> {
    if (!repository || receiptChecking) return;
    const control = await repository.readControl().catch(() => null);
    if (control === null || disposed) return;
    pendingRestore.value = control.pendingRestore;
    if (control.pendingRestore === null) return;
    receiptChecking = true;
    const startFlow = generationFlow.value;
    if (startFlow.phase === "protected") setFlow({ ...startFlow, receipt: "checking" });
    // 查询状态与错误归属具体 requestId + 指纹：所有出口先核对当前待确认是否
    // 仍归属本次查询的请求，不用「组件还在 protected」代替请求归属。
    const pending = control.pendingRestore;
    /** 本请求已被**另一个**请求取代（仍存在新待确认）：本请求的一切迟到结果
     * 不得显示给新请求。pending 已清空（本请求或他页已终态）不算取代。 */
    const replacedByNewRequest = (): boolean =>
      pendingRestore.value !== null
      && (pendingRestore.value.requestId !== pending.requestId
        || pendingRestore.value.requestFingerprint !== pending.requestFingerprint);
    /** 本请求的回执查询结束：结果归属本请求。 */
    const finishFor = (receipt: "committed" | "unknown" | "failed" | "idle"): void => {
      const current = generationFlow.value;
      if (current.phase === "protected") setFlow({ ...current, receipt });
    };
    try {
      const query = await queryRestoreReceipt({ accountId: options.accountId }, pending.requestId);
      if (disposed) return;
      if (query.status === "committed" && query.receipt.requestFingerprint === pending.requestFingerprint) {
        // 终态先落盘（持久边界），404/超时不解除待确认。落盘失败（配额/事务）
        // 不宣称任何结果：原请求/正文保留，进入可重试的 failed 状态；调用链
        // 全部为 void，这里必须自行消化拒绝，不留未处理 rejection。
        await repository.resolveRestoreOutcome(outcomeFromCommittedReceipt(pending, query.receipt));
        // 以最新控制为准：resolve 拒绝说明已有更新的请求（或他页已处理），
        // 迟到的本响应不能在内存里清掉那份更新的 pending。
        const latest = await repository.readControl().catch(() => null);
        if (!disposed && latest !== null) pendingRestore.value = latest.pendingRestore;
        // 本请求的旧错误（含此前的落盘失败）随本请求确认清除——只清回执查询
        // 拥有的错误文本，error 位上无关的保存错误原样保留。
        if (receiptQueryError !== "") {
          if (error.value === receiptQueryError) error.value = "";
          receiptQueryError = "";
        }
        if (disposed) return;
        if (replacedByNewRequest()) {
          // 新请求已取代本请求：旧 committed 不显示给新 pending，回位 idle
          // 并排队对当前新请求的跟进查询。
          queuedFollowUpReceiptQuery = true;
          finishFor("idle");
          return;
        }
        // pending 已清空（本请求终态确认/他页已处理）或仍是本请求：committed。
        finishFor("committed");
        return;
      }
      if (disposed) return;
      if (replacedByNewRequest()) {
        queuedFollowUpReceiptQuery = true;
        finishFor("idle");
        return;
      }
      if (pendingRestore.value === null) {
        // 本请求已被他页终态处理（pending 清空）：迟到的 unknown 不再展示。
        finishFor("idle");
        return;
      }
      finishFor("unknown");
    } catch {
      // 终态落盘失败：保留原 pending（事务已回滚），不虚报 committed/
      // not_committed；只有失败仍归属当前请求时才更新本实例错误与 failed
      // 状态——迟到的错误不得显示给已取代它的新请求或已终态处理的清空状态。
      if (!disposed && !replacedByNewRequest() && pendingRestore.value !== null) {
        receiptQueryError = "本机保存恢复结果失败，原请求已保留。请释放本机空间后重试查询。";
        error.value = receiptQueryError;
        finishFor("failed");
      } else if (!disposed && replacedByNewRequest()) {
        queuedFollowUpReceiptQuery = true;
        finishFor("idle");
      }
    } finally {
      receiptChecking = false;
      if (queuedFollowUpReceiptQuery) {
        queuedFollowUpReceiptQuery = false;
        // 当前待确认已被新请求取代：对它发起跟进查询（任何持久 pending 都可
        // 独立查询/确认）。
        void checkPendingRestoreReceipt();
      }
    }
  }

  /** 根据本机控制状态与 bootstrap 结果决策工作流。 */
  async function applyBootstrapDecision(): Promise<void> {
    if (!repository || !bootstrapInfo) return;
    const control = await repository.readControl();
    controlLegacyGeneration.value = control.legacyGeneration;
    pendingRestore.value = control.pendingRestore;
    const decision = decideWorkspaceOpen({
      activeGeneration: control.activeGeneration,
      legacyGeneration: control.legacyGeneration,
      hasLocalData: await repository.hasAnyGeneration(),
      serverGeneration: bootstrapInfo.documentGeneration,
      serverLegacyGeneration: bootstrapInfo.legacyGeneration,
    });
    if (decision.action === "normal") {
      const target = control.activeGeneration!;
      if (workspaceGeneration.value !== null && workspaceGeneration.value !== target) {
        // 共享控制已被其他窗口推进，但本实例已挂载旧工作区（离线打开后迟到的
        // bootstrap/回网重确认）：不能自动切换——旧表单/草稿未经 flush 与本人
        // 接收。进入保护流程，保存冻结，等待本人选择打开当前数据。
        protectMountedWorkspace(
          bootstrapInfo.documentGeneration,
          bootstrapInfo.legacyGeneration,
          "账号数据已在另一处更新。此设备原有记录和草稿已保留。",
        );
        await refresh();
        return;
      }
      ready.value = true;
      setFlow({ phase: "active", generation: target, serverConfirmed: true });
      await refresh();
      void checkPendingRestoreReceipt();
      return;
    }
    if (decision.action === "activate") {
      // 决策与激活之间存在异步边界：CAS 复核共享控制仍是决策时的前置状态，
      // 其他窗口已接收新代次时不把共享 activeGeneration 改回旧代次。
      const activation = await repository.activateGeneration(bootstrapInfo.documentGeneration, control.activeGeneration);
      if (activation.status === "stale") {
        await reopenWithBootstrap();
        return;
      }
      if (workspaceGeneration.value !== null && workspaceGeneration.value !== bootstrapInfo.documentGeneration) {
        protectMountedWorkspace(
          bootstrapInfo.documentGeneration,
          bootstrapInfo.legacyGeneration,
          "账号数据已在另一处更新。此设备原有记录和草稿已保留。",
        );
        await refresh();
        return;
      }
      apply(activation.state);
      ready.value = true;
      setFlow({ phase: "active", generation: bootstrapInfo.documentGeneration, serverConfirmed: true });
      await refresh();
      void checkPendingRestoreReceipt();
      return;
    }
    if (decision.action === "receive") {
      // 全新浏览器：GET 当前快照建立本机副本；204 时在已知代次下创建合法空文档。
      const expectedActive = control.activeGeneration;
      const snapshot = await fetchRefuelingSnapshot({ accountId: options.accountId });
      if (!snapshot.ok) {
        setFlow({ phase: "failed", message: "暂时无法获取当前数据，请稍后重试。" });
        return;
      }
      if (snapshot.snapshot.documentGeneration !== bootstrapInfo.documentGeneration) {
        await reopenWithBootstrap();
        return;
      }
      const outcome = await repository.receiveGeneration(bootstrapInfo.documentGeneration, snapshot.snapshot.snapshot, expectedActive);
      if (outcome.status === "stale") {
        await reopenWithBootstrap();
        return;
      }
      apply(outcome.state);
      ready.value = true;
      setFlow({ phase: "active", generation: bootstrapInfo.documentGeneration, serverConfirmed: true });
      // 新代次的控制快照（含按该代次过滤的导入冲突与待确认恢复）。
      await refresh();
      void checkPendingRestoreReceipt();
      return;
    }
    // generation-changed：保护流程——旧副本已由迁移/保存保留，保存冻结等待本人
    // 选择。已挂载旧工作区保持（localGeneration 取其实际绑定代次）。
    protectMountedWorkspace(
      bootstrapInfo.documentGeneration,
      bootstrapInfo.legacyGeneration,
      "账号数据已在另一处恢复。此设备原有记录和草稿已保留。",
    );
    await refresh();
  }

  async function open() {
    if (saving.value) return;
    error.value = "";
    // 重开先脱离旧同步客户端（停用 + 置空引用，在途交换被中止且不可再被启用）；
    // 已挂载工作区在重开/重试期间保持挂载（key 不变）：失败或后台确认不得先
    // 卸载旧实例。只有没有可保持的工作区（首次打开/失败态）才进入 opening。
    detachSyncClient();
    if (workspaceGeneration.value === null) {
      ready.value = false;
      setFlow({ phase: "opening" });
    }
    try {
      // 先打开新连接再换绑/回收旧 repository：新库打开失败时旧连接保持可用，
      // 不会把 repository 留成已关闭对象。已挂载工作区与旧草稿兜底不受影响。
      const previousRepository = repository;
      const opened = await openLocalRefuelingV2({ accountId: options.accountId, legacyGeneration: null });
      repository = opened;
      previousRepository?.close();
      if (disposed) { repository.close(); return; }
      // 已持久控制优先：此前迁移过的账号离线也有确定的 legacy 绑定，不随机生成。
      const control = await repository.readControl();
      controlLegacyGeneration.value = control.legacyGeneration;
      pendingRestore.value = control.pendingRestore;
      if (control.legacyGeneration !== null) {
        repository.setLegacyBinding(control.legacyGeneration);
        const migration = await repository.migrateFromV1().catch((failure) => ({ changed: false, pendingMergeError: describeError(failure) }));
        migrationPending.value = migration.pendingMergeError;
      }
      const localOutcome: "active" | "retained-only" | "empty" = control.activeGeneration !== null
        ? "active"
        : await repository.hasAnyGeneration() ? "retained-only" : "empty";

      // 本机可用先就绪（离线回退）：已持久的账号/代次按既有门禁打开本机工作区。
      if (localOutcome === "active") {
        const activeGeneration = control.activeGeneration as string;
        if (workspaceGeneration.value !== null && workspaceGeneration.value !== activeGeneration) {
          // 共享控制已被其他窗口推进（重开期间发现漂移）：已挂载旧工作区保持，
          // 进入保护流程等待本人接收；不把新代次数据直接交给旧工作区。
          protectMountedWorkspace(
            activeGeneration,
            control.legacyGeneration,
            "账号数据已在另一处更新。此设备原有记录和草稿已保留。",
          );
        } else {
          const result = await repository.readGenerationState(activeGeneration);
          apply(result);
          applyControlSnapshot(result);
          ready.value = true;
          setFlow({ phase: "active", generation: activeGeneration, serverConfirmed: false });
        }
      } else if (localOutcome === "retained-only") {
        ready.value = true;
        // 冲突提示按当前（旧工作区/空）记录过滤：零/唯一存活目标不显示为冲突。
        importConflicts.value = effectiveImportConflicts(control.importConflicts, records.value);
        setFlow({
          phase: "protected",
          localGeneration: null,
          serverGeneration: null,
          legacyGeneration: control.legacyGeneration,
          receipt: "idle",
          message: "需要联网确认账号当前数据；本机保留副本可查看，原有输入已保留。",
        });
        void checkPendingRestoreReceipt();
      }

      // bootstrap 尽力而为：失败不推翻本地可用状态，等待回网重试。
      const bootstrap = await bootstrapRefueling({ accountId: options.accountId });
      if (bootstrap.ok) {
        bootstrapInfo = bootstrap.info;
        repository.setLegacyBinding(bootstrap.info.legacyGeneration);
        const migration = await repository.migrateFromV1().catch((failure) => ({ changed: false, pendingMergeError: describeError(failure) }));
        migrationPending.value = migration.pendingMergeError;
        await applyBootstrapDecision();
      } else {
        if (bootstrap.error === "unauthorized" || bootstrap.error === "account_changed") {
          options.onSessionRejected();
        }
        if (localOutcome === "empty") {
          setFlow({
            phase: "failed",
            message: bootstrap.error === "generation_state_unavailable"
              ? "账号数据状态暂不可用，本机数据已保留。请稍后重试。"
              : "暂时无法连接服务，本机数据已保留。请稍后重试。",
          });
        }
      }
      if (disposed) return;
      // 只为当前有效 repository 装配客户端；旧实例已在开头脱离，不会中途复活。
      attachSyncClient();
      // 持久性是可选观测：查询失败只表示未知（null），不进入重开异常出口、
      // 不触发工作区/同步重装。
      persistent.value = await navigator.storage?.persisted?.().catch(() => null) ?? null;
    } catch (failure) {
      error.value = describeError(failure);
      if (workspaceGeneration.value !== null) {
        // 已挂载工作区保持（key 不变）：打开/读取/确认失败不卸载旧实例、
        // 不把未确认 flush 的表单/草稿拆掉。repository 仍指向当前有效连接
        // （新库未换绑时为旧连接），同步按可用状态重新装配或保持停用，
        // 错误显示为可重试。
        ready.value = true;
        if (!disposed && repository !== undefined) attachSyncClient();
      } else {
        // 没有旧实例的首次失败：failed 占位可重试。
        setFlow({ phase: "failed", message: describeError(failure) });
      }
    }
  }
  function initialize() {
    initializing ??= open().finally(() => { initializing = undefined; });
    return initializing;
  }
  /** 显式重试（失败流程与待联网确认状态都可用）。 */
  function retryOpen(): void {
    if (initializing === undefined) void initialize();
  }

  /** 本人选择「打开恢复后数据」：下载 + 控制事务内 CAS 接收（§6.2 步骤 5）。 */
  async function openCurrentGeneration(): Promise<{ ok: boolean; message: string }> {
    if (!repository) return { ok: false, message: "本机数据尚未就绪。" };
    const flow = generationFlow.value;
    if (flow.phase !== "protected") return { ok: true, message: "" };
    if (flow.serverGeneration === null) {
      return { ok: false, message: "需要联网确认账号当前数据后再打开。" };
    }
    try {
      // 下载发起时的本机前置状态：在点击/下载开始时捕获，提交时在同一控制事务复核。
      const beforeDownload = await repository.readControl();
      const expectedActive = beforeDownload.activeGeneration;
      const result = await fetchRefuelingSnapshot({ accountId: options.accountId });
      if (!result.ok) {
        return { ok: false, message: "暂时无法获取当前数据，已保留本机副本。请稍后重试。" };
      }
      if (result.snapshot.documentGeneration !== flow.serverGeneration) {
        // 下载期间又发生一次恢复：重新展示提示，不用旧目标覆盖更晚代次。
        await reopenWithBootstrap();
        return { ok: false, message: "账号数据又有了更新，请重新确认后再打开。" };
      }
      const outcome = await repository.receiveGeneration(result.snapshot.documentGeneration, result.snapshot.snapshot, expectedActive);
      if (outcome.status === "stale") {
        await reopenWithBootstrap();
        return { ok: false, message: outcome.message };
      }
      apply(outcome.state);
      if (bootstrapInfo !== undefined) {
        bootstrapInfo = { ...bootstrapInfo, documentGeneration: result.snapshot.documentGeneration };
      }
      setFlow({ phase: "active", generation: result.snapshot.documentGeneration, serverConfirmed: true });
      void checkPendingRestoreReceipt();
      return { ok: true, message: "" };
    } catch (failure) {
      // 本机空间不足或写失败：停止切换，旧副本仍可读，不显示已接收。
      return { ok: false, message: describeError(failure) };
    }
  }

  /** 重新 bootstrap 并重新决策（代次又变化/回网确认/手动刷新时使用）。 */
  async function reopenWithBootstrap(): Promise<void> {
    if (!repository) return;
    const bootstrap = await bootstrapRefueling({ accountId: options.accountId });
    if (!bootstrap.ok) {
      // 失败保留本地状态：离线/服务暂不可用不推翻已打开的工作区或保护流程。
      if (bootstrap.error === "unauthorized" || bootstrap.error === "account_changed") {
        options.onSessionRejected();
      }
      return;
    }
    bootstrapInfo = bootstrap.info;
    repository.setLegacyBinding(bootstrap.info.legacyGeneration);
    const migration = await repository.migrateFromV1().catch((failure) => ({ changed: false, pendingMergeError: describeError(failure) }));
    migrationPending.value = migration.pendingMergeError;
    await applyBootstrapDecision();
  }

  /** 回网/回前台时重试待确认的 bootstrap（离线打开或代次待确认）。 */
  async function retryBootstrapIfPending(): Promise<void> {
    if (!repository || initializing !== undefined) return;
    const flow = generationFlow.value;
    const needsConfirmation = (flow.phase === "active" && !flow.serverConfirmed)
      || (flow.phase === "protected" && flow.serverGeneration === null)
      || flow.phase === "failed";
    if (!needsConfirmation) return;
    await reopenWithBootstrap();
  }

  /** 重新查询待确认恢复结果（保护流程中的显式入口）。 */
  function recheckRestoreReceipt(): void {
    void checkPendingRestoreReceipt();
  }

  /** 显式重扫 v1 迟到写入（打开保留副本/回前台使用）；失败显示待处理。 */
  async function recheckMigration(): Promise<void> {
    if (!repository) return;
    try {
      const migration = await repository.migrateFromV1();
      migrationPending.value = migration.pendingMergeError;
      if (migration.changed) await refresh();
    } catch (failure) {
      migrationPending.value = describeError(failure);
    }
  }

  /** 当前应用/服务端是否提供恢复切换（bootstrap 元数据 + 联网确认）。 */
  const restoreWritesAvailable = computed(() => {
    const flow = generationFlow.value;
    return flow.phase === "active" && flow.serverConfirmed && (bootstrapInfo?.restoreWritesAvailable ?? false);
  });

  /**
   * 恢复确认前的本机持久（§7.3/§7.5）：随机 requestId 与不可变正文先在严格事务内
   * 落盘才发送。已有待确认请求时所有窗口复用原记录，不能用另一请求覆盖 control；
   * 返回复用提示供界面展示。
   */
  async function beginRestoreRequest(body: RestoreRequestBody): Promise<{ ok: boolean; pending: PendingRestoreRequest | null; message: string }> {
    if (!repository) return { ok: false, pending: null, message: "本机数据尚未就绪，请稍后重试。" };
    const pending: PendingRestoreRequest = {
      requestId: body.requestId,
      body,
      requestFingerprint: await fingerprintRestoreRequest(body),
      createdAtMs: Date.now(),
      dispatchedAtMs: null,
    };
    try {
      const stored = await repository.setPendingRestore(pending);
      pendingRestore.value = stored;
      if (stored.requestId !== pending.requestId) {
        return { ok: false, pending: stored, message: "已有恢复请求结果待确认，已沿用原请求；不会用新请求覆盖。" };
      }
      return { ok: true, pending: stored, message: "" };
    } catch (failure) {
      return { ok: false, pending: null, message: describeError(failure) };
    }
  }


  /**
   * 发送（或按本人选择重试）当前待确认的恢复请求：以原 requestId 与固定正文提交。
   * 本次操作绑定的请求身份（requestId + 固定指纹）在进入调用链时同步固定——显式
   * 传入，或以当前可见 pending 为准——并交给仓储在同一控制锁内逐一核对：若锁内
   * 当前待确认已被清除或替换，返回 stale_request，绝不代发另一笔恢复。
   * 首次派发资格与请求派发在同一临界区完成——判定与派发之间不存在可被同机保存
   * 插入的异步边界：未派发且当前代次仍有未同步保存时返回 waiting_local_sync，
   * 不发送、不清除原请求（同步完成后本人可再次以原请求重试）；已派发过的请求
   * 允许本人重试（可能已有服务端结果，由 requestId 幂等吸收），不因保存门禁封死
   * 原编号。结果只有 committed / not_committed 在核对本机待确认归属后先原子落盘
   * 才解除 pending。unknown 与 request_id_conflict 不清除、不换 ID、不自动发起新
   * 恢复。committed 落盘成功后重新 bootstrap：本机旧工作区进入保护流程，由本人
   * 选择「打开恢复后数据」（服务端成功与本机接收分开显示）。
   */
  async function submitPendingRestore(expected?: PendingRestoreIdentity): Promise<PanelSubmitOutcome> {
    if (!repository) return { kind: "error", message: "本机数据尚未就绪，请稍后重试。" };
    const visible = pendingRestore.value;
    const identity: PendingRestoreIdentity | null = expected
      ?? (visible === null ? null : { requestId: visible.requestId, requestFingerprint: visible.requestFingerprint });
    if (identity === null) return { kind: "stale_request" };
    const generation = workspaceGeneration.value;
    const dispatch = await repository.dispatchPendingRestore(generation, identity, (pending) =>
      submitRestoreRequest({ accountId: options.accountId }, pending.body));
    if (dispatch.status === "no_pending" || dispatch.status === "replaced") {
      // 锁内当前待确认已清除或已换成另一笔：本次点击不代发，只读刷新内存归属，
      // 由界面按最新 pending 让本人再次选择（不自动接管、不清除新请求）。
      const latest = await repository.readControl().catch(() => null);
      if (!disposed && latest !== null) pendingRestore.value = latest.pendingRestore;
      return { kind: "stale_request" };
    }
    if (dispatch.status === "generation_changed") {
      // 本机工作区已不是持久活动代次：不发送，按最新控制恢复内存归属并重判工作流。
      const latest = await repository.readControl().catch(() => null);
      if (!disposed && latest !== null) pendingRestore.value = latest.pendingRestore;
      void refresh();
      return { kind: "error", message: "本机工作区已在其他窗口切换，本次恢复未发送；请按当前提示处理本机数据。" };
    }
    const pending = dispatch.pending;
    pendingRestore.value = pending;
    if (dispatch.status === "local_sync_pending") return { kind: "waiting_local_sync" };
    const outcome = await dispatch.outcome;
    /** 终态落盘并同步内存；失败保留原请求并报告可重试错误。 */
    const persistOutcome = async (record: RestoreOutcomeRecord): Promise<boolean> => {
      try {
        const resolved = await repository!.resolveRestoreOutcome(record);
        const latest = await repository!.readControl().catch(() => null);
        if (latest !== null && !disposed) pendingRestore.value = latest.pendingRestore;
        return resolved;
      } catch {
        return false;
      }
    };
    if (outcome.status === "committed") {
      if (await persistOutcome(outcomeFromCommittedReceipt(pending, outcome.receipt))) {
        void reopenWithBootstrap();
        return { kind: "committed" };
      }
      return { kind: "local-failed", message: "服务端已提交恢复，但本机保存结果失败；原请求已保留，请释放本机空间后重试查询。" };
    }
    if (outcome.status === "not_committed") {
      if (await persistOutcome(notCommittedOutcome(pending, outcome.reason))) {
        return { kind: "not_committed", reason: outcome.reason };
      }
      return { kind: "local-failed", message: "服务端已确认本次恢复未执行，但本机保存结果失败；原请求已保留，请释放本机空间后重试查询。" };
    }
    if (outcome.status === "request_id_conflict") {
      return { kind: "conflict" };
    }
    return { kind: "unknown", errorCode: outcome.errorCode };
  }

  async function mutate(operation: (repository: LocalRefuelingV2Repository, generation: string) => Promise<GenerationWriteResult>): Promise<boolean> {
    if (!repository || !ready.value || saving.value || !options.active()) return false;
    if (generationFlow.value.phase !== "active") return false;
    const generation = workspaceGeneration.value;
    if (generation === null) return false;
    saving.value = true;
    ++loadSequence;
    error.value = "";
    try {
      // 保存/导入绑定调用实例代次；仓库在事务内复核持久 activeGeneration——
      // 失活写入保留在原代次副本并报告 inactive，此处随即进入保护流程。
      const result = await operation(repository, generation);
      apply(result);
      applyControlSnapshot(result);
      if (result.inactive) enterProtectedFromDrift(result.activeGeneration, result.legacyGeneration);
      notify();
      sync?.request();
      return true;
    } catch (failure) {
      error.value = describeError(failure);
      return false;
    } finally { saving.value = false; void refresh(); }
  }
  async function requestPersistence() {
    try { persistent.value = (await navigator.storage?.persist?.()) ?? false; }
    catch { persistent.value = false; }
  }
  const onEnvironment = () => {
    foregroundOnline.value = document.visibilityState === "visible" && navigator.onLine;
    updateSyncEnabled();
    if (document.visibilityState === "visible") {
      void refresh();
      // 旧标签页迟到写入：回到前台重新读取旧库并比较迁移指纹。
      void recheckMigration();
      // 离线打开/代次待确认：回网后重试 bootstrap 并重新决策。
      void retryBootstrapIfPending();
    }
  };
  watch([options.active, foregroundOnline], updateSyncEnabled, { flush: "sync" });
  onMounted(() => {
    window.addEventListener("focus", onEnvironment);
    window.addEventListener("online", onEnvironment);
    window.addEventListener("offline", onEnvironment);
    document.addEventListener("visibilitychange", onEnvironment);
    void initialize();
  });
  // 代次切换时重建按代次隔离的广播通道。
  watch(workspaceGeneration, (generation, previousGeneration) => {
    if (generation === previousGeneration) return;
    try { channel?.close(); } catch { /* Ignore. */ }
    channel = undefined;
    if (typeof BroadcastChannel !== "undefined" && generation !== null) {
      channel = new BroadcastChannel(accountStorageNamesV2(options.accountId).changesFor(generation));
      channel.onmessage = () => { void refresh(); };
    }
  });
  onUnmounted(() => {
    disposed = true;
    sync?.setEnabled(false);
    channel?.close();
    repository?.close();
    window.removeEventListener("focus", onEnvironment);
    window.removeEventListener("online", onEnvironment);
    window.removeEventListener("offline", onEnvironment);
    document.removeEventListener("visibilitychange", onEnvironment);
  });
  return {
    records: readonly(records), ready: readonly(ready), saving: readonly(saving), error: readonly(error),
    pendingSync: readonly(pendingSync), confirmed: readonly(confirmed), syncStatus: readonly(syncStatus),
    notice, persistent: readonly(persistent), importedLegacyIds: readonly(importedLegacyIds),
    generationFlow: readonly(generationFlow), workspaceGeneration: readonly(workspaceGeneration),
    pendingRestore: readonly(pendingRestore), importConflicts: readonly(importConflicts),
    migrationPending: readonly(migrationPending), restoreWritesAvailable,
    save: (id: string, patch: Partial<RefuelingRecord>, creating: boolean) => mutate((repo, generation) => repo.save(generation, id, patch, creating)),
    importLegacy: (selected: SavedRefuelingRecord[]) => mutate((repo, generation) => repo.importLegacy(generation, selected)),
    listRetainedGenerations: (exclude: string | null): Promise<RetainedGenerationSummary[]> => repository?.listRetainedGenerations(exclude) ?? Promise.resolve([]),
    readRetainedGeneration: (generation: string): Promise<RetainedGenerationView | null> => repository?.readRetainedGeneration(generation) ?? Promise.resolve(null),
    initialize, refresh, requestPersistence, retryOpen, openCurrentGeneration, recheckRestoreReceipt, recheckMigration,
    beginRestoreRequest, submitPendingRestore,
    retrySync: () => sync?.request(),
  };
}

/**
 * 工作流决策（纯逻辑）：
 * - 本机活动代次与服务端一致 → normal。
 * - 本机无活动代次且无任何本机数据（全新浏览器）→ receive：直接接收服务端当前代次。
 * - 本机无活动代次但有本地数据（迁移得到的 G0 等）且服务端仍在 legacy 代次 → activate。
 * - 其余（本机与服务端代次不一致）→ generation-changed 保护流程。
 */
export function decideWorkspaceOpen(input: {
  activeGeneration: string | null;
  legacyGeneration: string | null;
  hasLocalData: boolean;
  serverGeneration: string;
  serverLegacyGeneration: string;
}): { action: "normal" | "receive" | "activate" | "generation-changed" } {
  if (input.activeGeneration === input.serverGeneration) return { action: "normal" };
  if (input.activeGeneration === null) {
    if (!input.hasLocalData) return { action: "receive" };
    if (input.serverGeneration === input.serverLegacyGeneration
      && (input.legacyGeneration === null || input.legacyGeneration === input.serverLegacyGeneration)) {
      return { action: "activate" };
    }
    return { action: "generation-changed" };
  }
  return { action: "generation-changed" };
}

export type { PendingRestoreRequest, RestoreOutcomeRecord };
