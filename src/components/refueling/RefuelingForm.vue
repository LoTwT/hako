<script setup lang="ts">
import { computed, shallowRef } from "vue";
import {
  createDraft,
  numberFields,
  updateDraft,
  validateDraft,
  type FormField,
  type NumberField,
  type RefuelingRecord,
} from "../../domain/refueling/form";

const props = defineProps<{
  initial?: RefuelingRecord;
  busy: boolean;
  available: boolean;
}>();
const emit = defineEmits<{
  save: [record: RefuelingRecord];
  dirty: [value: boolean];
}>();
const draft = shallowRef(createDraft(props.initial));
const submitted = shallowRef(false);
const confirmed = shallowRef(false);
const validation = computed(() => validateDraft(draft.value));
const numericEntries = Object.entries(numberFields) as [
  NumberField,
  (typeof numberFields)[NumberField],
][];

function edit(field: FormField, event: Event) {
  draft.value = updateDraft(
    draft.value,
    field,
    (event.target as HTMLInputElement).value,
  );
  confirmed.value = false;
  emit("dirty", true);
}
function submit() {
  submitted.value = true;
  if (props.busy || !props.available || !validation.value.record) return;
  if (validation.value.warnings.length && !confirmed.value) return;
  emit("save", validation.value.record);
}
</script>

<template>
  <section class="panel" aria-labelledby="form-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">REFUELING</p>
        <h2 id="form-title">{{ initial ? "编辑记录" : "记录一次加油" }}</h2>
      </div>
      <span class="muted">手动录入</span>
    </div>
    <form novalidate @submit.prevent="submit">
      <fieldset :disabled="busy || !available" class="form-fields">
        <label class="field wide"
          >加油日期时间（北京时间）
          <input
            type="datetime-local"
            step="1"
            :value="draft.values.occurredAtLocal"
            :aria-invalid="submitted && !!validation.errors.occurredAtLocal"
            @input="edit('occurredAtLocal', $event)"
          />
          <span v-if="submitted" class="field-error">{{
            validation.errors.occurredAtLocal
          }}</span>
        </label>
        <label
          v-for="[key, definition] of numericEntries"
          :key="key"
          class="field"
        >
          <span
            >{{ definition.label }}
            <small
              >{{ definition.unit
              }}{{ key === "invoiceableAmountCents" ? " · 选填" : "" }}</small
            ></span
          >
          <input
            inputmode="decimal"
            :name="key"
            :aria-label="definition.label"
            :value="draft.values[key]"
            :aria-invalid="submitted && !!validation.errors[key]"
            autocomplete="off"
            @input="edit(key, $event)"
          />
          <span
            v-if="submitted && validation.errors[key]"
            class="field-error"
            >{{ validation.errors[key] }}</span
          >
          <span
            v-else-if="draft.sources[key] === 'calculated' && draft.values[key]"
            class="calculated"
            >已自动计算，可以修改</span
          >
        </label>
        <label class="field"
          >是否加满
          <select
            :value="draft.values.fullTank"
            :aria-invalid="submitted && !!validation.errors.fullTank"
            @change="edit('fullTank', $event)"
          >
            <option value="">请选择</option>
            <option value="yes">加满</option>
            <option value="no">没加满</option>
          </select>
          <span v-if="submitted" class="field-error">{{
            validation.errors.fullTank
          }}</span>
        </label>
        <label class="field"
          >加油前油灯状态 <small>选填</small>
          <select
            :value="draft.values.lowFuelLight"
            @change="edit('lowFuelLight', $event)"
          >
            <option value="">未填写</option>
            <option value="yes">油灯亮</option>
            <option value="no">没有亮</option>
          </select>
        </label>
        <label class="field"
          >加油站 <small>选填</small
          ><input
            :value="draft.values.stationName"
            @input="edit('stationName', $event)"
          /><span v-if="submitted" class="field-error">{{
            validation.errors.stationName
          }}</span></label
        >
        <label class="field"
          >油品 <small>选填</small
          ><input
            :value="draft.values.fuelGrade"
            placeholder="例如：92 号汽油"
            @input="edit('fuelGrade', $event)"
          /><span v-if="submitted" class="field-error">{{
            validation.errors.fuelGrade
          }}</span></label
        >
        <label class="field wide"
          >订单号 <small>选填</small
          ><input
            :value="draft.values.orderNumber"
            @input="edit('orderNumber', $event)"
          /><span v-if="submitted" class="field-error">{{
            validation.errors.orderNumber
          }}</span></label
        >
      </fieldset>
      <div v-if="validation.warnings.length" class="warning" role="note">
        <p v-for="warning of validation.warnings" :key="warning">
          {{ warning }}
        </p>
        <label class="confirmation"
          ><input
            v-model="confirmed"
            type="checkbox"
            :disabled="busy"
          />我已核对，按当前账单数据保存</label
        >
      </div>
      <p
        v-if="submitted && Object.keys(validation.errors).length"
        class="field-error"
        role="alert"
      >
        请补齐或修正上方字段。
      </p>
      <button
        class="primary save-button"
        :disabled="
          busy || !available || (!!validation.warnings.length && !confirmed)
        "
        type="submit"
      >
        {{ busy ? "保存中…" : "保存到本机" }}
      </button>
      <p class="form-note">
        单价、加油量、应付任填两项即可计算另一项。人工修改会保留；已保存的账单值在编辑时也会保留。
      </p>
    </form>
  </section>
</template>

<style scoped>
.form-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px 22px;
  border: 0;
  padding: 0;
  margin: 24px 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
  font-weight: 550;
}
.wide {
  grid-column: 1 / -1;
}
.calculated {
  color: var(--accent);
  font-size: 12px;
  font-weight: 400;
}
.confirmation {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.confirmation input {
  width: 18px;
  min-height: 18px;
}
.save-button {
  width: 100%;
}
.form-note {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
  margin: 14px 0 0;
}
@media (max-width: 450px) {
  .form-fields {
    gap: 18px 12px;
  }
}
</style>
