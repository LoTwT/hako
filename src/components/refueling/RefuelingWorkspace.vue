<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { ChartLine, Database, FileClock, List, LoaderCircle, Settings as SettingsIcon, ShieldAlert } from "@lucide/vue";
import { useLocalRefueling } from "../../composables/useLocalRefueling";
import { listRetainedDraftSources } from "../../data/retained-content";
import { useRefuelingDrafts } from "../../composables/useRefuelingDrafts";
import type {
  DraftFormContext,
  StoredRefuelingDraft,
} from "../../domain/refueling/draft-recovery";
import {
  changedFields,
  createDraft,
  numberFields,
  recordWarnings,
  unscale,
  type RefuelingDraft,
  type RefuelingRecord,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";
import {
  editorRouteFor,
  routeKey,
  type AppRoute,
  type RefuelingRoute,
} from "../../ui/app-route";
import { createModalFocus } from "../../ui/modal-focus";
import RefuelingForm from "./RefuelingForm.vue";
import RecordsRoot from "./RecordsRoot.vue";
import RecordDetailPanel from "./RecordDetailPanel.vue";
import StatisticsPage from "./StatisticsPage.vue";
import DataPage from "./DataPage.vue";
import LegacyImport from "./LegacyImport.vue";
import RetainedRefuelingCopy from "./RetainedRefuelingCopy.vue";
import BackupRestore from "./BackupRestore.vue";
import DraftSelectionLayer from "./DraftSelectionLayer.vue";

const props = defineProps<{
  accountId: string;
  local: ReturnType<typeof useLocalRefueling>;
  locked: boolean;
  navigatingForLogin: boolean;
  route: RefuelingRoute;
  appRoute: AppRoute;
  navigate: (next: AppRoute) => void;
  replaceRoute: (next: AppRoute) => void;
  backTo: (target: AppRoute) => void;
  openSettings: (event?: Event) => void;
}>();

const {
  records,
  ready,
  saving,
  error,
  save,
  initialize,
  requestPersistence,
  importedLegacyIds,
  importLegacy,
  generationFlow,
  workspaceGeneration,
  pendingRestore,
  importConflicts,
  migrationPending,
  openCurrentGeneration,
  recheckRestoreReceipt,
  listRetainedGenerations,
  readRetainedGeneration,
  retryOpen,
  pendingSync,
  confirmed,
  syncStatus,
} = props.local;

/** 工作区实例按代次挂载：实例生命周期内工作区绑定代次固定（key 由父级提供）。 */
const generation = workspaceGeneration.value;
const protectedFlow = computed(() => generationFlow.value.phase === "protected" ? generationFlow.value : null);
const failedFlow = computed(() => generationFlow.value.phase === "failed" ? generationFlow.value : null);
const serverConfirmedActive = computed(() => generationFlow.value.phase === "active" && generationFlow.value.serverConfirmed);
const generationLocked = computed(() => generationFlow.value.phase !== "active");
const formLocked = computed(() => props.locked || generationLocked.value || saving.value === true);
/** 逐项带回仅在已激活、已核对的当前代次开放；保护流程只读查看。 */
const allowBringBack = computed(() => serverConfirmedActive.value && !props.locked);
const importConflictCount = computed(() => Object.keys(importConflicts.value).length);

const drafts = useRefuelingDrafts({
  accountId: props.accountId,
  generation,
  knownRecords: () => new Map(records.value.map((record) => [record.id, record])),
});

const selected = shallowRef<SavedRefuelingRecord>();
const formId = shallowRef<string>(crypto.randomUUID());
const formKey = shallowRef(0);
const initialDraft = shallowRef<RefuelingDraft>();
const dirty = shallowRef(false);
const localNotice = shallowRef("");
const showDraftPicker = shallowRef(false);
const showDiscardConfirm = shallowRef(false);
const openingCurrent = shallowRef(false);
const openCurrentNotice = shallowRef("");
/** 从统计进入记录时可移除的筛选上下文（仅本窗口内存，不写地址）。 */
const statsFilterContext = shallowRef<{ period: { kind: "total" } | { kind: "yearly"; year: number } | { kind: "monthly"; year: number; month: number }; periodLabel: string; pendingOnly: boolean } | null>(null);
/**
 * 备份面板离开取消的未确认陈述（UI-R06.2）：面板可能随返回导航卸载（D2→D0），
 * 由本工作区（同账号、仍存活）承接，在数据页/备份区可读；新预览或新确认
 * 开始时由面板清除（旧操作的失败不带给新流程）。
 */
const backupCancelNotice = shallowRef("");
/**
 * 取消投递代次（UI-R06.2 剩余）：新预览/新确认开始时递增——旧面板卸载后
 * 在途的取消结果晚到时按其发起时捕获的代次核对；已被新流程作废的旧取消
 * 不再写呈现（没有新流程时照常可读）。跨账号/跨实例归属由本承接层统一核对。
 */
const backupCancelEpoch = shallowRef(0);
function onBackupCancelDelivery(message: string, deliveryEpoch?: number): void {
  if (message === "") {
    backupCancelNotice.value = "";
    backupCancelEpoch.value += 1;
    return;
  }
  // 非空：核对投递归属——捕获代次仍是当前代次（期间没有新预览/新确认）才呈现。
  if (deliveryEpoch !== backupCancelEpoch.value) return;
  backupCancelNotice.value = message;
}

/** 当前挂起编辑器（每窗口一个可操作实例）：由新建、编辑、恢复或带回建立。 */
const pendingEditor = shallowRef<{ mode: "create" | "edit"; recordId: string } | null>(null);
/** 编辑器的来源路由与一次性返回标记：保存/放弃仅在历史邻项可信时调用返回。 */
const editorSource = shallowRef<AppRoute | null>(null);

// ---------------------------------------------------------------- 代次保护分段
/**
 * 保护分段（DESIGN §6.4）：进入 protected 后先做草稿保护（flush），成功才用
 * 保护页替换普通工作区；失败保留可见原输入与同一表单实例/占用，冻结业务
 * 保存并可重试。会话门禁仍由 App 立即隐藏私有内容，优先级不倒置。
 */
type ProtectionStage = "idle" | "protecting" | "protected" | "failed";
const protectionStage = shallowRef<ProtectionStage>("idle");
const protectionFlushNotice = shallowRef("");
const protectionRetrying = shallowRef(false);

/** 普通工作区可见性：active/opening 可见；protected 在草稿保护成功前保持可见。 */
const normalViewportVisible = computed(() => {
  const flow = generationFlow.value;
  if (flow.phase === "active" || flow.phase === "opening") return true;
  if (flow.phase === "protected") return protectionStage.value !== "protected";
  return false;
});

const isProtectedFlow = computed(() => generationFlow.value.phase === "protected");

async function protectDrafts(): Promise<void> {
  if (!isProtectedFlow.value || protectionStage.value === "protected") return;
  protectionStage.value = "protecting";
  protectionRetrying.value = true;
  try {
    const flushed = await flushDraft();
    if (!flushed.ok) {
      protectionStage.value = "failed";
      protectionFlushNotice.value = flushed.message || "草稿尚未保存到本机，已暂停切换到保护页。";
      return;
    }
    protectionStage.value = "protected";
    protectionFlushNotice.value = "";
  } finally {
    protectionRetrying.value = false;
  }
}

watch(isProtectedFlow, (isProtected) => {
  if (!isProtected) {
    protectionStage.value = "idle";
    protectionFlushNotice.value = "";
    return;
  }
  if (protectionStage.value === "idle") void protectDrafts();
});

/**
 * 草稿装配完成后的保护解析（UI-R01）：首次挂载即处于 protected 的实例
 * （retained-only：AccountWorkspace 按代次 key 重挂载）不会触发 false→true
 * watcher，需在初始化就绪后统一启动保护阶段；无待写输入时 flush 直接成功。
 */
function resolveProtectionOnReady(): void {
  if (isProtectedFlow.value && (protectionStage.value === "idle" || protectionStage.value === "failed")) void protectDrafts();
}

const recovery = computed(() => drafts.drafts.value.recovery);
const recoveryCandidates = computed(() =>
  recovery.value.status === "ready" ? recovery.value.candidates : [],
);
const recoveryNotice = computed(() => {
  if (recovery.value.status === "ready") return recovery.value.notice;
  return recovery.value.status === "error"
    ? recovery.value.message
    : "正在打开本机草稿…";
});
const draftWriteError = computed(() => drafts.drafts.value.writeError);
const retainedDraftNotice = computed(() => {
  const parts: string[] = [];
  if (drafts.drafts.value.orphanedEditCount > 0)
    parts.push(
      `有 ${drafts.drafts.value.orphanedEditCount} 份编辑草稿找不到对应记录，已保留但未恢复。`,
    );
  if (drafts.drafts.value.unsupportedCount > 0)
    parts.push(
      `有 ${drafts.drafts.value.unsupportedCount} 份草稿无法识别（版本不受支持或内容损坏），已保留未改动。`,
    );
  return parts.join(" ");
});

// ---------------------------------------------------------------- 路由视图
const wideShell = shallowRef(typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(min-width: 880px)").matches
  : true);
const routeName = computed(() => props.route.name);
const isEditorView = computed(() => routeName.value === "record-new" || routeName.value === "record-edit");
const isRecordsView = computed(() => routeName.value === "records" || routeName.value === "record-detail");
const isRootRoute = computed(() => routeName.value === "records" || routeName.value === "statistics" || routeName.value === "data");
const isBackupsArea = computed(() =>
  routeName.value === "data-backups" || routeName.value === "data-backup-preview" || routeName.value === "data-restore-result");

const routeTitle = computed(() => {
  switch (props.route.name) {
    case "records": return "加油记录";
    case "record-detail": return "记录详情";
    case "record-new": return "记一次加油";
    case "record-edit": return "编辑记录";
    case "statistics": return "加油统计";
    case "data": return "数据";
    case "data-backups": return "备份与恢复";
    case "data-backup-preview": return "恢复预览";
    case "data-restore-result": return "恢复结果";
    case "data-retained": return "保留内容";
    case "data-legacy-import": return "导入旧验证记录";
  }
});

const detailRecordId = computed(() => props.route.name === "record-detail" ? props.route.recordId : null);
const detailRecord = computed(() => detailRecordId.value === null
  ? null
  : records.value.find((record) => record.id === detailRecordId.value) ?? null);
const recordsRoute: AppRoute = { name: "refueling", refueling: { name: "records" } };

/**
 * 路由交互归属（UI-R03）：隐藏/锁定的旧账号实例不再产生导航副作用（记录解析
 * 重定向、编辑器地址纠正、恢复结果回退、滚动与焦点）。locked === !active。
 */
const routeInteractionsAllowed = computed(() => !props.locked);

function refuelingNavigate(refueling: RefuelingRoute) {
  if (!routeInteractionsAllowed.value) return;
  void props.navigate({ name: "refueling", refueling });
}
function refuelingReplace(refueling: RefuelingRoute) {
  if (!routeInteractionsAllowed.value) return;
  void props.replaceRoute({ name: "refueling", refueling });
}
function backToRoute(refueling: RefuelingRoute) {
  if (!routeInteractionsAllowed.value) return;
  props.backTo({ name: "refueling", refueling });
}

/** 子页来源返回：按页面层级回到已知来源页。 */
function backToSubParent() {
  const name = props.route.name;
  backToRoute((name === "record-detail" || name === "record-new" || name === "record-edit")
    ? { name: "records" }
    : { name: "data" });
}

// ---------------------------------------------------------------- 编辑器生命周期
function attachedContext(): DraftFormContext {
  return selected.value
    ? { mode: "edit", recordId: selected.value.id, base: selected.value }
    : { mode: "create", recordId: formId.value, base: null };
}

function startFreshForm() {
  selected.value = undefined;
  formId.value = crypto.randomUUID();
  initialDraft.value = undefined;
  formKey.value += 1;
  dirty.value = false;
  drafts.attachForm(attachedContext());
}

function createNew() {
  localNotice.value = "";
  startFreshForm();
  pendingEditor.value = { mode: "create", recordId: formId.value };
}

function edit(record: SavedRefuelingRecord) {
  localNotice.value = "";
  selected.value = { ...record };
  formId.value = record.id;
  initialDraft.value = undefined;
  formKey.value += 1;
  dirty.value = false;
  drafts.attachForm(attachedContext());
  pendingEditor.value = { mode: "edit", recordId: record.id };
}

function onFormDraft(draft: RefuelingDraft) {
  drafts.updateDraft(draft);
}

/** 输入一旦产生即视为挂起编辑（内存标记；刷新后由本机草稿重新解析）。 */
watch(dirty, (value) => {
  if (!value || pendingEditor.value !== null) return;
  pendingEditor.value = selected.value
    ? { mode: "edit", recordId: selected.value.id }
    : { mode: "create", recordId: formId.value };
});

/**
 * 结束本次编辑（UI-R03.1/R03.2）：保存清理/放弃落库等异步边界后按两层归属
 * 复核。本机结束——仍拥有本次编辑（pendingEditor 仍是发起时的 mode/recordId）
 * 时结束它（清理来源/挂起标记/表单），无论账号当前是否可见：确属本次操作的
 * 已保存/已放弃编辑不能在隐藏时悬置、切回后仍可继续；编辑已被本人其他操作
 * 接管或结束时不动它。全局导航——额外要求账号仍是本实例（routeInteractions
 * Allowed）且用户没有产生更新的导航（仍在发起时的编辑地址上）：否则旧完成
 * 不得把页面拉回旧详情（R03.1），也不得改写其他账号页面。
 */
function returnFromEditor(context: { mode: "create" | "edit"; recordId: string } | null, originRoute: AppRoute) {
  // 按编辑实例身份（对象引用）复核（UI-R03.3）：同一记录先后两次编辑的
  // mode/recordId 相同，但实例不同——每个编辑入口（新建/编辑/恢复/带回）都
  // 建立新的 pendingEditor 对象；暂离、继续与同 ID 再进入不换实例。旧保存/
  // 放弃的迟到收尾只结束自己发起的那次编辑，不清理后来重开的新编辑。
  const ownsEditor = context !== null && pendingEditor.value === context;
  if (!ownsEditor) return;
  const source = editorSource.value;
  editorSource.value = null;
  pendingEditor.value = null;
  startFreshForm();
  if (!routeInteractionsAllowed.value) return;
  // 用户已离开本次编辑地址（保存/放弃在途时导航去了统计等页面，或打开设置层
  // 覆盖在编辑器上）：较新的导向意图优先，旧完成只结束编辑，不抢回页面。
  // 以应用级路由（appRoute）核对——设置层打开时业务路由保持编辑地址，但
  // 地址已变为 #settings，仍属「已离开」。
  if (routeKey(props.appRoute) !== routeKey(originRoute)) return;
  if (source !== null) props.backTo(source);
  else refuelingNavigate({ name: "records" });
}

async function submit(record: RefuelingRecord) {
  if (formLocked.value) return;
  // 发起时固定本次编辑归属与当时的编辑地址：保存/清理的异步边界后据此复核（UI-R03）。
  const context = pendingEditor.value;
  const originRoute: AppRoute = { name: "refueling", refueling: props.route };
  const patch = selected.value ? changedFields(selected.value, record) : record;
  if (!(await save(formId.value, patch, !selected.value))) return;
  const cleared = await drafts.clearAfterSave();
  localNotice.value = cleared.ok ? "" : cleared.message;
  returnFromEditor(context, originRoute);
}

/** 稍后继续：保存草稿后暂离；实例、占用与来源上下文保留（App 导航前统一 flush）。 */
function continueLater() {
  props.backTo(editorSource.value ?? recordsRoute);
}

/** 放弃当前编辑的草稿（明确确认后）：只放弃这份草稿，结束本次编辑。 */
async function discardActiveDraft() {
  showDiscardConfirm.value = false;
  const context = pendingEditor.value;
  const originRoute: AppRoute = { name: "refueling", refueling: props.route };
  const draftId = drafts.currentDraftId();
  if (draftId !== null) {
    const result = await drafts.discard(draftId);
    if (result === "held") {
      localNotice.value = "该草稿可能正被其他窗口使用，未删除。";
      return;
    }
    if (result === "failed") {
      localNotice.value = drafts.drafts.value.writeError || "草稿未能删除，已保留。";
      return;
    }
  }
  returnFromEditor(context, originRoute);
}

async function restoreDraft(draft: StoredRefuelingDraft) {
  const adopted = await drafts.adopt(draft.id);
  if (adopted === null) {
    localNotice.value = "该草稿正被其他窗口使用或已不存在，未在本窗口恢复。";
    return false;
  }
  applyAdoptedDraft(adopted);
  return true;
}

/** 把已占用的草稿填充到表单；恢复的金额差异确认由用户重新确认。 */
function applyAdoptedDraft(adopted: StoredRefuelingDraft) {
  selected.value =
    adopted.mode === "edit" && adopted.base !== null
      ? { ...adopted.base }
      : undefined;
  formId.value = adopted.recordId;
  initialDraft.value = { values: adopted.values, sources: adopted.sources };
  formKey.value += 1;
  dirty.value = true;
  pendingEditor.value = { mode: adopted.mode, recordId: adopted.recordId };
  localNotice.value = "已恢复未保存的草稿；保存前请重新核对金额差异提示。";
}

async function discardDraft(draft: StoredRefuelingDraft) {
  const result = await drafts.discard(draft.id);
  if (result === "held") {
    localNotice.value = "该草稿可能正被其他窗口使用，未删除。";
    return;
  }
  if (result === "failed") localNotice.value = drafts.drafts.value.writeError;
}

/**
 * 编辑器路由同步：直接进入（刷新/前进/地址输入）时按当前状态解析——挂起编辑器
 * 优先（地址必须与实际目标一致），其次本机草稿恢复（唯一可信自动恢复已由会话
 * 处理；多份草稿先选择，也可空白新建），最后按地址新建或编辑当前记录。
 */
function syncEditorWithRoute() {
  if (!routeInteractionsAllowed.value) return;
  if (!isEditorView.value) return;
  const route = props.route;
  const editor = pendingEditor.value;
  if (editor !== null) {
    const expected = editorRouteFor(editor.mode, editor.recordId);
    const current: AppRoute = { name: "refueling", refueling: route };
    if (routeKey(current) !== routeKey(expected)) {
      localNotice.value = "正在编辑另一份记录；请先完成或放弃当前编辑，再打开其他记录。";
      refuelingReplace(expected.refueling);
    } else {
      showDraftPicker.value = false;
    }
    return;
  }
  if (drafts.adoptedDraft() !== null) return;
  if (drafts.drafts.value.status === "loading") return;
  if (route.name === "record-new") {
    // 有可用草稿时先选择，也可空白新建；空白表单本身即是新建实例。
    if (recoveryCandidates.value.length > 0) showDraftPicker.value = true;
    return;
  }
  if (route.name === "record-edit") {
    // 该记录存在未占用草稿时先由本人选择（继续草稿或忽略草稿直接编辑），不自动任选。
    const recordDrafts = recoveryCandidates.value.filter((draft) => draft.mode === "edit" && draft.recordId === route.recordId);
    if (recordDrafts.length > 0) {
      showDraftPicker.value = true;
      return;
    }
    const record = records.value.find((entry) => entry.id === route.recordId);
    if (record !== undefined) {
      edit(record);
      editorSource.value = { name: "refueling", refueling: { name: "record-detail", recordId: record.id } };
    } else if (ready.value || error.value !== "") {
      localNotice.value = "没有找到这条记录。它可能已被修改或不在当前账号的数据中。";
      refuelingReplace({ name: "records" });
    }
  }
}

/** 用户主动开始/继续编辑：单一可操作编辑器，已有挂起编辑时回到该实例。 */
function startNew() {
  if (pendingEditor.value !== null) {
    localNotice.value = "已有正在编辑的内容，已回到当前编辑。";
    const editor = pendingEditor.value;
    editorSource.value = recordsRoute;
    refuelingNavigate(editorRouteFor(editor.mode, editor.recordId).refueling);
    return;
  }
  editorSource.value = recordsRoute;
  createNew();
  refuelingNavigate({ name: "record-new" });
}

function startEdit(record: SavedRefuelingRecord) {
  const editor = pendingEditor.value;
  if (editor !== null && editor.mode === "edit" && editor.recordId === record.id) {
    // 同 ID 再进入（详情页再次点「编辑记录」）：恢复既有实例与原来源，不重置输入。
    refuelingNavigate({ name: "record-edit", recordId: record.id });
    return;
  }
  if (editor !== null) {
    localNotice.value = "已有正在编辑的内容；请先完成或放弃当前编辑，再编辑其他记录。";
    refuelingNavigate(editorRouteFor(editor.mode, editor.recordId).refueling);
    return;
  }
  // 该记录存在未占用草稿时先由本人选择（与直接打开编辑地址共用同一决策，
  // UI-R05）：选择前不建立新编辑上下文，不占住唯一编辑器。
  if (recoveryCandidates.value.some((draft) => draft.mode === "edit" && draft.recordId === record.id)) {
    editorSource.value = detailRecordId.value === record.id
      ? { name: "refueling", refueling: { name: "record-detail", recordId: record.id } }
      : recordsRoute;
    refuelingNavigate({ name: "record-edit", recordId: record.id });
    return;
  }
  editorSource.value = detailRecordId.value === record.id
    ? { name: "refueling", refueling: { name: "record-detail", recordId: record.id } }
    : recordsRoute;
  edit(record);
  refuelingNavigate({ name: "record-edit", recordId: record.id });
}

function continueEditing() {
  const editor = pendingEditor.value;
  if (editor === null) return;
  refuelingNavigate(editorRouteFor(editor.mode, editor.recordId).refueling);
}

/** 草稿选择层的替代动作：新建模式空白新建并进入编辑地址；编辑模式忽略草稿直接编辑。 */
function alternateFromPicker() {
  showDraftPicker.value = false;
  if (pendingEditor.value !== null) return;
  if (props.route.name === "record-edit") {
    const record = records.value.find((entry) => entry.id === (props.route as { recordId?: string }).recordId);
    if (record === undefined) return;
    edit(record);
    editorSource.value = { name: "refueling", refueling: { name: "record-detail", recordId: record.id } };
    return;
  }
  createNew();
  refuelingNavigate({ name: "record-new" });
}

async function continueDraftFromPicker(draft: StoredRefuelingDraft) {
  const restored = await restoreDraft(draft);
  showDraftPicker.value = false;
  if (!restored) return;
  const editor = pendingEditor.value;
  if (editor !== null) refuelingNavigate(editorRouteFor(editor.mode, editor.recordId).refueling);
}

// ---------------------------------------------------------------- 记录选择与筛选
function selectRecord(recordId: string, options: { push: boolean }) {
  if (options.push) refuelingNavigate({ name: "record-detail", recordId });
  else refuelingReplace({ name: "record-detail", recordId });
}

/** 统计筛选上下文：携带明确的期间/条件（不解析本地化 label 作为业务条件）。 */
type StatisticsFilterContext = {
  period: { kind: "total" } | { kind: "yearly"; year: number } | { kind: "monthly"; year: number; month: number };
  periodLabel: string;
  pendingOnly: boolean;
};

function viewRecordsFromStatistics(context: StatisticsFilterContext) {
  statsFilterContext.value = context;
  refuelingNavigate({ name: "records" });
}

function removeStatsFilter(kind: "period" | "pending") {
  const context = statsFilterContext.value;
  if (context === null) return;
  if (kind === "period") {
    statsFilterContext.value = context.pendingOnly
      ? { period: { kind: "total" }, periodLabel: "", pendingOnly: true }
      : null;
  } else {
    statsFilterContext.value = context.period.kind === "total"
      ? null
      : { period: context.period, periodLabel: context.periodLabel, pendingOnly: false };
  }
}

/**
 * 从统计进入记录后，上下文随本窗口保留（详情/编辑子页往返不清除）；只有从
 * 统计与记录族之外的页面再次进入记录根页时才清掉（上下文只属于那次跳转）。
 */
const recordsFamilyRouteNames = new Set(["statistics", "record-detail", "record-new", "record-edit"]);
watch(routeName, (name, previous) => {
  if (props.locked) return;
  if (name === "records" && !(previous !== null && recordsFamilyRouteNames.has(previous))) statsFilterContext.value = null;
});

// 记录详情地址解析：非法/不存在/不在当前账号数据的记录统一回记录根页，不泄露归属。
// 仅当前账号实例执行（隐藏的旧账号工作区不得改写全局地址）。
watch([detailRecordId, ready, error, routeInteractionsAllowed], () => {
  if (!routeInteractionsAllowed.value) return;
  if (detailRecordId.value === null) return;
  if (!(ready.value || error.value !== "")) return;
  if (records.value.some((record) => record.id === detailRecordId.value)) return;
  localNotice.value = "没有找到这条记录。它可能已被修改或不在当前账号的数据中。";
  refuelingReplace({ name: "records" });
});

// 恢复结果地址：本机没有可显示的待确认请求或终态时回数据页（仅当前账号实例）。
// 保留内容地址：进入时先重扫 v1 迟到写入（发现新增历史合并进保留副本）。
watch([routeName, routeInteractionsAllowed], ([name]) => {
  if (!routeInteractionsAllowed.value) return;
  if (name === "data-retained") void props.local.recheckMigration();
}, { immediate: true });

/**
 * 本人选择「打开恢复后数据」：先 flush 当前表单草稿（失败保留页面与输入，
 * 暂不切换本机工作区），再下载并经控制事务 CAS 接收当前代次；服务端成功与
 * 本机接收分开显示。
 */
async function openCurrentData() {
  if (openingCurrent.value) return;
  openingCurrent.value = true;
  openCurrentNotice.value = "";
  try {
    const flushed = await flushDraft();
    if (!flushed.ok) {
      openCurrentNotice.value = flushed.message || "草稿尚未保存到本机，已取消切换。";
      return;
    }
    const result = await openCurrentGeneration();
    if (!result.ok) openCurrentNotice.value = result.message;
  } finally {
    openingCurrent.value = false;
  }
}

/** 保留副本视图排除的代次：保护流程列出全部（含被保护旧副本）；激活后排除当前代次。 */
function retainedExcludeForView(): string | null {
  const flow = generationFlow.value;
  if (flow.phase === "active") return flow.generation;
  return null;
}

/**
 * 保留副本逐项带回（§6.3）：以当前记录为普通编辑基线填入表单；记录已不存在时
 * 明确作为新记录填写并分配新记录 ID。已有未保存表单输入时先保护（不覆盖）。
 * 点击普通保存后才进入当前代次。
 */
function bringBackFromRetained(payload: { recordId: string; exists: boolean; patch: Partial<SavedRefuelingRecord> }) {
  if (!allowBringBack.value) return;
  if (dirty.value) {
    localNotice.value = "当前表单有未保存输入，请先保存或放弃后再带入保留内容。";
    return;
  }
  const current = payload.exists ? records.value.find((record) => record.id === payload.recordId) : undefined;
  const baseDraft = createDraft(current);
  const values = { ...baseDraft.values };
  const formValues = values as unknown as Record<string, string>;
  const sources: RefuelingDraft["sources"] = { ...baseDraft.sources };
  for (const [field, value] of Object.entries(payload.patch)) {
    // 勾选字段按记录域取值转换回表单值；数字定点、布尔/可空枚举与字符串分开处理。
    if (field in numberFields) {
      formValues[field] = value === null ? "" : unscale(value as number, numberFields[field as keyof typeof numberFields].decimals);
    } else if (field === "fullTank" || field === "lowFuelLight") {
      formValues[field] = value === null ? "" : value ? "yes" : "no";
    } else if (typeof value === "string") {
      formValues[field] = value;
    }
    sources[field as keyof RefuelingDraft["sources"]] = "manual";
  }
  if (payload.exists && current !== undefined) {
    selected.value = { ...current };
    formId.value = current.id;
  } else {
    selected.value = undefined;
    formId.value = crypto.randomUUID();
  }
  // 新表单实例绑定新的草稿上下文（当前代次、目标记录与当前基线）；
  // 否则后续输入仍落在带回前的旧 recordId/base 草稿上。
  drafts.attachForm(attachedContext());
  initialDraft.value = { values, sources };
  formKey.value += 1;
  dirty.value = true;
  const editorTarget = payload.exists && current !== undefined
    ? { mode: "edit" as const, recordId: current.id }
    : { mode: "create" as const, recordId: formId.value };
  pendingEditor.value = editorTarget;
  editorSource.value = { name: "refueling", refueling: { name: "data-retained" } };
  refuelingNavigate(editorTarget.mode === "edit"
    ? { name: "record-edit", recordId: editorTarget.recordId }
    : { name: "record-new" });
  localNotice.value = payload.exists
    ? "已按勾选字段填入当前记录的编辑表单，请核对后保存。"
    : "已按勾选字段填入新记录表单（新记录 ID），请核对后保存。";
}

/**
 * 保留草稿逐字段带回（C01）：以当前代次基线填入表单——同 ID 记录用当前记录为
 * 基线并只带入本人勾选的字段（空/否严格区分，不带旧 Loro 历史），记录不存在
 * 时作为新记录填写；普通保存才写入当前代次。
 */
function bringBackDraftFromRetained(payload: { draft: StoredRefuelingDraft; fields: string[] }) {
  if (!allowBringBack.value) return;
  const { draft, fields } = payload;
  if (fields.length === 0) {
    localNotice.value = "请先勾选要带回的草稿字段。";
    return;
  }
  if (dirty.value) {
    localNotice.value = "当前表单有未保存输入，请先保存或放弃后再带入保留草稿。";
    return;
  }
  // 勾选字段按草稿原始输入带入表单（UI-C01）：不经记录域往返转换——解析失败
  // 的数值（如超精度输入）保留原始字符串，由普通表单校验向用户提示纠正；
  // 未勾选字段以当前记录为基线。
  const current = records.value.find((record) => record.id === draft.recordId);
  const baseDraft = createDraft(current);
  const values = { ...baseDraft.values };
  const formValues = values as unknown as Record<string, string>;
  const sources: RefuelingDraft["sources"] = { ...baseDraft.sources };
  for (const field of fields) {
    formValues[field] = draft.values[field as keyof RefuelingDraft["values"]];
    sources[field as keyof RefuelingDraft["sources"]] = "manual";
  }
  if (current !== undefined) {
    selected.value = { ...current };
    formId.value = current.id;
  } else {
    selected.value = undefined;
    formId.value = crypto.randomUUID();
  }
  // 新表单实例绑定当前记录与当前基线，不接旧 base。
  drafts.attachForm(attachedContext());
  initialDraft.value = { values, sources };
  formKey.value += 1;
  dirty.value = true;
  const editorTarget = current !== undefined
    ? { mode: "edit" as const, recordId: current.id }
    : { mode: "create" as const, recordId: formId.value };
  pendingEditor.value = editorTarget;
  editorSource.value = { name: "refueling", refueling: { name: "data-retained" } };
  refuelingNavigate(editorTarget.mode === "edit"
    ? { name: "record-edit", recordId: editorTarget.recordId }
    : { name: "record-new" });
  localNotice.value = current !== undefined
    ? "已按勾选字段填入当前记录的编辑表单（保留草稿的原始输入），请核对后保存。"
    : "已按勾选字段填入新记录表单（新记录 ID），请核对后保存。";
}

/** 草稿原始输入（表单字符串值）→ 记录域值；无效数值返回 undefined（不带入）。 */
/** 工作区隐藏时也由应用层调用；失败提示显示在当前可见的账号区。 */
async function flushDraft(): Promise<{ ok: boolean; message: string }> {
  if (await drafts.flush()) return { ok: true, message: "" };
  const draftsState = drafts.drafts.value;
  return {
    ok: false,
    message:
      draftsState.writeError ||
      (draftsState.status === "loading"
        ? "正在准备本机草稿，请稍后再试。"
        : "草稿尚未保存到本机，已取消切换。"),
  };
}

defineExpose({ flushDraft, saving });

function draftTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function draftSummary(draft: StoredRefuelingDraft): string {
  return [
    draft.values.stationName,
    draft.values.occurredAtLocal.replace("T", " "),
  ]
    .filter((value) => value !== "")
    .join(" · ");
}

const pendingEditorLabel = computed(() => {
  const editor = pendingEditor.value;
  if (editor === null) return null;
  if (editor.mode === "create") return "新记录";
  const record = records.value.find((entry) => entry.id === editor.recordId);
  return record === undefined ? "编辑记录" : `编辑 ${record.occurredAtLocal.replace("T", " ").slice(5, 16)} 的记录`;
});

/** 全量记录的跨记录警告（里程递增等）：列表与详情共用同一来源（UI-R11）。 */
const recordWarningsMap = computed(() => recordWarnings([...records.value]));

/** 草稿选择层候选：直接编辑地址下只列该记录的未占用草稿（UI-R05）。 */
const pickerCandidates = computed(() => {
  if (props.route.name === "record-edit") {
    const recordId = props.route.recordId;
    return recoveryCandidates.value.filter((draft) => draft.mode === "edit" && draft.recordId === recordId);
  }
  return recoveryCandidates.value;
});

// 放弃草稿确认弹层：打开聚焦「继续填写」，关闭（含 Esc/遮罩）还原触发点。
const discardKeepButton = shallowRef<HTMLButtonElement | null>(null);
const discardDialogFocus = createModalFocus({
  close: () => { showDiscardConfirm.value = false; },
  initialFocus: () => discardKeepButton.value,
});
watch(showDiscardConfirm, (open) => {
  if (open) discardDialogFocus.focusOnOpen();
});
function closeDiscardConfirm() {
  discardDialogFocus.focusOnClose();
}
function onDiscardDialogKeydown(event: KeyboardEvent) {
  discardDialogFocus.onLayerKeydown(event);
}

const editorBackLabel = computed(() => {
  const source = editorSource.value;
  if (source !== null && source.name === "refueling" && source.refueling.name === "record-detail") return "返回详情";
  if (source !== null && source.name === "refueling" && source.refueling.name === "data-retained") return "返回保留内容";
  return "返回记录";
});

/** 顶栏同步摘要（文档级状态，不带时间；失败原因在数据页解释）。 */
const syncSummary = computed(() => {
  if (saving.value) return { tone: "busy" as const, text: "正在保存到本机", spinning: true };
  const status = syncStatus.value.phase;
  if (status === "syncing") return { tone: "busy" as const, text: "同步中", spinning: true };
  if (status === "failed") return { tone: "danger" as const, text: "同步失败 · 查看", spinning: false };
  if (pendingSync.value) return { tone: "muted" as const, text: "待同步", spinning: false };
  if (confirmed.value) return { tone: "success" as const, text: "已同步", spinning: false };
  return { tone: "muted" as const, text: "已存本机", spinning: false };
});

const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
  if (props.navigatingForLogin) return;
  if (dirty.value || saving.value) {
    event.preventDefault();
    event.returnValue = "";
  }
};
// 表单实例在挂载时就绑定草稿上下文；定位线索留给 initialize() 读取
drafts.attachForm(attachedContext(), { keepLocator: true });
// 业务记录加载完成后才能判断哪些草稿已保存、哪些编辑找不到记录
let recoveryApplied = false;
watch(
  [ready, error],
  async () => {
    if (!(ready.value || error.value !== "")) return;
    await drafts.initialize();
    const adopted = drafts.adoptedDraft();
    if (!recoveryApplied && adopted !== null) {
      recoveryApplied = true;
      applyAdoptedDraft(adopted);
      // 恢复的草稿即挂起编辑器：若当前正在编辑器地址上，保持地址与目标一致。
      syncEditorWithRoute();
      resolveProtectionOnReady();
      return;
    }
    // 没有可恢复草稿：清掉过期线索，保持空白表单
    if (drafts.currentDraftId() === null) drafts.attachForm(attachedContext());
    syncEditorWithRoute();
    resolveProtectionOnReady();
  },
  { immediate: true },
);
watch(() => props.route, () => {
  syncEditorWithRoute();
}, { immediate: true });
// 解锁（账号回到前台）后按当前路由重新解析编辑器与记录地址。
watch(routeInteractionsAllowed, (allowed) => {
  if (allowed) syncEditorWithRoute();
});

// 路由切换：键盘焦点移到当前页标题；子页回到顶部。主从选择（records↔detail）
// 不滚动，保留正在浏览的位置；编辑器返回记录族时恢复离开前的滚动位置。
// 设置层覆盖期间（appRoute 为 settings）背景路由推进（HS-R2）不改变焦点与
// 滚动——焦点归设置层所有，背景只在覆盖层关闭后恢复自己的焦点/滚动行为。
const routeHeading = shallowRef<HTMLHeadingElement | null>(null);
let recordsFamilyScrollY = 0;
watch(routeName, async (name, previous) => {
  if (props.locked) return;
  const wasRecords = previous === "records" || previous === "record-detail";
  const isRecords = name === "records" || name === "record-detail";
  const isEditor = name === "record-new" || name === "record-edit";
  const wasEditor = previous === "record-new" || previous === "record-edit";
  const returningFromEditor = wasEditor && isRecords;
  if (wasRecords && isEditor && typeof window !== "undefined") {
    recordsFamilyScrollY = typeof window.scrollY === "number" ? window.scrollY : 0;
  } else if (!isRecords && !isEditor) {
    recordsFamilyScrollY = 0;
  }
  await Promise.resolve();
  if (props.appRoute.name === "settings") return;
  routeHeading.value?.focus?.({ preventScroll: true });
  if (returningFromEditor) {
    if (typeof window !== "undefined") window.scrollTo?.(0, recordsFamilyScrollY);
    return;
  }
  const selectionChange = wasRecords && isRecords;
  if (!selectionChange && typeof window !== "undefined") window.scrollTo?.(0, 0);
}, { immediate: false });

function onShellMediaChange(event: MediaQueryListEvent) {
  wideShell.value = event.matches;
}
onMounted(() => {
  window.addEventListener("beforeunload", warnBeforeLeaving);
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(min-width: 880px)").addEventListener("change", onShellMediaChange);
  }
});
onUnmounted(() => {
  window.removeEventListener("beforeunload", warnBeforeLeaving);
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(min-width: 880px)").removeEventListener("change", onShellMediaChange);
  }
});
</script>

<template>
  <div class="refueling-workspace" :class="{ 'generation-locked': generationLocked, 'is-wide': wideShell }">
    <!-- Web 侧栏：首页、非交互「加油」分组、三项导航与设置；保护下禁用普通导航。 -->
    <aside class="side-nav" aria-label="加油导航">
      <a class="side-brand" href="/" aria-label="返回 Hako 首页" :aria-disabled="locked || navigatingForLogin"
        @click.prevent="navigate({ name: 'home' })">
        <img class="side-brand-mark" :src="'/hako-mark-32.png'" :srcset="'/hako-mark-48.png 1.5x, /hako-mark-64.png 2x'" width="32" height="32" alt="" decoding="async" />
        <span class="side-brand-name brand-wordmark">Hako</span>
      </a>
      <a class="side-home" href="/" :aria-disabled="locked || navigatingForLogin"
        @click.prevent="navigate({ name: 'home' })">
        <span aria-hidden="true">‹</span> 首页
      </a>
      <nav class="side-nav-items" aria-label="加油">
        <span class="side-group">加油</span>
        <button type="button" class="side-item" :class="{ active: route.name === 'records' || route.name === 'record-detail' }"
          :aria-current="(route.name === 'records' || route.name === 'record-detail') ? 'page' : undefined"
          :disabled="generationLocked || locked" @click="refuelingNavigate({ name: 'records' })">
          <List aria-hidden="true" :size="18" :stroke-width="2" /> 记录
        </button>
        <button type="button" class="side-item" :class="{ active: route.name === 'statistics' }"
          :aria-current="route.name === 'statistics' ? 'page' : undefined"
          :disabled="generationLocked || locked" @click="refuelingNavigate({ name: 'statistics' })">
          <ChartLine aria-hidden="true" :size="18" :stroke-width="2" /> 统计
        </button>
        <button type="button" class="side-item" :class="{ active: route.name.startsWith('data') }"
          :aria-current="route.name.startsWith('data') ? 'page' : undefined"
          :disabled="generationLocked || locked" @click="refuelingNavigate({ name: 'data' })">
          <Database aria-hidden="true" :size="18" :stroke-width="2" /> 数据
        </button>
        <button v-if="pendingRestore !== null && !generationLocked" type="button" class="side-item side-pending-link"
          @click="refuelingNavigate({ name: 'data-restore-result' })">
          <FileClock aria-hidden="true" :size="18" :stroke-width="2" /> 查看恢复结果
        </button>
      </nav>
      <button type="button" class="side-item side-settings" :disabled="locked || navigatingForLogin" @click="openSettings">
        <SettingsIcon aria-hidden="true" :size="18" :stroke-width="2" /> 设置
      </button>
    </aside>

    <div class="workspace-main">
      <!-- 顶栏：手机根页「‹ Hako + 页名」、子页来源返回；Web 面包屑。 -->
      <header class="workspace-topbar">
        <div class="topbar-leading">
          <button v-if="isRootRoute" type="button" class="topbar-home" :disabled="locked || navigatingForLogin"
            aria-label="返回 Hako 首页" @click="navigate({ name: 'home' })">
            <span aria-hidden="true">‹</span> Hako
          </button>
          <button v-else type="button" class="topbar-back" @click="backToSubParent">
            <span aria-hidden="true">‹</span> 返回
          </button>
          <h1 ref="routeHeading" class="topbar-title programmatic-focus-heading" tabindex="-1">
            <span class="topbar-crumb" aria-hidden="true">加油 / </span>{{ routeTitle }}
          </h1>
        </div>
        <div class="topbar-trailing">
          <button type="button" class="sync-chip" :class="`is-${syncSummary.tone}`"
            :aria-label="`同步状态：${syncSummary.text}`"
            @click="syncSummary.tone === 'danger' ? refuelingNavigate({ name: 'data' }) : undefined">
            <LoaderCircle v-if="syncSummary.spinning" aria-hidden="true" class="spin" :size="14" :stroke-width="2" />
            <span v-else class="sync-dot" aria-hidden="true"></span>
            {{ syncSummary.text }}
          </button>
          <button type="button" class="topbar-account" :disabled="locked || navigatingForLogin" aria-label="账号与外观" @click="openSettings">
            <span class="avatar-dot" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <p v-if="localNotice" class="local-notice" role="status">{{ localNotice }}</p>
      <p v-if="migrationPending" class="warning" role="status">{{ migrationPending }}</p>
      <p v-if="backupCancelNotice" class="warning" role="status">{{ backupCancelNotice }}</p>
      <p v-if="importConflictCount > 0" class="warning" role="status">
        有 {{ importConflictCount }} 个旧记录来源存在多个导入目标，需人工核对；这些来源已禁止自动导入，映射已保留。
      </p>

      <!-- 代次保护分段（R01）：草稿保护成功前不隐藏普通工作区；失败保留原输入并
           可重试。保护成功后用保护页替换普通呈现（实例仅隐藏，不卸载）。 -->
      <div v-if="protectedFlow && protectionStage !== 'protected'" class="protection-notice" role="region" aria-label="账号数据已在另一处恢复">
        <p class="protection-notice-title">账号数据已在另一处恢复。</p>
        <p v-if="protectionStage === 'protecting'" class="protection-sub" role="status">
          正在把当前输入保存为本机草稿，完成后才会显示保护页面。
        </p>
        <template v-else>
          <p class="protection-sub" role="alert">
            当前输入尚未保存到本机，已保留在本页；「保存记录」已冻结。请先重试保存草稿，再打开恢复后的数据。
          </p>
          <div class="protection-actions">
            <button type="button" class="primary" :disabled="protectionRetrying" @click="protectDrafts">
              {{ protectionRetrying ? "正在保存…" : "重试保存草稿" }}
            </button>
          </div>
          <p v-if="protectionFlushNotice" class="protection-sub" role="alert">{{ protectionFlushNotice }}</p>
        </template>
      </div>
      <div v-if="protectedFlow && protectionStage === 'protected'" class="protection-panel" role="region" aria-label="账号数据已在另一处恢复">
        <span class="protection-mark" aria-hidden="true">
          <ShieldAlert :size="26" :stroke-width="2" />
        </span>
        <h2 class="protection-title">{{ protectedFlow.message }}</h2>
        <p v-if="protectedFlow.serverGeneration === null" class="protection-sub">
          当前需要联网确认账号数据状态；本机保留副本与草稿可查看，原有输入已保留。
        </p>
        <p v-if="protectedFlow.receipt === 'unknown'" class="protection-sub">
          恢复结果尚未确认：原请求已保留，本机旧副本不上传。可稍后在此重试查询，或更新应用后再确认。
        </p>
        <p v-else-if="protectedFlow.receipt === 'committed'" class="protection-sub">恢复结果已确认，可放心打开恢复后的数据。</p>
        <p v-else-if="protectedFlow.receipt === 'failed'" class="protection-sub" role="alert">
          本机保存恢复结果失败：原请求已保留，尚未确认任何结果。请释放本机空间后重试查询。
        </p>
        <div class="protection-actions">
          <button type="button" class="primary" :disabled="openingCurrent || protectedFlow.serverGeneration === null" @click="openCurrentData">
            {{ openingCurrent ? "正在打开…" : "打开恢复后数据" }}
          </button>
          <button type="button" :disabled="openingCurrent" @click="refuelingNavigate({ name: 'data-retained' })">查看保留内容</button>
          <button v-if="protectedFlow.serverGeneration === null" type="button" class="text-button" @click="retryOpen()">重试确认</button>
          <button v-if="pendingRestore !== null" type="button" class="text-button" @click="refuelingNavigate({ name: 'data-restore-result' })">
            查看恢复结果
          </button>
          <button v-if="protectedFlow.receipt === 'unknown' || protectedFlow.receipt === 'committed' || protectedFlow.receipt === 'failed'"
            type="button" class="text-button" @click="recheckRestoreReceipt()">
            再次查询恢复结果
          </button>
        </div>
        <p v-if="openCurrentNotice" class="protection-sub" role="alert">{{ openCurrentNotice }}</p>
        <!-- 保护态下保留内容只读查看。 -->
        <RetainedRefuelingCopy v-if="route.name === 'data-retained'" :account-id="accountId" :allow-bring-back="false"
          :summaries="() => listRetainedGenerations(retainedExcludeForView())"
          :read-generation="readRetainedGeneration"
          :draft-sources="() => listRetainedDraftSources(accountId, retainedExcludeForView())"
          :known-records="() => new Map(records.map((record) => [record.id, record]))"
          @close="backToRoute({ name: 'data' })" @bring-back-record="bringBackFromRetained" @bring-back-draft="bringBackDraftFromRetained" />
        <!-- 保护态 D3：只挂本机原请求的查询/本人重试流程，不开放新预览或普通写入；
             面板内「确无结果」协调（回数据页）由此实例接管（UI-R06/R07）。 -->
        <BackupRestore v-if="route.name === 'data-restore-result'" :account-id="accountId" :local="local"
          :flush-draft="flushDraft" visible-section="result" protection-mode
          @request-section="(section: 'list' | 'preview' | 'result' | 'data') => refuelingNavigate(section === 'result' ? { name: 'data-restore-result' } : { name: 'data' })"
          :cancel-delivery-epoch="backupCancelEpoch" @cancel-unconfirmed-change="onBackupCancelDelivery" />
      </div>
      <div v-if="failedFlow" class="warning protection-panel" role="alert">
        <p>{{ failedFlow.message }}</p>
        <button type="button" class="text-button" @click="retryOpen()">重试</button>
      </div>

      <div v-show="normalViewportVisible" class="route-viewport">
        <!-- F1/F2：记录根页（宽屏主从；筛选与选中状态随实例保存在本窗口内存）。 -->
        <RecordsRoot v-show="isRecordsView" :records="records" :busy="formLocked" :ready="ready" :error="error"
          :wide="wideShell" :detail-record-id="detailRecordId" :warnings="recordWarningsMap"
          :pending-editor-label="pendingEditorLabel" :draft-count="recoveryCandidates.length"
          :draft-picker-notice="recoveryNotice" :filter-context="statsFilterContext"
          @select-record="selectRecord" @start-new="startNew" @continue-editing="continueEditing"
          @open-drafts="showDraftPicker = true" @edit-record="startEdit" @retry-load="initialize"
          @open-legacy-import="refuelingNavigate({ name: 'data-legacy-import' })"
          @remove-filter="removeStatsFilter">
          <template #detail="{ record }">
            <RecordDetailPanel :record="record" :busy="formLocked" :warnings="recordWarningsMap.get(record.id) ?? []" @edit="startEdit(record)" />
          </template>
        </RecordsRoot>

        <!-- F2 独立详情页（窄屏）：来源返回 + 完整业务字段。 -->
        <section v-if="route.name === 'record-detail' && !wideShell && detailRecord" class="subpage">
          <RecordDetailPanel :record="detailRecord" :busy="formLocked" :warnings="recordWarningsMap.get(detailRecord.id) ?? []" @edit="startEdit(detailRecord)" />
        </section>
        <section v-else-if="route.name === 'record-detail' && !wideShell" class="subpage" aria-busy="true">
          <p class="muted">{{ ready ? "没有找到这条记录。" : "正在打开账号的本机记录…" }}</p>
        </section>

        <!-- F3：编辑器（v-show 保活；离开路由先 flush，输入与占用保留）。 -->
        <section v-show="isEditorView" class="editor-view" aria-labelledby="editor-title">
          <div class="editor-header">
            <button type="button" class="editor-back" @click="continueLater">
              <span aria-hidden="true">‹</span> {{ editorBackLabel }}
            </button>
            <h2 id="editor-title" class="editor-title">{{ selected ? "编辑记录" : "记一次加油" }}</h2>
            <button type="button" class="editor-more" aria-label="放弃这份草稿" @click="showDiscardConfirm = true">
              放弃草稿…
            </button>
          </div>
          <p v-if="draftWriteError" class="field-error" role="alert">
            {{ draftWriteError }} 登录跳转会被阻止，请重试或释放本机空间。
          </p>
          <RefuelingForm
            :key="formKey"
            :initial="selected"
            :initial-draft="initialDraft"
            :busy="saving"
            :locked="formLocked"
            :available="ready"
            :records="records"
            :editing-record-id="selected?.id ?? null"
            @dirty="dirty = $event"
            @draft="onFormDraft"
            @save="submit"
            @continue-later="continueLater"
          />
        </section>

        <!-- F4：统计（入口与布局接线；尚未实施的统计能力明确标注，不放合成数字）。 -->
        <StatisticsPage v-if="route.name === 'statistics'" :records="records" @view-records="viewRecordsFromStatistics" />

        <!-- D0：数据页（本机 / 账号同步 / 独立备份 / 保留内容 / 旧验证导入 分区事实）。 -->
        <DataPage v-if="route.name === 'data'" :account-id="accountId" :local="local" :busy="formLocked"
          @retry-load="initialize" @persist="requestPersistence"
          @open-backups="refuelingNavigate({ name: 'data-backups' })"
          @open-restore-result="refuelingNavigate({ name: 'data-restore-result' })"
          @open-retained="refuelingNavigate({ name: 'data-retained' })"
          @open-legacy-import="refuelingNavigate({ name: 'data-legacy-import' })" />

        <!-- D1/D2/D3：备份版本、恢复预览与原请求结果（同一面板按地址分区呈现）。
             保护/锁定代次下本面板随普通 viewport 隐藏，其路由意图（含在途取消
             回调的迟到 emit）一并失效（UI-R07），由保护态面板接管结果分区。 -->
        <div v-if="isBackupsArea" class="subpage">
          <BackupRestore :account-id="accountId" :local="local" :flush-draft="flushDraft"
            :visible-section="route.name === 'data-backups' ? 'list' : route.name === 'data-backup-preview' ? 'preview' : 'result'"
            @close="backToRoute({ name: 'data' })"
            @request-section="(section: 'list' | 'preview' | 'result' | 'data') => { if (generationLocked) return; refuelingNavigate(section === 'preview' ? { name: 'data-backup-preview' } : section === 'result' ? { name: 'data-restore-result' } : section === 'data' ? { name: 'data' } : { name: 'data-backups' }); }"
            :cancel-delivery-epoch="backupCancelEpoch" @cancel-unconfirmed-change="onBackupCancelDelivery" />
        </div>

        <!-- D4：保留内容与旧草稿（激活后可逐项带回；保护流程只读）。 -->
        <div v-if="route.name === 'data-retained'" class="subpage">
          <p v-if="retainedDraftNotice" class="warning" role="status">{{ retainedDraftNotice }}</p>
          <RetainedRefuelingCopy :account-id="accountId" :allow-bring-back="allowBringBack"
            :summaries="() => listRetainedGenerations(retainedExcludeForView())"
            :read-generation="readRetainedGeneration"
            :draft-sources="() => listRetainedDraftSources(accountId, retainedExcludeForView())"
            :known-records="() => new Map(records.map((record) => [record.id, record]))"
            @close="backToRoute({ name: 'data' })" @bring-back-record="bringBackFromRetained" @bring-back-draft="bringBackDraftFromRetained" />
        </div>

        <!-- D5：旧验证导入（本人打开时才读取旧库；冲突字段不能靠图标解除）。 -->
        <div v-if="route.name === 'data-legacy-import'" class="subpage">
          <LegacyImport :disabled="formLocked || !ready" :can-import="serverConfirmedActive && !generationLocked"
            :imported-ids="importedLegacyIds" :import-conflicts="importConflicts" :import-records="importLegacy" />
        </div>
      </div>

      <!-- 手机底部导航：仅三个根页显示；子页使用来源返回。 -->
      <nav v-if="isRootRoute && !generationLocked" class="bottom-nav" aria-label="加油导航">
        <button type="button" :class="{ active: route.name === 'records' }" :aria-current="route.name === 'records' ? 'page' : undefined"
          @click="refuelingNavigate({ name: 'records' })">
          <List aria-hidden="true" :size="20" :stroke-width="2" /><span>记录</span>
        </button>
        <button type="button" :class="{ active: route.name === 'statistics' }" :aria-current="route.name === 'statistics' ? 'page' : undefined"
          @click="refuelingNavigate({ name: 'statistics' })">
          <ChartLine aria-hidden="true" :size="20" :stroke-width="2" /><span>统计</span>
        </button>
        <button type="button" :class="{ active: route.name === 'data' }" :aria-current="route.name === 'data' ? 'page' : undefined"
          @click="refuelingNavigate({ name: 'data' })">
          <Database aria-hidden="true" :size="20" :stroke-width="2" /><span>数据</span>
        </button>
      </nav>
    </div>

    <!-- 草稿选择层：有挂起编辑时先完成或放弃当前编辑；占用草稿不可接管。
         直接编辑地址下的选择层只列该记录的草稿，并提供「不用草稿直接编辑」。 -->
    <DraftSelectionLayer v-if="showDraftPicker" :candidates="pickerCandidates" :has-pending-editor="pendingEditor !== null"
      :mode="route.name === 'record-edit' ? 'edit' : 'new'"
      :draft-time="draftTime" :draft-summary="draftSummary"
      @continue="continueDraftFromPicker" @discard="discardDraft" @alternate="alternateFromPicker" @close="showDraftPicker = false" />

    <!-- 放弃草稿确认：默认焦点在「继续填写」，明确确认才放弃；关闭还原触发点。 -->
    <div v-if="showDiscardConfirm" :ref="(element) => { discardDialogFocus.layerRoot.value = element as HTMLElement | null; }" class="dialog-layer" role="dialog" aria-modal="true" aria-labelledby="discard-title" @keydown="onDiscardDialogKeydown">
      <div class="dialog-backdrop" @click="closeDiscardConfirm"></div>
      <div class="dialog-card" role="document">
        <h2 id="discard-title">放弃这份草稿？</h2>
        <p>已填写的内容会删除，无法恢复；已保存的记录不受影响。</p>
        <div class="dialog-actions">
          <button type="button" ref="discardKeepButton" class="primary" @click="closeDiscardConfirm">继续填写</button>
          <button type="button" class="danger-outline" @click="discardActiveDraft">放弃草稿</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.refueling-workspace {
  display: grid;
  grid-template-columns: 1fr;
  min-height: 100vh;
}
.side-nav {
  display: none;
}
.workspace-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 14px 16px 84px;
}
.workspace-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border-default);
}
.topbar-leading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.topbar-home,
.topbar-back {
  min-height: 40px;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: var(--text-accent);
  font-size: 0.875rem;
  white-space: nowrap;
}
.topbar-title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 500;
  letter-spacing: -0.2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar-crumb {
  display: none;
  color: var(--text-muted);
  font-weight: 400;
}
.topbar-trailing {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.sync-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 0.75rem;
  background: var(--surface-elevated);
  color: var(--text-secondary);
}
.sync-chip.is-success { color: var(--status-success-fg); border-color: var(--status-success-border); }
.sync-chip.is-danger { color: var(--status-danger-fg); border-color: var(--status-danger-border); background: var(--status-danger-bg); }
.sync-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.is-success .sync-dot { background: var(--status-success); }
.is-danger .sync-dot { background: var(--status-danger); }
.is-busy .sync-dot { background: var(--text-accent); }
.spin { animation: hako-spin 0.9s linear infinite; }
@keyframes hako-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
}
.topbar-account {
  display: grid;
  place-items: center;
  width: 36px;
  min-height: 36px;
  padding: 0;
  border-radius: 50%;
}
.avatar-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1.5px solid var(--text-accent);
}
.local-notice {
  margin: 0 0 12px;
  color: var(--text-accent);
  font-size: 0.8125rem;
  line-height: 1.8;
}
.route-viewport {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.subpage {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  background: var(--surface-panel);
  border-top: 1px solid var(--border-default);
  padding-bottom: env(safe-area-inset-bottom);
}
.bottom-nav button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-height: 56px;
  padding: 8px 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.6875rem;
}
.bottom-nav button.active {
  color: var(--text-accent);
  background: var(--accent-soft);
}
/* 编辑器视图 */
.editor-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 720px;
}
.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.editor-back {
  min-height: 40px;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: var(--text-accent);
  font-size: 0.875rem;
}
.editor-title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 500;
}
.editor-more {
  min-height: 40px;
  padding: 6px 12px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}
/* 保护流程 */
.protection-notice {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
  padding: 20px 22px;
  border: 1px solid var(--status-warning-border);
  border-radius: 16px;
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
}
.protection-notice-title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 500;
}
.protection-notice .protection-sub {
  color: inherit;
}
.protection-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
  padding: 24px;
  border: 1px solid var(--status-warning-border);
  border-radius: 16px;
  background: var(--surface-panel);
}
.protection-mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
}
.protection-title {
  margin: 0;
  font-size: 1.1875rem;
  font-weight: 500;
}
.protection-sub {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.8;
  color: var(--text-secondary);
}
.protection-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.protection-actions button {
  min-height: 44px;
}
/* 对话框 */
.dialog-layer {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: 20px;
}
.dialog-backdrop {
  position: absolute;
  inset: 0;
  background: rgb(9 8 12 / 0.32);
}
.dialog-card {
  position: relative;
  width: min(420px, 100%);
  padding: 24px;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  background: var(--surface-panel);
  box-shadow: var(--shadow-panel, 0 18px 48px rgb(9 8 12 / 0.2));
}
.dialog-card h2 {
  margin: 0 0 10px;
  font-size: 1.0625rem;
}
.dialog-card p {
  margin: 0 0 20px;
  font-size: 0.875rem;
  line-height: 1.8;
  color: var(--text-secondary);
}
.dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}
/* Web（≥880px）：固定侧栏 + 顶栏面包屑 */
@media (min-width: 880px) {
  .refueling-workspace {
    grid-template-columns: 236px minmax(0, 1fr);
  }
  .side-nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 18px 14px;
    border-right: 1px solid var(--border-default);
    background: var(--surface-panel);
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }
  .side-brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 4px 10px;
    margin-bottom: 14px;
    color: var(--text-primary);
    text-decoration: none;
    border-radius: 10px;
  }
  .side-brand-mark { width: 30px; height: 30px; display: block; }
  .side-brand-name { font-size: 1.0625rem; }
  .side-home {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 6px 10px;
    margin-bottom: 8px;
    border-radius: 10px;
    color: var(--text-accent);
    font-size: 0.875rem;
    text-decoration: none;
  }
  .side-home:hover {
    background: var(--surface-elevated);
  }
  .side-nav-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .side-group {
    padding: 10px 10px 4px;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .side-item {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: flex-start;
    min-height: 42px;
    padding: 8px 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.875rem;
    text-align: left;
  }
  .side-item:hover:not(:disabled) {
    background: var(--surface-elevated);
    border-color: transparent;
  }
  .side-item.active {
    background: var(--accent-soft);
    color: var(--text-accent);
  }
  .side-settings {
    margin-top: auto;
  }
  .workspace-main {
    padding: 18px 28px 40px;
    min-height: 100vh;
  }
  .topbar-crumb {
    display: inline;
  }
  .bottom-nav { display: none; }
  .editor-view {
    max-width: 640px;
  }
}
</style>
