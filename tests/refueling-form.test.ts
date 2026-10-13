import { describe, expect, it } from "vitest";
import { syntheticRecord } from "./helpers/sync-fixtures";
import {
  inspectRefuelingSave,
  assertRefuelingSavePrecondition,
  type ReadyRefuelingSave,
  type SavedRefuelingRecord,
  formatPaidAmount,
  amountWarnings,
  changedFields,
  createDraft,
  parseQuantity,
  recordWarnings,
  updateDraft,
  validDateTime,
  validateDraft,
  type FormField,
} from "../src/domain/refueling/form";

function fill(entries: [FormField, string][]) {
  return entries.reduce(
    (draft, [key, value]) => updateDraft(draft, key, value),
    createDraft(undefined, new Date("2026-08-08T06:49:42Z")),
  );
}
const required: [FormField, string][] = [
  ["odometerTenths", "10000"],
  ["fullTank", "yes"],
];

describe("保存确认的规范时间回归", () => {
  it.each(["2026-03-02T08:00", "2026-03-02T08:00:00"])("M20：%s 经真实表单校验不产生时间补丁", (time) => {
    const base = { ...syntheticRecord, occurredAtLocal: time };
    const draft = updateDraft(createDraft(base), "stationName", "SYN edited");
    const submitted = validateDraft(draft).record!;
    expect(submitted.occurredAtLocal).toBe("2026-03-02T08:00:00");
    expect(changedFields(base, submitted)).toEqual({ stationName: "SYN edited" });
    expect(changedFields(base, validateDraft(createDraft(base)).record!)).toEqual({});
    expect(base.occurredAtLocal).toBe(time);
  });

  it("M06：分钟和零秒按真实 ID 排序，数组来序不影响相邻警告", () => {
    const records = [
      { ...syntheticRecord, id: "z", occurredAtLocal: "2026-03-02T08:00:00", odometerTenths: 14000 },
      { ...syntheticRecord, id: "m", occurredAtLocal: "2026-03-02T08:00", odometerTenths: 9000 },
      { ...syntheticRecord, id: "a", occurredAtLocal: "2026-03-02T08:00:00", odometerTenths: 10000 },
    ];
    expect(recordWarnings(records).get("m")).toContain("总里程没有递增，请核对相邻记录。");
    expect(recordWarnings(records).get("a")).not.toContain("总里程没有递增，请核对相邻记录。");
    expect(records.map(record => record.id)).toEqual(["z", "m", "a"]);
  });
});

describe("manual refueling form", () => {
  it("preserves cents when formatting the largest supported amount", () => {
    expect(formatPaidAmount(Number.MAX_SAFE_INTEGER)).toBe("¥90071992547409.91");
    expect(formatPaidAmount(0)).toBe("¥0.00");
  });
  it("keeps the receipt amounts separate and never derives litres from discounted payment", () => {
    const draft = fill([
      ...required,
      ["unitPriceTenThousandths", "7.94"],
      ["fuelVolumeMillilitres", "43"],
      ["couponDiscountCents", "300"],
    ]);
    expect(validateDraft(draft)).toMatchObject({
      errors: {},
      warnings: [],
      record: {
        fuelVolumeMillilitres: 43000,
        unitPriceTenThousandths: 79400,
        amountPayableCents: 34142,
        couponDiscountCents: 30000,
        amountPaidCents: 4142,
        occurredAtLocal: "2026-08-08T14:49:42",
        fullTank: true,
      },
    });
  });
  it.each([
    [
      [
        ["amountPayableCents", "341.42"],
        ["unitPriceTenThousandths", "7.94"],
      ],
      "fuelVolumeMillilitres",
      "43",
    ],
    [
      [
        ["fuelVolumeMillilitres", "43"],
        ["amountPayableCents", "341.42"],
      ],
      "unitPriceTenThousandths",
      "7.94",
    ],
  ] as [[FormField, string][], FormField, string][])(
    "computes the third receipt value from %j",
    (entries, field, expected) => {
      expect(fill(entries).values[field]).toBe(expected);
    },
  );
  it("updates dependent calculations but preserves manually corrected payment", () => {
    let draft = fill([
      ["unitPriceTenThousandths", "7.94"],
      ["fuelVolumeMillilitres", "43"],
      ["amountPaidCents", "40"],
    ]);
    draft = updateDraft(draft, "fuelVolumeMillilitres", "44");
    expect(draft.values.amountPayableCents).toBe("349.36");
    expect(draft.values.amountPaidCents).toBe("40");
    draft = updateDraft(draft, "amountPaidCents", "");
    draft = updateDraft(draft, "couponDiscountCents", "10");
    expect(draft.values.amountPaidCents).toBe("");
  });
  it("clears obsolete calculated results when a prerequisite is cleared", () => {
    const draft = updateDraft(
      fill([
        ["unitPriceTenThousandths", "7.94"],
        ["fuelVolumeMillilitres", "43"],
      ]),
      "unitPriceTenThousandths",
      "",
    );
    expect(draft.values.amountPayableCents).toBe("");
    expect(draft.values.amountPaidCents).toBe("");
    expect(draft.values.fuelVolumeMillilitres).toBe("43");
  });
  it("accepts zero paid and partial fills, and requires an explicit full-tank selection", () => {
    const draft = fill([
      ["odometerTenths", "0"],
      ["unitPriceTenThousandths", "5"],
      ["fuelVolumeMillilitres", "20"],
      ["couponDiscountCents", "100"],
    ]);
    expect(validateDraft(draft).errors.fullTank).toBeTruthy();
    expect(
      validateDraft(updateDraft(draft, "fullTank", "no")).record,
    ).toMatchObject({
      fullTank: false,
      amountPaidCents: 0,
      lowFuelLight: null,
    });
  });
  it("rejects excess precision, negatives, exponents and unsafe scaled integers", () => {
    for (const value of ["1.001", "-1", "1e2", "NaN", "9007199254740992"])
      expect(parseQuantity("amountPaidCents", value)).toBeNull();
    expect(parseQuantity("fuelVolumeMillilitres", "43.001")).toBe(43001);
    expect(parseQuantity("fuelVolumeMillilitres", "0")).toBeNull();
  });
  it("rounds first and only warns when the difference exceeds one cent", () => {
    const record = validateDraft(
      fill([
        ...required,
        ["fuelVolumeMillilitres", "1"],
        ["unitPriceTenThousandths", "1.005"],
      ]),
    ).record!;
    expect(record.amountPayableCents).toBe(101);
    expect(
      amountWarnings({
        ...record,
        amountPayableCents: 100,
        amountPaidCents: 100,
      }),
    ).toEqual([]);
    expect(
      amountWarnings({
        ...record,
        amountPayableCents: 99,
        amountPaidCents: 99,
      }),
    ).toHaveLength(1);
  });
  it("uses Shanghai local time and rejects normalized invalid calendar dates", () => {
    expect(
      createDraft(undefined, new Date("2026-08-31T17:00:00Z")).values
        .occurredAtLocal,
    ).toBe("2026-09-01T01:00:00");
    expect(validDateTime("2026-02-30T12:00")).toBe(false);
    expect(validDateTime("2024-02-29T12:00")).toBe(true);
  });
  it("patches only changed fields and flags mileage anomalies without rejecting valid rows", () => {
    const original = validateDraft(
      fill([
        ...required,
        ["fuelVolumeMillilitres", "43"],
        ["unitPriceTenThousandths", "7.94"],
      ]),
    ).record!;
    expect(
      changedFields(original, { ...original, stationName: "新站" }),
    ).toEqual({ stationName: "新站" });
    expect(
      recordWarnings([
        { ...original, id: "a" },
        { ...original, id: "b", occurredAtLocal: "2026-09-01T12:00:00" },
      ]).get("b"),
    ).toContain("总里程没有递增，请核对相邻记录。");
  });
});

function saveRecord(id: string, occurredAtLocal: string, odometerTenths: number): SavedRefuelingRecord {
  return { id, occurredAtLocal, odometerTenths, fuelVolumeMillilitres: 20000, unitPriceTenThousandths: 60000,
    amountPayableCents: 12000, couponDiscountCents: 0, amountPaidCents: 12000, invoiceableAmountCents: null,
    fullTank: true, lowFuelLight: null, stationName: "", fuelGrade: "", orderNumber: "" };
}
const P = saveRecord("P", "2026-03-01T08:00:00", 10000);
const X = saveRecord("X", "2026-03-02T08:00:00", 12000);
const N = saveRecord("N", "2026-03-03T08:00:00", 14000);
function inspect(records = [P, N], submitted = X, baseline: SavedRefuelingRecord | null = null): ReadyRefuelingSave {
  const result = inspectRefuelingSave({ records, recordId: submitted.id, mode: baseline ? "edit" : "create", baseline, submittedRecord: submitted });
  expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error(result.message);
  return result;
}
function assertCurrent(inspection: ReadyRefuelingSave, records: SavedRefuelingRecord[], id = "X") {
  assertRefuelingSavePrecondition(records, id, inspection.patch, inspection.creating, inspection.precondition);
}

describe("保存二次确认纯判定 M01–M23", () => {
  it("M01/M07：首笔/正常保存不警告，无关位置旧异常不要求确认", () => {
    expect(inspect([]).conflicts).toEqual([]);
    expect(inspect().conflicts).toEqual([]);
    const u = saveRecord("U", "2026-01-01T08:00:00", 9000);
    const v = saveRecord("V", "2026-01-02T08:00:00", 8000);
    expect(inspect([u, v, P, N]).conflicts).toEqual([]);
    expect(recordWarnings([u, v, P, N]).get("V")).toContain("总里程没有递增，请核对相邻记录。");
  });
  it.each([
    [9000, [P, N], [["previous", "backward", -1000n]]],
    [15000, [P, N], [["next", "backward", -1000n]]],
    [15000, [{ ...P, odometerTenths: 16000 }, N], [["previous", "backward", -1000n], ["next", "backward", -1000n]]],
    [10000, [P, N], [["previous", "equal", 0n]]],
    [14000, [P, N], [["next", "equal", 0n]]],
  ] as const)("M02–M04：候选里程 %s 与两侧分别比较", (odometerTenths, records, expected) => {
    const result = inspect([...records], { ...X, odometerTenths });
    expect(result.conflicts.map(conflict => [conflict.position, conflict.kind, conflict.deltaTenths])).toEqual(expected);
  });
  it("M05：编辑排除自身，移位形成的旧位置桥接坏边纳入确认", () => {
    expect(inspect([P, X, N], X, X).conflicts).toEqual([]);
    const moved = { ...X, occurredAtLocal: "2026-03-04T08:00:00", odometerTenths: 15000 };
    const normal = inspect([P, X, N], moved, X);
    expect(normal.conflicts).toEqual([]);
    expect(normal.precondition.previous?.id).toBe("N");
    expect(normal.precondition.next).toBeNull();
    const conflict = inspect([{ ...P, odometerTenths: 16000 }, X, N], { ...moved, odometerTenths: 17000 }, X);
    expect(conflict.conflicts).toMatchObject([{ position: "old-position-bridge", start: { id: "P" }, end: { id: "N" }, deltaTenths: -2000n }]);
  });
  it("M06：同时间分钟秒、逆序输入按真实 ID 插入，新建和编辑一致", () => {
    const a = { ...P, id: "a", occurredAtLocal: X.occurredAtLocal };
    const z = { ...N, id: "z", occurredAtLocal: "2026-03-02T08:00" };
    const m = { ...X, id: "m", odometerTenths: 9000 };
    for (const result of [inspect([z, a], m), inspect([z, m, a], m, m)]) {
      expect(result.precondition.previous?.id).toBe("a");
      expect(result.precondition.next?.id).toBe("z");
      expect(result.conflicts).toMatchObject([{ start: { id: "a" }, end: { id: "m" } }]);
    }
  });
  it("M08：金额差与里程并存；一分容差不变", () => {
    const result = inspect([P, N], { ...X, odometerTenths: 9000, amountPaidCents: 11900 });
    expect(result.conflicts).toHaveLength(1);
    expect(result.amountWarnings).toEqual(["应付 − 优惠与实付相差 1.00 元，请核对账单。"]);
    expect(inspect([P, N], { ...X, amountPaidCents: 11999 }).amountWarnings).toEqual([]);
  });
  it("M10/M16：新旧位置依赖、目标字段、实际 ID/补丁/模式必须完全对应", () => {
    const result = inspect();
    for (const records of [
      [{ ...P, odometerTenths: 9000 }, N], [{ ...P, occurredAtLocal: "2026-03-01T09:00:00" }, N], [N],
      [P, N, saveRecord("near", "2026-03-02T07:00:00", 11000)], [P, X, N],
    ]) expect(() => assertCurrent(result, records)).toThrow("记录或相邻里程已变化");
    expect(() => assertRefuelingSavePrecondition([P, N], "other", result.patch, true, result.precondition)).toThrow();
    expect(() => assertRefuelingSavePrecondition([P, N], "X", { ...result.patch, stationName: "different" }, true, result.precondition)).toThrow();
    expect(() => assertRefuelingSavePrecondition([P, N], "X", result.patch, false, result.precondition)).toThrow();
    const editing = inspect([P, X, N], { ...X, stationName: "edited" }, X);
    expect(() => assertCurrent(editing, [P, { ...X, orderNumber: "sync" }, N])).toThrow();
    const moved = inspect([P, X, N], { ...X, occurredAtLocal: "2026-03-04T08:00:00", odometerTenths: 15000 }, X);
    expect(() => assertCurrent(moved, [{ ...P, odometerTenths: 11000 }, X, N])).toThrow();
  });
  it("M11：无关更新、数组重排、邻项账单字段和时间等价表示不误拒绝", () => {
    const result = inspect();
    expect(() => assertCurrent(result, [{ ...N, occurredAtLocal: "2026-03-03T08:00" }, { ...P, stationName: "sync", amountPaidCents: 0 }, saveRecord("far", "2026-01-01T08:00:00", 0)])).not.toThrow();
  });
  it("M19a：只改站名保留最新里程，以实际候选检查冲突并列出保留字段", () => {
    const result = inspect([P, { ...X, odometerTenths: 9000 }, N], { ...X, stationName: "SYN edited" }, X);
    expect(result.patch).toEqual({ stationName: "SYN edited" });
    expect(result.effectiveRecord.odometerTenths).toBe(9000);
    expect(result.retainedFields).toEqual(["odometerTenths"]);
    expect(result.conflicts).toMatchObject([{ position: "previous", deltaTenths: -1000n }]);
  });
  it("M19b：三份合法记录合并产生 30.00 元软提示，精确优惠/实付补丁不覆盖最新油量", () => {
    const submitted = { ...X, couponDiscountCents: 1000, amountPaidCents: 11000 };
    const current = { ...X, fuelVolumeMillilitres: 25000, amountPayableCents: 15000, amountPaidCents: 15000 };
    for (const record of [X, submitted, current]) expect(validateDraft(createDraft(record))).toMatchObject({ errors: {}, warnings: [] });
    const result = inspect([P, current, N], submitted, X);
    expect(result.patch).toEqual({ couponDiscountCents: 1000, amountPaidCents: 11000 });
    expect(result.effectiveRecord).toMatchObject({ fuelVolumeMillilitres: 25000, amountPayableCents: 15000, couponDiscountCents: 1000, amountPaidCents: 11000 });
    expect(result.amountWarnings).toEqual(["应付 − 优惠与实付相差 30.00 元，请核对账单。"]);
    expect(() => assertCurrent(result, [P, current, N])).not.toThrow();
  });
  it("M21：基线分钟补秒不覆盖同步 09:00，按最终时间判断相邻关系", () => {
    const base = { ...X, occurredAtLocal: "2026-03-02T08:00", stationName: "SYN original" };
    const current = { ...base, occurredAtLocal: "2026-03-02T09:00:00" };
    const previous = { ...P, occurredAtLocal: "2026-03-02T08:30:00", odometerTenths: 11000 };
    const submitted = validateDraft(updateDraft(createDraft(base), "stationName", "SYN edited")).record!;
    const result = inspect([current, previous], { ...submitted, id: "X" }, base);
    expect(result.patch).toEqual({ stationName: "SYN edited" });
    expect(result.effectiveRecord.occurredAtLocal).toBe("2026-03-02T09:00:00");
    expect(result.conflicts).toEqual([]);
    expect(result.retainedFields).toEqual(["occurredAtLocal"]);
    expect(result.precondition.patch).toEqual(result.patch);
  });
  it.each(["2026-03-02T08:01", "2026-03-02T08:00:01"])("M22：真实时间 %s 和其他字段修改全部保留", (time) => {
    const base = { ...X, occurredAtLocal: "2026-03-02T08:00" };
    const current = { ...base, occurredAtLocal: "2026-03-02T09:00:00" };
    const previous = { ...P, occurredAtLocal: "2026-03-02T08:30:00", odometerTenths: 11000 };
    let draft = createDraft(base);
    for (const [field, input] of [["occurredAtLocal", time], ["stationName", "SYN edited"], ["odometerTenths", "1250"], ["amountPaidCents", "119"]] as [FormField, string][]) draft = updateDraft(draft, field, input);
    const submitted = validateDraft(draft).record!;
    const result = inspect([current, previous], { ...submitted, id: "X" }, base);
    expect(result.patch).toEqual({ occurredAtLocal: time.length === 16 ? `${time}:00` : time, stationName: "SYN edited", odometerTenths: 12500, amountPaidCents: 11900 });
    expect(result.conflicts).toMatchObject([{ position: "next", deltaTenths: -1500n }]);
    expect(result.amountWarnings[0]).toContain("1.00");
    expect(() => assertCurrent(result, [current, previous])).not.toThrow();
  });
  it("M15/M23：硬错误、目标损坏、丢失编辑/新增身份冲突均不能确认绕过", () => {
    for (const current of [{ ...X, amountPaidCents: -1 }, { ...X, occurredAtLocal: "invalid" }])
      expect(inspectRefuelingSave({ records: [P, current], recordId: "X", mode: "edit", baseline: X, submittedRecord: { ...X, stationName: "edited" } }).state).toBe("blocked");
    expect(inspectRefuelingSave({ records: [X], recordId: "X", mode: "create", baseline: null, submittedRecord: X }).state).toBe("blocked");
    expect(inspectRefuelingSave({ records: [], recordId: "X", mode: "edit", baseline: X, submittedRecord: X }).state).toBe("blocked");
    expect(inspectRefuelingSave({ records: [P], recordId: "X", mode: "create", baseline: null, submittedRecord: { ...X, odometerTenths: -1 } }).state).toBe("blocked");
  });
});
