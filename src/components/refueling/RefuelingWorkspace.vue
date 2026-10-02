<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { useRegisterSW } from "virtual:pwa-register/vue";
import { useAuthSession } from "../../composables/useAuthSession";
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
import AuthStatus from "../auth/AuthStatus.vue";
import RefuelingForm from "./RefuelingForm.vue";
import RefuelingRecords from "./RefuelingRecords.vue";
import StorageStatus from "./StorageStatus.vue";

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
} = useLocalRefueling();
const {
  auth,
  refresh: refreshAuth,
  login: startLogin,
  logout: endLogin,
} = useAuthSession();
const drafts = useRefuelingDrafts({
  knownRecords: () => new Map(records.value.map((record) => [record.id, record])),
});

const selected = shallowRef<SavedRefuelingRecord>();
const formId = shallowRef<string>(crypto.randomUUID());
const formKey = shallowRef(0);
const initialDraft = shallowRef<RefuelingDraft>();
const dirty = shallowRef(false);
const localNotice = shallowRef("");
const registrationError = shallowRef("");
/** 登录跳转期间不再弹离页确认：草稿已经确认落盘。 */
const navigatingForLogin = shallowRef(false);
/**
 * 登录流程阶段：preparing 期间冻结页面输入，navigating 表示正在顶层跳转。
 * 冻结保证离页内容与已确认落盘的版本一致，也避免并发发起两次登录。
 */
const loginPhase = shallowRef<"idle" | "preparing" | "navigating">("idle");
const loginInProgress = computed(() => loginPhase.value !== "idle");
const { offlineReady, needRefresh } = useRegisterSW({
  onRegisterError() {
    registrationError.value = "离线资源准备失败；重新联网打开后再检查。";
  },
});

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

async function login() {
  if (loginInProgress.value || auth.value.loggingIn || auth.value.loggingOut) return;
  localNotice.value = "";
  loginPhase.value = "preparing";
  try {
    // 先确认最新草稿已经写入本机，再允许顶层跳转
    if (!(await confirmDraftSaved())) return;
    const result = await startLogin();
    if (!result.ok) return;
    // 请求期间页面已冻结；跳转前再确认一次，保证离页版本就是已落盘版本
    if (!(await confirmDraftSaved())) return;
    loginPhase.value = "navigating";
    navigatingForLogin.value = true;
    window.location.assign(result.authorizationUrl);
  } finally {
    // 跳转成功时保持冻结，等待浏览器接管
    if (loginPhase.value !== "navigating") loginPhase.value = "idle";
  }
}

/** 等待草稿落盘；失败时给出可读提示并返回 false（由调用方取消跳转）。 */
async function confirmDraftSaved(): Promise<boolean> {
  if (await drafts.flush()) return true;
  const draftsState = drafts.drafts.value;
  localNotice.value =
    draftsState.writeError ||
    (draftsState.status === "loading"
      ? "正在准备本机草稿，请稍后再试。"
      : "草稿尚未保存到本机，已取消登录跳转。");
  return false;
}

async function logout() {
  localNotice.value = "";
  await endLogin();
}

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
  if (navigatingForLogin.value) return;
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
  <main class="workspace">
    <header class="page-header">
      <a class="brand" href="/" aria-label="Hako 首页"
        >hako<span class="brand-dot">.</span></a
      ><span class="version-label">本地验证版</span>
    </header>
    <div class="page-heading">
      <div>
        <p class="eyebrow">ONE CAR, EVERY JOURNEY</p>
        <h1>把每次加油，记清楚。</h1>
        <p class="intro">
          先验证本机保存、草稿恢复与多窗口编辑。请使用测试记录，云端同步和备份尚未接入。
        </p>
      </div>
      <button v-if="selected" :disabled="saving || loginInProgress" @click="createNew">
        新增记录
      </button>
    </div>
    <AuthStatus
      :auth="auth"
      :notice="localNotice"
      :busy="loginInProgress"
      @login="login"
      @logout="logout"
      @retry="refreshAuth"
    />
    <div v-if="recoveryCandidates.length" class="warning" role="region" aria-label="未保存的草稿">
      <p>{{ recoveryNotice }}</p>
      <ul class="draft-list">
        <li v-for="draft of recoveryCandidates" :key="draft.id" :data-draft-id="draft.id">
          <span class="draft-meta"
            >{{ draft.mode === "edit" ? "编辑记录" : "新建记录" }} ·
            {{ draftTime(draft.updatedAt) }}</span
          >
          <span class="draft-summary">{{ draftSummary(draft) }}</span>
          <button class="text-button" @click="restoreDraft(draft)">恢复</button>
          <button class="text-button" @click="discardDraft(draft)">放弃</button>
        </li>
      </ul>
    </div>
    <p v-if="draftWriteError" class="field-error" role="alert">
      {{ draftWriteError }} 登录跳转会被阻止，请重试或释放本机空间。
    </p>
    <p v-else-if="retainedDraftNotice" class="warning">
      {{ retainedDraftNotice }}
    </p>
    <p v-if="registrationError" class="warning">{{ registrationError }}</p>
    <p v-else-if="offlineReady" class="offline-label">离线页面已准备好</p>
    <div v-if="needRefresh" class="warning">
      新版本已就绪。请保存所有窗口中的输入，再关闭并重新打开 Hako。
    </div>
    <div class="workspace-grid">
      <RefuelingForm
        :key="formKey"
        :initial="selected"
        :initial-draft="initialDraft"
        :busy="saving"
        :locked="loginInProgress"
        :available="ready"
        @dirty="dirty = $event"
        @draft="onFormDraft"
        @save="submit"
      /><RefuelingRecords
        :records="records"
        :busy="saving || loginInProgress"
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
  </main>
</template>

<style scoped>
.workspace {
  max-width: 1080px;
  margin: 0 auto;
  padding: 30px 28px 40px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--line);
}
.brand {
  font-size: 30px;
  font-weight: 750;
  letter-spacing: -1.5px;
  color: var(--ink);
  text-decoration: none;
}
.brand-dot {
  color: var(--accent);
}
.version-label {
  font-size: 12px;
  color: var(--muted);
}
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin: 42px 0 26px;
}
.page-heading h1 {
  margin: 9px 0 12px;
  font-size: clamp(25px, 4vw, 34px);
  font-weight: 550;
  letter-spacing: -0.8px;
}
.intro {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.9;
  max-width: 620px;
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
.offline-label {
  color: var(--accent);
  font-size: 12px;
  margin-bottom: 16px;
}
@media (max-width: 760px) {
  .workspace {
    padding: 20px 16px;
  }
  .workspace-grid {
    grid-template-columns: 1fr;
  }
  .page-heading {
    margin-top: 30px;
  }
}
</style>
