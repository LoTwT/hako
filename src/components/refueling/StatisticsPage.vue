<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { ChevronLeft, ChevronRight, TriangleAlert } from "@lucide/vue";
import {
  describeTripPriceAllocation,
  formatStatisticsValue as format,
  type AggregateMetric,
  type ConsumptionSource,
  type RefuelingStatisticsHistory,
  type StatisticsPeriod,
  type StatisticsPeriodResult,
  type StatisticsReason,
  type StatisticsRecordsContext,
  type StatisticsTrip,
  type TripId,
} from "../../domain/refueling/statistics";
import StatisticsTrend from "./StatisticsTrend.vue";

const props = defineProps<{
  history: RefuelingStatisticsHistory | null;
  result: StatisticsPeriodResult | null;
  period: StatisticsPeriod;
  ready: boolean;
  error: string;
}>();
const emit = defineEmits<{
  updatePeriod: [period: StatisticsPeriod];
  viewRecords: [context: StatisticsRecordsContext];
  retryLoad: [];
}>();
const today = new Date(Date.now() + 8 * 60 * 60 * 1000);
const currentYear = today.getUTCFullYear();
const currentMonth = today.getUTCMonth() + 1;
const periodLabel = computed(() => props.period.kind === "total" ? "累计"
  : props.period.kind === "yearly" ? `${props.period.year} 年` : `${props.period.year} 年 ${props.period.month} 月`);
const periodYear = computed(() => props.period.kind === "total" ? currentYear : props.period.year);
const periodMonth = computed(() => props.period.kind === "monthly" ? props.period.month : currentMonth);
const availableYears = computed(() => [...new Set([currentYear, periodYear.value,
  ...(props.history?.orderedRecords.map(record => Number(record.occurredAtLocal.slice(0, 4))) ?? [])])].sort((a, b) => a - b));
const monthBounds = computed(() => {
  const months = props.history?.orderedRecords.map(record => Number(record.occurredAtLocal.slice(0, 4)) * 12 + Number(record.occurredAtLocal.slice(5, 7)) - 1) ?? [];
  let first = currentYear * 12 + currentMonth - 1;
  let last = first;
  for (const month of months) { first = Math.min(first, month); last = Math.max(last, month); }
  return { first, last };
});
function setKind(kind: StatisticsPeriod["kind"]) {
  emit("updatePeriod", kind === "total" ? { kind } : kind === "yearly"
    ? { kind, year: periodYear.value } : { kind, year: periodYear.value, month: periodMonth.value });
}
function canStep(delta: number): boolean {
  if (props.period.kind === "total") return false;
  const position = props.period.kind === "yearly" ? props.period.year : props.period.year * 12 + props.period.month - 1;
  const first = props.period.kind === "yearly" ? Math.floor(monthBounds.value.first / 12) : monthBounds.value.first;
  const last = props.period.kind === "yearly" ? Math.floor(monthBounds.value.last / 12) : monthBounds.value.last;
  return delta < 0 ? position > first : position < last;
}
function step(delta: number) {
  if (!canStep(delta) || props.period.kind === "total") return;
  if (props.period.kind === "yearly") emit("updatePeriod", { kind: "yearly", year: props.period.year + delta });
  else {
    const month = props.period.year * 12 + props.period.month - 1 + delta;
    emit("updatePeriod", { kind: "monthly", year: Math.floor(month / 12), month: month % 12 + 1 });
  }
}
function selectYear(event: Event) {
  const year = Number((event.target as HTMLSelectElement).value);
  emit("updatePeriod", props.period.kind === "monthly" ? { kind: "monthly", year, month: props.period.month } : { kind: "yearly", year });
}
function selectMonth(event: Event) {
  emit("updatePeriod", { kind: "monthly", year: periodYear.value, month: Number((event.target as HTMLSelectElement).value) });
}
const metrics = computed(() => props.result === null ? [] : [
  { key: "consumption", title: "平均油耗", kind: "fuelConsumption" as const, unit: "L/100km", metric: props.result.fuelConsumption },
  { key: "cost", title: "每公里油费", kind: "costPerKilometre" as const, unit: "元/km", metric: props.result.fuelCost },
]);
function unavailableLabel(metric: AggregateMetric): string {
  if (metric.reviewTripCount) return "待核对";
  if (metric.pendingTripCount) return "待计算";
  return props.result?.selectedRecordCount ? "尚无已结束行程" : "本期没有记录";
}
const reasonLabels: Record<StatisticsReason, string> = {
  "no-records": "本期没有记录",
  "no-ended-trip": "尚无已结束的相邻行程",
  "no-completed-source": "尚未形成满箱或亮灯计算依据",
  "non-increasing-odometer": "相邻记录里程未递增，请核对两端记录",
  "source-crosses-odometer-anomaly": "计算来源跨过里程异常，请核对关联记录",
  "insufficient-price-history": "历史价格依据不足",
};
const recordsById = computed(() => new Map(props.history?.orderedRecords.map(record => [record.id, record]) ?? []));
function recordTime(id: string): string { return recordsById.value.get(id)?.occurredAtLocal.replace("T", " ") ?? id; }
function sourceFor(trip: StatisticsTrip): ConsumptionSource | undefined {
  return trip.consumption.state === "valid" ? props.history?.sources.get(trip.consumption.sourceId) : undefined;
}
function sourceLabel(source: ConsumptionSource): string {
  return `${source.method === "full-tank" ? "满箱" : "亮灯"} · ${source.kind === "single" ? "单次" : "阶段参考"}`;
}
function viewPeriodRecords(pendingOnly: boolean) {
  emit("viewRecords", { period: props.period, periodLabel: periodLabel.value, pendingOnly });
}
function viewRelated(recordIds: readonly string[], label: string) {
  emit("viewRecords", { period: { kind: "total" }, periodLabel: "累计", pendingOnly: false, related: { recordIds, label } });
}
function viewSource(source: ConsumptionSource) {
  viewRelated(props.history!.orderedRecords.slice(source.startIndex, source.endIndex + 1).map(record => record.id), "计算依据（含期外记录）");
}
function reviewRecordIds(trips: readonly StatisticsTrip[]): string[] {
  const ids = new Set<string>();
  for (const trip of trips) {
    if (trip.consumption.state === "valid") continue;
    trip.consumption.relatedRecordIds.forEach(id => ids.add(id));
    for (const sourceId of trip.consumption.blockedSourceIds) {
      const source = props.history!.sources.get(sourceId)!;
      if (source.validity.state === "blocked") for (const issue of source.validity.issues) {
        ids.add(issue.startRecordId); ids.add(issue.endRecordId);
      }
    }
  }
  return [...ids];
}
function viewIssues() {
  const trips = props.result!.trendPoints.map(point => props.history!.trips[point.edgeIndex]);
  viewRelated(reviewRecordIds(trips.filter(trip => trip.consumption.state === "review")), "里程异常依据（含期外记录）");
}
const detailsOpen = shallowRef(false);
const tripPage = shallowRef(0);
const priceTripId = shallowRef<TripId | null>(null);
const pricePage = shallowRef(0);
const pageCount = computed(() => Math.max(1, Math.ceil((props.result?.selectedTripCount ?? 0) / 50)));
const visibleTrips = computed(() => props.result?.trendPoints.slice(tripPage.value * 50, (tripPage.value + 1) * 50)
  .map(point => props.history!.trips[point.edgeIndex]) ?? []);
const priceTrip = computed(() => priceTripId.value === null ? null : visibleTrips.value.find(trip =>
  trip.id[0] === priceTripId.value![0] && trip.id[1] === priceTripId.value![1]) ?? null);
const priceAllocations = computed(() => priceTrip.value === null || props.history === null ? [] : describeTripPriceAllocation(props.history, priceTrip.value.id));
const pricePageCount = computed(() => Math.max(1, Math.ceil(priceAllocations.value.length / 50)));
const visiblePrices = computed(() => priceAllocations.value.slice(pricePage.value * 50, (pricePage.value + 1) * 50));
function showPrices(trip: StatisticsTrip) {
  priceTripId.value = priceTripId.value?.[0] === trip.id[0] && priceTripId.value?.[1] === trip.id[1] ? null : trip.id;
  pricePage.value = 0;
}
function viewPriceRecords() {
  const cost = priceTrip.value?.cost;
  if (cost?.state !== "valid") return;
  viewRelated(props.history!.orderedRecords.slice(cost.allocation.oldestRecordIndex, cost.allocation.newestRecordIndex + 1).map(record => record.id), "历史实付价格（含期外记录）");
}
watch(() => props.period, () => { tripPage.value = 0; priceTripId.value = null; });
watch(() => props.result, () => {
  tripPage.value = Math.min(tripPage.value, pageCount.value - 1);
  if (priceTrip.value?.cost.state !== "valid") priceTripId.value = null;
  pricePage.value = 0;
});
</script>

<template>
  <section class="statistics-page" aria-label="加油统计">
    <h2 class="statistics-heading">加油统计</h2>
    <template v-if="!ready || !history || !result">
      <p v-if="error" role="alert">{{ error }} <button type="button" @click="emit('retryLoad')">重新读取</button></p>
      <p v-else role="status">正在打开本机记录…</p>
    </template>
    <template v-else>
      <div class="period-controls">
        <div class="segmented" role="group" aria-label="统计期间">
          <button v-for="kind of (['total', 'monthly', 'yearly'] as const)" :key="kind" type="button"
            class="segment" :class="{ active: period.kind === kind }" :aria-pressed="period.kind === kind" @click="setKind(kind)">
            {{ kind === "total" ? "累计" : kind === "monthly" ? "月度" : "年度" }}
          </button>
        </div>
        <div v-if="period.kind !== 'total'" class="period-stepper">
          <button type="button" :aria-label="period.kind === 'monthly' ? '上一月' : '上一年'" :disabled="!canStep(-1)" @click="step(-1)"><ChevronLeft aria-hidden="true" :size="16" /></button>
          <select aria-label="统计年份" :value="periodYear" @change="selectYear"><option v-for="year of availableYears" :key="year" :value="year">{{ year }} 年</option></select>
          <select v-if="period.kind === 'monthly'" aria-label="统计月份" :value="periodMonth" @change="selectMonth"><option v-for="month of 12" :key="month" :value="month">{{ month }} 月</option></select>
          <button type="button" :aria-label="period.kind === 'monthly' ? '下一月' : '下一年'" :disabled="!canStep(1)" @click="step(1)"><ChevronRight aria-hidden="true" :size="16" /></button>
        </div>
        <span class="period-zone muted">北京时间</span>
      </div>
      <p class="period-announcement muted" aria-live="polite" aria-atomic="true">{{ periodLabel }} · 油耗有效 {{ format(result.fuelConsumption.coveredDistanceTenths, 'distance') }} km · 油费有效 {{ format(result.fuelCost.coveredDistanceTenths, 'distance') }} km</p>
      <div class="statistics-grid">
        <section v-for="item of metrics" :key="item.key" class="panel stat-section metric-section" :class="`metric-${item.key}`" :aria-label="item.title">
          <h3>{{ item.title }}</h3>
          <p v-if="item.metric.availability === 'available'" class="metric-value"><strong class="num">{{ format(item.metric.value, item.kind) }}</strong><span>{{ item.unit }}</span></p>
          <p v-else class="metric-status">{{ unavailableLabel(item.metric) }}</p>
          <p class="coverage num">有效 {{ item.metric.validTripCount }} 段 / 本期结束 {{ result.selectedTripCount }} 段，覆盖 {{ format(item.metric.coveredDistanceTenths, 'distance') }} km</p>
          <p v-if="item.metric.coverage === 'partial'" class="coverage-state">部分区间</p>
          <p v-if="item.metric.pendingTripCount || item.metric.reviewTripCount" class="muted">待计算 {{ item.metric.pendingTripCount }} 段 · 待核对 {{ item.metric.reviewTripCount }} 段</p>
          <p v-for="reason of item.metric.reasons" :key="reason.reason" class="muted metric-reason">{{ reasonLabels[reason.reason] }}<template v-if="reason.count">（{{ reason.count }} 段）</template>。</p>
          <p v-if="item.metric.basisCounts.stageReference" class="muted">含 {{ item.metric.basisCounts.stageReference }} 段阶段参考。</p>
        </section>
        <StatisticsTrend class="panel trend-section" :points="result.trendPoints" :period="period" :period-label="periodLabel" />
        <section class="panel stat-section expense-section" aria-label="加油支出">
          <h3>加油支出</h3>
          <p class="muted">按加油日期汇总 · 本期 {{ result.selectedRecordCount }} 条记录</p>
          <dl class="expense-rows">
            <div><dt>应付</dt><dd class="num">¥{{ format(result.expense.amountPayableCents, 'amount') }}</dd></div>
            <div><dt>优惠券</dt><dd class="num">¥{{ format(result.expense.couponDiscountCents, 'amount') }}</dd></div>
            <div class="expense-total"><dt>实付</dt><dd class="num">¥{{ format(result.expense.amountPaidCents, 'amount') }}</dd></div>
          </dl>
          <p v-if="!result.selectedRecordCount" class="muted">本期间还没有加油记录。</p>
          <button type="button" class="text-button" @click="viewPeriodRecords(false)">查看本期记录</button>
        </section>
        <section class="panel stat-section basis-section" aria-label="待核对与依据">
          <h3>记录覆盖里程</h3>
          <template v-if="result.recordCoverage.availability === 'available'">
            <p class="record-coverage num">{{ format(result.recordCoverage.distanceTenths, 'distance') }} km</p>
            <p class="muted">{{ recordTime(result.recordCoverage.firstId) }} 至 {{ recordTime(result.recordCoverage.lastId) }}</p>
          </template>
          <p v-else>{{ result.recordCoverage.reason === 'insufficient-records' ? '记录不足：本期至少需要两条记录。' : '待核对：本期记录跨度内存在里程异常。' }}</p>
          <p class="muted">本期首末记录的里程差，不代表自然月实际行驶里程。</p>
          <h3>依据与待核对</h3>
          <p class="muted">每公里油费按历史实付价格估算消耗费用；各段独立分摊，和本期加油支出含义不同。</p>
          <p v-if="result.reviewSummary.recordWarnings.size" class="review-line"><TriangleAlert aria-hidden="true" :size="16" />本期有 {{ result.reviewSummary.recordWarnings.size }} 条记录待核对。<button type="button" class="text-button" @click="viewPeriodRecords(true)">查看待核对记录</button></p>
          <p v-else class="muted">本期交易记录没有待核对提示。</p>
          <p v-if="result.reviewSummary.odometerIssues.length" class="review-line">{{ result.reviewSummary.odometerIssues.length }} 处里程异常影响本期 {{ result.fuelConsumption.reviewTripCount }} 段计算。<span v-if="result.reviewSummary.externalRecordIds.length">包含期间外异常记录。</span><button type="button" class="text-button" @click="viewIssues">查看异常依据（含期外）</button></p>
          <details class="trip-details" @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open">
            <summary>逐段统计依据 · {{ result.selectedTripCount }} 段</summary>
            <div v-if="detailsOpen">
              <p class="muted">数量显示到 0.001 L，汇总使用未舍入值。阶段参考按来源区间估算，并非各段独立实测。</p>
              <p v-if="!result.selectedTripCount">本期没有已结束的相邻行程。</p>
              <ol v-else class="trip-list" :start="tripPage * 50 + 1" aria-label="逐段统计依据">
                <li v-for="trip of visibleTrips" :key="trip.edgeIndex" class="trip-row">
                  <p class="trip-heading num">{{ recordTime(trip.startRecordId) }} → {{ recordTime(trip.endRecordId) }}</p>
                  <p class="muted num">{{ format(BigInt(recordsById.get(trip.startRecordId)!.odometerTenths), 'distance') }} → {{ format(BigInt(recordsById.get(trip.endRecordId)!.odometerTenths), 'distance') }} km · 记录 {{ trip.startRecordId }} → {{ trip.endRecordId }}</p>
                  <template v-if="trip.consumption.state === 'valid'">
                    <p class="num">油耗 {{ format(trip.consumption.litresPer100Km, 'fuelConsumption') }} L/100km · 耗油 {{ format(trip.consumption.consumedMillilitres, 'volume') }} L · 有效里程 {{ format(trip.distanceTenths, 'distance') }} km</p>
                    <p v-if="sourceFor(trip)" class="source-description">{{ sourceLabel(sourceFor(trip)!) }}：{{ sourceFor(trip)!.startAtLocal.replace('T', ' ') }} 至 {{ sourceFor(trip)!.endAtLocal.replace('T', ' ') }} · {{ format(sourceFor(trip)!.fuelVolumeMillilitres, 'volume') }} L / {{ format(sourceFor(trip)!.distanceTenths, 'distance') }} km <button type="button" class="text-button" @click="viewSource(sourceFor(trip)!)">查看来源记录</button></p>
                  </template>
                  <p v-else>油耗{{ trip.consumption.state === 'review' ? '待核对' : '待计算' }}：{{ reasonLabels[trip.consumption.reason] }}。<button type="button" class="text-button" @click="viewRelated(reviewRecordIds([trip]), '行程依据（含期外记录）')">查看关联记录</button></p>
                  <template v-if="trip.cost.state === 'valid'">
                    <p class="num">油费 {{ format(trip.cost.yuanPerKilometre, 'costPerKilometre') }} 元/km · 消耗费用 ¥{{ format(trip.cost.allocatedCostCents, 'amount') }} <button type="button" class="text-button" :aria-expanded="priceTrip === trip" @click="showPrices(trip)">历史实付分摊</button></p>
                  </template>
                  <p v-else>油费{{ trip.cost.state === 'review' ? '待核对' : '待计算' }}：{{ reasonLabels[trip.cost.reason] }}。<span v-if="trip.cost.reason === 'insufficient-price-history'" class="num">需要 {{ format(trip.cost.requiredMillilitres, 'volume') }} L，已有 {{ format(trip.cost.availableMillilitres, 'volume') }} L，缺 {{ format(trip.cost.missingMillilitres, 'volume') }} L；整段不计入油费。</span></p>
                </li>
              </ol>
              <div v-if="pageCount > 1" class="pagination" role="group" aria-label="行程分页">
                <button type="button" :disabled="tripPage === 0" @click="tripPage--; priceTripId = null">上一页</button><span aria-live="polite">第 {{ tripPage + 1 }} / {{ pageCount }} 页 · 共 {{ result.selectedTripCount }} 段</span><button type="button" :disabled="tripPage + 1 === pageCount" @click="tripPage++; priceTripId = null">下一页</button>
              </div>
              <section v-if="priceTrip && priceTrip.cost.state === 'valid'" class="price-details" aria-label="历史实付分摊">
                <h4>历史实付分摊 · {{ recordTime(priceTrip.startRecordId) }} → {{ recordTime(priceTrip.endRecordId) }}</h4>
                <p>每段从起点向前独立取量，不使用终点新油价格。</p>
                <ul><li v-for="allocation of visiblePrices" :key="allocation.recordId" class="num">{{ allocation.occurredAtLocal.replace('T', ' ') }} · 记录 {{ allocation.recordId }}：原始 {{ format(BigInt(recordsById.get(allocation.recordId)!.fuelVolumeMillilitres), 'volume') }} L / 实付 ¥{{ format(BigInt(recordsById.get(allocation.recordId)!.amountPaidCents), 'amount') }}；取 {{ format(allocation.usedMillilitres, 'volume') }} L，分摊 ¥{{ format(allocation.allocatedCostCents, 'amount') }}</li></ul>
                <div v-if="pricePageCount > 1" class="pagination" role="group" aria-label="价格依据分页"><button type="button" :disabled="pricePage === 0" @click="pricePage--">上一页</button><span>第 {{ pricePage + 1 }} / {{ pricePageCount }} 页 · 共 {{ priceAllocations.length }} 笔</span><button type="button" :disabled="pricePage + 1 === pricePageCount" @click="pricePage++">下一页</button></div>
                <button type="button" class="text-button" @click="viewPriceRecords">查看价格记录</button>
              </section>
            </div>
          </details>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.statistics-page { display: flex; flex-direction: column; gap: 16px; max-width: 960px; min-width: 0; }
.statistics-heading { margin: 0; font-size: 1.125rem; font-weight: 500; }
.period-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.segmented { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--border-default); border-radius: 999px; background: var(--surface-panel); }
.segment { min-height: 36px; padding: 4px 16px; border: 0; border-radius: 999px; background: transparent; color: var(--text-secondary); font-size: 0.8125rem; }
.segment.active { background: var(--accent-soft); color: var(--text-accent); }
.period-stepper { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.period-stepper button { display: grid; place-items: center; min-width: 32px; min-height: 36px; padding: 4px; border-radius: 50%; }
.period-stepper select { width: auto; min-height: 36px; padding: 4px 20px 4px 8px; font-size: 0.8125rem; }
.period-zone, .period-announcement { font-size: 0.75rem; }
.period-announcement { margin: 0; }
.statistics-grid { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "consumption" "trend" "cost" "expense" "basis"; gap: 16px; }
.metric-consumption { grid-area: consumption; }
.metric-cost { grid-area: cost; }
.trend-section { grid-area: trend; }
.expense-section { grid-area: expense; }
.basis-section { grid-area: basis; }
.stat-section { min-width: 0; overflow-wrap: anywhere; }
.stat-section h3 { margin: 0 0 8px; font-size: 0.9375rem; font-weight: 500; }
.stat-section p { margin: 8px 0; font-size: 0.8125rem; line-height: 1.8; }
.metric-value { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.metric-value strong { font-size: 2rem; font-weight: 500; min-width: 0; line-height: 1.3; }
.metric-value span { font-size: 0.8125rem; }
.stat-section .metric-status { font-size: 1.25rem; }
.coverage-state, .review-line { color: var(--status-warning-fg); }
.coverage { color: var(--text-secondary); }
.expense-rows { margin: 0; }
.expense-rows > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; padding: 10px 0; border-top: 1px solid var(--border-default); font-size: 0.875rem; }
.expense-rows dt { color: var(--text-secondary); }
.expense-rows dd { margin: 0; font-weight: 500; min-width: 0; }
.expense-total dd { font-size: 1.0625rem; }
.review-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.review-line svg { flex-shrink: 0; }
.basis-section h3:not(:first-child) { margin-top: 24px; }
.trip-details { margin-top: 18px; }
summary { cursor: pointer; padding: 8px 0; font-size: 0.875rem; }
.trip-list { padding-left: 24px; margin: 8px 0; }
.trip-row { padding: 12px 0; border-top: 1px solid var(--border-default); }
.trip-heading { font-weight: 500; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 0.8125rem; }
.price-details { margin-top: 16px; padding: 16px; border: 1px solid var(--border-default); border-radius: 12px; }
.price-details h4 { margin: 0; font-weight: 500; }
.price-details ul { padding-left: 20px; font-size: 0.8125rem; line-height: 1.8; }
@media (min-width: 880px) {
  .statistics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-areas: "consumption cost" "trend expense" "basis basis"; }
}
</style>
