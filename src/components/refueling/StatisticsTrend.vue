<script setup lang="ts">
import { computed, useId } from "vue";
import { formatStatisticsValue, type StatisticsPeriod, type TrendPoint } from "../../domain/refueling/statistics";

const props = defineProps<{
  points: readonly TrendPoint[];
  period: StatisticsPeriod;
  periodLabel: string;
}>();
const titleId = useId();
const descriptionId = useId();
const validPoints = computed(() => props.points.filter(point => point.consumption.state === "valid"));
const summary = computed(() => `${props.periodLabel}，油耗单位 L/100km。${validPoints.value.length} 个有效点，`
  + `${props.points.filter(point => point.consumption.state === "pending").length} 段待计算，`
  + `${props.points.filter(point => point.consumption.state === "review").length} 段待核对。缺失区间不连线；逐段数值和来源见下方统计依据。`);

function monthStart(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, 1);
  date.setUTCHours(-8, 0, 0, 0);
  return date.getTime();
}
const chart = computed(() => {
  const points = props.points;
  const period = props.period;
  const first = points[0]?.xTimestampMs ?? 0;
  const last = points.at(-1)?.xTimestampMs ?? first;
  const from = period.kind === "total" ? first : monthStart(period.year, period.kind === "monthly" ? period.month : 1);
  const to = period.kind === "total" ? last : monthStart(period.year, period.kind === "monthly" ? period.month + 1 : 13) - 1;
  const valid = validPoints.value;
  const maximumPoint = valid.reduce<TrendPoint | undefined>((largest, point) => {
    if (point.consumption.state !== "valid") return largest;
    if (largest?.consumption.state !== "valid") return point;
    const a = point.consumption.litresPer100Km;
    const b = largest.consumption.litresPer100Km;
    return a.numerator * b.denominator > b.numerator * a.denominator ? point : largest;
  }, undefined);
  const maximum = maximumPoint?.consumption.state === "valid" ? maximumPoint.consumption.litresPer100Km : { numerator: 1n, denominator: 1n };
  // 只在映射像素坐标时转换；数值标签与汇总仍使用领域的精确值。
  const heightValue = Number(maximum.numerator) / Number(maximum.denominator);
  let singleLines = "";
  let stageLines = "";
  let singlePoints = "";
  let stagePoints = "";
  let previous: { point: TrendPoint; x: number; y: number } | null = null;
  for (const point of points) {
    if (point.consumption.state !== "valid") { previous = null; continue; }
    const value = point.consumption.litresPer100Km;
    const x = Number((first === last ? 276 : 52 + (point.xTimestampMs - from) / (to - from) * 448).toFixed(2));
    const y = Number((172 - (Number(value.numerator) / Number(value.denominator)) / heightValue * 136).toFixed(2));
    if (previous !== null && point.edgeIndex === previous.point.edgeIndex + 1) {
      const line = `M${previous.x},${previous.y}L${x},${y}`;
      if (point.consumption.kind === "single" && previous.point.consumption.state === "valid" && previous.point.consumption.kind === "single") singleLines += line;
      else stageLines += line;
    }
    const dot = `M${x - 3.5},${y}a3.5,3.5 0 1,0 7,0a3.5,3.5 0 1,0 -7,0`;
    if (point.consumption.kind === "single") singlePoints += dot;
    else stagePoints += dot;
    previous = { point, x, y };
  }
  const dateLabel = (timestamp: number) => new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(period.kind === "total" ? 0 : 5, 10).replaceAll("-", "/");
  return { singleLines, stageLines, singlePoints, stagePoints,
    maximumLabel: formatStatisticsValue(maximum, "fuelConsumption"),
    middleLabel: formatStatisticsValue({ numerator: maximum.numerator, denominator: maximum.denominator * 2n }, "fuelConsumption"),
    fromLabel: dateLabel(first === last ? first : from), toLabel: first === last ? "" : dateLabel(to) };
});
</script>

<template>
  <section class="statistics-trend" aria-label="油耗趋势">
    <h3>油耗趋势</h3>
    <p class="trend-legend"><span>● 实心 / 实线：单次</span><span>○ 空心 / 虚线：阶段参考</span></p>
    <svg v-if="validPoints.length" viewBox="0 0 520 210" role="img" :aria-labelledby="`${titleId} ${descriptionId}`">
      <title :id="titleId">{{ periodLabel }}油耗趋势</title>
      <desc :id="descriptionId">{{ summary }}</desc>
      <g class="grid-lines"><path d="M52,36H500M52,104H500M52,172H500" /></g>
      <g class="axis-labels">
        <text x="52" y="19">L/100km</text>
        <text x="52" y="31">{{ chart.maximumLabel }}</text>
        <text x="52" y="99">{{ chart.middleLabel }}</text>
        <text x="46" y="176" text-anchor="end">0.00</text>
        <text x="52" y="198">{{ chart.fromLabel }}</text>
        <text x="500" y="198" text-anchor="end">{{ chart.toLabel }}</text>
      </g>
      <path class="single-lines" :d="chart.singleLines" />
      <path class="stage-lines" :d="chart.stageLines" />
      <path class="single-points" :d="chart.singlePoints" />
      <path class="stage-points" :d="chart.stagePoints" />
    </svg>
    <p v-else class="trend-empty">{{ points.length ? "尚无有效油耗区间。待计算或待核对的行程保留在下方依据中。" : "本期尚无已结束的相邻行程。" }}</p>
    <p class="trend-summary muted">{{ summary }}</p>
  </section>
</template>

<style scoped>
.statistics-trend { min-width: 0; }
h3 { margin: 0; font-size: 0.9375rem; font-weight: 500; }
.trend-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 0.75rem; color: var(--text-secondary); }
svg { display: block; width: 100%; height: auto; overflow: visible; }
.grid-lines { fill: none; stroke: var(--border-default); stroke-dasharray: 3 3; }
.axis-labels { fill: var(--text-secondary); font-size: 11px; }
.single-lines, .stage-lines { fill: none; stroke: var(--text-accent); stroke-width: 2; }
.stage-lines { stroke-dasharray: 5 4; }
.single-points { fill: var(--text-accent); }
.stage-points { fill: var(--surface-panel); stroke: var(--text-accent); stroke-width: 2; }
.trend-empty { padding: 24px 0; color: var(--text-secondary); }
.trend-summary { font-size: 0.75rem; line-height: 1.8; }
</style>
