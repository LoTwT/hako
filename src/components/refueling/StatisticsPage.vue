<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { ChartLine, ChevronLeft, ChevronRight, Info, TriangleAlert } from "@lucide/vue";
import { recordWarnings, type SavedRefuelingRecord } from "../../domain/refueling/form";

/**
 * 统计页（F4）：入口与布局按已确认设计接线，仅呈现可由现有记录直接得到的
 * 真实事实（期间记录数与费用合计，按加油日期/北京时间汇总）。平均油耗、
 * 每公里油费、趋势与覆盖里程的统计算法尚未实施，明确标注为后续项；
 * 不显示合成数字或假趋势，缺数据不当作 0。
 */
const props = defineProps<{
  records: readonly SavedRefuelingRecord[];
}>();
type StatisticsPeriod = { kind: "total" } | { kind: "yearly"; year: number } | { kind: "monthly"; year: number; month: number };

const emit = defineEmits<{
  viewRecords: [context: { period: StatisticsPeriod; periodLabel: string; pendingOnly: boolean }];
}>();

type PeriodKind = "total" | "monthly" | "yearly";
const periodKind = shallowRef<PeriodKind>("monthly");
/**
 * 统计期间统一按北京时间（Asia/Shanghai）确定“当前”（UI-R09）：设备时区不
 * 参与当前年月与前进上限；记录归属本身按 occurredAtLocal（北京时间）前缀。
 */
function beijingNow(): { year: number; month: number } {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}
const now = beijingNow();
const year = shallowRef(now.year);
const month = shallowRef(now.month);

const warnings = computed(() => recordWarnings([...props.records]));
const pendingReviewIds = computed(() => new Set(
  [...warnings.value.entries()].filter(([, list]) => list.length > 0).map(([id]) => id)));

const currentPeriod = computed<StatisticsPeriod>(() => {
  if (periodKind.value === "total") return { kind: "total" };
  if (periodKind.value === "yearly") return { kind: "yearly", year: year.value };
  return { kind: "monthly", year: year.value, month: month.value };
});

const periodLabel = computed(() => {
  if (periodKind.value === "total") return "累计";
  if (periodKind.value === "yearly") return `${year.value} 年`;
  return `${year.value} 年 ${month.value} 月`;
});

const periodRecords = computed(() => {
  if (periodKind.value === "total") return props.records;
  const prefix = periodKind.value === "yearly"
    ? `${String(year.value).padStart(4, "0")}-`
    : `${String(year.value).padStart(4, "0")}-${String(month.value).padStart(2, "0")}-`;
  return props.records.filter((record) => record.occurredAtLocal.startsWith(prefix));
});

interface ExpenseTotal { payable: number; coupon: number; paid: number }
const expense = computed<ExpenseTotal>(() => {
  const total: ExpenseTotal = { payable: 0, coupon: 0, paid: 0 };
  for (const record of periodRecords.value) {
    total.payable += record.amountPayableCents;
    total.coupon += record.couponDiscountCents;
    total.paid += record.amountPaidCents;
  }
  return total;
});

function yuan(cents: number): string {
  return `¥${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`;
}

const periodPendingCount = computed(() => periodRecords.value.filter((record) => pendingReviewIds.value.has(record.id)).length);

const emptyPeriod = computed(() => periodRecords.value.length === 0);

watch(periodKind, () => {
  if (periodKind.value === "monthly") {
    year.value = now.year;
    month.value = now.month;
  }
});

function stepMonth(delta: number) {
  const next = new Date(year.value, month.value - 1 + delta, 1);
  year.value = next.getFullYear();
  month.value = next.getMonth() + 1;
}

function stepYear(delta: number) {
  year.value = Math.min(Math.max(year.value + delta, 2000), now.year);
}

const atLatestMonth = computed(() => year.value === now.year && month.value === now.month);
</script>

<template>
  <section class="statistics-page" aria-label="加油统计">
    <h2 class="statistics-heading">加油统计</h2>

    <div class="period-controls">
      <div class="segmented" role="group" aria-label="统计期间">
        <button v-for="kind of (['total', 'monthly', 'yearly'] as const)" :key="kind" type="button"
          class="segment" :class="{ active: periodKind === kind }" :aria-pressed="periodKind === kind"
          @click="periodKind = kind">
          {{ kind === "total" ? "累计" : kind === "monthly" ? "月度" : "年度" }}
        </button>
      </div>
      <div v-if="periodKind !== 'total'" class="period-stepper">
        <button v-if="periodKind === 'monthly'" type="button" aria-label="上一月" @click="stepMonth(-1)">
          <ChevronLeft aria-hidden="true" :size="16" :stroke-width="2" />
        </button>
        <button v-else type="button" aria-label="上一年" @click="stepYear(-1)">
          <ChevronLeft aria-hidden="true" :size="16" :stroke-width="2" />
        </button>
        <span class="period-label num">{{ periodLabel }}</span>
        <button v-if="periodKind === 'monthly' && !atLatestMonth" type="button" aria-label="下一月" @click="stepMonth(1)">
          <ChevronRight aria-hidden="true" :size="16" :stroke-width="2" />
        </button>
        <button v-else-if="periodKind === 'yearly' && year < now.year" type="button" aria-label="下一年" @click="stepYear(1)">
          <ChevronRight aria-hidden="true" :size="16" :stroke-width="2" />
        </button>
      </div>
      <span class="period-zone muted">北京时间</span>
    </div>

    <div class="statistics-grid">
      <section class="panel stat-section" aria-label="加油支出">
        <h3>加油支出</h3>
        <p class="muted expense-note">按加油日期汇总{{ periodKind === "total" ? "（全部记录）" : "" }}。</p>
        <dl class="expense-rows">
          <div class="expense-row">
            <dt>应付</dt>
            <dd class="num">{{ yuan(expense.payable) }}</dd>
          </div>
          <div class="expense-row">
            <dt>优惠券</dt>
            <dd class="num">{{ yuan(expense.coupon) }}</dd>
          </div>
          <div class="expense-row expense-total">
            <dt>实付</dt>
            <dd class="num">{{ yuan(expense.paid) }}</dd>
          </div>
        </dl>
        <p class="muted record-count num">本期 {{ periodRecords.length }} 条记录</p>
        <p v-if="emptyPeriod" class="muted empty-note">本期间还没有加油记录；记一次加油后这里会显示费用合计。</p>
      </section>

      <section class="panel stat-section" aria-label="油耗与油费">
        <h3>平均油耗与每公里油费</h3>
        <div class="pending-metrics">
          <Info aria-hidden="true" :size="18" :stroke-width="2" />
          <p>统计计算尚未实施。平均油耗、每公里油费、油耗趋势与记录覆盖里程将按已确认的统计口径另行实现，当前不显示估算值。</p>
        </div>
      </section>
    </div>

    <section class="panel stat-section" aria-label="待核对与依据">
      <h3>依据与待核对</h3>
      <p v-if="periodPendingCount > 0" class="review-line">
        <TriangleAlert aria-hidden="true" :size="15" :stroke-width="2" />
        本期有 {{ periodPendingCount }} 条记录待核对。
        <button type="button" class="text-button" @click="emit('viewRecords', { period: currentPeriod, periodLabel, pendingOnly: true })">查看待核对记录</button>
      </p>
      <p v-else class="muted review-line">本期没有待核对的记录。</p>
      <p class="muted">
        <ChartLine aria-hidden="true" :size="15" :stroke-width="2" />
        费用合计来自本期记录的直接汇总；
        <button type="button" class="text-button" @click="emit('viewRecords', { period: currentPeriod, periodLabel, pendingOnly: false })">查看本期记录</button>
      </p>
    </section>
  </section>
</template>

<style scoped>
.statistics-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 860px;
}
.statistics-heading {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 500;
}
.period-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
}
.segmented {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--surface-panel);
}
.segment {
  min-height: 32px;
  padding: 4px 16px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8125rem;
}
.segment.active {
  background: var(--accent-soft);
  color: var(--text-accent);
}
.period-stepper {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.period-stepper button {
  display: grid;
  place-items: center;
  width: 36px;
  min-height: 36px;
  padding: 0;
  border-radius: 50%;
}
.period-label {
  min-width: 96px;
  text-align: center;
  font-size: 0.875rem;
  font-weight: 500;
}
.period-zone { font-size: 0.75rem; }
.statistics-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
.stat-section h3 {
  margin: 0 0 4px;
  font-size: 0.875rem;
  font-weight: 500;
}
.expense-note { margin: 0 0 10px; font-size: 0.75rem; }
.expense-rows {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.expense-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid var(--border-default);
  font-size: 0.875rem;
}
.expense-row dt { color: var(--text-secondary); }
.expense-row dd { margin: 0; font-weight: 500; }
.expense-total dd { font-size: 1.0625rem; font-weight: 600; }
.record-count { margin: 10px 0 0; font-size: 0.75rem; }
.empty-note { margin: 8px 0 0; font-size: 0.75rem; }
.pending-metrics {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  line-height: 1.8;
}
.pending-metrics svg { flex-shrink: 0; margin-top: 3px; color: var(--text-muted); }
.review-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: 0.8125rem;
  line-height: 1.8;
}
.review-line svg { flex-shrink: 0; color: var(--status-warning-fg); }
@media (min-width: 880px) {
  .statistics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
