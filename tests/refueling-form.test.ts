import { describe, expect, it } from "vitest";
import {
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
