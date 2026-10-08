<script setup lang="ts">
import { computed, nextTick, shallowRef } from "vue";
import { ChevronDown, Clock } from "@lucide/vue";
import {
  createDraft,
  numberFields,
  updateDraft,
  validateDraft,
  type FormField,
  type NumberField,
  type RefuelingDraft,
  type RefuelingRecord,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";

const props = defineProps<{
  initial?: RefuelingRecord;
  /** 恢复或延用的初始草稿；未提供时按初始记录（或空表单）生成。 */
  initialDraft?: RefuelingDraft;
  busy: boolean;
  /** 登录流程进行中：冻结输入，保证离页内容与已确认落盘的版本一致。 */
  locked?: boolean;
  available: boolean;
  /** 当前代次已知记录：用于参考里程（表单时间前后相邻记录）。 */
  records?: readonly SavedRefuelingRecord[];
  /** 正在编辑的记录 ID：参考里程排除自身。 */
  editingRecordId?: string | null;
}>();
const emit = defineEmits<{
  save: [record: RefuelingRecord];
  dirty: [value: boolean];
  /** 每次编辑后的完整原始草稿，交由页面持久保存。 */
  draft: [draft: RefuelingDraft];
  continueLater: [];
}>();
const draft = shallowRef(props.initialDraft ?? createDraft(props.initial));
const submitted = shallowRef(false);
const confirmed = shallowRef(false);
const showMore = shallowRef(false);
const validation = computed(() => validateDraft(draft.value));
const formRoot = shallowRef<HTMLFormElement | null>(null);

/** 折叠在「更多信息」内的选填字段：定位其错误前需要展开分组（UI-R10）。 */
const collapsedFields: ReadonlySet<FormField> = new Set(["stationName", "fuelGrade", "orderNumber", "invoiceableAmountCents"]);

const fieldLabels: Record<FormField, string> = {
  occurredAtLocal: "加油时间",
  odometerTenths: "总里程",
  fuelVolumeMillilitres: "加油量",
  unitPriceTenThousandths: "原始单价",
  amountPayableCents: "应付金额",
  couponDiscountCents: "优惠券抵扣",
  amountPaidCents: "订单实付",
  invoiceableAmountCents: "可开票金额",
  fullTank: "是否加满",
  lowFuelLight: "加油前油灯",
  stationName: "加油站",
  fuelGrade: "油品",
  orderNumber: "订单号",
};

/** 错误摘要条目：字段名 + 原因（不只报数量）；聚焦第一项前自动展开其分组。 */
const errorEntries = computed(() =>
  Object.entries(validation.value.errors).map(([field, message]) => ({
    field: field as FormField,
    label: fieldLabels[field as FormField] ?? field,
    message,
  })));

/** 表单是否带记录基线：本人填写标签只在编辑基线上有意义（区分手填默认值）。 */
const hasRecordBase = computed(() => props.initial !== undefined
  || (props.initialDraft !== undefined && props.initialDraft.sources.amountPayableCents === "record"));

const billFields = computed(() =>
  (["unitPriceTenThousandths", "fuelVolumeMillilitres", "amountPayableCents", "couponDiscountCents", "amountPaidCents"] as NumberField[]));

const unitText: Record<string, string> = { "公里": "km", "升": "L", "元/升": "元/L", "元": "元" };

/** 来源标签：计算/原记录/默认/本人填写（编辑基线）按真实来源展示。 */
function sourceTag(field: FormField): string | null {
  const source = draft.value.sources[field];
  if (source === "calculated") return "自动计算";
  if (source === "record") return "原记录";
  if (source === "default") return "默认";
  if (source === "manual" && hasRecordBase.value) return "本人填写";
  return null;
}

/** 参考里程：按表单当前时间选前后相邻记录，编辑时排除自身；有哪条显示哪条。 */
const referenceRecords = computed(() => {
  if (props.records === undefined) return { before: null as SavedRefuelingRecord | null, after: null as SavedRefuelingRecord | null };
  const time = draft.value.values.occurredAtLocal;
  const ordered = [...props.records]
    .filter((record) => record.id !== props.editingRecordId)
    .sort((a, b) => a.occurredAtLocal.localeCompare(b.occurredAtLocal));
  let before: SavedRefuelingRecord | null = null;
  let after: SavedRefuelingRecord | null = null;
  for (const record of ordered) {
    if (record.occurredAtLocal < time) before = record;
    else if (after === null && record.occurredAtLocal > time) after = record;
  }
  return { before, after };
});

function referenceLine(record: SavedRefuelingRecord | null, label: string): string | null {
  if (record === null) return null;
  return `${label} ${record.occurredAtLocal.replace("T", " ").slice(5, 16)} · ${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(record.odometerTenths / 10)} km`;
}

function edit(field: FormField, event: Event) {
  draft.value = updateDraft(
    draft.value,
    field,
    (event.target as HTMLInputElement).value,
  );
  confirmed.value = false;
  emit("dirty", true);
  emit("draft", draft.value);
}

async function focusFirstError() {
  const first = errorEntries.value[0];
  if (first !== undefined && collapsedFields.has(first.field)) showMore.value = true;
  await nextTick();
  const invalid = formRoot.value?.querySelector?.<HTMLElement>('[aria-invalid="true"]');
  invalid?.focus();
}

function submit() {
  submitted.value = true;
  if (props.busy || props.locked || !props.available || !validation.value.record) {
    void focusFirstError();
    return;
  }
  if (validation.value.warnings.length && !confirmed.value) {
    void focusFirstError();
    return;
  }
  emit("save", validation.value.record);
}
</script>

<template>
  <form ref="formRoot" class="refueling-form panel" novalidate @submit.prevent="submit">
    <fieldset :disabled="busy || locked || !available" class="form-fields">
      <legend class="form-legend">加油信息</legend>

      <section class="field-group" aria-label="时间">
        <label class="field wide">
          <span class="field-label">加油时间（北京时间）<span v-if="sourceTag('occurredAtLocal')" class="source-tag">{{ sourceTag("occurredAtLocal") }}</span></span>
          <input
            type="datetime-local"
            step="1"
            :value="draft.values.occurredAtLocal"
            :aria-invalid="submitted && !!validation.errors.occurredAtLocal"
            @input="edit('occurredAtLocal', $event)"
          />
          <span v-if="submitted" class="field-error">{{ validation.errors.occurredAtLocal }}</span>
        </label>
      </section>

      <section class="field-group" aria-label="账单">
        <h3 class="group-title">账单</h3>
        <label v-for="key of billFields" :key="key" class="field">
          <span class="field-label">
            {{ numberFields[key].label }}（{{ unitText[numberFields[key].unit] ?? numberFields[key].unit }}）
            <span v-if="sourceTag(key)" class="source-tag">{{ sourceTag(key) }}</span>
          </span>
          <input
            inputmode="decimal"
            :name="key"
            :value="draft.values[key]"
            :aria-invalid="submitted && !!validation.errors[key]"
            autocomplete="off"
            @input="edit(key, $event)"
          />
          <span v-if="submitted && validation.errors[key]" class="field-error">{{ validation.errors[key] }}</span>
        </label>
      </section>

      <section class="field-group" aria-label="车辆">
        <h3 class="group-title">车辆</h3>
        <label class="field">
          <span class="field-label">总里程（km）</span>
          <input
            inputmode="decimal"
            name="odometerTenths"
            :value="draft.values.odometerTenths"
            :aria-invalid="submitted && !!validation.errors.odometerTenths"
            autocomplete="off"
            @input="edit('odometerTenths', $event)"
          />
          <span v-if="submitted && validation.errors.odometerTenths" class="field-error">{{ validation.errors.odometerTenths }}</span>
          <span class="reference-odometer">
            <Clock aria-hidden="true" :size="13" :stroke-width="2" />
            {{ referenceLine(referenceRecords.before, "前一条") || "暂无更早的记录" }}
          </span>
          <span v-if="referenceRecords.after" class="reference-odometer">
            <Clock aria-hidden="true" :size="13" :stroke-width="2" />
            {{ referenceLine(referenceRecords.after, "后一条") }}
          </span>
        </label>
        <fieldset class="field radio-field">
          <legend class="field-label">是否加满 <span aria-hidden="true">*</span></legend>
          <span class="radio-options">
            <label class="radio-option" :class="{ checked: draft.values.fullTank === 'yes' }">
              <input type="radio" name="fullTank" value="yes" :checked="draft.values.fullTank === 'yes'" :aria-invalid="submitted && !!validation.errors.fullTank" @change="edit('fullTank', $event)" />
              加满
            </label>
            <label class="radio-option" :class="{ checked: draft.values.fullTank === 'no' }">
              <input type="radio" name="fullTank" value="no" :checked="draft.values.fullTank === 'no'" :aria-invalid="submitted && !!validation.errors.fullTank" @change="edit('fullTank', $event)" />
              未加满
            </label>
          </span>
          <span v-if="submitted" class="field-error">{{ validation.errors.fullTank }}</span>
          <span class="field-hint">新建时须本人选择，不预选。</span>
        </fieldset>
        <label class="field">
          <span class="field-label">加油前油灯 <span class="field-optional">选填</span></span>
          <select
            :value="draft.values.lowFuelLight"
            :aria-invalid="submitted && !!validation.errors.lowFuelLight"
            @change="edit('lowFuelLight', $event)"
          >
            <option value="">未填写</option>
            <option value="yes">油灯亮</option>
            <option value="no">没有亮</option>
          </select>
          <span v-if="submitted" class="field-error">{{ validation.errors.lowFuelLight }}</span>
        </label>
      </section>

      <section class="field-group" aria-label="更多信息">
        <button type="button" class="text-button more-toggle" :aria-expanded="showMore" @click="showMore = !showMore">
          <ChevronDown aria-hidden="true" :size="14" :stroke-width="2" :class="{ open: showMore }" />
          {{ showMore ? "收起更多信息" : "更多信息（加油站、油品、订单号等）" }}
        </button>
        <template v-if="showMore">
          <label class="field">
            <span class="field-label">加油站 <span class="field-optional">选填</span></span>
            <input name="stationName" :value="draft.values.stationName" :aria-invalid="submitted && !!validation.errors.stationName" @input="edit('stationName', $event)" />
            <span v-if="submitted" class="field-error">{{ validation.errors.stationName }}</span>
          </label>
          <label class="field">
            <span class="field-label">油品 <span class="field-optional">选填</span></span>
            <input name="fuelGrade" :value="draft.values.fuelGrade" placeholder="例如：92 号汽油" :aria-invalid="submitted && !!validation.errors.fuelGrade" @input="edit('fuelGrade', $event)" />
            <span v-if="submitted" class="field-error">{{ validation.errors.fuelGrade }}</span>
          </label>
          <label class="field">
            <span class="field-label">订单号 <span class="field-optional">选填</span></span>
            <input name="orderNumber" :value="draft.values.orderNumber" :aria-invalid="submitted && !!validation.errors.orderNumber" @input="edit('orderNumber', $event)" />
            <span v-if="submitted" class="field-error">{{ validation.errors.orderNumber }}</span>
          </label>
          <label class="field">
            <span class="field-label">可开票金额（元） <span class="field-optional">选填</span></span>
            <input name="invoiceableAmountCents" inputmode="decimal" :value="draft.values.invoiceableAmountCents" :aria-invalid="submitted && !!validation.errors.invoiceableAmountCents" @input="edit('invoiceableAmountCents', $event)" />
            <span v-if="submitted" class="field-error">{{ validation.errors.invoiceableAmountCents }}</span>
          </label>
        </template>
      </section>
    </fieldset>

    <div v-if="submitted && errorEntries.length" class="field-error error-summary" role="alert">
      <p class="error-summary-title">还有 {{ errorEntries.length }} 项需要填写或修正：</p>
      <ul class="error-summary-list">
        <li v-for="entry of errorEntries" :key="entry.field">{{ entry.label }}：{{ entry.message }}</li>
      </ul>
      <button type="button" class="text-button" @click="focusFirstError">查看第一项</button>
    </div>

    <div v-if="validation.warnings.length" class="warning" role="note">
      <p v-for="warning of validation.warnings" :key="warning">
        {{ warning }}
      </p>
      <label class="confirmation">
        <input v-model="confirmed" type="checkbox" :disabled="busy || locked" />我已核对，按当前账单数据保存
      </label>
    </div>

    <div class="form-actions">
      <button type="button" :disabled="busy || locked" @click="emit('continueLater')">稍后继续</button>
      <button
        class="primary save-button"
        :disabled="busy || locked || !available || (!!validation.warnings.length && !confirmed)"
        type="submit"
      >
        {{ busy ? "保存中…" : "保存记录" }}
      </button>
    </div>
    <p class="form-note">
      单价、加油量、应付任填两项即可计算另一项；人工修改会保留。保存只写入本机，联网后自动同步。
    </p>
  </form>
</template>

<style scoped>
.form-fields {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.form-legend {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.field-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 14px;
  border: 0;
  padding: 0;
  margin: 0;
}
.field-group[aria-label="时间"] {
  grid-template-columns: 1fr;
}
.group-title {
  grid-column: 1 / -1;
  margin: -6px 0 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
}
.more-toggle {
  grid-column: 1 / -1;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.more-toggle svg { transition: transform 120ms ease; }
.more-toggle svg.open { transform: rotate(180deg); }
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 0.875rem;
  font-weight: 500;
  min-width: 0;
}
.wide { grid-column: 1 / -1; }
.field-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.field-optional {
  font-size: 0.6875rem;
  font-weight: 400;
  color: var(--text-muted);
}
.source-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--surface-subtle);
  color: var(--text-secondary);
  font-size: 0.6875rem;
  font-weight: 400;
  line-height: 1.6;
}
.field-hint {
  font-size: 0.6875rem;
  font-weight: 400;
  color: var(--text-muted);
}
.reference-odometer {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--text-muted);
}
.reference-odometer svg { flex-shrink: 0; }
.radio-field { border: 0; padding: 0; margin: 0; }
.radio-options {
  /* auto-fit + min(9rem, 100%)：默认字号两列；根字号放大（文字放大）时列下限
     收缩到容器宽，选项真实重排为单列竖排——不靠裁切或隐藏横向溢出（UI-V01）。 */
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(9rem, 100%), 1fr));
  gap: 8px;
}
.radio-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control, 10px);
  background: var(--surface-elevated);
  cursor: pointer;
  font-weight: 400;
}
.radio-option:hover { border-color: var(--border-strong); }
.radio-option.checked {
  background: var(--accent-soft);
  border-color: var(--accent-primary);
}
.radio-option input {
  width: 18px;
  min-height: 18px;
  height: 18px;
  flex: 0 0 18px;
  margin: 0;
  accent-color: var(--accent-primary);
}
.error-summary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 14px 0 0;
}
.error-summary-title {
  margin: 0;
  font-weight: 600;
}
.error-summary-list {
  margin: 0;
  padding-left: 1.25em;
}
.error-summary-list li {
  line-height: 1.8;
}
.confirmation {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8125rem;
  font-weight: 400;
}
.confirmation input {
  width: 18px;
  min-height: 18px;
  height: 18px;
  padding: 0;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}
.save-button { flex: 1 1 200px; }
.form-note {
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.8;
  margin: 14px 0 0;
}
@media (max-width: 450px) {
  .field-group { gap: 14px 10px; }
}
</style>
