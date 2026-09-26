import Decimal from "decimal.js";

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const numberFields = {
  odometerTenths: {
    label: "总里程",
    unit: "公里",
    decimals: 1,
    positive: false,
  },
  fuelVolumeMillilitres: {
    label: "加油量",
    unit: "升",
    decimals: 3,
    positive: true,
  },
  unitPriceTenThousandths: {
    label: "原始单价",
    unit: "元/升",
    decimals: 4,
    positive: true,
  },
  amountPayableCents: {
    label: "应付金额",
    unit: "元",
    decimals: 2,
    positive: true,
  },
  couponDiscountCents: {
    label: "优惠券抵扣",
    unit: "元",
    decimals: 2,
    positive: false,
  },
  amountPaidCents: {
    label: "订单实付",
    unit: "元",
    decimals: 2,
    positive: false,
  },
  invoiceableAmountCents: {
    label: "可开票金额",
    unit: "元",
    decimals: 2,
    positive: false,
  },
} as const;

export type NumberField = keyof typeof numberFields;
export type RefuelingRecord = Record<
  Exclude<NumberField, "invoiceableAmountCents">,
  number
> & {
  invoiceableAmountCents: number | null;
  occurredAtLocal: string;
  fullTank: boolean;
  lowFuelLight: boolean | null;
  stationName: string;
  fuelGrade: string;
  orderNumber: string;
};
export type SavedRefuelingRecord = RefuelingRecord & { id: string };
export type FormValues = Record<NumberField, string> & {
  occurredAtLocal: string;
  fullTank: "" | "yes" | "no";
  lowFuelLight: "" | "yes" | "no";
  stationName: string;
  fuelGrade: string;
  orderNumber: string;
};
export type FormField = keyof FormValues;
export type RefuelingDraft = {
  values: FormValues;
  sources: Partial<
    Record<FormField, "manual" | "calculated" | "record" | "default">
  >;
};

export function shanghaiDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19);
}

export function validDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return false;
  const canonical = value.length === 16 ? `${value}:00` : value;
  const date = new Date(`${canonical}+08:00`);
  return (
    Number.isFinite(date.getTime()) && shanghaiDateTime(date) === canonical
  );
}

export function unscale(value: number, decimals: number): string {
  return new Money(value).div(new Money(10).pow(decimals)).toString();
}

export function formatPaidAmount(cents: number): string {
  return `¥${new Money(cents).div(100).toFixed(2)}`;
}

export function createDraft(
  record?: RefuelingRecord,
  now = new Date(),
): RefuelingDraft {
  const values: FormValues = {
    occurredAtLocal: record?.occurredAtLocal ?? shanghaiDateTime(now),
    odometerTenths: "",
    fuelVolumeMillilitres: "",
    unitPriceTenThousandths: "",
    amountPayableCents: "",
    couponDiscountCents: "0",
    amountPaidCents: "",
    invoiceableAmountCents: "",
    fullTank: record ? (record.fullTank ? "yes" : "no") : "",
    lowFuelLight:
      record?.lowFuelLight == null ? "" : record.lowFuelLight ? "yes" : "no",
    stationName: record?.stationName ?? "",
    fuelGrade: record?.fuelGrade ?? "",
    orderNumber: record?.orderNumber ?? "",
  };
  const sources: RefuelingDraft["sources"] = {
    occurredAtLocal: "default",
    couponDiscountCents: "default",
  };
  if (record) {
    for (const key of Object.keys(numberFields) as NumberField[]) {
      const value = record[key];
      values[key] =
        value == null ? "" : unscale(value, numberFields[key].decimals);
    }
    for (const key of Object.keys(values) as FormField[])
      sources[key] = "record";
  }
  return { values, sources };
}

export function parseQuantity(
  field: NumberField,
  value: string,
): number | null {
  const rule = numberFields[field];
  if (
    value.length > 32 ||
    !new RegExp(`^\\d+(?:\\.\\d{1,${rule.decimals}})?$`).test(value)
  )
    return null;
  const scaled = new Money(value)
    .mul(new Money(10).pow(rule.decimals))
    .toNumber();
  if (
    !Number.isSafeInteger(scaled) ||
    (rule.positive ? scaled <= 0 : scaled < 0)
  )
    return null;
  return scaled;
}

export function updateDraft(
  draft: RefuelingDraft,
  field: FormField,
  value: string,
): RefuelingDraft {
  const next = {
    values: { ...draft.values, [field]: value },
    sources: { ...draft.sources, [field]: "manual" as const },
  };
  const quantity = (key: NumberField) =>
    parseQuantity(key, next.values[key]) === null
      ? null
      : new Money(next.values[key]);
  const derive = (key: NumberField, value: Decimal | null) => {
    const source = next.sources[key];
    if (source && source !== "calculated") return;
    next.values[key] =
      value === null
        ? ""
        : value.toDecimalPlaces(numberFields[key].decimals).toFixed();
    next.sources[key] = "calculated";
  };
  const price = quantity("unitPriceTenThousandths");
  const volume = quantity("fuelVolumeMillilitres");
  const payable = quantity("amountPayableCents");
  // Calculate only the dependent value, never use a previous derived value to infer its own inputs.
  if (
    !next.sources.amountPayableCents ||
    next.sources.amountPayableCents === "calculated"
  ) {
    derive("amountPayableCents", price && volume ? price.mul(volume) : null);
  } else if (
    !next.sources.fuelVolumeMillilitres ||
    next.sources.fuelVolumeMillilitres === "calculated"
  ) {
    derive(
      "fuelVolumeMillilitres",
      payable && price ? payable.div(price) : null,
    );
  } else if (
    !next.sources.unitPriceTenThousandths ||
    next.sources.unitPriceTenThousandths === "calculated"
  ) {
    derive(
      "unitPriceTenThousandths",
      payable && volume ? payable.div(volume) : null,
    );
  }
  const updatedPayable = quantity("amountPayableCents");
  const coupon = quantity("couponDiscountCents");
  derive(
    "amountPaidCents",
    updatedPayable && coupon ? updatedPayable.minus(coupon) : null,
  );
  return next;
}

export function validateDraft(draft: RefuelingDraft): {
  record: RefuelingRecord | null;
  errors: Partial<Record<FormField, string>>;
  warnings: string[];
} {
  const errors: Partial<Record<FormField, string>> = {};
  const numeric = {} as Record<NumberField, number | null>;
  for (const field of Object.keys(numberFields) as NumberField[]) {
    const rule = numberFields[field];
    const value = draft.values[field];
    numeric[field] = parseQuantity(field, value);
    if (field === "invoiceableAmountCents" && value === "") continue;
    if (numeric[field] === null)
      errors[field] =
        `请填写${rule.positive ? "大于 0" : "不小于 0"}的数值，最多 ${rule.decimals} 位小数，并在安全数值范围内。`;
  }
  if (!validDateTime(draft.values.occurredAtLocal))
    errors.occurredAtLocal = "请填写有效的北京时间。";
  if (!["yes", "no"].includes(draft.values.fullTank))
    errors.fullTank = "请选择加满或没加满。";
  if (!["", "yes", "no"].includes(draft.values.lowFuelLight))
    errors.lowFuelLight = "请选择有效的油灯状态。";
  for (const [field, length] of [
    ["stationName", 100],
    ["fuelGrade", 80],
    ["orderNumber", 128],
  ] as const) {
    if ([...draft.values[field]].length > length)
      errors[field] = `最多 ${length} 个字符。`;
  }
  if (Object.keys(errors).length) return { record: null, errors, warnings: [] };
  const record: RefuelingRecord = {
    ...(numeric as Omit<
      RefuelingRecord,
      | "occurredAtLocal"
      | "fullTank"
      | "lowFuelLight"
      | "stationName"
      | "fuelGrade"
      | "orderNumber"
    >),
    occurredAtLocal:
      draft.values.occurredAtLocal.length === 16
        ? `${draft.values.occurredAtLocal}:00`
        : draft.values.occurredAtLocal,
    fullTank: draft.values.fullTank === "yes",
    lowFuelLight:
      draft.values.lowFuelLight === ""
        ? null
        : draft.values.lowFuelLight === "yes",
    stationName: draft.values.stationName,
    fuelGrade: draft.values.fuelGrade,
    orderNumber: draft.values.orderNumber,
  };
  return { record, errors, warnings: amountWarnings(record) };
}

export function amountWarnings(record: RefuelingRecord): string[] {
  const warnings: string[] = [];
  const calculated = new Money(record.unitPriceTenThousandths)
    .mul(record.fuelVolumeMillilitres)
    .div(100000)
    .toDecimalPlaces(0);
  const payableDifference = calculated.minus(record.amountPayableCents);
  const paidDifference = new Money(record.amountPayableCents)
    .minus(record.couponDiscountCents)
    .minus(record.amountPaidCents);
  if (payableDifference.abs().gt(1))
    warnings.push(
      `单价 × 加油量与应付相差 ${payableDifference.abs().div(100).toFixed(2)} 元，请核对账单。`,
    );
  if (paidDifference.abs().gt(1))
    warnings.push(
      `应付 − 优惠与实付相差 ${paidDifference.abs().div(100).toFixed(2)} 元，请核对账单。`,
    );
  return warnings;
}

export function changedFields(
  before: RefuelingRecord,
  after: RefuelingRecord,
): Partial<RefuelingRecord> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => before[key as keyof RefuelingRecord] !== value,
    ),
  );
}

export function recordWarnings(
  records: SavedRefuelingRecord[],
): Map<string, string[]> {
  const ordered = [...records].sort(
    (a, b) =>
      a.occurredAtLocal.localeCompare(b.occurredAtLocal) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return new Map(
    ordered.map((record, index) => {
      const warnings = amountWarnings(record);
      if (
        index > 0 &&
        record.odometerTenths <= ordered[index - 1].odometerTenths
      )
        warnings.push("总里程没有递增，请核对相邻记录。");
      return [record.id, warnings];
    }),
  );
}
