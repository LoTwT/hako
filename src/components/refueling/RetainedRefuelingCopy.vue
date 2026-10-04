<script setup lang="ts">
import { shallowRef } from "vue";
import type { SavedRefuelingRecord } from "../../domain/refueling/form";
import { numberFields, unscale } from "../../domain/refueling/form";
import type { StoredRefuelingDraft } from "../../domain/refueling/draft-recovery";
import type { RetainedGenerationSummary, RetainedGenerationView } from "../../data/local-refueling-v2";
import type { RetainedDraftSource } from "../../data/retained-content";

/**
 * 保留副本与旧草稿只读查看（恢复设计 §6.1/§6.3）：显示各代次记录、来源、待传
 * 状态与草稿（含旧 v1 草稿库与只有草稿的代次）；默认不勾选任何内容，不自动与
 * 新文档做 Loro 合并，不占用旧页面草稿锁、不清理原库。仅在已激活且已核对的
 * 当前代次（allowBringBack）支持逐项选取字段/草稿带回：以当前记录为普通编辑
 * 基线填入表单（同 ID 记录）或作为新记录填写（已不存在）；点击普通保存后才
 * 进入当前代次。保护流程中只读，无带回入口。
 */
const props = defineProps<{
  accountId: string;
  /** 仅已激活、已核对的当前代次允许带回；保护流程中为 false（只读查看）。 */
  allowBringBack: boolean;
  /** 代次副本清单（保护流程含被保护旧副本；激活后由调用方排除当前代次）。 */
  summaries: () => Promise<RetainedGenerationSummary[]>;
  readGeneration: (generation: string) => Promise<RetainedGenerationView | null>;
  /** 保留草稿来源清单（旧 v1 草稿库 + 各保留代次草稿库；不含当前代次）。 */
  draftSources: () => Promise<RetainedDraftSource[]>;
  /** 当前代次的已知记录：决定同 ID 记录的编辑基线与新记录的分配。 */
  knownRecords: () => ReadonlyMap<string, SavedRefuelingRecord>;
}>();
const emit = defineEmits<{
  close: [];
  bringBackRecord: [payload: { recordId: string; exists: boolean; patch: Partial<SavedRefuelingRecord> }];
  bringBackDraft: [draft: StoredRefuelingDraft];
}>();

const generationSummaries = shallowRef<RetainedGenerationSummary[]>([]);
const draftSourceList = shallowRef<RetainedDraftSource[]>([]);
const expanded = shallowRef<RetainedGenerationView | null>(null);
const expandedLoading = shallowRef(false);
const openError = shallowRef("");
/** 选中的带回字段：recordId → 字段名集合（默认不勾选任何内容）。 */
const selectedFields = shallowRef<Record<string, Set<string>>>({});
/** 展开的记录条目（字段勾选面板）。 */
const openRecordId = shallowRef<string | null>(null);
/** 展开的草稿条目（原始输入核对）。 */
const openDraftKey = shallowRef<string | null>(null);

async function refresh() {
  openError.value = "";
  try {
    const [summaryList, sources] = await Promise.all([props.summaries(), props.draftSources()]);
    generationSummaries.value = summaryList;
    draftSourceList.value = sources;
    if (expanded.value !== null && !summaryList.some((entry) => entry.generation === expanded.value?.generation)) {
      expanded.value = null;
    }
  } catch {
    openError.value = "保留副本暂时不可读，请稍后重试。";
  }
}
void refresh();

async function open(generation: string) {
  expandedLoading.value = true;
  openError.value = "";
  try {
    expanded.value = await props.readGeneration(generation);
    selectedFields.value = {};
    openRecordId.value = null;
  } catch {
    openError.value = "保留副本暂时不可读，请稍后重试。";
  } finally {
    expandedLoading.value = false;
  }
}

function currentRecord(recordId: string): SavedRefuelingRecord | null {
  return props.knownRecords().get(recordId) ?? null;
}

/** 记录是否仍存在于当前代次：存在则以当前记录为编辑基线，否则作为新记录填写。 */
function recordExists(recordId: string): boolean {
  return currentRecord(recordId) !== null;
}

function fieldSelection(recordId: string): Set<string> {
  return selectedFields.value[recordId] ?? new Set<string>();
}

function toggleField(recordId: string, field: string): void {
  const next = { ...selectedFields.value };
  const selection = new Set(next[recordId] ?? []);
  if (selection.has(field)) selection.delete(field);
  else selection.add(field);
  next[recordId] = selection;
  selectedFields.value = next;
}

/** 从保留记录构造带回表单的部分字段值（仅勾选字段）。 */
function submitBringBack(record: SavedRefuelingRecord): void {
  if (!props.allowBringBack) return;
  const selection = fieldSelection(record.id);
  if (selection.size === 0) {
    openError.value = "请先勾选要带回的字段。";
    return;
  }
  openError.value = "";
  const patch: Record<string, unknown> = {};
  for (const field of selection) patch[field] = (record as unknown as Record<string, unknown>)[field];
  // 逐项带回通过普通表单保存生成新的 Loro 操作；不带旧 CRDT 历史。
  emit("bringBackRecord", {
    recordId: record.id,
    exists: recordExists(record.id),
    patch: patch as Partial<SavedRefuelingRecord>,
  });
}

/** 带回保留草稿：先核对原始输入，再由工作区以当前代次基线填入表单。 */
function submitBringBackDraft(draft: StoredRefuelingDraft): void {
  if (!props.allowBringBack) return;
  emit("bringBackDraft", draft);
}

function recordFields(record: SavedRefuelingRecord): { field: string; label: string; value: string }[] {
  const entries: { field: string; label: string; value: string }[] = [];
  for (const key of Object.keys(numberFields) as (keyof typeof numberFields)[]) {
    const raw = record[key];
    entries.push({ field: key, label: numberFields[key].label, value: raw === null ? "（空）" : unscale(raw, numberFields[key].decimals) + numberFields[key].unit });
  }
  for (const key of ["occurredAtLocal", "fullTank", "lowFuelLight", "stationName", "fuelGrade", "orderNumber"] as const) {
    const raw = (record as unknown as Record<string, unknown>)[key];
    entries.push({
      field: key,
      label: { occurredAtLocal: "时间", fullTank: "是否加满", lowFuelLight: "油灯", stationName: "加油站", fuelGrade: "油品", orderNumber: "订单号" }[key],
      value: raw === null ? "（空）" : typeof raw === "boolean" ? (raw ? "是" : "否") : String(raw),
    });
  }
  return entries;
}

function draftFields(draft: StoredRefuelingDraft): { label: string; value: string }[] {
  const values = draft.values as unknown as Record<string, string>;
  const entries: { label: string; value: string }[] = [{ label: "时间", value: values.occurredAtLocal }];
  for (const key of Object.keys(numberFields) as (keyof typeof numberFields)[]) {
    entries.push({ label: numberFields[key].label, value: values[key] === "" ? "（空）" : values[key] });
  }
  // 布尔字段的原始输入（yes/no/空）与带回时复制的内容一致，核对面板完整展示。
  for (const key of ["fullTank", "lowFuelLight", "stationName", "fuelGrade", "orderNumber"] as const) {
    const label = { fullTank: "是否加满", lowFuelLight: "油灯", stationName: "加油站", fuelGrade: "油品", orderNumber: "订单号" }[key];
    const raw = values[key];
    const value = key === "fullTank" || key === "lowFuelLight"
      ? (raw === "yes" ? "是" : raw === "no" ? "否" : "（空）")
      : raw === "" ? "（空）" : raw;
    entries.push({ label, value });
  }
  return entries;
}

function draftTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function draftSummaryLine(draft: StoredRefuelingDraft): string {
  return [draft.values.stationName, draft.values.occurredAtLocal.replace("T", " ")]
    .filter((value) => value !== "")
    .join(" · ");
}

function sourceLabel(source: RetainedDraftSource): string {
  return source.kind === "v1" ? "升级前草稿（旧窗口）" : `代次草稿 ${source.generation!.slice(0, 8)}…`;
}
</script>

<template>
  <section class="retained-copy" aria-label="保留副本与旧草稿">
    <div class="retained-header">
      <h3>保留副本与旧草稿</h3>
      <button class="text-button" type="button" @click="emit('close')">关闭</button>
    </div>
    <p class="retained-note">
      只读查看，不自动与当前记录合并{{ allowBringBack ? "。勾选字段或核对草稿后填入普通表单，普通保存后才进入当前代次。" : "；确认打开恢复后的数据后才能逐项带回。" }}
    </p>
    <p v-if="openError" class="field-error" role="alert">{{ openError }}</p>
    <p v-else-if="generationSummaries.length === 0 && draftSourceList.length === 0" class="retained-note">当前没有保留副本。</p>
    <ul v-if="generationSummaries.length" class="retained-list">
      <li v-for="summary of generationSummaries" :key="summary.generation">
        <span class="retained-meta">
          {{ summary.legacyGeneration ? "升级前副本" : "恢复前副本" }} · {{ summary.recordCount }} 条记录
          {{ summary.pendingSync ? " · 有待上传修改（保留，不上传）" : "" }}
        </span>
        <button class="text-button" type="button" :disabled="expandedLoading" @click="expanded?.generation === summary.generation ? (expanded = null) : open(summary.generation)">
          {{ expanded?.generation === summary.generation ? "收起记录" : "查看记录" }}
        </button>
      </li>
    </ul>
    <div v-if="expanded" class="retained-records">
      <table class="retained-table">
        <thead>
          <tr><th>时间</th><th>加油站</th><th>实付</th><th></th></tr>
        </thead>
        <tbody>
          <template v-for="record of expanded.records" :key="record.id">
            <tr>
              <td>{{ record.occurredAtLocal.replace("T", " ") }}</td>
              <td>{{ record.stationName }}</td>
              <td>¥{{ (record.amountPaidCents / 100).toFixed(2) }}</td>
              <td>
                <button class="text-button" type="button" @click="openRecordId = openRecordId === record.id ? null : record.id">
                  {{ openRecordId === record.id ? "收起字段" : allowBringBack ? "选取字段" : "查看字段" }}
                </button>
              </td>
            </tr>
            <tr v-if="openRecordId === record.id" class="field-row">
              <td colspan="4">
                <p v-if="allowBringBack" class="retained-note">
                  {{ recordExists(record.id) ? "当前代次仍有同 ID 记录：勾选字段将填入该记录的编辑表单。" : "该记录已不存在于当前代次：将作为新记录填写（分配新记录 ID）。" }}
                </p>
                <p v-else class="retained-note">当前处于保护流程，仅可查看字段；确认打开恢复后的数据后才可逐项带回。</p>
                <ul class="field-list">
                  <li v-for="entry of recordFields(record)" :key="entry.field">
                    <label v-if="allowBringBack">
                      <input type="checkbox"
                        :checked="fieldSelection(record.id).has(entry.field)"
                        @change="toggleField(record.id, entry.field)" />
                      <span class="field-label">{{ entry.label }}</span>
                      <span class="field-value">{{ entry.value }}</span>
                    </label>
                    <template v-else>
                      <span class="field-label">{{ entry.label }}</span>
                      <span class="field-value">{{ entry.value }}</span>
                    </template>
                  </li>
                </ul>
                <button v-if="allowBringBack" class="text-button" type="button" @click="submitBringBack(record)">
                  {{ recordExists(record.id) ? "填入当前记录的表单" : "作为新记录填写" }}
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p v-else-if="expandedLoading" class="retained-note">正在读取保留副本…</p>
    <div v-if="draftSourceList.length" class="retained-drafts">
      <h4>保留草稿</h4>
      <section v-for="source of draftSourceList" :key="source.kind + (source.generation ?? '')">
        <p class="retained-meta">{{ sourceLabel(source) }}</p>
        <ul class="draft-items">
          <li v-for="draft of source.drafts" :key="draft.id">
            <span class="draft-meta">{{ draft.mode === "edit" ? "编辑记录" : "新建记录" }} · {{ draftTime(draft.updatedAt) }}</span>
            <span class="draft-summary">{{ draftSummaryLine(draft) }}</span>
            <button class="text-button" type="button" @click="openDraftKey = openDraftKey === draft.id ? null : draft.id">核对输入</button>
            <button v-if="allowBringBack" class="text-button" type="button" @click="submitBringBackDraft(draft)">填入表单</button>
            <div v-if="openDraftKey === draft.id" class="draft-values">
              <ul class="field-list">
                <li v-for="entry of draftFields(draft)" :key="entry.label">
                  <span class="field-label">{{ entry.label }}</span>
                  <span class="field-value">{{ entry.value }}</span>
                </li>
              </ul>
            </div>
          </li>
        </ul>
        <p v-if="source.unsupportedCount > 0" class="retained-note">
          有 {{ source.unsupportedCount }} 份草稿无法识别（版本不受支持或内容损坏），已保留未改动。
        </p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.retained-copy {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px 20px;
  margin: 18px 0;
}
.retained-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.retained-header h3 {
  margin: 0;
  font-size: 16px;
}
.retained-drafts h4 {
  margin: 16px 0 6px;
  font-size: 14px;
}
.retained-note {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
}
.retained-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.retained-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.retained-meta {
  color: var(--muted);
  font-size: 13px;
  flex: 1 1 200px;
}
.retained-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.retained-table th,
.retained-table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.field-row td {
  border-bottom: 1px solid var(--line);
  background: #fafbfa;
}
.field-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 6px 14px;
}
.field-list li label,
.field-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.field-label {
  font-weight: 600;
}
.field-value {
  color: var(--muted);
}
.draft-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.draft-items > li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
}
.draft-meta {
  font-weight: 600;
  font-size: 13px;
}
.draft-summary {
  color: var(--muted);
  font-size: 13px;
  flex: 1 1 140px;
}
.draft-values {
  flex-basis: 100%;
}
</style>
