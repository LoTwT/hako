<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from "vue";
import { ChevronRight, Plus, Pencil } from "@lucide/vue";
import {
  formatPaidAmount,
  formatQuantity,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";

/** 统计筛选上下文：携带明确期间/条件（与统计页同源定义）。 */
type StatisticsFilterContext = {
  period: { kind: "total" } | { kind: "yearly"; year: number } | { kind: "monthly"; year: number; month: number };
  periodLabel: string;
  pendingOnly: boolean;
};

/**
 * 记录根页（F1/F2）：手机按月份分组列表；Web（≥880px）表格与右栏详情并排，
 * 初始不自动选中记录，↑↓ 移动选择、宽屏 Enter 聚焦详情标题、窄屏 Enter 进入
 * 详情页。筛选（全部 / 待核对）与选中、滚动只保存在本窗口内存，不写地址；
 * 来自统计的期间/待核对筛选以可移除标签呈现。
 */
const props = defineProps<{
  records: readonly SavedRefuelingRecord[];
  busy: boolean;
  ready: boolean;
  error: string;
  wide: boolean;
  detailRecordId: string | null;
  /** 全量记录的跨记录警告（里程递增等）：由工作区统一计算（UI-R11）。 */
  warnings: ReadonlyMap<string, string[]>;
  pendingEditorLabel: string | null;
  draftCount: number;
  draftPickerNotice: string;
  filterContext: StatisticsFilterContext | null;
}>();
const emit = defineEmits<{
  selectRecord: [recordId: string, options: { push: boolean }];
  startNew: [];
  continueEditing: [];
  openDrafts: [];
  editRecord: [record: SavedRefuelingRecord];
  retryLoad: [];
  openLegacyImport: [];
  removeFilter: [kind: "period" | "pending"];
}>();

const pendingReviewIds = computed(() => new Set(
  [...props.warnings.entries()].filter(([, list]) => list.length > 0).map(([id]) => id)));
const filter = shallowRef<"all" | "review">("all");
/** 选中项：内存状态；详情地址（record-detail）到达时与其保持一致。 */
const selectedId = shallowRef<string | null>(null);
const detailHeading = shallowRef<HTMLHeadingElement | null>(null);

/** 统计筛选前缀（北京时间 occurredAtLocal）：月度精确到月，年度到年，累计不限。 */
function statisticsPeriodPrefix(period: StatisticsFilterContext["period"]): string | null {
  if (period.kind === "total") return null;
  if (period.kind === "yearly") return `${String(period.year).padStart(4, "0")}-`;
  return `${String(period.year).padStart(4, "0")}-${String(period.month).padStart(2, "0")}-`;
}

/** 可见记录 = 统计上下文（期间 + 待核对）∩ 用户筛选（全部/待核对）：展示与过滤同源（UI-R08）。 */
const visibleRecords = computed(() => {
  const context = props.filterContext;
  let result: readonly SavedRefuelingRecord[] = props.records;
  if (context !== null) {
    const prefix = statisticsPeriodPrefix(context.period);
    if (prefix !== null) result = result.filter((record) => record.occurredAtLocal.startsWith(prefix));
    if (context.pendingOnly) result = result.filter((record) => pendingReviewIds.value.has(record.id));
  }
  if (filter.value === "review") return result.filter((record) => pendingReviewIds.value.has(record.id));
  return [...result];
});

interface MonthGroup {
  key: string;
  label: string;
  records: SavedRefuelingRecord[];
}
const monthGroups = computed<MonthGroup[]>(() => {
  const groups: MonthGroup[] = [];
  for (const record of visibleRecords.value) {
    const key = record.occurredAtLocal.slice(0, 7);
    const label = `${Number(record.occurredAtLocal.slice(0, 4))} 年 ${Number(record.occurredAtLocal.slice(5, 7))} 月`;
    let group = groups.at(-1);
    if (group === undefined || group.key !== key) {
      group = { key, label, records: [] };
      groups.push(group);
    }
    group.records.push(record);
  }
  return groups;
});

const selectedRecord = computed(() =>
  selectedId.value === null ? null : props.records.find((record) => record.id === selectedId.value) ?? null);

watch(() => props.detailRecordId, (recordId) => {
  if (recordId === null) return;
  if (props.records.some((record) => record.id === recordId)) selectedId.value = recordId;
}, { immediate: true });

function toggleFilter(next: "all" | "review") {
  filter.value = next;
}

function select(record: SavedRefuelingRecord, options: { push: boolean }) {
  selectedId.value = record.id;
  emit("selectRecord", record.id, options);
}

function onRowKeydown(event: KeyboardEvent, index: number) {
  const list = visibleRecords.value;
  if (list.length === 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = list[Math.min(Math.max(index + delta, 0), list.length - 1)];
    if (next !== undefined) {
      selectedId.value = next.id;
      emit("selectRecord", next.id, { push: false });
      rowButtons.get(next.id)?.focus();
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    const record = list[index];
    if (record === undefined) return;
    if (props.wide) {
      void nextTick();
      detailHeading.value?.focus();
    } else {
      selectedId.value = record.id;
      emit("selectRecord", record.id, { push: true });
    }
  }
}

const rowButtons = new Map<string, HTMLButtonElement>();
function setRowButton(recordId: string, element: HTMLButtonElement | null) {
  if (element === null) rowButtons.delete(recordId);
  else rowButtons.set(recordId, element);
}

function rowSummary(record: SavedRefuelingRecord): string {
  return `${formatQuantity(record.fuelVolumeMillilitres, 3)} L · ${formatQuantity(record.odometerTenths, 1)} km · ${record.fullTank ? "加满" : "未加满"}`;
}

function rowTime(record: SavedRefuelingRecord): string {
  return record.occurredAtLocal.replace("T", " ");
}

function jumpToMonth(event: Event) {
  const key = (event.target as HTMLSelectElement).value;
  if (key === "") return;
  document.getElementById(`month-${key}`)?.scrollIntoView({ block: "start" });
}
</script>

<template>
  <section class="records-root" aria-label="加油记录">
    <div class="records-toolbar">
      <div class="records-heading">
        <h2 class="records-title">加油记录</h2>
        <span class="records-count muted num">{{ records.length }} 笔</span>
      </div>
      <div class="records-filters" role="group" aria-label="筛选记录">
        <button type="button" class="filter-option" :class="{ active: filter === 'all' }" :aria-pressed="filter === 'all'"
          @click="toggleFilter('all')">全部</button>
        <button type="button" class="filter-option" :class="{ active: filter === 'review' }" :aria-pressed="filter === 'review'"
          @click="toggleFilter('review')">待核对 ({{ pendingReviewIds.size }})</button>
        <label v-if="monthGroups.length > 1" class="month-jump">
          <span class="visually-hidden">跳到月份</span>
          <select @change="jumpToMonth">
            <option value="">跳到月份</option>
            <option v-for="group of monthGroups" :key="group.key" :value="group.key">{{ group.label }}</option>
          </select>
        </label>
      </div>
      <div v-if="filterContext" class="filter-chips">
        <span v-if="filterContext.period.kind !== 'total'" class="filter-chip">
          {{ filterContext.periodLabel }}
          <button type="button" aria-label="移除期间筛选" @click="emit('removeFilter', 'period')">✕</button>
        </span>
        <span v-if="filterContext.pendingOnly" class="filter-chip">
          待核对
          <button type="button" aria-label="移除待核对筛选" @click="emit('removeFilter', 'pending')">✕</button>
        </span>
      </div>
    </div>

    <!-- 挂起编辑横幅：主动作变为「继续填写」，不能再开第二个编辑器。 -->
    <div v-if="pendingEditorLabel" class="pending-edit-banner">
      <p>正在编辑 · {{ pendingEditorLabel }}<span v-if="draftCount > 0"> · 草稿已保存在本机</span></p>
      <button v-if="draftCount > 0" type="button" class="text-button" @click="emit('openDrafts')">
        草稿 {{ draftCount }} 份 · 查看
      </button>
    </div>
    <div v-else-if="draftCount > 0" class="pending-edit-banner">
      <button type="button" class="text-button" @click="emit('openDrafts')">未完成的草稿 {{ draftCount }} 份 · 查看</button>
    </div>

    <p v-if="error" class="field-error" role="alert">
      {{ error }}
      <button type="button" class="text-button" @click="emit('retryLoad')">重新读取</button>
    </p>

    <!-- 空状态：记一次加油 + 低权重旧验证导入入口。 -->
    <div v-if="ready && records.length === 0" class="empty-records">
      <h3>还没有加油记录</h3>
      <p>把每次加油记清楚；记录与草稿保存在此浏览器。</p>
      <button type="button" class="primary empty-new" @click="emit('startNew')">
        <Plus aria-hidden="true" :size="16" :stroke-width="2" /> 记一次加油
      </button>
      <button type="button" class="text-button" @click="emit('openLegacyImport')">导入旧验证记录</button>
    </div>

    <div v-else class="records-layout" :class="{ 'has-selection': selectedRecord !== null }">
      <!-- 记录列表（月份分组；Web 表格式行）。 -->
      <div class="records-list" role="list" aria-label="加油记录列表">
        <section v-for="group of monthGroups" :key="group.key" class="month-group" :id="`month-${group.key}`">
          <h3 class="month-label">{{ group.label }}</h3>
          <button
            v-for="record of group.records"
            :key="record.id"
            :ref="(element) => setRowButton(record.id, element as HTMLButtonElement | null)"
            type="button"
            class="record-row"
            :class="{ selected: selectedId === record.id }"
            role="listitem"
            :aria-current="selectedId === record.id ? 'true' : undefined"
            @click="select(record, { push: true })"
            @keydown="onRowKeydown($event, visibleRecords.indexOf(record))"
          >
            <span class="row-time num">{{ rowTime(record) }}</span>
            <span class="row-amount num">{{ formatPaidAmount(record.amountPaidCents) }}</span>
            <span class="row-summary">{{ rowSummary(record) }}</span>
            <span v-for="warning of warnings.get(record.id) ?? []" :key="warning" class="row-warning">待核对：{{ warning }}</span>
            <span v-if="selectedId === record.id" class="row-selected-mark" aria-hidden="true"></span>
            <ChevronRight v-if="!wide" class="row-chevron" aria-hidden="true" :size="18" :stroke-width="2" />
          </button>
        </section>
        <p v-if="visibleRecords.length === 0" class="muted empty-filter">当前筛选下没有记录。</p>
      </div>

      <!-- Web 右栏详情（F2）：未选中时提示，编辑只经明确按钮进入。 -->
      <aside v-if="wide" class="records-detail" aria-label="记录详情">
        <template v-if="selectedRecord">
          <h3 ref="detailHeading" class="detail-heading programmatic-focus-heading" tabindex="-1">记录详情</h3>
          <slot name="detail" :record="selectedRecord"></slot>
        </template>
        <div v-else class="detail-placeholder">
          <h3 tabindex="-1" class="programmatic-focus-heading">选择一条记录查看详情</h3>
          <p>↑↓ 切换记录 · Enter 聚焦详情</p>
        </div>
      </aside>
    </div>

    <!-- 主操作：有挂起编辑时为「继续填写」。 -->
    <div v-if="records.length > 0 || pendingEditorLabel" class="records-primary">
      <button v-if="pendingEditorLabel" type="button" class="primary" @click="emit('continueEditing')">
        <Pencil aria-hidden="true" :size="16" :stroke-width="2" /> 继续填写
      </button>
      <button v-else type="button" class="primary" @click="emit('startNew')">
        <Plus aria-hidden="true" :size="16" :stroke-width="2" /> 记一次加油
      </button>
      <span v-if="pendingEditorLabel" class="muted pending-hint">{{ pendingEditorLabel }}</span>
    </div>
  </section>
</template>

<style scoped>
.records-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.records-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
}
.records-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-right: auto;
}
.records-title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 500;
}
.records-count { font-size: 0.75rem; }
.records-filters {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--surface-panel);
}
.filter-option {
  min-height: 32px;
  padding: 4px 14px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8125rem;
}
.filter-option.active {
  background: var(--accent-soft);
  color: var(--text-accent);
}
.month-jump select {
  min-height: 32px;
  width: auto;
  padding: 4px 24px 4px 10px;
  font-size: 0.8125rem;
  border-radius: 999px;
}
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pending-edit-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  padding: 12px 16px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  background: var(--accent-soft);
}
.pending-edit-banner p {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
}
.empty-records {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 56px 16px;
  text-align: center;
}
.empty-records h3 { margin: 0; font-size: 1.0625rem; }
.empty-records p { margin: 0 0 12px; font-size: 0.8125rem; color: var(--text-secondary); }
.empty-new { display: inline-flex; align-items: center; gap: 8px; }
.records-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0 24px;
  align-items: start;
}
.month-group { margin-bottom: 6px; }
.month-label {
  margin: 14px 0 6px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
}
.record-row {
  display: grid;
  grid-template-columns: minmax(96px, 1fr) auto;
  grid-template-areas:
    "time amount"
    "summary summary"
    "warning warning";
  align-items: baseline;
  gap: 4px 12px;
  width: 100%;
  min-height: 56px;
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid var(--border-default);
  border-radius: 0;
  background: transparent;
  text-align: left;
}
.record-row:hover:not(:disabled) { background: var(--surface-elevated); border-color: var(--border-default); }
.record-row.selected {
  background: var(--accent-soft);
}
.row-time { grid-area: time; font-size: 0.75rem; color: var(--text-secondary); }
.row-amount { grid-area: amount; justify-self: end; font-size: 1rem; font-weight: 600; }
.row-summary { grid-area: summary; font-size: 0.75rem; color: var(--text-secondary); }
.row-warning {
  grid-area: warning;
  justify-self: start;
  font-size: 0.75rem;
  color: var(--status-warning-fg);
}
.row-chevron { display: none; }
.row-selected-mark { display: none; }
.detail-heading {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  margin: 0;
}
/* 聚焦时显形（仅由脚本聚焦）：装饰环由 .programmatic-focus-heading 统一处理。 */
.detail-heading:focus-visible {
  position: fixed;
  width: auto;
  height: auto;
  clip-path: none;
}
.empty-filter { padding: 24px 0; }
.records-primary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.records-primary .primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 200px;
  justify-content: center;
}
.pending-hint { font-size: 0.75rem; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.detail-placeholder {
  display: grid;
  place-items: center;
  gap: 6px;
  min-height: 220px;
  padding: 24px;
  border: 1px dashed var(--border-default);
  border-radius: 16px;
  color: var(--text-secondary);
  text-align: center;
}
.detail-placeholder h3 { margin: 0; font-size: 0.9375rem; font-weight: 500; }
.detail-placeholder p { margin: 0; font-size: 0.75rem; color: var(--text-muted); }
/* Web 主从：宽屏两列，窄屏单列流程。 */
@media (min-width: 880px) {
  .records-layout {
    grid-template-columns: minmax(0, 1.2fr) minmax(300px, 1fr);
  }
  .record-row {
    grid-template-columns: minmax(120px, 1fr) minmax(88px, auto) minmax(150px, 1.4fr) minmax(84px, auto);
    grid-template-areas: "time amount summary review";
    align-items: center;
  }
  .row-amount { justify-self: end; }
  .row-summary { justify-self: start; }
  .row-warning { grid-area: review; justify-self: end; font-size: 0.75rem; }
}
</style>
