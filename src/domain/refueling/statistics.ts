import {
  compareRefuelingRecords,
  inspectOdometerRelationship,
  isValidRefuelingRecord,
  normalizeOccurredAtLocal,
  recordWarnings,
  type SavedRefuelingRecord,
} from "./form";

export type ExactRatio = Readonly<{ numerator: bigint; denominator: bigint }>;
export type StatisticsPeriod =
  | Readonly<{ kind: "total" }>
  | Readonly<{ kind: "yearly"; year: number }>
  | Readonly<{ kind: "monthly"; year: number; month: number }>;
export type StatisticsRecordsContext = Readonly<{
  period: StatisticsPeriod;
  periodLabel: string;
  pendingOnly: boolean;
  related?: Readonly<{ recordIds: readonly string[]; label: string }>;
}>;
export type TripId = readonly [startRecordId: string, endRecordId: string];
export type SourceMethod = "full-tank" | "low-fuel-light";
export type SourceKind = "single" | "stage-reference";
export type OdometerIssue = Readonly<{
  startRecordId: string; endRecordId: string;
  startIndex: number; endIndex: number; deltaTenths: bigint;
}>;
export type ConsumptionSource = Readonly<{
  id: string; method: SourceMethod; kind: SourceKind;
  startRecordId: string; endRecordId: string; startIndex: number; endIndex: number;
  startAtLocal: string; endAtLocal: string; elapsedMilliseconds: number;
  distanceTenths: bigint; fuelVolumeMillilitres: bigint;
  validity: Readonly<{ state: "valid" }> | Readonly<{ state: "blocked"; issues: readonly OdometerIssue[] }>;
}>;
type ConsumptionUnavailableReason = "no-completed-source" | "non-increasing-odometer" | "source-crosses-odometer-anomaly";
export type StatisticsReason = ConsumptionUnavailableReason | "no-records" | "no-ended-trip" | "insufficient-price-history";
type UnavailableTripResult = Readonly<{
  state: "pending" | "review";
  reason: ConsumptionUnavailableReason;
  relatedRecordIds: readonly string[];
  blockedSourceIds: readonly string[];
}>;
export type ConsumptionResult = UnavailableTripResult | Readonly<{
  state: "valid"; sourceId: string; method: SourceMethod; kind: SourceKind;
  consumedMillilitres: ExactRatio; litresPer100Km: ExactRatio;
}>;
export type PriceAllocation = Readonly<{
  newestRecordIndex: number; oldestRecordIndex: number; oldestUsedMillilitres: ExactRatio;
}>;
export type TripCostResult = UnavailableTripResult | Readonly<{
  state: "pending"; reason: "insufficient-price-history";
  relatedRecordIds: readonly string[]; blockedSourceIds: readonly string[];
  requiredMillilitres: ExactRatio; availableMillilitres: bigint; missingMillilitres: ExactRatio;
}> | Readonly<{
  state: "valid"; allocatedCostCents: ExactRatio; yuanPerKilometre: ExactRatio; allocation: PriceAllocation;
}>;
export type StatisticsTrip = Readonly<{
  id: TripId; edgeIndex: number; startRecordId: string; endRecordId: string;
  startIndex: number; endIndex: number; endAtLocal: string; distanceTenths: bigint;
  consumption: ConsumptionResult; cost: TripCostResult;
}>;
export type RefuelingStatisticsHistory = Readonly<{
  orderedRecords: readonly Readonly<SavedRefuelingRecord>[];
  sources: ReadonlyMap<string, ConsumptionSource>;
  trips: readonly StatisticsTrip[];
  recordWarnings: ReadonlyMap<string, readonly string[]>;
  odometerIssues: readonly OdometerIssue[];
  quantityPrefix: readonly bigint[];
  paidPrefix: readonly bigint[];
}>;
export type AggregateMetric = Readonly<{
  coverage: "complete" | "partial" | "none";
  coveredDistanceTenths: bigint;
  validTripCount: number; pendingTripCount: number; reviewTripCount: number;
  reasons: readonly Readonly<{ reason: StatisticsReason; count: number; tripIds: readonly TripId[]; relatedRecordIds: readonly string[] }>[];
  basisCounts: Readonly<{ fullTank: number; lowFuelLight: number; single: number; stageReference: number }>;
}> & (Readonly<{ availability: "available"; value: ExactRatio }> | Readonly<{ availability: "unavailable" }>);
export type TrendPoint = Readonly<{
  tripId: TripId; edgeIndex: number; endAtLocal: string; xTimestampMs: number;
  consumption: ConsumptionResult;
}>;
export type StatisticsPeriodResult = Readonly<{
  period: StatisticsPeriod;
  selectedRecordIds: readonly string[]; selectedRecordCount: number;
  selectedTripIds: readonly TripId[]; selectedTripCount: number;
  expense: Readonly<{ amountPayableCents: bigint; couponDiscountCents: bigint; amountPaidCents: bigint }>;
  fuelConsumption: AggregateMetric; fuelCost: AggregateMetric;
  recordCoverage: Readonly<{ availability: "available"; distanceTenths: bigint; firstId: string; lastId: string }>
    | Readonly<{ availability: "unavailable"; reason: "insufficient-records" | "odometer-anomaly-in-record-span"; relatedRecordIds: readonly string[] }>;
  trendPoints: readonly TrendPoint[];
  reviewSummary: Readonly<{
    recordWarnings: ReadonlyMap<string, readonly string[]>;
    odometerIssues: readonly OdometerIssue[];
    externalRecordIds: readonly string[];
  }>;
}>;

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function ratio(numerator: bigint, denominator = 1n): ExactRatio {
  if (numerator < 0n || denominator <= 0n) throw new Error("统计比值必须非负且分母为正。");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function add(left: ExactRatio, right: ExactRatio): ExactRatio {
  const divisor = gcd(left.denominator, right.denominator);
  const numerator = left.numerator * (right.denominator / divisor) + right.numerator * (left.denominator / divisor);
  // 两项已约分，和的新公因子只能来自两个分母原有的公因子。
  const reduction = gcd(numerator, divisor);
  return { numerator: numerator / reduction, denominator: (left.denominator / divisor) * (right.denominator / reduction) };
}
function multiply(value: ExactRatio, numerator: bigint, denominator = 1n): ExactRatio {
  const factor = ratio(numerator, denominator);
  const crossLeft = gcd(value.numerator, factor.denominator);
  const crossRight = gcd(factor.numerator, value.denominator);
  return { numerator: (value.numerator / crossLeft) * (factor.numerator / crossRight),
    denominator: (value.denominator / crossRight) * (factor.denominator / crossLeft) };
}
/** 平衡合并避免每一项都与不断增大的精确分母相加。 */
function sum(values: readonly ExactRatio[]): ExactRatio {
  if (values.length === 0) return ratio(0n);
  let level = [...values];
  while (level.length > 1) {
    const next: ExactRatio[] = [];
    for (let index = 0; index < level.length; index += 2)
      next.push(index + 1 < level.length ? add(level[index], level[index + 1]) : level[index]);
    level = next;
  }
  return level[0];
}

export function formatStatisticsValue(value: bigint | ExactRatio, kind: "amount"): string;
export function formatStatisticsValue(value: bigint, kind: "distance"): string;
export function formatStatisticsValue(value: ExactRatio, kind: "fuelConsumption" | "costPerKilometre"): string;
export function formatStatisticsValue(value: bigint | ExactRatio, kind: "fuelConsumption" | "costPerKilometre" | "distance" | "amount"): string {
  const digits = kind === "distance" ? 1 : kind === "costPerKilometre" ? 3 : 2;
  const input = typeof value === "bigint" ? ratio(value) : ratio(value.numerator, value.denominator);
  const divisor = kind === "amount" ? 100n : kind === "distance" ? 10n : 1n;
  const denominator = input.denominator * divisor;
  const scaled = input.numerator * 10n ** BigInt(digits);
  const rounded = scaled / denominator + (2n * (scaled % denominator) >= denominator ? 1n : 0n);
  const text = rounded.toString().padStart(digits + 1, "0");
  return `${text.slice(0, -digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${text.slice(-digits)}`;
}

export function calculateRefuelingHistory(records: readonly SavedRefuelingRecord[]): RefuelingStatisticsHistory {
  const ids = new Set<string>();
  for (const record of records) {
    if (!isValidRefuelingRecord(record) || typeof record.id !== "string" || ids.has(record.id))
      throw new Error("统计记录格式无效，不能跳过损坏记录计算。");
    ids.add(record.id);
  }
  const orderedRecords = records.map(record => ({ ...record })).sort(compareRefuelingRecords);
  const canonicalTimes = orderedRecords.map(record => normalizeOccurredAtLocal(record.occurredAtLocal));
  const quantityPrefix = [0n];
  const paidPrefix = [0n];
  const issuePrefix = [0];
  const odometerIssues: OdometerIssue[] = [];
  for (let index = 0; index < orderedRecords.length; index++) {
    const record = orderedRecords[index];
    quantityPrefix.push(quantityPrefix[index] + BigInt(record.fuelVolumeMillilitres));
    paidPrefix.push(paidPrefix[index] + BigInt(record.amountPaidCents));
    if (index > 0) {
      const conflict = inspectOdometerRelationship(orderedRecords[index - 1], record);
      if (conflict !== null) odometerIssues.push({
        startRecordId: orderedRecords[index - 1].id, endRecordId: record.id,
        startIndex: index - 1, endIndex: index, deltaTenths: conflict.deltaTenths,
      });
      issuePrefix.push(odometerIssues.length);
    }
  }
  const sources = new Map<string, ConsumptionSource>();
  const candidates: ConsumptionSource[][] = Array.from({ length: Math.max(0, records.length - 1) }, () => []);
  for (const method of ["full-tank", "low-fuel-light"] as const) {
    let previousAnchor: number | null = null;
    for (let index = 0; index < orderedRecords.length; index++) {
      if (!(method === "full-tank" ? orderedRecords[index].fullTank : orderedRecords[index].lowFuelLight === true)) continue;
      if (previousAnchor !== null) {
        const start = previousAnchor;
        const issues = odometerIssues.slice(issuePrefix[start], issuePrefix[index]);
        const source: ConsumptionSource = {
          id: JSON.stringify([method, orderedRecords[start].id, orderedRecords[index].id]),
          method, kind: index === start + 1 ? "single" : "stage-reference",
          startRecordId: orderedRecords[start].id, endRecordId: orderedRecords[index].id, startIndex: start, endIndex: index,
          startAtLocal: canonicalTimes[start], endAtLocal: canonicalTimes[index],
          elapsedMilliseconds: Date.parse(`${canonicalTimes[index]}+08:00`) - Date.parse(`${canonicalTimes[start]}+08:00`),
          distanceTenths: BigInt(orderedRecords[index].odometerTenths) - BigInt(orderedRecords[start].odometerTenths),
          fuelVolumeMillilitres: method === "full-tank"
            ? quantityPrefix[index + 1] - quantityPrefix[start + 1] : quantityPrefix[index] - quantityPrefix[start],
          validity: issues.length ? { state: "blocked", issues } : { state: "valid" },
        };
        sources.set(source.id, source);
        for (let edge = start; edge < index; edge++) candidates[edge].push(source);
      }
      previousAnchor = index;
    }
  }
  const trips: StatisticsTrip[] = [];
  for (let start = 0; start + 1 < orderedRecords.length; start++) {
    const end = start + 1;
    const distanceTenths = BigInt(orderedRecords[end].odometerTenths) - BigInt(orderedRecords[start].odometerTenths);
    const blocked = candidates[start].filter(source => source.validity.state === "blocked");
    const valid = candidates[start].filter(source => source.validity.state === "valid").sort((a, b) =>
      Number(a.kind !== "single") - Number(b.kind !== "single")
      || (a.kind === "single" ? 0 : a.elapsedMilliseconds - b.elapsedMilliseconds)
      || Number(a.method !== "full-tank") - Number(b.method !== "full-tank"));
    let consumption: ConsumptionResult;
    if (distanceTenths <= 0n || valid.length === 0) {
      consumption = {
        state: distanceTenths <= 0n || blocked.length > 0 ? "review" : "pending",
        reason: distanceTenths <= 0n ? "non-increasing-odometer" : blocked.length > 0 ? "source-crosses-odometer-anomaly" : "no-completed-source",
        relatedRecordIds: [...new Set([orderedRecords[start].id, orderedRecords[end].id, ...blocked.flatMap(source => [source.startRecordId, source.endRecordId])])],
        blockedSourceIds: blocked.map(source => source.id),
      };
    } else {
      const source = valid[0];
      const litresPer100Km = ratio(source.fuelVolumeMillilitres, source.distanceTenths);
      consumption = { state: "valid", sourceId: source.id, method: source.method, kind: source.kind,
        litresPer100Km, consumedMillilitres: multiply(litresPer100Km, distanceTenths) };
    }
    trips.push({
      id: [orderedRecords[start].id, orderedRecords[end].id], edgeIndex: start,
      startRecordId: orderedRecords[start].id, endRecordId: orderedRecords[end].id,
      startIndex: start, endIndex: end, endAtLocal: canonicalTimes[end], distanceTenths, consumption,
      cost: consumption.state === "valid"
        ? allocatePrice(orderedRecords, quantityPrefix, paidPrefix, start, consumption.consumedMillilitres, distanceTenths)
        : consumption,
    });
  }
  return { orderedRecords, sources, trips, odometerIssues, quantityPrefix, paidPrefix, recordWarnings: recordWarnings(orderedRecords) };
}

function allocatePrice(records: readonly SavedRefuelingRecord[], quantities: readonly bigint[], payments: readonly bigint[], start: number, required: ExactRatio, distance: bigint): TripCostResult {
  const available = quantities[start + 1];
  if (available * required.denominator < required.numerator) return {
    state: "pending", reason: "insufficient-price-history", relatedRecordIds: [records[0].id, records[start].id], blockedSourceIds: [],
    requiredMillilitres: required, availableMillilitres: available,
    missingMillilitres: ratio(required.numerator - available * required.denominator, required.denominator),
  };
  // 最大的 j 使 [j,start] 足够；等于整批时不多带一个零量来源。
  let low = 0;
  let high = start;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((available - quantities[middle]) * required.denominator >= required.numerator) low = middle;
    else high = middle - 1;
  }
  const oldest = low;
  const fullBatchQuantity = available - quantities[oldest + 1];
  const oldestUsedMillilitres = ratio(required.numerator - fullBatchQuantity * required.denominator, required.denominator);
  const allocatedCostCents = add(ratio(payments[start + 1] - payments[oldest + 1]),
    multiply(oldestUsedMillilitres, BigInt(records[oldest].amountPaidCents), BigInt(records[oldest].fuelVolumeMillilitres)));
  return { state: "valid", allocatedCostCents, yuanPerKilometre: multiply(allocatedCostCents, 1n, 10n * distance),
    allocation: { newestRecordIndex: start, oldestRecordIndex: oldest, oldestUsedMillilitres } };
}

export function describeTripPriceAllocation(history: RefuelingStatisticsHistory, tripId: TripId): readonly Readonly<{
  recordId: string; occurredAtLocal: string; usedMillilitres: ExactRatio; allocatedCostCents: ExactRatio;
}>[] {
  const trip = history.trips.find(trip => trip.id[0] === tripId[0] && trip.id[1] === tripId[1]);
  if (trip === undefined) throw new Error("行程不属于当前统计快照。");
  if (trip.cost.state !== "valid") return [];
  const allocation = trip.cost.allocation;
  const details = [];
  for (let index = allocation.newestRecordIndex; index >= allocation.oldestRecordIndex; index--) {
    const record = history.orderedRecords[index];
    const usedMillilitres = index === allocation.oldestRecordIndex ? allocation.oldestUsedMillilitres : ratio(BigInt(record.fuelVolumeMillilitres));
    details.push({ recordId: record.id, occurredAtLocal: normalizeOccurredAtLocal(record.occurredAtLocal), usedMillilitres,
      allocatedCostCents: multiply(usedMillilitres, BigInt(record.amountPaidCents), BigInt(record.fuelVolumeMillilitres)) });
  }
  return details;
}

function matchesPeriod(time: string, period: StatisticsPeriod): boolean {
  return period.kind === "total" || Number(time.slice(0, 4)) === period.year
    && (period.kind === "yearly" || Number(time.slice(5, 7)) === period.month);
}
function aggregate(history: RefuelingStatisticsHistory, trips: readonly StatisticsTrip[], cost: boolean, recordCount: number): AggregateMetric {
  let distance = 0n;
  let validTripCount = 0;
  let pendingTripCount = 0;
  let reviewTripCount = 0;
  const basisCounts = { fullTank: 0, lowFuelLight: 0, single: 0, stageReference: 0 };
  const reasons = new Map<StatisticsReason, { count: number; tripIds: TripId[]; relatedRecordIds: Set<string> }>();
  const quantitiesBySource = new Map<string, bigint>();
  const costs: ExactRatio[] = [];
  for (const trip of trips) {
    const result = cost ? trip.cost : trip.consumption;
    if (result.state === "valid" && trip.consumption.state === "valid") {
      validTripCount++;
      distance += trip.distanceTenths;
      basisCounts[trip.consumption.method === "full-tank" ? "fullTank" : "lowFuelLight"]++;
      basisCounts[trip.consumption.kind === "single" ? "single" : "stageReference"]++;
      if (cost && trip.cost.state === "valid") costs.push(trip.cost.allocatedCostCents);
      else quantitiesBySource.set(trip.consumption.sourceId, (quantitiesBySource.get(trip.consumption.sourceId) ?? 0n) + trip.distanceTenths);
    } else if (result.state !== "valid") {
      if (result.state === "pending") pendingTripCount++;
      else reviewTripCount++;
      const reason = reasons.get(result.reason) ?? { count: 0, tripIds: [], relatedRecordIds: new Set<string>() };
      reason.count++;
      reason.tripIds.push(trip.id);
      result.relatedRecordIds.forEach(id => reason.relatedRecordIds.add(id));
      reasons.set(result.reason, reason);
    }
  }
  if (trips.length === 0) reasons.set(recordCount === 0 ? "no-records" : "no-ended-trip", { count: 0, tripIds: [], relatedRecordIds: new Set() });
  const common = {
    coverage: (validTripCount === 0 ? "none" : validTripCount === trips.length ? "complete" : "partial") as AggregateMetric["coverage"],
    coveredDistanceTenths: distance, validTripCount, pendingTripCount, reviewTripCount, basisCounts,
    reasons: [...reasons].map(([reason, value]) => ({ reason, ...value, relatedRecordIds: [...value.relatedRecordIds] })),
  };
  if (validTripCount === 0) return { ...common, availability: "unavailable" };
  const values = cost ? costs : [...quantitiesBySource].map(([id, selectedDistance]) => {
    const source = history.sources.get(id)!;
    return multiply(ratio(source.fuelVolumeMillilitres, source.distanceTenths), selectedDistance);
  });
  return { ...common, availability: "available", value: multiply(sum(values), 1n, cost ? 10n * distance : distance) };
}

export function projectRefuelingStatistics(history: RefuelingStatisticsHistory, period: StatisticsPeriod): StatisticsPeriodResult {
  if (period.kind !== "total" && (!Number.isInteger(period.year) || period.year < 0 || period.year > 9999
    || period.kind === "monthly" && (!Number.isInteger(period.month) || period.month < 1 || period.month > 12)))
    throw new Error("统计期间无效。");
  const selectedRecords = history.orderedRecords.filter(record => matchesPeriod(record.occurredAtLocal, period));
  const selectedIds = new Set(selectedRecords.map(record => record.id));
  const trips = history.trips.filter(trip => matchesPeriod(trip.endAtLocal, period));
  const expense = { amountPayableCents: 0n, couponDiscountCents: 0n, amountPaidCents: 0n };
  for (const record of selectedRecords) {
    expense.amountPayableCents += BigInt(record.amountPayableCents);
    expense.couponDiscountCents += BigInt(record.couponDiscountCents);
    expense.amountPaidCents += BigInt(record.amountPaidCents);
  }
  let recordCoverage: StatisticsPeriodResult["recordCoverage"];
  if (selectedRecords.length < 2) recordCoverage = { availability: "unavailable", reason: "insufficient-records", relatedRecordIds: [] };
  else {
    const first = history.orderedRecords.findIndex(record => record.id === selectedRecords[0].id);
    const last = first + selectedRecords.length - 1;
    const issues = history.odometerIssues.filter(issue => issue.startIndex >= first && issue.endIndex <= last);
    recordCoverage = issues.length > 0
      ? { availability: "unavailable", reason: "odometer-anomaly-in-record-span", relatedRecordIds: [...new Set(issues.flatMap(issue => [issue.startRecordId, issue.endRecordId]))] }
      : { availability: "available", distanceTenths: BigInt(selectedRecords.at(-1)!.odometerTenths) - BigInt(selectedRecords[0].odometerTenths), firstId: selectedRecords[0].id, lastId: selectedRecords.at(-1)!.id };
  }
  const relevantIssues = new Set<number>();
  const blockedSourceIds = new Set<string>();
  for (const trip of trips) {
    if (trip.distanceTenths <= 0n) relevantIssues.add(trip.edgeIndex);
    if (trip.consumption.state !== "valid") trip.consumption.blockedSourceIds.forEach(id => blockedSourceIds.add(id));
  }
  for (const id of blockedSourceIds) {
    const source = history.sources.get(id)!;
    if (source.validity.state === "blocked") source.validity.issues.forEach(issue => relevantIssues.add(issue.startIndex));
  }
  const issues = history.odometerIssues.filter(issue => relevantIssues.has(issue.startIndex));
  return {
    period: { ...period }, selectedRecordIds: [...selectedIds], selectedRecordCount: selectedRecords.length,
    selectedTripIds: trips.map(trip => trip.id), selectedTripCount: trips.length, expense,
    fuelConsumption: aggregate(history, trips, false, selectedRecords.length), fuelCost: aggregate(history, trips, true, selectedRecords.length), recordCoverage,
    trendPoints: trips.map(trip => ({ tripId: trip.id, edgeIndex: trip.edgeIndex, endAtLocal: trip.endAtLocal,
      xTimestampMs: Date.parse(`${trip.endAtLocal}+08:00`), consumption: trip.consumption })),
    reviewSummary: {
      recordWarnings: new Map(selectedRecords.filter(record => (history.recordWarnings.get(record.id)?.length ?? 0) > 0).map(record => [record.id, history.recordWarnings.get(record.id)!])),
      odometerIssues: issues,
      externalRecordIds: [...new Set(issues.flatMap(issue => [issue.startRecordId, issue.endRecordId]).filter(id => !selectedIds.has(id)))],
    },
  };
}
