<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue";
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
  unscale,
  type RefuelingDraft,
  type RefuelingRecord,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";
import RefuelingForm from "./RefuelingForm.vue";
import RefuelingRecords from "./RefuelingRecords.vue";
import StorageStatus from "./StorageStatus.vue";
import LegacyImport from "./LegacyImport.vue";
import RetainedRefuelingCopy from "./RetainedRefuelingCopy.vue";

const props = defineProps<{
  accountId: string;
  local: ReturnType<typeof useLocalRefueling>;
  locked: boolean;
  navigatingForLogin: boolean;
}>();

const {
  records,
  ready,
  saving,
  error,
  notice,
  persistent,
  save,
  initialize,
  requestPersistence,
  importedLegacyIds,
  importLegacy,
  retrySync,
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
const showRetained = shallowRef(false);
const openingCurrent = shallowRef(false);
const openCurrentNotice = shallowRef("");

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
}

function edit(record: SavedRefuelingRecord) {
  localNotice.value = "";
  selected.value = { ...record };
  formId.value = record.id;
  initialDraft.value = undefined;
  formKey.value += 1;
  dirty.value = false;
  drafts.attachForm(attachedContext());
}

function onFormDraft(draft: RefuelingDraft) {
  drafts.updateDraft(draft);
}

async function submit(record: RefuelingRecord) {
  if (formLocked.value) return;
  const patch = selected.value ? changedFields(selected.value, record) : record;
  if (!(await save(formId.value, patch, !selected.value))) return;
  const cleared = await drafts.clearAfterSave();
  localNotice.value = cleared.ok ? "" : cleared.message;
  startFreshForm();
}

async function restoreDraft(draft: StoredRefuelingDraft) {
  const adopted = await drafts.adopt(draft.id);
  if (adopted === null) {
    localNotice.value = "该草稿正被其他窗口使用或已不存在，未在本窗口恢复。";
    return;
  }
  applyAdoptedDraft(adopted);
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

/**
 * 打开保留副本视图：先按 §6.1 重新扫描 v1 迟到写入（发现新增历史合并进保留
 * G0 副本，失败明确显示待处理），再进入只读查看。
 */
async function openRetained() {
  await props.local.recheckMigration();
  showRetained.value = true;
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
  showRetained.value = false;
  localNotice.value = payload.exists
    ? "已按勾选字段填入当前记录的编辑表单，请核对后保存。"
    : "已按勾选字段填入新记录表单（新记录 ID），请核对后保存。";
}

/**
 * 保留草稿带回：先核对原始输入（视图内），再以当前代次基线填入表单——同 ID
 * 记录用当前记录为基线，禁止自动接上旧 base；记录不存在时作为新记录填写。
 */
function bringBackDraftFromRetained(draft: StoredRefuelingDraft) {
  if (!allowBringBack.value) return;
  if (dirty.value) {
    localNotice.value = "当前表单有未保存输入，请先保存或放弃后再带入保留草稿。";
    return;
  }
  const current = records.value.find((record) => record.id === draft.recordId);
  if (current !== undefined) {
    selected.value = { ...current };
    formId.value = current.id;
  } else {
    selected.value = undefined;
    formId.value = crypto.randomUUID();
  }
  // 同上：带回草稿后的新输入绑定当前记录与当前基线，不接旧 base。
  drafts.attachForm(attachedContext());
  initialDraft.value = { values: { ...draft.values }, sources: { ...draft.sources } };
  formKey.value += 1;
  dirty.value = true;
  showRetained.value = false;
  localNotice.value = current !== undefined
    ? "已填入当前记录的编辑表单（保留草稿的原始输入），请核对后保存。"
    : "已填入新记录表单（新记录 ID），请核对后保存。";
}

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
      return;
    }
    // 没有可恢复草稿：清掉过期线索，保持空白表单
    if (drafts.currentDraftId() === null) drafts.attachForm(attachedContext());
  },
  { immediate: true },
);
onMounted(() => window.addEventListener("beforeunload", warnBeforeLeaving));
onUnmounted(() =>
  window.removeEventListener("beforeunload", warnBeforeLeaving),
);
</script>

<template>
  <div class="refueling-workspace">
    <p v-if="localNotice" class="local-notice" role="status">{{ localNotice }}</p>
    <!-- 代次保护流程：冻结保存，保留旧副本与草稿，等待本人选择。 -->
    <div v-if="protectedFlow" class="warning generation-guard" role="region" aria-label="账号数据已在另一处恢复">
      <p>{{ protectedFlow.message }}</p>
      <p v-if="protectedFlow.serverGeneration === null" class="generation-sub">
        当前需要联网确认账号数据状态；本机保留副本与草稿可查看，原有输入已保留。
      </p>
      <p v-if="protectedFlow.receipt === 'unknown'" class="generation-sub">
        恢复结果尚未确认：原请求已保留，本机旧副本不上传。可稍后在此重试查询，或更新应用后再确认。
      </p>
      <p v-else-if="protectedFlow.receipt === 'committed'" class="generation-sub">恢复结果已确认，可放心打开恢复后的数据。</p>
      <p v-else-if="protectedFlow.receipt === 'failed'" class="generation-sub" role="alert">
        本机保存恢复结果失败：原请求已保留，尚未确认任何结果。请释放本机空间后重试查询。
      </p>
      <div class="generation-actions">
        <button type="button" :disabled="openingCurrent" @click="openRetained">查看保留副本</button>
        <button type="button" :disabled="openingCurrent || protectedFlow.serverGeneration === null" @click="openCurrentData">
          {{ openingCurrent ? "正在打开…" : "打开恢复后数据" }}
        </button>
        <button v-if="protectedFlow.serverGeneration === null" type="button" class="text-button" @click="retryOpen()">重试确认</button>
        <button v-if="protectedFlow.receipt === 'unknown' || protectedFlow.receipt === 'committed' || protectedFlow.receipt === 'failed'" type="button" class="text-button" @click="recheckRestoreReceipt()">
          再次查询恢复结果
        </button>
      </div>
      <p v-if="openCurrentNotice" class="generation-sub" role="alert">{{ openCurrentNotice }}</p>
    </div>
    <p v-else-if="failedFlow" class="warning generation-guard" role="alert">
      {{ failedFlow.message }}
      <button type="button" class="text-button" @click="retryOpen()">重试</button>
    </p>
    <p v-if="migrationPending" class="warning">{{ migrationPending }}</p>
    <p v-if="importConflictCount > 0" class="warning" role="status">
      有 {{ importConflictCount }} 个旧记录来源存在多个导入目标，需人工核对；这些来源已禁止自动导入，映射已保留。
    </p>
    <RetainedRefuelingCopy v-if="showRetained" :account-id="accountId" :allow-bring-back="allowBringBack"
      :summaries="() => listRetainedGenerations(retainedExcludeForView())"
      :read-generation="readRetainedGeneration"
      :draft-sources="() => listRetainedDraftSources(accountId, retainedExcludeForView())"
      :known-records="() => new Map(records.map((record) => [record.id, record]))"
      @close="showRetained = false" @bring-back-record="bringBackFromRetained" @bring-back-draft="bringBackDraftFromRetained" />
    <div v-if="selected && !generationLocked" class="workspace-actions">
      <button :disabled="formLocked" @click="createNew">
        新增记录
      </button>
    </div>
    <div v-if="recoveryCandidates.length" class="warning" role="region" aria-label="未保存的草稿">
      <p>{{ recoveryNotice }}</p>
      <ul class="draft-list">
        <li v-for="draft of recoveryCandidates" :key="draft.id" :data-draft-id="draft.id">
          <span class="draft-meta"
            >{{ draft.mode === "edit" ? "编辑记录" : "新建记录" }} ·
            {{ draftTime(draft.updatedAt) }}</span
          >
          <span class="draft-summary">{{ draftSummary(draft) }}</span>
          <button class="text-button" :disabled="formLocked" @click="restoreDraft(draft)">恢复</button>
          <button class="text-button" :disabled="formLocked" @click="discardDraft(draft)">放弃</button>
        </li>
      </ul>
    </div>
    <p v-if="draftWriteError" class="field-error" role="alert">
      {{ draftWriteError }} 登录跳转会被阻止，请重试或释放本机空间。
    </p>
    <p v-else-if="retainedDraftNotice" class="warning">
      {{ retainedDraftNotice }}
    </p>
    <p v-if="pendingRestore && generationFlow.phase === 'active'" class="warning" role="status">
      有恢复请求结果尚待确认；正常同步不受影响。请稍后重试或更新应用后再确认。
      <button type="button" class="text-button" @click="recheckRestoreReceipt()">再次查询恢复结果</button>
    </p>
    <div class="workspace-grid">
      <RefuelingForm
        :key="formKey"
        :initial="selected"
        :initial-draft="initialDraft"
        :busy="saving"
        :locked="formLocked"
        :available="ready"
        @dirty="dirty = $event"
        @draft="onFormDraft"
        @save="submit"
      /><RefuelingRecords
        :records="records"
        :busy="formLocked"
        @edit="edit"
      />
    </div>
    <StorageStatus
      :ready="ready"
      :error="error"
      :notice="notice"
      :persistent="persistent"
      @retry="initialize"
      @persist="requestPersistence"
    />
    <div v-if="generationFlow.phase === 'active'" class="workspace-links">
      <button class="text-button sync-now" :disabled="formLocked" @click="retrySync">立即同步</button>
      <button class="text-button" type="button" @click="openRetained">查看保留副本与旧草稿</button>
    </div>
    <p class="local-notice">同步成功不代表独立备份已完成；本版暂不提供备份恢复。</p>
    <LegacyImport v-if="serverConfirmedActive" :disabled="formLocked || !ready" :imported-ids="importedLegacyIds" :import-records="importLegacy" />
  </div>
</template>

<style scoped>
.sync-now { min-height: 44px; }
.workspace-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
}
.workspace-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
}
.local-notice {
  color: var(--accent);
  font-size: 13px;
  line-height: 1.8;
}
.workspace-grid {
  display: grid;
  grid-template-columns: 1.08fr 1fr;
  gap: 24px;
  align-items: start;
}
.draft-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.draft-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
}
.draft-meta {
  font-weight: 600;
}
.draft-summary {
  color: var(--muted);
  flex: 1 1 140px;
}
.generation-guard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.generation-guard p {
  margin: 0;
}
.generation-sub {
  font-size: 13px;
  line-height: 1.8;
}
.generation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.generation-actions button {
  min-height: 44px;
}
@media (max-width: 760px) {
  .workspace-grid {
    grid-template-columns: 1fr;
  }
}
</style>
