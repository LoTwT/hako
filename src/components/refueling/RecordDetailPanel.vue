<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { ChevronDown, Pencil } from "@lucide/vue";
import {
  formatPaidAmount,
  formatQuantity,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";

/**
 * 记录详情（F2）：两端保留同一组业务字段。只读字段不带暗示可编辑的箭头，
 * 油灯未填写仅展示值；进入编辑统一使用「编辑记录」按钮。
 */
const props = defineProps<{
  record: SavedRefuelingRecord;
  busy: boolean;
  /** 全量记录的跨记录警告（里程递增等）：由上层统一计算后传入（UI-R11）。 */
  warnings?: string[];
}>();
const emit = defineEmits<{ edit: [] }>();

const warnings = computed(() => props.warnings ?? []);
const showMore = shallowRef(false);

const lowFuelLightText = computed(() => {
  if (props.record.lowFuelLight === null) return "未填写";
  return props.record.lowFuelLight ? "油灯亮" : "没有亮";
});

const detailRows = computed(() => [
  { label: "总里程", value: `${formatQuantity(props.record.odometerTenths, 1)} km` },
  { label: "单价", value: `¥${formatQuantity(props.record.unitPriceTenThousandths, 4)} / L` },
  { label: "应付", value: `¥${formatQuantity(props.record.amountPayableCents, 2)}` },
  { label: "优惠券", value: `¥${formatQuantity(props.record.couponDiscountCents, 2)}` },
  { label: "油灯", value: lowFuelLightText.value },
]);

const moreRows = computed(() => [
  { label: "加油站", value: props.record.stationName || "未填写" },
  { label: "油品", value: props.record.fuelGrade || "未填写" },
  { label: "订单号", value: props.record.orderNumber || "未填写" },
  { label: "可开票金额", value: props.record.invoiceableAmountCents === null ? "未填写" : `¥${formatQuantity(props.record.invoiceableAmountCents, 2)}` },
]);
</script>

<template>
  <article class="record-detail panel" aria-label="记录详情">
    <p class="detail-time num">{{ record.occurredAtLocal.replace("T", " ") }}</p>
    <p class="detail-paid num">{{ formatPaidAmount(record.amountPaidCents) }}</p>
    <p class="detail-sub num">{{ formatQuantity(record.fuelVolumeMillilitres, 3) }} L · {{ record.fullTank ? "加满" : "未加满" }}</p>
    <dl class="detail-rows">
      <div v-for="row of detailRows" :key="row.label" class="detail-row">
        <dt>{{ row.label }}</dt>
        <dd class="num">{{ row.value }}</dd>
      </div>
    </dl>
    <p v-for="warning of warnings" :key="warning" class="detail-warning">待核对：{{ warning }}</p>
    <button type="button" class="text-button more-toggle" :aria-expanded="showMore" @click="showMore = !showMore">
      <ChevronDown aria-hidden="true" :size="14" :stroke-width="2" :class="{ open: showMore }" />
      {{ showMore ? "收起更多信息" : "更多信息" }}
    </button>
    <dl v-if="showMore" class="detail-rows">
      <div v-for="row of moreRows" :key="row.label" class="detail-row">
        <dt>{{ row.label }}</dt>
        <dd class="num">{{ row.value }}</dd>
      </div>
    </dl>
    <button type="button" class="primary detail-edit" :disabled="busy" @click="emit('edit')">
      <Pencil aria-hidden="true" :size="15" :stroke-width="2" /> 编辑记录
    </button>
  </article>
</template>

<style scoped>
.record-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-time {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}
.detail-paid {
  margin: 2px 0 0;
  font-size: 2rem;
  font-weight: 600;
  letter-spacing: -0.5px;
}
.detail-sub {
  margin: 0 0 10px;
  font-size: 0.9375rem;
  color: var(--text-secondary);
}
.detail-rows {
  margin: 6px 0;
  display: flex;
  flex-direction: column;
}
.detail-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid var(--border-default);
  font-size: 0.875rem;
}
.detail-row dt { color: var(--text-secondary); }
.detail-row dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.detail-warning {
  margin: 6px 0 0;
  font-size: 0.8125rem;
  color: var(--status-warning-fg);
  line-height: 1.7;
}
.more-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.more-toggle svg { transition: transform 120ms ease; }
.more-toggle svg.open { transform: rotate(180deg); }
.detail-edit {
  margin-top: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
</style>
