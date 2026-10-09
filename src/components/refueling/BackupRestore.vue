<script setup lang="ts">
// 「备份与恢复」面板（恢复设计 §7）：列表、固定预览与比较、保护等待、最终明确
// 确认、结果待确认/已提交/本机接收失败、重试与取消入口。UI 不暴露 DO/R2/epoch
// 等实现术语；比较使用独立只读 Loro 文档与稳定记录 ID，默认显示有变化记录，
// 其余按需展开。确认前先 flush 当前表单草稿（说明不在云端备份）；有待上传修改
// 时禁用最终确认。等待备份时按 30 秒轮询只读状态（仅面板可见且联网）。
import { computed, onBeforeUnmount, onMounted, onUnmounted, shallowRef, watch } from "vue";
import type { PanelSubmitOutcome, useLocalRefueling } from "../../composables/useLocalRefueling";
import { initializeLoro } from "../../data/loro-runtime";
import { fetchBackupStatus, fetchRefuelingSnapshot, type RefuelingBackupStatus } from "../../data/refueling-server-api";
import {
  cancelRestorePreview,
  createRestorePreview,
  fetchRestorePreviewSnapshot,
  listRefuelingBackups,
  type RefuelingBackupList,
  type RestorePreview,
} from "../../data/refueling-restore";
import {
  compareRestoreSnapshots,
  differingFields,
  type RestoreComparison,
  type RestoreComparisonRecord,
} from "../../data/restore-comparison";

const props = defineProps<{
  accountId: string;
  local: ReturnType<typeof useLocalRefueling>;
  /** 工作区提供的草稿 flush：确认前先保存当前表单输入为本代次草稿。 */
  flushDraft: () => Promise<{ ok: boolean; message: string }>;
  /**
   * 地址分区（D1 列表 / D2 预览 / D3 原请求结果）：未提供时渲染完整面板
   * （组件测试口径）；提供时同一面板状态机按地址只呈现对应分区，分区切换
   * 通过 requestSection 事件交由工作区推进路由。
   */
  visibleSection?: "list" | "preview" | "result";
  /** 保护流程下的 D3（UI-R07）：只呈现本机原请求的查询/本人重试，不提供新预览入口。 */
  protectionMode?: boolean;
  /**
   * 离开取消未确认的承接投递（UI-R06.2）：面板卸载后 emit 会被 Vue 丢弃，
   * 声明为显式 prop 使上层传入的回调进入 instance.props——卸载前的同步阶段
   * 提取闭包引用（回调闭包属于仍存活的父级工作区），结果晚于卸载到达时仍可
   * 调用。与 cancelUnconfirmedChange 事件等价（模板 @ 监听两者同名注入）。
   */
  onCancelUnconfirmedChange?: (message: string, deliveryEpoch?: number) => void;
  /**
   * 取消投递代次（UI-R06.2 剩余）：由父级工作区维护并在新预览/新确认开始时
   * 递增；离开取消发起时捕获当前值并随结果投递——旧面板实例的 refreshEpoch
   * 无法被新面板实例推进，跨实例归属由该代次在承接层核对（新流程使旧取消
   * 失去投递资格；没有新流程时结果照常可读）。
   */
  cancelDeliveryEpoch?: number;
}>();
const emit = defineEmits<{
  close: [];
  requestSection: [section: "list" | "preview" | "result" | "data"];
  /**
   * 离开取消的未确认陈述（UI-R06.2）：面板可能已随导航卸载（D2→D0），本地
   * 状态不可达；空消息表示清除。由仍存活的同账号工作区承接呈现。
   */
  cancelUnconfirmedChange: [message: string, deliveryEpoch?: number];
}>();

type PanelView = "listing" | "previewing" | "protecting" | "submitting";

const view = shallowRef<PanelView>("listing");
const sectionList = computed(() => props.visibleSection === undefined || props.visibleSection === "list");
const sectionPreview = computed(() => props.visibleSection === undefined || props.visibleSection === "preview");
const sectionResult = computed(() => props.visibleSection === "result");

/**
 * 地址分区与内部状态协调（UI-R06）：从 D2 回到 D1 时精确取消尚未提交的那份
 * 预览（设计 §6.2：仅当前 previewId；有待确认请求时不取消任何请求），本地
 * 预览状态复位；取消结果按归属复核后单独陈述，不因列表读取失败被吞掉。
 */
watch(() => props.visibleSection, (section, previous) => {
  if (previous === "preview" && section === "list" && pendingRestore.value === null && !confirmBusy.value) {
    const leaving = preview.value;
    if (leaving !== null) void cancelPreviewOnLeave(leaving.previewId);
  }
  if (section !== "list") return;
  if (pendingRestore.value !== null) return;
  if (view.value === "previewing" || view.value === "protecting") {
    preview.value = null;
    comparison.value = null;
    protection.value = null;
    expanded.value = new Set();
    view.value = "listing";
  }
});

onBeforeUnmount(() => {
  // 工作区「返回」从 D2 直接离开整个备份区（route 不再是 backups 族）时，
  // 本面板经 v-if 卸载而非 visibleSection 分区切换：卸载前同样对未提交预览
  // 发送精确取消。与确认操作互斥（UI-R06.1）：begin 登记/提交在途
  // （confirmBusy，pending 内存值可能尚为 null）时不取消本人已确认的预览，
  // 沿用「可离开而不取消」；有待确认请求时同样不取消任何内容。取消结果可能
  // 晚于卸载到达：在此同步阶段提取上层承接监听（闭包引用不随卸载失效）。
  const leaving = preview.value;
  if (leaving !== null && pendingRestore.value === null && !confirmBusy.value) {
    // 声明 prop 的承接回调：在组件标记卸载前的同步阶段提取闭包引用（回调
    // 闭包属于仍存活的父级工作区），结果晚于卸载到达时仍可调用（UI-R06.2）。
    const deliver = props.onCancelUnconfirmedChange;
    void cancelPreviewOnLeave(leaving.previewId, deliver);
  }
});

/**
 * 返回时的精确预览取消：捕获发起归属（epoch + previewId），await 后仅在归属
 * 仍成立时陈述取消未确认；保护态/新待确认请求/新操作推进 epoch 后，旧取消
 * 的任何结果都不再写入当前状态（UI-R07 同一归属原则）。
 */
/**
 * 承接投递（UI-R06.2）：离开取消可能在面板卸载后（D2→D0）才拿到结果——Vue
 * 的 emit 在组件卸载后会被丢弃，卸载路径由调用方在 onBeforeUnmount 同步阶段
 * （组件标记卸载前 props 仍有效）提取上层监听闭包传入；组件存活的分区返回
 * 路径不传该参数，走本地状态 + emit。
 */
async function cancelPreviewOnLeave(previewId: string, deliverAfterUnmount?: (message: string, deliveryEpoch?: number) => void): Promise<void> {
  const epoch = invalidateRefreshOwnership();
  // 跨实例投递代次（UI-R06.2 剩余）：发起时捕获父级工作区的当前代次——旧组件
  // 自身的 refreshEpoch 无法被新面板实例推进，跨面板归属由该代次在承接层核对。
  const deliveryEpoch = props.cancelDeliveryEpoch ?? 0;
  const message = "未能确认预览已关闭；返回后请重新预览。";
  const deliver = (text: string): void => {
    cancelUnconfirmed.value = text;
    emit("cancelUnconfirmedChange", text, deliveryEpoch);
    deliverAfterUnmount?.(text, deliveryEpoch);
  };
  try {
    const result = await cancelRestorePreview({ accountId: props.accountId }, previewId);
    if (epoch !== refreshEpoch) return;
    if (!result.cancelled) deliver(message);
  } catch {
    if (epoch === refreshEpoch) deliver(message);
  }
}
const loading = shallowRef(false);
const notice = shallowRef("");
const failure = shallowRef("");
/**
 * 取消未确认提示（UI-R06）：显式取消/返回取消得到 cancelled=false 时的独立
 * 事实陈述，不并入 failure——后续列表读取失败时两项事实同时可见，取消状态
 * 不依赖列表成功才显示。
 */
const cancelUnconfirmed = shallowRef("");
/** 本次会话内绑定原请求的可显示终态（UI-R06）：not_committed 等终态清 pending 后 D3 仍可显示。 */
const terminalOutcome = shallowRef<string | null>(null);
const list = shallowRef<RefuelingBackupList | null>(null);
const preview = shallowRef<RestorePreview | null>(null);
const comparison = shallowRef<RestoreComparison | null>(null);
const expanded = shallowRef<Set<string>>(new Set());
const confirmBusy = shallowRef(false);
/** 保护等待状态：创建时由服务端给出，其后按只读元数据轮询更新（执行时仍完整验证）。 */
const protection = shallowRef<RestorePreview["protection"] | null>(null);
/** 面板根节点：同时校验业务可见性（上层工作区可能以 v-show 保留在 DOM 中）。 */
const panelRoot = shallowRef<unknown>(null);
/** 保护等待轮询（仅面板可见且联网；30 秒只读备份状态元数据，不下载完整快照）。 */
let statusTimer: ReturnType<typeof setInterval> | undefined;

const pendingRestore = computed(() => props.local.pendingRestore.value);
const pendingSync = computed(() => props.local.pendingSync.value);

/**
 * D3 结果分区协调（UI-R06）：外层工作区不再凭 pending=null 一律赶回 D0——
 * 「确无结果」（无待确认请求、无可显示终态、无在途操作）才回到数据页；
 * not_committed 等确定终态清 pending 后仍在 D3 显示说明与重新预览入口。
 * 仅业务可见的面板有权发出该路由意图（隐藏的普通面板无路由权，UI-R07）。
 */
watch(
  [() => props.visibleSection, pendingRestore, terminalOutcome, confirmBusy, view],
  () => {
    if (props.visibleSection !== "result") return;
    if (pendingRestore.value !== null) return;
    if (terminalOutcome.value !== null) return;
    if (confirmBusy.value || view.value === "submitting") return;
    if (!panelIsVisible()) return;
    emit("requestSection", "data");
  },
  { immediate: true },
);

const protectionCovered = computed(() => protection.value?.covered === true);
const canConfirm = computed(() =>
  preview.value !== null
  && comparison.value !== null
  && protectionCovered.value
  && !pendingSync.value
  && !pendingRestore.value
  && !confirmBusy.value
  && preview.value.expiresAtMs > Date.now(),
);
const changedRecords = computed(() =>
  comparison.value === null ? [] : comparison.value.records.filter((record) => record.status !== "same"),
);
const sameRecords = computed(() =>
  comparison.value === null ? [] : comparison.value.records.filter((record) => record.status === "same"),
);

/** 保护等待原因的中文说明（UI 不暴露内部错误码）。 */
function describeWaitingReason(reason: string | null): string {
  if (reason === "pending_backup_window") return "等待当前修改的备份窗口完成";
  if (reason === "backup_blocked") return "备份暂时受阻，请先处理备份问题";
  if (reason === "cleanup_pending") return "正在收尾旧备份，请稍候";
  if (reason === "backup_task_in_progress") return "有一份备份正在进行";
  if (reason === "coverage_mismatch") return "当前修改尚未被完成备份覆盖";
  return "保护备份尚未就绪";
}

function describeListError(error: string): string {
  if (error === "unauthorized") return "会话已失效，请重新登录后再试。";
  if (error === "account_changed") return "账号状态已变化，请刷新后重试。";
  if (error === "generation_state_unavailable") return "账号数据状态暂不可用，请先完成一次正常同步。";
  if (error === "backup_invalid") return "备份序列暂不可核对（可能正在清理或存在未解释对象），请稍后重试。";
  return "暂时无法读取备份列表，请稍后重试。";
}

function describePreviewError(error: string): string {
  if (error === "backup_not_found") return "所选备份已不可用（可能正在清理），请重新选择。";
  if (error === "no_restore_change") return "所选版本与当前数据完全一致，无需恢复。";
  if (error === "source_changed") return "账号数据已变化，请重新选择并预览。";
  if (error === "preview_replaced") return "已有新的预览，本次预览未保存。";
  if (error === "backup_not_ready") return "当前数据尚无完成备份，等待正常备份完成后再试。";
  if (error === "backup_invalid") return "所选备份读取校验未通过，未创建预览。";
  if (error === "generation_state_unavailable") return "账号数据状态暂不可用，请先完成一次正常同步。";
  return "暂时无法创建预览，请稍后重试。";
}

/**
 * 刷新归属代次：待确认请求换人或新的面板操作推进时 +1，使在途的列表读取与
 * 收尾失效。旧刷新在成功、失败与 finally 每次写共享状态前都必须复核该代次，
 * 不能再改动当前请求的提示、错误、列表或 loading；loading 由新归属重建。
 */
let refreshEpoch = 0;

/** 推进归属代次：旧列表回调/旧收尾自此不得再写共享状态。 */
function invalidateRefreshOwnership(): number {
  refreshEpoch += 1;
  loading.value = false;
  return refreshEpoch;
}

/** 待确认请求身份（requestId + 固定指纹）：同一请求的只读刷新不是换人。 */
function pendingIdentityOf(pending: { requestId: string; requestFingerprint?: string } | null): string | null {
  return pending === null ? null : `${pending.requestId}:${pending.requestFingerprint ?? ""}`;
}

async function refreshList(epoch: number = refreshEpoch, options: { retainFailure?: string } = {}) {
  if (epoch !== refreshEpoch) return;
  loading.value = true;
  failure.value = "";
  try {
    await initializeLoro();
    const result = await listRefuelingBackups({ accountId: props.accountId });
    // 归属已失效（请求换人或新操作推进）：本次响应不得改动任何共享状态。
    if (epoch !== refreshEpoch) return;
    if (!result.ok) {
      failure.value = describeListError(result.error);
      list.value = null;
      return;
    }
    list.value = result.list;
    if (!result.list.initialized) notice.value = "此账号还没有独立备份；正常使用并联网后会自动生成。";
    else notice.value = "";
    // 列表刷新属于发起它的那次操作：成功刷新后仍保留该操作的可读失败原因
    // （如预览失败）；归属已推进时上面的复核已返回，旧错误不会写回新操作。
    if (options.retainFailure !== undefined) failure.value = options.retainFailure;
  } finally {
    if (epoch === refreshEpoch) loading.value = false;
  }
}

/** 选择版本创建固定预览，并加载目标与当前快照做比较。 */
async function selectVersion(version: { backupStreamId: string; revision: number; bundleSha256: string }) {
  // 本操作取得界面归属：其后的每个异步边界后复核，旧操作/旧列表的迟到结果
  // 不得写入更新的操作或新的待确认流程。
  const epoch = invalidateRefreshOwnership();
  loading.value = true;
  failure.value = "";
  notice.value = "";
  comparison.value = null;
  preview.value = null;
  protection.value = null;
  expanded.value = new Set();
  try {
    await initializeLoro();
    if (epoch !== refreshEpoch) return;
    const created = await createRestorePreview({ accountId: props.accountId }, version);
    if (epoch !== refreshEpoch) return;
    if (!created.ok) {
      // 列表刷新成功后仍保留本次预览的可读失败原因（归属未变时；新操作推进即作废）。
      await refreshList(epoch, { retainFailure: describePreviewError(created.error) });
      return;
    }
    preview.value = created.preview;
    protection.value = created.preview.protection;
    // 浏览器分别读取固定目标与当前服务端快照（独立只读实例比较）。
    const target = await fetchRestorePreviewSnapshot({ accountId: props.accountId }, created.preview.previewId);
    if (epoch !== refreshEpoch) return;
    if (!target.ok) {
      failure.value = "暂时无法读取所选版本内容，请稍后重试或重新选择。";
      return;
    }
    if (target.snapshotSha256 !== created.preview.target.snapshotSha256) {
      failure.value = "所选版本内容校验不一致，未进入比较；请重新选择。";
      return;
    }
    const current = await fetchRefuelingSnapshot({ accountId: props.accountId });
    if (epoch !== refreshEpoch) return;
    if (!current.ok) {
      failure.value = "暂时无法读取当前数据，请稍后重试。";
      return;
    }
    if (current.snapshot.documentGeneration !== created.preview.expected.generation
      || current.snapshot.revision !== created.preview.expected.revision) {
      // 当前版本不再匹配：预览失效，重新列表；失败原因同样保留到列表刷新之后。
      preview.value = null;
      comparison.value = null;
      protection.value = null;
      await refreshList(epoch, { retainFailure: "账号数据已变化，本次预览已失效；请重新选择。" });
      return;
    }
    if (current.snapshot.snapshot === null) {
      failure.value = "当前数据状态异常，请先完成一次正常同步。";
      return;
    }
    const compared = compareRestoreSnapshots(target.snapshot, current.snapshot.snapshot);
    if (epoch !== refreshEpoch) return;
    if (compared === null) {
      failure.value = "所选版本或当前数据无法解析，未进入比较。";
      return;
    }
    comparison.value = compared;
    view.value = "previewing";
    // 新预览开启：上一份预览的取消未确认事实不再跨流程残留（本地与承接层）。
    cancelUnconfirmed.value = "";
    emit("cancelUnconfirmedChange", "");
    // 地址推进到 D2（恢复预览）；预览状态本身不写地址。
    if (props.visibleSection !== undefined) emit("requestSection", "preview");
    if (compared.stateIdentical && compared.historyIdentical) {
      notice.value = "所选版本与当前数据完全一致，无需恢复。";
    } else if (compared.stateIdentical) {
      notice.value = "所有记录字段一致，但修改历史不同；恢复会替换完整历史。";
    }
  } finally {
    // 收尾同样复核归属：本操作已被推进（新 pending 或新的列表刷新在途）时，
    // 迟到的 finally 不得结束当前归属的加载状态。
    if (epoch === refreshEpoch) loading.value = false;
  }
}

function toggleExpand(recordId: string) {
  const next = new Set(expanded.value);
  if (next.has(recordId)) next.delete(recordId);
  else next.add(recordId);
  expanded.value = next;
}

/** 展开时显示全部字段，默认只显示有差异的字段（渲染期纯读取）。 */
function visibleFieldsOf(record: RestoreComparisonRecord): { field: string; label: string; before: string; after: string }[] {
  return expanded.value.has(record.recordId) ? record.fields : differingFields(record);
}

function recordStatusText(record: RestoreComparisonRecord): string {
  if (record.status === "added") return "将增加";
  if (record.status === "removed") return "将移除";
  if (record.status === "changed") return "字段不同";
  return "相同";
}

async function cancelPreview() {
  if (preview.value === null) return;
  // 发起时固定归属（epoch + previewId）：await 后保护态/新待确认请求/新操作
  // 推进归属时，旧回调不得改写共享状态、发路由意图或刷新列表（UI-R07）。
  const epoch = invalidateRefreshOwnership();
  const previewId = preview.value.previewId;
  loading.value = true;
  try {
    const result = await cancelRestorePreview({ accountId: props.accountId }, previewId);
    if (epoch !== refreshEpoch || preview.value?.previewId !== previewId) return;
    // 取消失败：不宣称服务端预览已删除；独立陈述（不依赖后续列表读取成功）。
    if (!result.cancelled) cancelUnconfirmed.value = "未能确认预览已关闭；返回后请重新预览。";
    else cancelUnconfirmed.value = "";
    preview.value = null;
    comparison.value = null;
    protection.value = null;
    view.value = "listing";
    if (props.visibleSection !== undefined) emit("requestSection", "list");
    await refreshList(epoch);
  } finally {
    if (epoch === refreshEpoch) loading.value = false;
  }
}

/**
 * 待确认流程结束（§7.3）后的统一收尾：清掉绑定刚结束请求的预览/比较/保护状态，
 * 读回备份列表，并给出与结果归属一致的下一步提示（列表自身的提示优先）。
 * 收尾开始时固定本次刷新归属（epoch=调用时的代次）：await 列表返回后若归属已
 * 失效（新请求/新操作推进），不再写入终态文案，避免标到当前请求。
 */
async function finishPendingFlow(noticeText: string, epoch: number = refreshEpoch): Promise<void> {
  preview.value = null;
  comparison.value = null;
  protection.value = null;
  expanded.value = new Set();
  view.value = "listing";
  failure.value = "";
  notice.value = "";
  await refreshList(epoch);
  if (epoch !== refreshEpoch) return;
  if (notice.value === "") notice.value = noticeText;
}

/** 待确认结束后的中立提示：已切代次时指向既有「打开恢复后数据」接收流程。 */
function pendingCompletionNotice(): string {
  const phase = props.local.generationFlow?.value.phase ?? "active";
  return phase === "active"
    ? "待确认的恢复请求已处理完毕；可重新选择版本预览并确认。"
    : "该恢复已在服务端提交；请按上方提示打开恢复后的数据完成接收。";
}

/**
 * 本次面板异步操作（确认或本人重试）的请求归属：进入调用链时固定它绑定的
 * requestId，结果/错误只在收尾时按当前 pending 归属落位——迟到或旧结果不得
 * 标到新请求；busy 期间的 pending 转移同样在收尾时按最新归属统一协调。
 */
let operationIdentity: { requestId: string; requestFingerprint: string } | null = null;
let operationSubmitted = false;
let operationNotice = "";
let operationFailure = "";
let operationKind: string | null = null;
/** 已由操作收尾消费的换人键（from→to）：watcher 不再重复协调同一次转移。 */
let consumedTransition: string | null = null;

function pendingTransitionKey(
  from: { requestId: string; requestFingerprint?: string } | null,
  to: { requestId: string; requestFingerprint?: string } | null,
): string {
  return `${pendingIdentityOf(from)} → ${pendingIdentityOf(to)}`;
}

// 待确认请求换人（其他窗口终态处理、重开后的只读回执查询完成、被新请求替换，
// 包括本窗口一次 control 刷新直接 P1→P2）：按 requestId + 固定指纹识别换人，
// 同一请求的只读刷新不触发。换人即作废在途列表/收尾的归属；busy 期间由操作
// 收尾（settleOperation）统一协调并消费同一次转移，不能因为 busy 直接丢弃。
watch(() => props.local.pendingRestore.value, (pending, previous) => {
  if (pendingIdentityOf(pending) === pendingIdentityOf(previous)) return;
  invalidateRefreshOwnership();
  terminalOutcome.value = null;
  if (confirmBusy.value) return;
  const key = pendingTransitionKey(previous, pending);
  if (key === consumedTransition) {
    // 该转移已由 operation 收尾协调（其 watcher 回调此前在 busy 中被跳过）。
    consumedTransition = null;
    return;
  }
  // 非 busy 换人：清旧归属的提示/错误与预览流程，保留最新 pending 与其本人入口。
  void finishPendingFlow(pending === null
    ? pendingCompletionNotice()
    : "当前的待确认恢复请求已更新；请按上方提示处理。");
});

/** 本轮操作收尾：按当前 pending 归属落位结果/错误并协调 busy 期间的转移。 */
function settleOperation(): void {
  confirmBusy.value = false;
  const identity = operationIdentity;
  const submitted = operationSubmitted;
  const noticeText = operationNotice;
  const failureText = operationFailure;
  const kind = operationKind;
  operationIdentity = null;
  operationSubmitted = false;
  operationNotice = "";
  operationFailure = "";
  operationKind = null;
  const current = pendingRestore.value;
  const currentIdentity = pendingIdentityOf(current);
  const claimedIdentity = identity === null ? null : pendingIdentityOf(identity);
  if (!submitted) {
    // 未进入派发链的早退（flush 失败、已有待确认、保护未就绪等）：若本轮尚未
    // 认领请求、或认领的请求仍是当前记录，则本次提示仍准确，按原样展示；只有
    // 认领的请求已被换人或消失时才按最新归属做中立协调，旧提示不留给新请求。
    const replacedAway = claimedIdentity !== null && currentIdentity !== null && currentIdentity !== claimedIdentity;
    const endedAway = claimedIdentity !== null && current === null;
    if (replacedAway || endedAway) {
      consumedTransition = pendingTransitionKey(identity, current);
      void finishPendingFlow(current === null
        ? pendingCompletionNotice()
        : "当前的待确认恢复请求已更新；请按上方提示处理。");
      return;
    }
    if (noticeText !== "") notice.value = noticeText;
    if (failureText !== "") failure.value = failureText;
    return;
  }
  if (current !== null && claimedIdentity !== null && currentIdentity === claimedIdentity) {
    // 本轮点击的请求仍是当前待确认（身份含固定指纹）：显示本次结果对应的提示/错误。
    if (noticeText !== "") notice.value = noticeText;
    if (failureText !== "") failure.value = failureText;
    return;
  }
  // 本次点击的请求已结束或被新请求（可能来自其他窗口）取代：旧结果、旧错误与
  // 旧列表刷新都不得更新当前请求的界面状态；消费这次转移并做中立协调。
  if (identity !== null) consumedTransition = pendingTransitionKey(identity, current);
  if (current !== null) {
    void finishPendingFlow("当前的待确认恢复请求已更新；请按上方提示处理。");
    return;
  }
  // pending 已结束：本轮终态用结果自身文案；他处已处理或迟到 unknown 用中立提示。
  const ownedTerminal = kind === "committed" || kind === "not_committed";
  if (ownedTerminal && noticeText !== "") terminalOutcome.value = noticeText;
  void finishPendingFlow(ownedTerminal && noticeText !== "" ? noticeText : pendingCompletionNotice());
}

/** 按结果记录本轮操作的提示/错误；视图与请求归属在 settleOperation 统一处理。 */
function applyOperationOutcome(outcome: PanelSubmitOutcome): void {
  operationKind = outcome.kind;
  switch (outcome.kind) {
    case "committed":
      operationNotice = "恢复已提交到服务端。此设备原有记录和草稿已保留；请在上方提示中打开恢复后的数据完成接收。";
      break;
    case "not_committed":
      operationNotice = outcome.reason === "preview_expired"
        ? "预览已过期，本次恢复未执行；请重新选择并确认。"
        : outcome.reason === "source_changed"
          ? "账号数据已变化，本次恢复未执行；请重新预览并确认。"
          : "预览已被替换或取消，本次恢复未执行；请重新预览并确认。";
      break;
    case "conflict":
      operationNotice = "该请求编号已被不同内容的恢复使用，已停止发送；请核对后重新预览并使用新编号。";
      view.value = "protecting";
      break;
    case "unknown":
      operationNotice = "恢复结果尚待确认（原请求已保留，不会自动换编号重发）。可稍后查询结果，或由你选择以原请求重试。";
      view.value = "protecting";
      break;
    case "waiting_local_sync":
      operationNotice = "本设备（含其他窗口）还有尚未同步的修改，已暂停发送；同步完成后可用「以原请求重试」继续。";
      view.value = "protecting";
      break;
    case "stale_request":
      operationNotice = "本次操作绑定的待确认请求已处理完毕或被新的请求取代；请按当前待确认状态重新操作。";
      break;
    case "local-failed":
      operationFailure = outcome.message;
      view.value = "protecting";
      break;
    case "error":
      operationFailure = outcome.message;
      view.value = "previewing";
      break;
  }
}

/**
 * 最终确认：先 flush 当前表单草稿（明确不在云端备份），再持久保存随机 requestId
 * 与不可变正文，然后提交。结果显示服务端结果与本机接收分开。
 */
async function confirmRestore() {
  if (!canConfirm.value || preview.value === null) return;
  const previewValue = preview.value;
  confirmBusy.value = true;
  // 新操作推进：作废在途的列表读取与旧收尾，避免其回调改动本次操作的提示/错误/loading。
  invalidateRefreshOwnership();
  failure.value = "";
  notice.value = "";
  view.value = "submitting";
  operationIdentity = null;
  operationSubmitted = false;
  operationNotice = "";
  operationFailure = "";
  operationKind = null;
  // 本人开始新的确认操作：上一份预览的「取消未确认」陈述不再跨流程残留。
  cancelUnconfirmed.value = "";
  emit("cancelUnconfirmedChange", "");
  try {
    const flushed = await props.flushDraft();
    if (!flushed.ok) {
      operationFailure = flushed.message || "草稿尚未保存到本机，已取消恢复。";
      view.value = "previewing";
      return;
    }
    // flush 的异步边界后重验本机保存/同步、请求资格与预览归属（§7.2/§7.3）：
    // 不能只依赖点击前的一次 computed——另一窗口或在途保存可能已改变状态。
    if (preview.value === null || preview.value.previewId !== previewValue.previewId) {
      operationFailure = "预览已失效，未提交本次恢复；请重新选择版本。";
      view.value = preview.value === null ? "listing" : "previewing";
      return;
    }
    // 当前存在持久待确认请求的早退优先进入 D3 原请求流程（UI-R06）：即使同时
    // 出现未同步修改，原请求的查询/重试入口也必须在结果分区呈现。
    if (pendingRestore.value !== null) {
      operationNotice = "已有待确认的恢复请求，不会用新请求覆盖；请先查询结果或按原请求重试。";
      view.value = "protecting";
      if (props.visibleSection !== undefined) emit("requestSection", "result");
      return;
    }
    if (pendingSync.value) {
      operationNotice = "本设备出现了尚未同步的修改，已暂停本次恢复；同步完成后可再次确认。";
      view.value = "previewing";
      return;
    }
    if (!protectionCovered.value) {
      operationNotice = "保护备份尚未就绪，已暂停本次恢复；请等待正常备份完成后再确认。";
      view.value = "previewing";
      return;
    }
    const body = {
      requestId: crypto.randomUUID(),
      previewId: previewValue.previewId,
      backupStreamId: previewValue.target.backupStreamId,
      revision: previewValue.target.revision,
      bundleSha256: previewValue.target.bundleSha256,
      expectedGeneration: previewValue.expected.generation,
      expectedRevision: previewValue.expected.revision,
      expectedSnapshotSha256: previewValue.expected.snapshotSha256,
    };
    const begun = await props.local.beginRestoreRequest(body);
    if (!begun.ok && begun.pending !== null) {
      // 控制锁发现他窗口已登记原请求（复用既有 pending，不新建）：当前本机就
      // 存在持久原请求，同样进入 D3 的原请求流程（UI-R06），不能留在 D2。
      operationNotice = begun.message || "已有待确认的恢复请求，不会用新请求覆盖；请先查询结果或按原请求重试。";
      view.value = "protecting";
      if (props.visibleSection !== undefined) emit("requestSection", "result");
      return;
    }
    if (!begun.ok || begun.pending === null) {
      // 真正的保存失败（无既有请求可复用）：保持原提示，不进入结果分区。
      operationNotice = begun.message || "恢复请求未能保存到本机，已取消本次恢复。";
      view.value = "protecting";
      return;
    }
    // 本次操作绑定 begin 返回的同一请求身份（requestId + 固定指纹）：仓储在控制锁内核对；
    // 后续任一异步边界发现该请求被替换时，收尾都按最新归属做中立协调。
    operationIdentity = { requestId: begun.pending.requestId, requestFingerprint: begun.pending.requestFingerprint };
    // 请求已持久登记：后续所有分支（首次派发被门禁拦下、unknown、终态）都进入
    // D3 的原请求流程（UI-R06），不能停留在 D2 的预览分区。
    if (props.visibleSection !== undefined) emit("requestSection", "result");
    // begin 的异步边界（指纹计算 + 本机严格事务）之后再次复核本机保存资格：
    // 期间出现的保存或同步状态变化不能被跳过（自己窗口或其他窗口都可能写入）。
    if (pendingSync.value) {
      operationNotice = "本设备（含其他窗口）出现了尚未同步的修改，已暂停发送；同步完成后可用下方「以原请求重试」继续。";
      view.value = "protecting";
      return;
    }
    operationSubmitted = true;
    notice.value = "正在提交恢复请求…（未保存的表单输入已存为本机草稿，不在云端备份中）";
    const outcome = await props.local.submitPendingRestore({
      requestId: begun.pending.requestId,
      requestFingerprint: begun.pending.requestFingerprint,
    });
    applyOperationOutcome(outcome);
    // 确认后的结果归属 D3（原请求结果）：地址切换由工作区完成。
    if (props.visibleSection !== undefined) emit("requestSection", "result");
  } finally {
    settleOperation();
  }
}

/** 本人选择以原 requestId 与固定正文重试待确认请求（身份在点击时固定）。 */
async function retryPendingRestore() {
  if (pendingRestore.value === null || confirmBusy.value) return;
  const clicked = pendingRestore.value;
  confirmBusy.value = true;
  invalidateRefreshOwnership();
  failure.value = "";
  operationIdentity = { requestId: clicked.requestId, requestFingerprint: clicked.requestFingerprint ?? "" };
  operationSubmitted = true;
  operationNotice = "";
  operationFailure = "";
  operationKind = null;
  try {
    const outcome = await props.local.submitPendingRestore({
      requestId: clicked.requestId,
      requestFingerprint: clicked.requestFingerprint,
    });
    applyOperationOutcome(outcome);
    if (props.visibleSection !== undefined) emit("requestSection", "result");
  } finally {
    settleOperation();
  }
}

function timeText(ms: number | null): string {
  if (ms === null) return "未知";
  return new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 面板业务可见性：文档可见之外再用根元素校验（上层工作区可能以 v-show 保留在 DOM 中）。 */
function panelIsVisible(): boolean {
  // 无 DOM 环境（SSR/组件测试宿主）无法判定，默认可见：D3 协调不被环境阻断。
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== "visible") return false;
  const element = panelRoot.value as { checkVisibility?: (options?: { checkVisibilityCSS?: boolean }) => boolean } | null;
  if (element !== null && element !== undefined && typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkVisibilityCSS: true });
  }
  return true;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

onMounted(() => {
  if (pendingRestore.value !== null) {
    // 重开面板时持久的待确认请求优先：先查结果（404/unknown 保留原 ID）。
    view.value = "protecting";
    props.local.recheckRestoreReceipt();
  } else {
    void refreshList();
  }
  statusTimer = setInterval(() => {
    // 仅面板可见且联网时轮询只读元数据；关闭面板即停止。
    if (panelIsVisible() && isOnline() && preview.value !== null) {
      void refreshProtection();
    }
  }, 30_000);
});
onUnmounted(() => {
  if (statusTimer !== undefined) clearInterval(statusTimer);
});

/** 从只读备份状态元数据推导保护等待（展示用；最终 POST 仍必须完整读回保护包）。 */
function protectionFromStatus(status: RefuelingBackupStatus, previewValue: RestorePreview): RestorePreview["protection"] {
  const protectionRevision = status.latestCompletedRevision;
  const covered = status.state === "current_backed_up"
    && status.currentGeneration === previewValue.expected.generation
    && status.currentRevision === previewValue.expected.revision
    && status.latestCompletedGeneration === previewValue.expected.generation
    && protectionRevision !== null
    && status.currentBackedUp;
  if (covered) return { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision };
  const waitingReason = status.blockedError !== null ? "backup_blocked"
    : status.frozenTaskRevision !== null ? "backup_task_in_progress"
      : status.cleanupPendingCount > 0 ? "cleanup_pending"
        : status.pendingFromRevision !== null || status.pendingToRevision !== null ? "pending_backup_window"
          : "coverage_mismatch";
  return {
    covered: false,
    waitingReason,
    // 实际可行动时间由服务端按责任优先级与持久失败下限给出；不再用原始窗口推算。
    nextAttemptAtMs: status.nextActionAtMs,
    protectionRevision,
  };
}

/**
 * 刷新保护等待状态（只读元数据）：预览过期或当前版本变化时使预览失效并回到列表；
 * 迟到结果只作用于发起时的同一 previewId，替换/取消后的响应不落到新预览。
 */
async function refreshProtection() {
  const previewValue = preview.value;
  if (previewValue === null) return;
  const requested = await fetchBackupStatus({ accountId: props.accountId });
  if (preview.value === null || preview.value.previewId !== previewValue.previewId) return;
  if (!requested.ok) return;
  const status = requested.status;
  if (status.currentGeneration !== null
    && (status.currentGeneration !== previewValue.expected.generation
      || (status.currentRevision !== null && status.currentRevision !== previewValue.expected.revision))) {
    preview.value = null;
    comparison.value = null;
    protection.value = null;
    view.value = "listing";
    // 同一模式的连通修复：列表刷新成功后失败原因仍对本人可读。
    await refreshList(refreshEpoch, { retainFailure: "账号数据已变化，本次预览已失效；请重新选择。" });
    return;
  }
  if (previewValue.expiresAtMs <= Date.now()) {
    failure.value = "预览已过期；请重新选择并确认。";
    preview.value = null;
    comparison.value = null;
    protection.value = null;
    view.value = "listing";
    return;
  }
  protection.value = protectionFromStatus(status, previewValue);
}
</script>

<template>
  <section ref="panelRoot" class="backup-restore-panel">
    <header class="panel-header">
      <h2>备份与恢复</h2>
      <button type="button" class="text-button" @click="emit('close')">关闭</button>
    </header>

    <div class="panel-body">
      <p v-if="failure" class="error">{{ failure }}</p>
      <p v-else-if="notice" class="local-notice">{{ notice }}</p>
      <!-- 取消未确认是独立事实（UI-R06）：列表读取失败时两项同时可见。 -->
      <p v-if="cancelUnconfirmed" class="warning" role="status">{{ cancelUnconfirmed }}</p>

      <!-- D2 直达/刷新：预览不写地址，重新选择版本；不声称服务端暂存已删除。 -->
      <div v-if="visibleSection === 'preview' && view === 'listing' && preview === null" class="preview-missing">
        <p>本次没有可显示的预览；请重新选择版本。服务端的暂存预览不代表已删除。</p>
        <button type="button" @click="emit('requestSection', 'list')">返回版本列表</button>
      </div>

      <!-- 待确认恢复请求（持久保存）：重开面板即显示，先查结果；404/unknown 保留原 ID。
           分区模式下在 D1/D3 呈现；D1 额外提供进入 D3 的入口。 -->
      <div v-if="pendingRestore !== null && (visibleSection === undefined || visibleSection === 'list' || visibleSection === 'result')" class="pending-restore">
        <p class="pending-hint">
          有一笔恢复请求结果待确认（编号 {{ pendingRestore.requestId.slice(0, 8) }}…），原编号与内容已保留。
          查询只读结果；确认未执行前不会自动换编号重发，也不会用新请求覆盖。
        </p>
        <div class="pending-actions">
          <button type="button" class="text-button" @click="props.local.recheckRestoreReceipt()">查询恢复结果</button>
          <button type="button" :disabled="confirmBusy" @click="retryPendingRestore()">以原请求重试</button>
          <button v-if="visibleSection === 'list'" type="button" class="text-button" @click="emit('requestSection', 'result')">查看恢复结果</button>
        </div>
      </div>

      <!-- 列表视图（D1） -->
      <div v-if="sectionList && view === 'listing'" class="version-list">
        <p v-if="pendingRestore !== null" class="muted">请先处理上方待确认的恢复请求；处理完成前不能选择新版本。</p>
        <p v-if="loading">正在读取备份列表…</p>
        <div v-else-if="list && !list.initialized" class="muted">
          <p>此账号还没有独立备份；正常使用并联网后会自动生成。</p>
        </div>
        <div v-else-if="list && list.initialized && list.versions.length === 0" class="muted">
          <p>此账号还没有独立备份；正常使用并联网后会自动生成。</p>
        </div>
        <ul v-else-if="list">
          <li v-for="version in list.versions" :key="version.revision" :class="{ unselectable: !version.selectable }">
            <div class="version-meta">
              <span class="version-time">{{ version.capturedAtMs === null ? `备份完成时间 ${timeText(version.completedAtMs)}` : `备份时间 ${timeText(version.capturedAtMs)}` }}</span>
              <span>共 {{ version.recordCount }} 条记录</span>
              <span v-if="version.restoreBaseline">恢复基线</span>
              <span v-if="!version.selectable" class="muted">清理中，不可选择</span>
            </div>
            <button type="button" :disabled="!version.selectable || loading || pendingRestore !== null" @click="selectVersion(version)">
              {{ version.selectable ? "预览此版本" : "不可选择" }}
            </button>
          </li>
        </ul>
      </div>

      <!-- 预览比较（D2）：默认显示有变化记录，其余按需展开。 -->
      <div v-else-if="sectionPreview && (view === 'previewing' || view === 'protecting')" class="preview">
        <p v-if="loading">正在校验所选版本并比较差异…</p>
        <div v-else-if="comparison && preview" class="compare-body">
          <p class="list-hint">
            将恢复到 {{ preview.target.capturedAtMs === null ? `版本 ${preview.target.revision}` : timeText(preview.target.capturedAtMs) }}
            （共 {{ preview.target.recordCount }} 条记录）。预览有效期至 {{ timeText(preview.expiresAtMs) }}。
          </p>
          <p class="compare-summary">
            将增加 {{ comparison.added }} 条 · 将移除 {{ comparison.removed }} 条 · 字段不同 {{ comparison.changed }} 条 · 相同 {{ comparison.same }} 条
            <span v-if="comparison.stateIdentical && comparison.historyIdentical">（完整状态与历史均相同，无需恢复）</span>
            <span v-else-if="comparison.stateIdentical">（所有字段一致，但修改历史不同）</span>
          </p>
          <p v-if="protection" class="protection-state" role="status">
            <template v-if="protection.covered">
              保护备份已就绪{{ protection.protectionRevision === null ? "" : `（版本 ${protection.protectionRevision}）` }}；确认时将再次完整核验。
            </template>
            <template v-else>
              {{ describeWaitingReason(protection.waitingReason) }}{{ protection.protectionRevision === null ? "" : `（最新完成版本 ${protection.protectionRevision}）` }}
              <span v-if="protection.nextAttemptAtMs !== null">，预计 {{ timeText(protection.nextAttemptAtMs) }} 再试</span>；就绪前不能最终确认。
            </template>
          </p>
          <ul class="compare-list">
            <li v-for="record in changedRecords" :key="record.recordId">
              <div class="compare-record-head">
                <span class="record-id">记录 {{ record.recordId.slice(0, 8) }}…</span>
                <span :class="`status-${record.status}`">{{ recordStatusText(record) }}</span>
                <button type="button" class="text-button" @click="toggleExpand(record.recordId)">
                  {{ expanded.has(record.recordId) ? "收起" : "展开全部字段" }}
                </button>
              </div>
              <ul class="field-list">
                <li v-for="entry in visibleFieldsOf(record)" :key="entry.field">
                  <span class="field-label">{{ entry.label }}</span>
                  <span class="field-before">{{ entry.before }}</span>
                  <span class="field-arrow">→</span>
                  <span class="field-after">{{ entry.after }}</span>
                </li>
                <li v-if="visibleFieldsOf(record).length === 0" class="muted">无字段差异</li>
              </ul>
            </li>
          </ul>
          <div v-if="sameRecords.length > 0" class="same-records">
            <button type="button" class="text-button" @click="toggleExpand('same-records')">
              {{ expanded.has('same-records') ? "收起相同记录" : "展开相同记录" }}（{{ sameRecords.length }} 条）
            </button>
            <ul v-if="expanded.has('same-records')" class="compare-list">
              <li v-for="record in sameRecords" :key="record.recordId">
                <div class="compare-record-head">
                  <span class="record-id">记录 {{ record.recordId.slice(0, 8) }}…</span>
                  <span :class="`status-${record.status}`">{{ recordStatusText(record) }}</span>
                  <button type="button" class="text-button" @click="toggleExpand(record.recordId)">
                    {{ expanded.has(record.recordId) ? "收起字段" : "查看逐条字段" }}
                  </button>
                </div>
                <ul v-if="expanded.has(record.recordId)" class="field-list">
                  <li v-for="entry in record.fields" :key="entry.field">
                    <span class="field-label">{{ entry.label }}</span>
                    <span class="field-after">{{ entry.after }}</span>
                  </li>
                </ul>
              </li>
            </ul>
          </div>
          <p v-if="pendingSync" class="field-error" role="status">
            本设备有已保存但尚未同步的修改；正在同步，完成后才能最终确认。
          </p>
          <div class="confirm-block">
            <p class="confirm-warning">
              这会替换账号当前的全部加油记录。其他设备原有修改会保留，之后需核对。此设备未保存的草稿不在云端备份中。
            </p>
            <div class="generation-actions">
              <button type="button" :disabled="!canConfirm" @click="confirmRestore()">
                {{ confirmBusy ? "正在提交…" : "恢复到此版本" }}
              </button>
              <button type="button" :disabled="loading || confirmBusy" @click="cancelPreview">取消预览</button>
            </div>
            <p v-if="!canConfirm && !pendingSync && !pendingRestore && preview.expiresAtMs <= Date.now()" class="field-error">
              预览已过期，请重新选择。
            </p>
          </div>
        </div>
      </div>
      <p v-else-if="view === 'submitting'" class="muted">正在提交恢复请求…</p>

      <!-- D3 原请求结果：终态文案 + 下一步入口（待确认区块在上方）。 -->
      <div v-if="sectionResult && !protectionMode && pendingRestore === null && view !== 'submitting'" class="result-next">
        <p class="muted">这笔恢复请求已处理完毕；如需恢复请重新预览当前数据后再确认。</p>
        <div class="generation-actions">
          <button type="button" @click="emit('requestSection', 'list')">重新预览当前数据</button>
          <button type="button" @click="emit('close')">返回数据页</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.backup-restore-panel {
  border: 1px solid var(--border-default);
  border-radius: 16px;
  padding: 20px 22px;
  background: var(--surface-panel);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.panel-header h2 { margin: 0; font-size: 1rem; font-weight: 500; }
.preview-missing {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--status-info-border);
  border-radius: 10px;
  background: var(--status-info-bg);
  color: var(--status-info-fg);
  font-size: 0.8125rem;
  line-height: 1.8;
}
.result-next {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.result-next .generation-actions button { min-height: 44px; }
.version-list ul, .compare-list, .field-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.version-list ul > li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-default);
}
.version-list ul > li.unselectable { opacity: 0.6; }
.version-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 0.8125rem; }
.version-time { font-weight: 500; }
.muted { color: var(--text-secondary); font-size: 0.8125rem; }
.error { color: var(--status-danger-fg); font-size: 0.8125rem; line-height: 1.8; }
.list-hint { font-size: 0.8125rem; }
.compare-summary { font-weight: 500; font-size: 0.8125rem; }
.compare-record-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.record-id { font-weight: 500; font-size: 0.8125rem; }
.status-added { color: var(--status-success-fg); }
.status-removed { color: var(--status-danger-fg); }
.status-changed { color: var(--status-warning-fg); }
.field-list li { display: flex; flex-wrap: wrap; gap: 8px; font-size: 0.8125rem; padding-left: 8px; }
.field-label { min-width: 72px; color: var(--text-secondary); }
.field-before { text-decoration: line-through; opacity: 0.8; }
.field-arrow { color: var(--text-muted); }
.field-after { font-weight: 500; }
.confirm-block { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.confirm-warning { margin: 0; padding: 12px 14px; font-size: 0.8125rem; line-height: 1.8; border: 1px solid var(--status-warning-border); border-radius: 10px; background: var(--status-warning-bg); color: var(--status-warning-fg); }
.generation-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.generation-actions button { min-height: 44px; }
.pending-restore { display: flex; flex-direction: column; gap: 8px; }
.pending-hint { margin: 0; font-size: 0.8125rem; line-height: 1.8; }
.pending-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.protection-state { margin: 0; font-size: 0.8125rem; line-height: 1.8; color: var(--text-secondary); }
.local-notice { color: var(--text-accent); font-size: 0.8125rem; line-height: 1.8; }
</style>
