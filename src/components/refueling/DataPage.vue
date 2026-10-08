<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { Archive, ChevronRight, CircleCheck, CirclePause, CircleQuestionMark, Clock, FileClock, FileInput, Files, HardDrive, LoaderCircle, RefreshCw, TriangleAlert } from "@lucide/vue";
import type { useLocalRefueling } from "../../composables/useLocalRefueling";
import { fetchBackupStatus, type RefuelingBackupStatus } from "../../data/refueling-server-api";
import { listRetainedDraftSources } from "../../data/retained-content";

/**
 * 数据页（D0）：本机、账号同步、独立备份分别陈述事实，不显示总括的“安全”
 * 评分；一个已同步状态不代表其他设备未上传的数据已备份。备份等待时间只使用
 * 服务端 nextActionAtMs，没有值时明确未知；blocked 表示自动备份暂停、需要
 * 排查，不提供虚构的自动解锁时间。保留内容与旧验证导入是常驻低权重入口。
 */
const props = defineProps<{
  accountId: string;
  local: ReturnType<typeof useLocalRefueling>;
  busy: boolean;
}>();
const emit = defineEmits<{
  retryLoad: [];
  persist: [];
  openBackups: [];
  openRestoreResult: [];
  openRetained: [];
  openLegacyImport: [];
}>();

const { error, persistent, pendingSync, confirmed, syncStatus, pendingRestore, restoreWritesAvailable, generationFlow, listRetainedGenerations, retrySync } = props.local;

const backupStatus = shallowRef<{ state: "loading" } | { state: "ready"; status: RefuelingBackupStatus } | { state: "failed" }>({ state: "loading" });
const retainedState = shallowRef<{ state: "loading" } | { state: "ready"; copies: number; drafts: number } | { state: "failed" }>({ state: "loading" });

async function loadBackupStatus() {
  backupStatus.value = { state: "loading" };
  const result = await fetchBackupStatus({ accountId: props.accountId });
  backupStatus.value = result.ok ? { state: "ready", status: result.status } : { state: "failed" };
}

async function loadRetainedState() {
  retainedState.value = { state: "loading" };
  try {
    const exclude = generationFlow.value.phase === "active" ? generationFlow.value.generation : null;
    const [copies, draftSources] = await Promise.all([
      listRetainedGenerations(exclude),
      listRetainedDraftSources(props.accountId, exclude),
    ]);
    retainedState.value = {
      state: "ready",
      copies: copies.length,
      drafts: draftSources.reduce((total, source) => total + source.drafts.length, 0),
    };
  } catch {
    retainedState.value = { state: "failed" };
  }
}

onMounted(() => {
  void loadBackupStatus();
  void loadRetainedState();
});

const persistenceText = computed(() => {
  if (persistent.value === true) return "浏览器已授予持久存储；清除网站数据仍会删除本机记录。";
  if (persistent.value === false) return "本机数据仍可能被浏览器清理。";
  return "持久存储状态暂不可确认。";
});

const syncStateText = computed(() => {
  if (syncStatus.value.phase === "syncing") return "正在同步最新修改…";
  if (syncStatus.value.phase === "failed") return syncStateTextFailure();
  if (pendingSync.value) return "已保存到本机，待网络可用时同步。";
  if (confirmed.value) return "此设备文档的已保存版本已由服务端持久保存。";
  return "本机副本尚未与服务端确认。";
});

function syncStateTextFailure(): string {
  return syncStatus.value.phase === "failed" ? (syncStatus.value.message || "同步失败；请检查网络或稍后重试。") : "";
}

const backupSummary = computed(() => {
  const current = backupStatus.value;
  if (current.state === "loading") return { tone: "loading" as const, title: "正在读取备份状态…", detail: "" };
  if (current.state === "failed") return { tone: "failed" as const, title: "备份状态读取失败", detail: "请稍后重试。" };
  const status = current.status;
  if (!status.initialized) return { tone: "idle" as const, title: "此账号还没有独立备份", detail: "正常使用并联网后会自动生成。" };
  if (status.blockedError !== null) return { tone: "blocked" as const, title: "自动备份已暂停，需要排查", detail: "需处理暂停原因，不会自动解除。" };
  if (status.currentBackedUp) {
    return {
      tone: "ok" as const,
      title: status.latestCompletedRevision === null ? "最近完成版本未知" : `最近完成版本 ${status.latestCompletedRevision}`,
      detail: "",
    };
  }
  const waiting = status.nextActionAtMs === null
    ? "下一次尝试时间未知"
    : `预计 ${new Date(status.nextActionAtMs).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 后再次尝试`;
  return { tone: "waiting" as const, title: "有变化等待备份", detail: waiting };
});

const retainedSummary = computed(() => {
  const current = retainedState.value;
  if (current.state === "loading") return "正在读取…";
  if (current.state === "failed") return "暂时无法读取 · 重试";
  if (current.copies === 0 && current.drafts === 0) return "没有保留内容";
  const parts: string[] = [];
  if (current.copies > 0) parts.push(`有恢复前副本（${current.copies} 份）`);
  if (current.drafts > 0) parts.push(`${current.drafts} 份旧草稿`);
  return parts.join(" · ");
});

function retryRetained() {
  void loadRetainedState();
}
</script>

<template>
  <section class="data-page" aria-label="数据">
    <h2 class="data-heading">数据</h2>

    <!-- 本机 -->
    <section class="panel data-section" aria-label="本机">
      <h3 class="data-section-title">
        <HardDrive aria-hidden="true" :size="17" :stroke-width="2" /> 本机
      </h3>
      <p class="data-fact">记录与草稿保存在此浏览器。</p>
      <p class="data-fact-detail">{{ persistenceText }}</p>
      <p v-if="error" class="field-error" role="alert">
        {{ error }}
        <button type="button" class="text-button" @click="emit('retryLoad')">重新读取</button>
      </p>
      <div v-if="persistent !== true" class="data-actions">
        <button type="button" :disabled="busy" @click="emit('persist')">申请保留本机数据</button>
      </div>
    </section>

    <!-- 账号同步 -->
    <section class="panel data-section" aria-label="账号同步">
      <h3 class="data-section-title">
        <RefreshCw aria-hidden="true" :size="17" :stroke-width="2" /> 账号同步
      </h3>
      <p class="data-fact">{{ syncStateText }}</p>
      <div class="data-actions">
        <button type="button" :disabled="busy" @click="retrySync()">立即同步</button>
      </div>
    </section>

    <!-- 独立备份 -->
    <section class="panel data-section" aria-label="独立备份">
      <h3 class="data-section-title">
        <Archive aria-hidden="true" :size="17" :stroke-width="2" /> 独立备份
      </h3>
      <p class="data-fact backup-fact" :class="`is-${backupSummary.tone}`">
        <LoaderCircle v-if="backupSummary.tone === 'loading'" aria-hidden="true" class="spin" :size="15" :stroke-width="2" />
        <CircleCheck v-else-if="backupSummary.tone === 'ok'" aria-hidden="true" :size="15" :stroke-width="2" />
        <CirclePause v-else-if="backupSummary.tone === 'blocked'" aria-hidden="true" :size="15" :stroke-width="2" />
        <TriangleAlert v-else-if="backupSummary.tone === 'failed'" aria-hidden="true" :size="15" :stroke-width="2" />
        <Clock v-else-if="backupSummary.tone === 'waiting'" aria-hidden="true" :size="15" :stroke-width="2" />
        {{ backupSummary.title }}
      </p>
      <p v-if="backupSummary.detail" class="data-fact-detail">{{ backupSummary.detail }}</p>
      <div v-if="backupSummary.tone === 'failed'" class="data-actions">
        <button type="button" @click="loadBackupStatus">重试</button>
      </div>
      <div v-if="backupSummary.tone !== 'failed'" class="data-actions">
        <button v-if="restoreWritesAvailable" type="button" :disabled="busy" @click="emit('openBackups')">
          备份版本与恢复 <ChevronRight aria-hidden="true" :size="15" :stroke-width="2" />
        </button>
        <span v-else class="muted">备份与恢复需要在联网确认账号数据后可用。</span>
      </div>
    </section>

    <!-- 待确认恢复请求：条件入口，处理完之前不能新建另一预览/请求。 -->
    <section v-if="pendingRestore !== null" class="panel data-section pending-restore-entry" aria-label="恢复结果待确认">
      <p class="data-fact">
        <CircleQuestionMark aria-hidden="true" :size="15" :stroke-width="2" />
        有一笔恢复请求结果待确认。
      </p>
      <div class="data-actions">
        <button type="button" @click="emit('openRestoreResult')">
          <FileClock aria-hidden="true" :size="15" :stroke-width="2" /> 查看恢复结果
        </button>
      </div>
    </section>

    <!-- 保留内容 -->
    <section class="panel data-section data-entry" aria-label="保留内容">
      <button type="button" class="entry-row" @click="emit('openRetained')">
        <span class="entry-icon"><Files aria-hidden="true" :size="17" :stroke-width="2" /></span>
        <span class="entry-copy">
          <span class="entry-title">保留内容</span>
          <span class="entry-sub">{{ retainedSummary }}</span>
        </span>
        <ChevronRight aria-hidden="true" class="entry-chevron" :size="17" :stroke-width="2" />
      </button>
      <button v-if="retainedState.state === 'failed'" type="button" class="text-button" @click="retryRetained">重试读取</button>
    </section>

    <!-- 旧验证导入 -->
    <section class="panel data-section data-entry" aria-label="旧验证导入">
      <button type="button" class="entry-row" @click="emit('openLegacyImport')">
        <span class="entry-icon"><FileInput aria-hidden="true" :size="17" :stroke-width="2" /></span>
        <span class="entry-copy">
          <span class="entry-title">从旧验证记录导入</span>
          <span class="entry-sub">打开时读取，不自动关联账号</span>
        </span>
        <ChevronRight aria-hidden="true" class="entry-chevron" :size="17" :stroke-width="2" />
      </button>
    </section>

    <p class="data-note">同步完成不代表所有设备的修改都已备份；独立备份仅覆盖已同步的数据。</p>
  </section>
</template>

<style scoped>
.data-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}
.data-heading {
  margin: 0 0 2px;
  font-size: 1.125rem;
  font-weight: 600;
}
.data-section {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.data-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}
.data-section-title svg { color: var(--text-secondary); flex-shrink: 0; }
.data-fact {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
}
.backup-fact {
  display: flex;
  align-items: center;
  gap: 7px;
}
.backup-fact svg { flex-shrink: 0; color: var(--text-secondary); }
.backup-fact.is-blocked { color: var(--status-warning-fg); }
.backup-fact.is-failed { color: var(--status-danger-fg); }
.backup-fact.is-ok { color: var(--status-success-fg); }
.backup-fact.is-ok svg,
.backup-fact.is-blocked svg,
.backup-fact.is-failed svg { color: currentColor; }
.data-fact-detail {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.7;
  color: var(--text-secondary);
}
.data-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}
.data-actions button {
  min-height: 40px;
  padding: 7px 14px;
  font-size: 0.8125rem;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.pending-restore-entry {
  border-color: var(--status-info-border);
}
.pending-restore-entry .data-fact {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--status-info-fg);
}
.data-entry { padding: 8px 12px; gap: 4px; }
.entry-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 56px;
  padding: 8px 8px;
  border: 0;
  background: transparent;
  text-align: left;
  border-radius: 10px;
}
.entry-row:hover:not(:disabled) { background: var(--surface-elevated); border-color: transparent; }
.entry-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 10px;
  background: var(--surface-subtle);
  color: var(--text-secondary);
}
.entry-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.entry-title { font-size: 0.875rem; font-weight: 500; }
.entry-sub { font-size: 0.75rem; color: var(--text-muted); }
.entry-chevron { color: var(--text-muted); flex-shrink: 0; }
.data-note {
  margin: 4px 0 0;
  font-size: 0.75rem;
  line-height: 1.8;
  color: var(--text-muted);
}
.spin { animation: data-spin 0.9s linear infinite; }
@keyframes data-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
}
</style>
