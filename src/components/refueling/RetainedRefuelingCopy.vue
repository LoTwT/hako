<script setup lang="ts">
import { shallowRef } from "vue";
import type { SavedRefuelingRecord } from "../../domain/refueling/form";
import { formatQuantity, normalizeOccurredAtLocal, numberFields, parseQuantity } from "../../domain/refueling/form";
import type { StoredRefuelingDraft } from "../../domain/refueling/draft-recovery";
import type { RetainedGenerationSummary, RetainedGenerationView } from "../../data/local-refueling-v2";
import type { RetainedDraftSource } from "../../data/retained-content";

/**
 * 保留副本与旧草稿只读查看（恢复设计 §6.1/§6.3 + UI-C01）：显示各代次记录、
 * 来源、待传状态与草稿（含旧 v1 草稿库与只有草稿的代次）；默认不勾选任何
 * 内容，不自动与新文档做 Loro 合并，不占用旧页面草稿锁、不清理原库。
 * 记录副本按「保留值 / 当前值」对照展示；按业务值比较后相同的字段禁选
 * （空值与明确的“否”区分，不当成相同）。仅在已激活且已核对的当前代次
 * （allowBringBack）支持逐项选取字段带回：保留记录与旧草稿都只填入本人选中
 * 的不同字段，以当前记录为普通编辑基线（同 ID 记录）或作为新记录填写
 * （已不存在）；点击普通保存后才进入当前代次。保护流程中只读，无带回入口。
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
  bringBackDraft: [payload: { draft: StoredRefuelingDraft; fields: string[] }];
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
/** 展开的草稿条目（原始输入核对 + 字段勾选）。 */
const openDraftKey = shallowRef<string | null>(null);
/** 选中的草稿带回字段：draftId → 字段名集合（默认不勾选）。 */
const selectedDraftFields = shallowRef<Record<string, Set<string>>>({});

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

function draftFieldSelection(draftId: string): Set<string> {
  return selectedDraftFields.value[draftId] ?? new Set<string>();
}

function toggleDraftField(draftId: string, field: string): void {
  const next = { ...selectedDraftFields.value };
  const selection = new Set(next[draftId] ?? []);
  if (selection.has(field)) selection.delete(field);
  else selection.add(field);
  next[draftId] = selection;
  selectedDraftFields.value = next;
}

/**
 * 按业务值比较保留值与当前值：数值（含 null 的可开票金额）、布尔（null ≠
 * false）、字符串逐项严格比较；当前记录不存在时一律视为不同（全部可选）。
 */
interface RetainedFieldEntry {
  field: string;
  label: string;
  retainedText: string;
  currentText: string;
  same: boolean;
}

/** 记录副本字段对照（保留值 / 当前值；相同禁选）。 */
function recordFieldEntries(record: SavedRefuelingRecord): RetainedFieldEntry[] {
  const current = currentRecord(record.id);
  const entries: RetainedFieldEntry[] = [];
  const raw = record as unknown as Record<string, unknown>;
  const currentRaw = (current ?? {}) as unknown as Record<string, unknown>;
  const formatValue = (field: string, value: unknown): string => {
    if (field in numberFields) {
      if (value === null) return "（空）";
      return `${formatQuantity(value as number, numberFields[field as keyof typeof numberFields].decimals)}${unitSuffix(numberFields[field as keyof typeof numberFields].unit)}`;
    }
    if (field === "fullTank" || field === "lowFuelLight") {
      if (value === null) return "（空）";
      return value ? "是" : "否";
    }
    if (value === null || value === undefined || value === "") return "（空）";
    return String(value);
  };
  for (const key of Object.keys(numberFields) as (keyof typeof numberFields)[]) {
    const same = current !== null && raw[key] === currentRaw[key];
    entries.push({ field: key, label: numberFields[key].label, retainedText: formatValue(key, raw[key]), currentText: current === null ? "（无当前记录）" : formatValue(key, currentRaw[key]), same });
  }
  for (const key of ["occurredAtLocal", "fullTank", "lowFuelLight", "stationName", "fuelGrade", "orderNumber"] as const) {
    const same = current !== null && raw[key] === currentRaw[key];
    entries.push({
      field: key,
      label: { occurredAtLocal: "时间", fullTank: "是否加满", lowFuelLight: "油灯", stationName: "加油站", fuelGrade: "油品", orderNumber: "订单号" }[key],
      retainedText: formatValue(key, raw[key]),
      currentText: current === null ? "（无当前记录）" : formatValue(key, currentRaw[key]),
      same,
    });
  }
  return entries;
}

function unitSuffix(unit: string): string {
  if (unit === "公里") return " km";
  if (unit === "升") return " L";
  if (unit === "元/升") return " 元/L";
  return " 元";
}

/** 从保留记录构造带回表单的部分字段值（仅勾选字段；相同字段不可选）。 */
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

/** 带回保留草稿：勾选字段后交由工作区以当前代次基线填入表单。 */
function submitBringBackDraft(draft: StoredRefuelingDraft): void {
  if (!props.allowBringBack) return;
  const selection = draftFieldSelection(draft.id);
  if (selection.size === 0) {
    openError.value = "请先勾选要带回的草稿字段。";
    return;
  }
  openError.value = "";
  emit("bringBackDraft", { draft, fields: [...selection] });
}

/**
 * 草稿字段核对 + 勾选：原始输入完整展示，附当前记录值对照；与当前记录业务值
 * 相同的字段禁选。相等按业务值判定，区分四类事实（UI-C01）：
 * - 业务相等（可解析且值相同、明确是/否一致、空对未填写）→ 禁选「相同」；
 * - 解析失败（如超精度输入）→ 与任何当前值都不相同，保留原始输入供勾选；
 * - 空字符串 → 仅与当前 null（未填写）相同；
 * - 明确否 → 与 false 相同、与 null 不同。
 */
interface DraftFieldEntry {
  field: string;
  label: string;
  /** 草稿原始输入的显示文本（无效数值按原文显示，交由表单校验纠正）。 */
  valueText: string;
  /** 当前记录值的显示文本。 */
  currentText: string;
  same: boolean;
}

function draftFieldEntries(draft: StoredRefuelingDraft): DraftFieldEntry[] {
  const values = draft.values as unknown as Record<string, string>;
  const current = currentRecord(draft.recordId);
  const currentRaw = (current ?? {}) as unknown as Record<string, unknown>;
  const entries: DraftFieldEntry[] = [
    {
      field: "occurredAtLocal", label: "时间",
      valueText: values.occurredAtLocal,
      currentText: current === null ? "（无当前记录）" : String(currentRaw.occurredAtLocal ?? "（空）"),
      // 时间按领域语义判同（分钟与零秒是同一业务时间；UI-C01.1），原文展示/带回保留。
      same: current !== null && normalizeOccurredAtLocal(values.occurredAtLocal) === normalizeOccurredAtLocal(String(currentRaw.occurredAtLocal ?? "")),
    },
  ];
  for (const key of Object.keys(numberFields) as (keyof typeof numberFields)[]) {
    const raw = values[key];
    const currentIsNull = currentRaw[key] === null || currentRaw[key] === undefined;
    // 数值按记录域比较：空字符串仅可开票金额等同 null（未填写）；解析失败
    // （parseQuantity 为 null 的超精度等输入）不与任何当前值判同。
    const parsed = raw === "" ? null : parseQuantity(key, raw);
    const same = current !== null
      && raw !== ""
      && parsed !== null
      && parsed === currentRaw[key];
    const emptySame = current !== null && raw === "" && key === "invoiceableAmountCents" && currentIsNull;
    entries.push({
      field: key,
      label: numberFields[key].label,
      valueText: raw === "" ? "（空）" : raw,
      currentText: current === null ? "（无当前记录）" : currentIsNull ? "（空）" : formatQuantity(currentRaw[key] as number, numberFields[key].decimals),
      same: same || emptySame,
    });
  }
  // 布尔字段的原始输入（yes/no/空）与当前记录值对照：空对未填写（null）相同。
  for (const key of ["fullTank", "lowFuelLight", "stationName", "fuelGrade", "orderNumber"] as const) {
    const label = { fullTank: "是否加满", lowFuelLight: "油灯", stationName: "加油站", fuelGrade: "油品", orderNumber: "订单号" }[key];
    const raw = values[key];
    let same = false;
    let currentText = "（无当前记录）";
    if (current !== null) {
      if (key === "fullTank" || key === "lowFuelLight") {
        const currentBool = currentRaw[key] as boolean | null;
        currentText = currentBool === null || currentBool === undefined ? "（空）" : currentBool ? "是" : "否";
        same = raw === "" ? currentBool === null || currentBool === undefined : (raw === "yes") === currentBool;
      } else {
        const currentText2 = String(currentRaw[key] ?? "");
        currentText = currentText2 === "" ? "（空）" : currentText2;
        same = raw === currentText2;
      }
    }
    const valueText = key === "fullTank" || key === "lowFuelLight"
      ? (raw === "yes" ? "是" : raw === "no" ? "否" : "（空）")
      : raw === "" ? "（空）" : raw;
    entries.push({ field: key, label, valueText, currentText, same });
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

function retainedAmount(record: SavedRefuelingRecord): string {
  return `¥${formatQuantity(record.amountPaidCents, 2)}`;
}
</script>

<template>
  <section class="retained-copy" aria-label="保留副本与旧草稿">
    <div class="retained-header">
      <div>
        <h3>保留内容</h3>
        <p class="retained-caption">恢复前副本与旧草稿（只读保留）</p>
      </div>
      <button class="text-button" type="button" @click="emit('close')">关闭</button>
    </div>
    <p class="retained-note">
      只读查看，不自动与当前记录合并{{ allowBringBack ? "。勾选字段（保留值与当前值相同的不可选）后填入普通表单，普通保存后才进入当前代次。" : "；确认打开恢复后的数据后才能逐项带回。" }}
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
              <td>{{ retainedAmount(record) }}</td>
              <td>
                <button class="text-button" type="button" @click="openRecordId = openRecordId === record.id ? null : record.id">
                  {{ openRecordId === record.id ? "收起字段" : allowBringBack ? "选取字段" : "查看字段" }}
                </button>
              </td>
            </tr>
            <tr v-if="openRecordId === record.id" class="field-row">
              <td colspan="4">
                <p v-if="allowBringBack" class="retained-note">
                  {{ recordExists(record.id) ? "当前代次仍有同 ID 记录：勾选字段将填入该记录的编辑表单；与当前值相同的字段不可选。" : "该记录已不存在于当前代次：勾选字段将作为新记录填写（分配新记录 ID）。" }}
                </p>
                <p v-else class="retained-note">当前处于保护流程，仅可查看字段；确认打开恢复后的数据后才可逐项带回。</p>
                <table class="field-compare-table" aria-label="保留值与当前值对照">
                  <thead>
                    <tr><th v-if="allowBringBack" class="compare-select"></th><th>字段</th><th>保留值</th><th>当前值</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="entry of recordFieldEntries(record)" :key="entry.field">
                      <td v-if="allowBringBack" class="compare-select">
                        <input v-if="!entry.same" type="checkbox"
                          :checked="fieldSelection(record.id).has(entry.field)"
                          :aria-label="`带回字段 ${entry.label}`"
                          @change="toggleField(record.id, entry.field)" />
                        <span v-else class="same-mark" title="与当前值相同">相同</span>
                      </td>
                      <td v-else class="compare-select"></td>
                      <td>{{ entry.label }}</td>
                      <td>{{ entry.retainedText }}</td>
                      <td>{{ entry.currentText }}</td>
                    </tr>
                  </tbody>
                </table>
                <button v-if="allowBringBack" class="text-button" type="button" @click="submitBringBack(record)">
                  {{ recordExists(record.id) ? "填入当前记录的表单" : "作为新记录填写" }}（已选 {{ fieldSelection(record.id).size }} 项）
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
            <button class="text-button" type="button" @click="openDraftKey = openDraftKey === draft.id ? null : draft.id">
              {{ openDraftKey === draft.id ? "收起字段" : "核对并选取字段" }}
            </button>
            <div v-if="openDraftKey === draft.id" class="draft-values">
              <p v-if="allowBringBack" class="retained-note">
                勾选要带回的草稿字段（与当前记录值相同的不可选）；填入表单后普通保存才生效。
              </p>
              <table class="field-compare-table" aria-label="草稿原始输入">
                <thead>
                  <tr><th v-if="allowBringBack" class="compare-select"></th><th>字段</th><th>草稿原始输入</th><th>当前值</th></tr>
                </thead>
                <tbody>
                  <tr v-for="entry of draftFieldEntries(draft)" :key="entry.field">
                    <td v-if="allowBringBack" class="compare-select">
                      <input v-if="!entry.same" type="checkbox"
                        :checked="draftFieldSelection(draft.id).has(entry.field)"
                        :aria-label="`带回草稿字段 ${entry.label}`"
                        @change="toggleDraftField(draft.id, entry.field)" />
                      <span v-else class="same-mark" title="与当前值相同">相同</span>
                    </td>
                    <td v-else class="compare-select"></td>
                    <td>{{ entry.label }}</td>
                    <td>{{ entry.valueText }}</td>
                    <td>{{ entry.currentText }}</td>
                  </tr>
                </tbody>
              </table>
              <button v-if="allowBringBack" class="text-button" type="button" @click="submitBringBackDraft(draft)">
                填入选中的 {{ draftFieldSelection(draft.id).size }} 项字段
              </button>
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
  border: 1px solid var(--border-default);
  border-radius: 16px;
  padding: 20px 22px;
  background: var(--surface-panel);
}
.retained-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.retained-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 500;
}
.retained-caption {
  margin: 4px 0 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.retained-drafts h4 {
  margin: 16px 0 6px;
  font-size: 0.875rem;
}
.retained-note {
  color: var(--text-secondary);
  font-size: 0.8125rem;
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
  color: var(--text-secondary);
  font-size: 0.8125rem;
  flex: 1 1 200px;
}
.retained-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.retained-table th,
.retained-table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--border-default);
  vertical-align: top;
}
.field-row td {
  border-bottom: 1px solid var(--border-default);
  background: var(--surface-subtle);
}
.field-compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
  margin: 8px 0;
}
.field-compare-table th,
.field-compare-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-default);
  vertical-align: middle;
}
.compare-select {
  width: 4.5rem;
  text-align: center;
}
.compare-select input {
  width: 18px;
  min-height: 18px;
  height: 18px;
  padding: 0;
}
.same-mark {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--surface-muted);
  color: var(--text-muted);
  font-size: 0.6875rem;
  white-space: nowrap;
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
  font-weight: 500;
  font-size: 0.8125rem;
}
.draft-summary {
  color: var(--text-secondary);
  font-size: 0.8125rem;
  flex: 1 1 140px;
}
.draft-values {
  flex-basis: 100%;
}
</style>
