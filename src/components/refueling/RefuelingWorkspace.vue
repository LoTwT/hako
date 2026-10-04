<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { useLocalRefueling } from "../../composables/useLocalRefueling";
import { useRefuelingDrafts } from "../../composables/useRefuelingDrafts";
import type {
  DraftFormContext,
  StoredRefuelingDraft,
} from "../../domain/refueling/draft-recovery";
import {
  changedFields,
  type RefuelingDraft,
  type RefuelingRecord,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";
import RefuelingForm from "./RefuelingForm.vue";
import RefuelingRecords from "./RefuelingRecords.vue";
import StorageStatus from "./StorageStatus.vue";
import LegacyImport from "./LegacyImport.vue";

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
} = props.local;
const drafts = useRefuelingDrafts({
  accountId: props.accountId,
  knownRecords: () => new Map(records.value.map((record) => [record.id, record])),
});

const selected = shallowRef<SavedRefuelingRecord>();
const formId = shallowRef<string>(crypto.randomUUID());
const formKey = shallowRef(0);
const initialDraft = shallowRef<RefuelingDraft>();
const dirty = shallowRef(false);
const localNotice = shallowRef("");

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
  if (props.locked) return;
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
        : "草稿尚未保存到本机，已取消登录跳转。"),
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
    <div v-if="selected" class="workspace-actions">
      <button :disabled="saving || locked" @click="createNew">
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
          <button class="text-button" :disabled="locked || saving" @click="restoreDraft(draft)">恢复</button>
          <button class="text-button" :disabled="locked || saving" @click="discardDraft(draft)">放弃</button>
        </li>
      </ul>
    </div>
    <p v-if="draftWriteError" class="field-error" role="alert">
      {{ draftWriteError }} 登录跳转会被阻止，请重试或释放本机空间。
    </p>
    <p v-else-if="retainedDraftNotice" class="warning">
      {{ retainedDraftNotice }}
    </p>
    <div class="workspace-grid">
      <RefuelingForm
        :key="formKey"
        :initial="selected"
        :initial-draft="initialDraft"
        :busy="saving"
        :locked="locked"
        :available="ready"
        @dirty="dirty = $event"
        @draft="onFormDraft"
        @save="submit"
      /><RefuelingRecords
        :records="records"
        :busy="saving || locked"
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
    <button class="text-button sync-now" :disabled="locked || !ready" @click="retrySync">立即同步</button>
    <p class="local-notice">同步成功不代表独立备份已完成；本版暂不提供备份恢复。</p>
    <LegacyImport :disabled="locked || saving || !ready" :imported-ids="importedLegacyIds" :import-records="importLegacy" />
  </div>
</template>

<style scoped>
.sync-now { min-height: 44px; }
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
@media (max-width: 760px) {
  .workspace-grid {
    grid-template-columns: 1fr;
  }
}
</style>
