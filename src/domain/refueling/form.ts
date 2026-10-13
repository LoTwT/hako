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
export const refuelingRecordFields: ReadonlySet<keyof RefuelingRecord> = new Set([
  ...Object.keys(numberFields) as NumberField[], "occurredAtLocal", "fullTank", "lowFuelLight",
  "stationName", "fuelGrade", "orderNumber",
]);

export type RefuelingSaveIntent = {
  record: RefuelingRecord;
  recordId: string;
  formInstanceKey: number;
};
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

/** 加油时间（北京时间）规范化：分钟精度补秒（16 位 → :00），其余原样。 */
export function normalizeOccurredAtLocal(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

export function validDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return false;
  const canonical = normalizeOccurredAtLocal(value);
  const date = new Date(`${canonical}+08:00`);
  return (
    Number.isFinite(date.getTime()) && shanghaiDateTime(date) === canonical
  );
}

export function unscale(value: number, decimals: number): string {
  return new Money(value).div(new Money(10).pow(decimals)).toString();
}

/** 展示格式：按已确认精度固定位数（金额 2 位、加油量 3 位、单价 4 位、里程 1 位），带千分位。 */
export function formatQuantity(value: number, decimals: number): string {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(new Money(value).div(new Money(10).pow(decimals)).toNumber());
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
    occurredAtLocal: normalizeOccurredAtLocal(draft.values.occurredAtLocal),
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
    [...refuelingRecordFields].filter((key) => key === "occurredAtLocal"
      ? normalizeOccurredAtLocal(before[key]) !== normalizeOccurredAtLocal(after[key])
      : before[key] !== after[key])
      .map((key) => [key, key === "occurredAtLocal" ? normalizeOccurredAtLocal(after[key]) : after[key]]),
  );
}

export function compareOccurredAtLocal(a: string, b: string): number {
  const left = normalizeOccurredAtLocal(a);
  const right = normalizeOccurredAtLocal(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareRefuelingRecords(
  a: Pick<SavedRefuelingRecord, "id" | "occurredAtLocal">,
  b: Pick<SavedRefuelingRecord, "id" | "occurredAtLocal">,
): number {
  return compareOccurredAtLocal(a.occurredAtLocal, b.occurredAtLocal)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 与表单硬规则相同的记录边界；不把合法金额差异当作损坏。 */
export function isValidRefuelingRecord(value: unknown): value is RefuelingRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as RefuelingRecord;
  for (const key of Object.keys(numberFields) as NumberField[]) {
    const number = record[key];
    if (key === "invoiceableAmountCents" && number === null) continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number)
      || (numberFields[key].positive ? number <= 0 : number < 0)) return false;
  }
  return typeof record.occurredAtLocal === "string" && validDateTime(record.occurredAtLocal)
    && typeof record.fullTank === "boolean" && [true, false, null].includes(record.lowFuelLight)
    && ([['stationName', 100], ['fuelGrade', 80], ['orderNumber', 128]] as const)
      .every(([key, limit]) => typeof record[key] === "string" && [...record[key]].length <= limit);
}

export type OdometerEndpoint = Readonly<Pick<SavedRefuelingRecord, "id" | "occurredAtLocal" | "odometerTenths">>;
export type OdometerConflict = Readonly<{
  start: OdometerEndpoint;
  end: OdometerEndpoint;
  deltaTenths: bigint;
  kind: "backward" | "equal";
}>;
export type ProposedOdometerConflict = OdometerConflict & Readonly<{
  position: "previous" | "next" | "old-position-bridge";
}>;

function odometerEndpoint(record: SavedRefuelingRecord | undefined): OdometerEndpoint | null {
  return record === undefined ? null : {
    id: record.id, occurredAtLocal: normalizeOccurredAtLocal(record.occurredAtLocal), odometerTenths: record.odometerTenths,
  };
}

export function inspectOdometerRelationship(start: OdometerEndpoint, end: OdometerEndpoint): OdometerConflict | null {
  const deltaTenths = BigInt(end.odometerTenths) - BigInt(start.odometerTenths);
  return deltaTenths > 0n ? null : {
    start: { ...start, occurredAtLocal: normalizeOccurredAtLocal(start.occurredAtLocal) },
    end: { ...end, occurredAtLocal: normalizeOccurredAtLocal(end.occurredAtLocal) },
    deltaTenths, kind: deltaTenths === 0n ? "equal" : "backward",
  };
}

export function refuelingNeighbours(records: readonly SavedRefuelingRecord[], candidate: Pick<SavedRefuelingRecord, "id" | "occurredAtLocal">) {
  const ordered = records.filter(record => record.id !== candidate.id).sort(compareRefuelingRecords);
  const insertion = ordered.findIndex(record => compareRefuelingRecords(record, candidate) > 0);
  const index = insertion < 0 ? ordered.length : insertion;
  return { previous: ordered[index - 1] ?? null, next: ordered[index] ?? null };
}

export function describeOdometerConflict(conflict: ProposedOdometerConflict, recordId: string): string {
  const describe = (endpoint: OdometerEndpoint, side: "start" | "end") => {
    const label = conflict.position === "old-position-bridge"
      ? (side === "start" ? "原位置前一条" : "原位置后一条")
      : endpoint.id === recordId ? "本次" : side === "start" ? "前一条" : "后一条";
    return `${label} ${endpoint.occurredAtLocal.replace("T", " ")} · ${new Money(endpoint.odometerTenths).div(10).toFixed(1)} km`;
  };
  return `${describe(conflict.start, "start")} → ${describe(conflict.end, "end")}：${conflict.kind === "equal" ? "里程相同" : `里程倒退 ${new Money((-conflict.deltaTenths).toString()).div(10).toFixed(1)} km`}，请核对。`;
}

export type RefuelingSavePrecondition = Readonly<{
  recordId: string;
  creating: boolean;
  patch: Readonly<Partial<RefuelingRecord>>;
  effectiveRecord: Readonly<RefuelingRecord>;
  target: Readonly<RefuelingRecord> | null;
  previous: OdometerEndpoint | null;
  next: OdometerEndpoint | null;
  oldPositionPrevious: OdometerEndpoint | null;
  oldPositionNext: OdometerEndpoint | null;
}>;

export type ReadyRefuelingSave = Readonly<{
  state: "ready";
  creating: boolean;
  patch: Readonly<Partial<RefuelingRecord>>;
  effectiveRecord: Readonly<RefuelingRecord>;
  conflicts: readonly ProposedOdometerConflict[];
  amountWarnings: readonly string[];
  retainedFields: readonly (keyof RefuelingRecord)[];
  precondition: RefuelingSavePrecondition;
}>;
export type RefuelingSaveInspection = ReadyRefuelingSave | { state: "blocked"; message: string };

function copyRecord(record: RefuelingRecord): RefuelingRecord {
  return Object.fromEntries([...refuelingRecordFields].map(key => [key, record[key]])) as RefuelingRecord;
}

function validRecordSnapshot(records: readonly SavedRefuelingRecord[]): boolean {
  const ids = new Set<string>();
  return records.every(record => {
    if (!isValidRefuelingRecord(record) || typeof record.id !== "string" || ids.has(record.id)) return false;
    ids.add(record.id);
    return true;
  });
}

function savePrecondition(records: readonly SavedRefuelingRecord[], recordId: string, patch: Partial<RefuelingRecord>, creating: boolean): RefuelingSavePrecondition | null {
  const target = records.find(record => record.id === recordId);
  if (creating ? target !== undefined : target === undefined) return null;
  const effectiveRecord = { ...(target === undefined ? {} : copyRecord(target)), ...patch } as RefuelingRecord;
  if (!isValidRefuelingRecord(effectiveRecord)) return null;
  const neighbours = refuelingNeighbours(records, { ...effectiveRecord, id: recordId });
  const oldNeighbours = target === undefined ? null : refuelingNeighbours(records, target);
  const moved = oldNeighbours !== null && (oldNeighbours.previous?.id !== neighbours.previous?.id || oldNeighbours.next?.id !== neighbours.next?.id);
  return {
    recordId, creating, patch: { ...patch }, effectiveRecord,
    target: target === undefined ? null : copyRecord(target),
    previous: odometerEndpoint(neighbours.previous ?? undefined), next: odometerEndpoint(neighbours.next ?? undefined),
    oldPositionPrevious: moved ? odometerEndpoint(oldNeighbours?.previous ?? undefined) : null,
    oldPositionNext: moved ? odometerEndpoint(oldNeighbours?.next ?? undefined) : null,
  };
}

export function inspectRefuelingSave(options: {
  records: readonly SavedRefuelingRecord[];
  recordId: string;
  mode: "create" | "edit";
  baseline: RefuelingRecord | null;
  submittedRecord: RefuelingRecord;
}): RefuelingSaveInspection {
  const { records, recordId, mode, baseline, submittedRecord } = options;
  if (!validRecordSnapshot(records) || !isValidRefuelingRecord(submittedRecord)
    || (mode === "edit" && !isValidRefuelingRecord(baseline)))
    return { state: "blocked", message: "记录字段无效，请保留输入并重新核对。" };
  const patch = mode === "create" ? copyRecord(submittedRecord) : changedFields(baseline!, submittedRecord);
  const precondition = savePrecondition(records, recordId, patch, mode === "create");
  if (precondition === null) return { state: "blocked", message: "记录已变化或保存身份冲突，请保留输入并重新核对。" };
  const conflicts: ProposedOdometerConflict[] = [];
  const candidate = { ...precondition.effectiveRecord, id: recordId };
  function add(start: OdometerEndpoint | null, end: OdometerEndpoint | null, position: ProposedOdometerConflict["position"]) {
    if (start === null || end === null || conflicts.some(conflict => conflict.start.id === start.id && conflict.end.id === end.id)) return;
    const conflict = inspectOdometerRelationship(start, end);
    if (conflict !== null) conflicts.push({ ...conflict, position });
  }
  add(precondition.previous, candidate, "previous");
  add(candidate, precondition.next, "next");
  add(precondition.oldPositionPrevious, precondition.oldPositionNext, "old-position-bridge");
  return {
    state: "ready", creating: precondition.creating, patch: precondition.patch,
    effectiveRecord: precondition.effectiveRecord, conflicts,
    amountWarnings: amountWarnings(precondition.effectiveRecord), precondition,
    retainedFields: [...refuelingRecordFields].filter(key => !(key in patch)
      && (key === "occurredAtLocal"
        ? compareOccurredAtLocal(submittedRecord[key], precondition.effectiveRecord[key]) !== 0
        : submittedRecord[key] !== precondition.effectiveRecord[key])),
  };
}

export class RefuelingSavePreconditionError extends Error {
  constructor() {
    super("记录或相邻里程已变化，请重新核对后保存。");
    this.name = "RefuelingSavePreconditionError";
  }
}

function sameFields(left: object | null, right: object | null): boolean {
  if (left === null || right === null) return left === right;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]);
}

export function assertRefuelingSavePrecondition(records: readonly SavedRefuelingRecord[], recordId: string, patch: Partial<RefuelingRecord>, creating: boolean, expected: RefuelingSavePrecondition): void {
  if (recordId !== expected.recordId || creating !== expected.creating || !sameFields(patch, expected.patch)
    || Object.keys(patch).some(key => !refuelingRecordFields.has(key as keyof RefuelingRecord))
    || !validRecordSnapshot(records)) throw new RefuelingSavePreconditionError();
  const current = savePrecondition(records, recordId, patch, creating);
  if (current === null || !(["target", "effectiveRecord", "previous", "next", "oldPositionPrevious", "oldPositionNext"] as const)
    .every(key => sameFields(current[key], expected[key]))) throw new RefuelingSavePreconditionError();
}

export function recordWarnings(
  records: readonly SavedRefuelingRecord[],
): Map<string, string[]> {
  const ordered = [...records].sort(compareRefuelingRecords);
  return new Map(
    ordered.map((record, index) => {
      const warnings = amountWarnings(record);
      if (
        index > 0 &&
        inspectOdometerRelationship(ordered[index - 1], record) !== null
      )
        warnings.push("总里程没有递增，请核对相邻记录。");
      return [record.id, warnings];
    }),
  );
}
