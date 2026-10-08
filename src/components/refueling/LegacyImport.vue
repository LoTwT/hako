<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { readLegacyRefueling } from "../../data/legacy-refueling";
import type { SavedRefuelingRecord } from "../../domain/refueling/form";

/**
 * 旧验证导入页（D5 + UI-C02）：只有本人打开入口时才读取旧验证库；选中记录
 * 复制到当前账号并在联网时上传，原库保留。逐项状态区分：空库、该记录已导入、
 * 该来源存在多个导入目标（冲突，不可选）、读取失败；关闭不导入。冲突判定
 * 复用上层既有来源映射事实，不自动修复或清理旧库。
 */
const props = defineProps<{
  disabled: boolean;
  /** 当前代次是否允许写入导入记录（联网确认后的激活代次）。 */
  canImport: boolean;
  importedIds: readonly string[];
  /** 来源 ID → 多个导入目标（工作区已按当前代次存活的记录过滤）。 */
  importConflicts: Readonly<Record<string, readonly string[]>>;
  importRecords: (records: SavedRefuelingRecord[]) => Promise<boolean>;
}>();

type LegacyItemState = "selectable" | "imported" | "conflict";

const opened = shallowRef(false);
const loading = shallowRef(false);
const records = shallowRef<SavedRefuelingRecord[]>([]);
const selected = ref<string[]>([]);
const message = shallowRef("");
const importBusy = shallowRef(false);

function itemState(record: SavedRefuelingRecord): LegacyItemState {
  // 未解决的多目标冲突优先呈现（UI-C02）：同一来源可以同时存在既有导入映射和
  // 仍存活的冲突目标，此时「已导入」会隐藏需本人核对的事实。映射与历史都保留，
  // 不自动修复来源；单目标冲突已被上层收敛为 importedIds。
  const targets = props.importConflicts[record.id];
  if (targets !== undefined && targets.length > 1) return "conflict";
  if (props.importedIds.includes(record.id)) return "imported";
  return "selectable";
}

/** 逐项状态说明：贴近条目呈现，冲突条目不可选。 */
function itemStateText(state: LegacyItemState): string {
  if (state === "imported") return "已导入";
  if (state === "conflict") return "来源冲突，需人工核对";
  return "";
}

const selectableItems = computed(() => records.value.filter((record) => itemState(record) === "selectable"));
const chosen = computed(() => selectableItems.value.filter((record) => selected.value.includes(record.id)));
const importedCount = computed(() => records.value.filter((record) => itemState(record) === "imported").length);
const conflictCount = computed(() => records.value.filter((record) => itemState(record) === "conflict").length);
const canSubmit = computed(() => props.canImport && !props.disabled && !importBusy.value);

async function preview() {
  if (props.disabled || loading.value) return;
  loading.value = true;
  message.value = "";
  try {
    records.value = await readLegacyRefueling();
    selected.value = [];
    opened.value = true;
  } catch {
    message.value = "无法读取旧验证数据，原库已保留，请稍后重试。";
  } finally { loading.value = false; }
}
async function importSelected() {
  if (!canSubmit.value || !chosen.value.length) return;
  importBusy.value = true;
  const count = chosen.value.length;
  try {
    if (await props.importRecords(chosen.value)) {
      selected.value = [];
      message.value = `已导入 ${count} 条到当前账号的本机副本，联网时自动同步。原库仍保留。`;
    } else message.value = "导入未完成，原库和选择均保留，可重试。";
  } finally {
    importBusy.value = false;
  }
}
</script>

<template>
  <section class="legacy-import panel" aria-label="导入旧验证记录">
    <h2>导入旧验证记录</h2>
    <p>来自此浏览器的旧验证数据；打开时读取，不自动关联账号。</p>
    <p>旧记录和旧草稿保留在此浏览器。仅复制勾选记录的当前字段值到此账号，联网时上传；原库及原修改历史保留，旧草稿不在此次导入范围内。</p>

    <div v-if="!opened" class="legacy-actions">
      <button type="button" class="primary" :disabled="disabled || loading" @click="preview">
        {{ loading ? "正在读取…" : "查看可导入的旧记录" }}
      </button>
    </div>
    <template v-else>
      <p v-if="records.length === 0">旧验证库没有记录。</p>
      <!-- 无可选记录时仍列出逐项状态（UI-C02）：用户需要看到该核对哪条，不能只剩总数。 -->
      <p v-else-if="selectableItems.length === 0 && importedCount > 0 && conflictCount === 0">
        旧记录都已导入（共 {{ importedCount }} 条），没有可再次导入的记录。
      </p>
      <fieldset v-else :disabled="disabled || loading">
        <legend>选择要导入的旧记录</legend>
        <label v-for="record in records" :key="record.id" class="legacy-record" :class="{ 'is-state': itemState(record) !== 'selectable' }">
          <input v-if="itemState(record) === 'selectable'" v-model="selected" type="checkbox" :value="record.id" />
          <input v-else type="checkbox" disabled :aria-label="`${itemStateText(itemState(record))}，不可选择`" />
          <span class="legacy-record-copy">
            <span>
              {{ record.occurredAtLocal.replace('T', ' ') }} · {{ record.stationName || '未填加油站' }} · 实付 ¥{{ (record.amountPaidCents / 100).toFixed(2) }}
              <small>{{ record.odometerTenths / 10 }} km · {{ record.fuelVolumeMillilitres / 1000 }} L · {{ record.fuelGrade || '未填油品' }} · {{ record.fullTank ? '加满' : '未加满' }}</small>
            </span>
            <span v-if="itemState(record) !== 'selectable'" class="legacy-state">{{ itemStateText(itemState(record)) }}</span>
          </span>
        </label>
        <div class="legacy-actions">
          <button type="button" class="primary" :disabled="!canSubmit || !chosen.length" @click="importSelected">
            {{ importBusy ? "正在导入…" : `导入选中的 ${chosen.length} 条并同步` }}
          </button>
          <button type="button" class="text-button" @click="opened = false; selected = []">保留原样，关闭</button>
        </div>
        <p v-if="!canImport" class="field-error">账号数据需要联网确认后才能导入；旧库读取不受影响。</p>
      </fieldset>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.legacy-import {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 0.8125rem;
  line-height: 1.8;
}
.legacy-import h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
.legacy-import p { margin: 0; color: var(--text-secondary); }
fieldset { border: 0; padding: 0; margin: 4px 0 0; }
legend { font-size: 0.75rem; color: var(--text-muted); padding: 0; }
.legacy-record { display: flex; gap: 12px; align-items: center; min-height: 48px; padding: 8px 0; border-bottom: 1px solid var(--border-default); }
.legacy-record.is-state { color: var(--text-secondary); }
.legacy-record input { flex: 0 0 20px; width: 20px; min-height: 20px; height: 20px; padding: 0; }
.legacy-record-copy { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; }
.legacy-record-copy span { min-width: 0; overflow-wrap: anywhere; }
.legacy-state {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 999px;
  border: 1px solid var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
  font-size: 0.6875rem;
  white-space: nowrap;
}
.legacy-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; align-items: center; }
.legacy-actions .primary { display: inline-flex; align-items: center; gap: 8px; }
small { display: block; color: var(--text-muted); }
</style>
