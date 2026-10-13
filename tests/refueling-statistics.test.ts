import { describe, expect, it } from "vitest";
import { calculateRefuelingHistory, projectRefuelingStatistics, formatStatisticsValue, describeTripPriceAllocation, type AggregateMetric, type ExactRatio } from "../src/domain/refueling/statistics";
import type { SavedRefuelingRecord } from "../src/domain/refueling/form";

// 输入逐字段取自已批准 C00–C16 原始合成表；下方期望独立取自 CASES 人工算例。
function r(id: string, occurredAtLocal: string, odometerTenths: number, fuelVolumeMillilitres: number,
  unitPriceTenThousandths: number, amountPayableCents: number, couponDiscountCents: number,
  amountPaidCents: number, fullTank: boolean, lowFuelLight: boolean | null): SavedRefuelingRecord {
  return { id, occurredAtLocal, odometerTenths, fuelVolumeMillilitres, unitPriceTenThousandths,
    amountPayableCents, couponDiscountCents, amountPaidCents, fullTank, lowFuelLight,
    invoiceableAmountCents: null, stationName: "", fuelGrade: "", orderNumber: "" };
}
const cases: Record<string, SavedRefuelingRecord[]> = {
  C00_empty: [
  ],
  C01_single: [
    r("A", "2026-03-01T08:00:00", 10000, 20000, 60000, 12000, 2000, 10000, true, null),
  ],
  C02_full: [
    r("A", "2026-03-01T08:00:00", 10000, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 11000, 10000, 60000, 6000, 0, 6000, true, null),
    r("C", "2026-03-03T08:00:00", 19000, 40000, 70000, 28000, 0, 28000, true, null),
  ],
  C03_partial: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
  ],
  C04_light: [
    r("A", "2026-03-01T08:00:00", 10000, 20000, 50000, 10000, 0, 10000, false, true),
    r("B", "2026-03-02T08:00:00", 12000, 15000, 60000, 9000, 0, 9000, false, null),
    r("C", "2026-03-03T08:00:00", 15000, 40000, 70000, 28000, 0, 28000, false, true),
  ],
  C05_nested_single: [
    r("A", "2026-10-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, false),
    r("B", "2026-10-02T08:00:00", 1000, 10000, 60000, 6000, 0, 6000, false, true),
    r("C", "2026-10-03T08:00:00", 2000, 20000, 70000, 14000, 0, 14000, false, true),
    r("D", "2026-10-05T08:00:00", 3000, 30000, 80000, 24000, 0, 24000, true, false),
  ],
  C06_equal_span: [
    r("A", "2026-10-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, false),
    r("B", "2026-10-02T08:00:00", 1000, 10000, 60000, 6000, 0, 6000, false, true),
    r("C", "2026-10-05T08:00:00", 3000, 20000, 70000, 14000, 0, 14000, true, false),
    r("D", "2026-10-06T08:00:00", 5000, 40000, 80000, 32000, 0, 32000, false, true),
  ],
  C06_short_light: [
    r("A", "2026-10-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, false),
    r("B", "2026-10-02T08:00:00", 1000, 10000, 60000, 6000, 0, 6000, false, true),
    r("C", "2026-10-05T08:00:00", 3000, 20000, 70000, 14000, 0, 14000, true, false),
    r("D", "2026-10-05T20:00:00", 5000, 40000, 80000, 32000, 0, 32000, false, true),
  ],
  C07_cross_year: [
    r("A", "2025-12-20T08:00:00", 10000, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2025-12-31T23:30:00", 13000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-01-01T00:30:00", 19000, 40000, 70000, 28000, 0, 28000, true, null),
  ],
  C08_short_history: [
    r("A", "2026-01-31T08:00:00", 10000, 5000, 50000, 2500, 0, 2500, true, null),
    r("B", "2026-02-01T08:00:00", 11000, 10000, 60000, 6000, 0, 6000, true, null),
    r("C", "2026-02-02T08:00:00", 12000, 5000, 70000, 3500, 0, 3500, true, null),
  ],
  C08_history_added: [
    r("P", "2026-01-30T08:00:00", 9000, 5000, 40000, 2000, 0, 2000, false, null),
    r("A", "2026-01-31T08:00:00", 10000, 5000, 50000, 2500, 0, 2500, true, null),
    r("B", "2026-02-01T08:00:00", 11000, 10000, 60000, 6000, 0, 6000, true, null),
    r("C", "2026-02-02T08:00:00", 12000, 5000, 70000, 3500, 0, 3500, true, null),
  ],
  C09_rollback: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 2500, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
    r("E", "2026-03-06T08:00:00", 11000, 10000, 90000, 9000, 0, 9000, true, null),
  ],
  C09_equal: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 3000, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
    r("E", "2026-03-06T08:00:00", 11000, 10000, 90000, 9000, 0, 9000, true, null),
  ],
  C09_corrected: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
    r("E", "2026-03-06T08:00:00", 11000, 10000, 90000, 9000, 0, 9000, true, null),
  ],
  C09_independent_light: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 1000, 10000, 60000, 6000, 0, 6000, false, true),
    r("C", "2026-03-03T08:00:00", 2000, 10000, 70000, 7000, 0, 7000, false, true),
    r("D", "2026-03-04T08:00:00", 1500, 20000, 80000, 16000, 0, 16000, false, null),
    r("E", "2026-03-05T08:00:00", 4000, 20000, 90000, 18000, 0, 18000, true, null),
  ],
  C10_same_time: [
    r("z", "2026-04-01T08:00:00", 2000, 20000, 70000, 14000, 0, 14000, true, null),
    r("b", "2026-04-01T08:00", 1000, 10000, 60000, 6000, 0, 6000, true, null),
    r("a", "2026-04-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
  ],
  C11_zero_paid: [
    r("A", "2026-03-01T08:00:00", 0, 20000, 50000, 10000, 10000, 0, true, null),
    r("B", "2026-03-02T08:00:00", 2000, 10000, 60000, 6000, 0, 6000, true, null),
  ],
  C11_amount_warning: [
    r("A", "2026-03-01T08:00:00", 0, 20000, 50000, 10000, 0, 0, true, null),
    r("B", "2026-03-02T08:00:00", 2000, 10000, 60000, 6000, 0, 6000, true, null),
  ],
  C12_max: [
    r("A", "2026-03-01T08:00:00", 0, 9007199254740991, 9007199254740991, 9007199254740991, 0, 9007199254740991, true, null),
    r("B", "2026-03-02T08:00:00", 9007199254740991, 9007199254740991, 9007199254740991, 9007199254740991, 0, 9007199254740991, true, null),
  ],
  C12_min_quantity: [
    r("A", "2026-03-01T08:00:00", 0, 1, 10000, 9007199254740991, 0, 9007199254740991, true, null),
    r("B", "2026-03-02T08:00:00", 1, 1, 10000, 9007199254740991, 9007199254740991, 0, true, null),
  ],
  C13_half_up: [
    r("A", "2026-03-01T08:00:00", 0, 2000, 50, 1, 0, 1, true, null),
    r("B", "2026-03-02T08:00:00", 10, 1000, 100, 1, 0, 1, true, null),
    r("C", "2026-03-03T08:00:00", 20, 1000, 100, 1, 0, 1, true, null),
  ],
  C14_insert: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("X", "2026-03-02T20:00:00", 4000, 5000, 70000, 3500, 0, 3500, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
  ],
  C14_edit: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 30000, 80000, 24000, 0, 24000, true, null),
  ],
  C14_delete_middle: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
  ],
  C14_delete_end: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
  ],
  C15_external_anomaly: [
    r("A", "2026-01-30T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-01-31T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-02-01T08:00:00", 2500, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-02-28T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
    r("E", "2026-03-01T08:00:00", 11000, 10000, 90000, 9000, 0, 9000, true, null),
  ],
  C04_unknown_light: [
    r("A", "2026-03-01T08:00:00", 10000, 20000, 50000, 10000, 0, 10000, false, true),
    r("B", "2026-03-02T08:00:00", 12000, 15000, 60000, 9000, 0, 9000, false, null),
    r("C", "2026-03-03T08:00:00", 15000, 40000, 70000, 28000, 0, 28000, false, null),
  ],
  C16_both_single: [
    r("A", "2026-03-01T08:00:00", 0, 40000, 50000, 20000, 0, 20000, true, true),
    r("B", "2026-03-02T08:00:00", 1000, 20000, 60000, 12000, 0, 12000, true, true),
  ],
};
const exact = (numerator: bigint, denominator = 1n): ExactRatio => ({ numerator, denominator });
function value(metric: AggregateMetric) {
  expect(metric.availability).toBe("available");
  if (metric.availability !== "available") throw new Error("expected an available metric");
  return metric.value;
}
function total(name: string) { return projectRefuelingStatistics(calculateRefuelingHistory(cases[name]), { kind: "total" }); }

describe("完整历史统计：人工算例 C00–C16", () => {
  it.each([
    ["C02_full", "5.56", "0.289", 9000n, 59000n],
    ["C03_partial", "6.67", "0.394", 9000n, 67500n],
    ["C04_light", "7.00", "0.380", 5000n, 47000n],
    ["C05_nested_single", "16.67", "1.000", 3000n, 69000n],
    ["C06_equal_span", "9.00", "0.530", 5000n, 77000n],
    ["C06_short_light", "8.00", "0.480", 5000n, 77000n],
    ["C07_cross_year", "6.67", "0.356", 9000n, 65000n],
    ["C09_rollback", "5.00", "0.400", 2000n, 76500n],
    ["C09_equal", "5.00", "0.400", 2000n, 76500n],
    ["C09_corrected", "6.36", "0.395", 11000n, 76500n],
    ["C09_independent_light", "10.00", "0.600", 1000n, 72000n],
    ["C10_same_time", "15.00", "0.800", 2000n, 45000n],
    ["C11_zero_paid", "5.00", "0.000", 2000n, 6000n],
    ["C11_amount_warning", "5.00", "0.000", 2000n, 6000n],
    ["C13_half_up", "100.00", "0.008", 20n, 3n],
    ["C14_insert", "7.22", "0.437", 9000n, 71000n],
    ["C14_edit", "7.22", "0.426", 9000n, 71500n],
    ["C14_delete_middle", "5.00", "0.272", 9000n, 57000n],
    ["C16_both_single", "20.00", "1.000", 1000n, 32000n],
  ] as const)("%s：精确累计、独立覆盖与全部支出", (name, consumption, cost, distance, paid) => {
    const result = total(name);
    expect(formatStatisticsValue(value(result.fuelConsumption), "fuelConsumption")).toBe(consumption);
    expect(formatStatisticsValue(value(result.fuelCost), "costPerKilometre")).toBe(cost);
    expect(result.fuelConsumption.coveredDistanceTenths).toBe(distance);
    expect(result.fuelCost.coveredDistanceTenths).toBe(distance);
    expect(result.expense.amountPaidCents).toBe(paid);
    expect(result.selectedTripCount).toBe(cases[name].length - 1);
    expect(result.fuelConsumption.validTripCount + result.fuelConsumption.pendingTripCount + result.fuelConsumption.reviewTripCount).toBe(result.selectedTripCount);
    expect(new Set(result.selectedTripIds.map(id => JSON.stringify(id))).size).toBe(result.selectedTripCount);
  });

  it("C00/C01：空集合支出为零，首笔没有虚构行程", () => {
    const empty = total("C00_empty");
    expect(empty.selectedTripCount).toBe(0);
    expect(empty.expense).toEqual({ amountPayableCents: 0n, couponDiscountCents: 0n, amountPaidCents: 0n });
    expect(empty.fuelConsumption).toMatchObject({ availability: "unavailable", coverage: "none", reasons: [{ reason: "no-records" }] });
    const single = total("C01_single");
    expect(single.expense).toEqual({ amountPayableCents: 12000n, couponDiscountCents: 2000n, amountPaidCents: 10000n });
    expect(single.fuelCost).toMatchObject({ availability: "unavailable", reasons: [{ reason: "no-ended-trip" }] });
    expect(single.recordCoverage).toMatchObject({ availability: "unavailable", reason: "insufficient-records" });
    expect(single.trendPoints).toEqual([]);
  });

  it("C02/C03：加权、分数量、历史批次重复独立使用及按需展开", () => {
    expect(value(total("C02_full").fuelConsumption)).toEqual(exact(50n, 9n));
    expect(value(total("C02_full").fuelCost)).toEqual(exact(13n, 45n));
    const history = calculateRefuelingHistory(cases.C03_partial);
    expect(history.trips[1].consumption).toMatchObject({ state: "valid", consumedMillilitres: exact(40000n, 3n) });
    expect(history.trips[2].consumption).toMatchObject({ state: "valid", consumedMillilitres: exact(80000n, 3n) });
    expect(describeTripPriceAllocation(history, ["B", "C"])).toEqual([
      { recordId: "B", occurredAtLocal: "2026-03-02T08:00:00", usedMillilitres: exact(40000n, 3n), allocatedCostCents: exact(8000n) },
    ]);
    expect(describeTripPriceAllocation(history, ["C", "D"]).map(detail => [detail.recordId, detail.usedMillilitres, detail.allocatedCostCents])).toEqual([
      ["C", exact(15000n), exact(10500n)], ["B", exact(35000n, 3n), exact(7000n)],
    ]);
    expect(value(projectRefuelingStatistics(history, { kind: "total" }).fuelCost)).toEqual(exact(71n, 180n));
  });

  it("C04/C05/C06/C16：亮灯边界、单次优先、真实时间跨度及满箱 tie", () => {
    const light = calculateRefuelingHistory(cases.C04_light);
    expect([...light.sources.values()][0]).toMatchObject({ method: "low-fuel-light", fuelVolumeMillilitres: 35000n, kind: "stage-reference" });
    expect(total("C04_unknown_light").fuelConsumption).toMatchObject({ availability: "unavailable", pendingTripCount: 2, reviewTripCount: 0 });
    expect(calculateRefuelingHistory(cases.C05_nested_single).trips.map(trip => trip.consumption)).toMatchObject([
      { method: "full-tank", kind: "stage-reference" }, { method: "low-fuel-light", kind: "single" }, { method: "full-tank", kind: "stage-reference" },
    ]);
    expect(calculateRefuelingHistory(cases.C06_equal_span).trips[1].consumption).toMatchObject({ method: "full-tank" });
    expect(calculateRefuelingHistory(cases.C06_short_light).trips[1].consumption).toMatchObject({ method: "low-fuel-light" });
    expect(calculateRefuelingHistory(cases.C16_both_single).trips[0].consumption).toMatchObject({ method: "full-tank", kind: "single" });
  });

  it("C07：期后补满补算旧月，终点唯一归属；单条期内记录仍有油耗与费用", () => {
    const before = calculateRefuelingHistory(cases.C07_cross_year.slice(0, 2));
    const history = calculateRefuelingHistory(cases.C07_cross_year);
    const december = { kind: "monthly", year: 2025, month: 12 } as const;
    expect(projectRefuelingStatistics(before, december).fuelConsumption.availability).toBe("unavailable");
    const dec = projectRefuelingStatistics(history, december);
    expect(value(dec.fuelConsumption)).toEqual(exact(20n, 3n));
    expect(value(dec.fuelCost)).toEqual(exact(1n, 3n));
    expect(dec.expense.amountPaidCents).toBe(37000n);
    const jan = projectRefuelingStatistics(history, { kind: "monthly", year: 2026, month: 1 });
    expect(jan.selectedRecordIds).toEqual(["C"]);
    expect(jan.selectedTripIds).toEqual([["B", "C"]]);
    expect(value(jan.fuelCost)).toEqual(exact(11n, 30n));
    expect(jan.fuelCost.coveredDistanceTenths).toBe(6000n);
    expect(jan.recordCoverage).toMatchObject({ reason: "insufficient-records" });
    expect(projectRefuelingStatistics(history, { kind: "yearly", year: 2025 }).selectedTripIds).toEqual(dec.selectedTripIds);
    expect(projectRefuelingStatistics(history, { kind: "monthly", year: 2024, month: 1 }).fuelConsumption.availability).toBe("unavailable");
  });

  it("C08：价格不足排除整段费用，补历史只恢复相应覆盖，整批边界无零量切片", () => {
    const period = { kind: "monthly", year: 2026, month: 2 } as const;
    const before = calculateRefuelingHistory(cases.C08_short_history);
    expect(before.trips[0].cost).toMatchObject({ state: "pending", reason: "insufficient-price-history", missingMillilitres: exact(5000n) });
    const shortfall = before.trips[0].cost;
    if (shortfall.state !== "pending" || shortfall.reason !== "insufficient-price-history") throw new Error("expected price shortfall");
    expect(shortfall.requiredMillilitres).toEqual(exact(10000n));
    expect(shortfall.availableMillilitres).toBe(5000n);
    expect(shortfall.missingMillilitres).toEqual(exact(5000n));
    const result = projectRefuelingStatistics(before, period);
    expect(value(result.fuelConsumption)).toEqual(exact(15n, 2n));
    expect(result.fuelConsumption.coveredDistanceTenths).toBe(2000n);
    expect(result.fuelCost).toMatchObject({ coverage: "partial", coveredDistanceTenths: 1000n, validTripCount: 1, pendingTripCount: 1 });
    const after = calculateRefuelingHistory(cases.C08_history_added);
    expect(value(projectRefuelingStatistics(after, period).fuelCost)).toEqual(exact(3n, 8n));
    expect(describeTripPriceAllocation(after, ["A", "B"]).map(detail => [detail.recordId, detail.usedMillilitres])).toEqual([["A", exact(5000n)], ["P", exact(5000n)]]);
  });

  it("C09/C15：D1 阻断来源但不扩大到共享端点，期外坏边和独立记录覆盖同时保留", () => {
    for (const name of ["C09_rollback", "C09_equal"]) {
      const history = calculateRefuelingHistory(cases[name]);
      expect(history.trips.map(trip => trip.consumption.state)).toEqual(["review", "review", "review", "valid"]);
      expect(history.trips[0].consumption).toMatchObject({ reason: "source-crosses-odometer-anomaly" });
      expect(history.trips[1].consumption).toMatchObject({ reason: "non-increasing-odometer" });
      expect(total(name).recordCoverage).toMatchObject({ reason: "odometer-anomaly-in-record-span" });
    }
    expect(total("C09_corrected").fuelConsumption.reviewTripCount).toBe(0);
    const independent = calculateRefuelingHistory(cases.C09_independent_light);
    expect(independent.trips.map(trip => trip.consumption.state)).toEqual(["review", "valid", "review", "review"]);
    const jan = projectRefuelingStatistics(calculateRefuelingHistory(cases.C15_external_anomaly), { kind: "monthly", year: 2026, month: 1 });
    expect(jan.fuelConsumption).toMatchObject({ availability: "unavailable", reviewTripCount: 1 });
    expect(jan.reviewSummary.externalRecordIds).toEqual(["C"]);
    expect(jan.reviewSummary.recordWarnings.size).toBe(0);
    expect(jan.reviewSummary.odometerIssues).toMatchObject([{ startRecordId: "B", endRecordId: "C", deltaTenths: -500n }]);
    expect(jan.recordCoverage).toEqual({ availability: "available", distanceTenths: 3000n, firstId: "A", lastId: "B" });
    expect(jan.expense.amountPaidCents).toBe(37000n);
  });

  it("C10：规范同时间、设备时区和输入排列不改变来源，不原地排序或改写日期", () => {
    const input = cases.C10_same_time.map(record => Object.freeze({ ...record }));
    const before = structuredClone(input);
    const history = calculateRefuelingHistory(Object.freeze(input));
    expect(history.orderedRecords.map(record => record.id)).toEqual(["a", "b", "z"]);
    expect([...history.sources.values()].every(source => source.elapsedMilliseconds === 0)).toBe(true);
    expect(input).toEqual(before);
    expect(calculateRefuelingHistory([...input].reverse())).toEqual(history);
    expect(projectRefuelingStatistics(history, { kind: "total" }).trendPoints.map(point => point.xTimestampMs)).toEqual([1775001600000, 1775001600000]);
  });

  it("C11：有效零费用与合法金额警告互不排除", () => {
    expect(value(total("C11_amount_warning").fuelCost)).toEqual(exact(0n));
    expect(total("C11_amount_warning").reviewSummary.recordWarnings.size).toBe(1);
    expect(total("C11_zero_paid").expense).toEqual({ amountPayableCents: 16000n, couponDiscountCents: 10000n, amountPaidCents: 6000n });
  });

  it("C12/C13：超过安全整数的金额合计、极小数量和精确 HALF_UP", () => {
    const maximum = total("C12_max");
    expect(formatStatisticsValue(maximum.expense.amountPaidCents, "amount")).toBe("180,143,985,094,819.82");
    expect(formatStatisticsValue(maximum.fuelConsumption.coveredDistanceTenths, "distance")).toBe("900,719,925,474,099.1");
    expect(value(maximum.fuelConsumption)).toEqual(exact(1n));
    expect(value(maximum.fuelCost)).toEqual(exact(1n, 10n));
    expect(formatStatisticsValue(value(total("C12_min_quantity").fuelCost), "costPerKilometre")).toBe("900,719,925,474,099.100");
    const halves = calculateRefuelingHistory(cases.C13_half_up);
    expect(halves.trips[0].cost).toMatchObject({ allocatedCostCents: exact(1n, 2n) });
    expect(formatStatisticsValue(exact(1n, 2n), "amount")).toBe("0.01");
    expect(formatStatisticsValue(exact(3n, 2n), "amount")).toBe("0.02");
    expect(value(total("C13_half_up").fuelCost)).toEqual(exact(3n, 400n));
    // 非终止小数位于半分下方：不能先以固定有效位舍入。
    const scale = 10n ** 60n;
    expect(formatStatisticsValue(exact(scale - 1n, 2n * scale), "amount")).toBe("0.00");
  });

  it("C14：删除闭合终点失去旧来源，同 ID 编辑和移日期重建数量/邻接/期间", () => {
    const pending = total("C14_delete_end");
    expect(pending.fuelConsumption).toMatchObject({ availability: "unavailable", pendingTripCount: 2 });
    expect(pending.fuelCost.coveredDistanceTenths).toBe(0n);
    expect(pending.expense.amountPaidCents).toBe(47500n);
    const original = calculateRefuelingHistory(cases.C03_partial);
    const edited = calculateRefuelingHistory(cases.C14_edit);
    expect([...original.sources.keys()]).toEqual([...edited.sources.keys()]);
    expect([...edited.sources.values()][0].fuelVolumeMillilitres).toBe(65000n);
    const moved = calculateRefuelingHistory(cases.C03_partial.map(record => record.id === "B" ? { ...record, occurredAtLocal: "2026-04-01T08:00:00" } : record));
    expect(moved.trips.map(trip => trip.id)).toEqual([["A", "C"], ["C", "D"], ["D", "B"]]);
    expect(projectRefuelingStatistics(moved, { kind: "monthly", year: 2026, month: 4 }).selectedTripIds).toEqual([["D", "B"]]);
  });

  it("拒绝损坏输入及重复身份，不静默丢行或返回零；二元身份不拼接碰撞", () => {
    for (const invalid of [{ amountPaidCents: -1 }, { fuelVolumeMillilitres: 0 }, { occurredAtLocal: "bad" }])
      expect(() => calculateRefuelingHistory([{ ...cases.C01_single[0], ...invalid }])).toThrow();
    expect(() => calculateRefuelingHistory([cases.C01_single[0], cases.C01_single[0]])).toThrow();
    const records = cases.C02_full.map((record, index) => ({ ...record, id: ["a/b", "c", "b/c"][index] }));
    expect(calculateRefuelingHistory(records).trips.map(trip => trip.id)).toEqual([["a/b", "c"], ["c", "b/c"]]);
  });
});

it("来源用升显示：精确半毫升最终舍入、大数末位和零保持", () => {
  expect(formatStatisticsValue({ numerator: 40000n, denominator: 3n }, "volume")).toBe("13.333");
  expect(formatStatisticsValue({ numerator: 1n, denominator: 2n }, "volume")).toBe("0.001");
  expect(formatStatisticsValue(9007199254740991n, "volume")).toBe("9,007,199,254,740.991");
  expect(formatStatisticsValue(0n, "volume")).toBe("0.000");
});
