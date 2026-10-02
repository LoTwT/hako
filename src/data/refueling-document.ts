import { LoroDoc, LoroMap } from "loro-crdt/web";
import {
  createDraft,
  numberFields,
  validateDraft,
  type RefuelingRecord,
  type SavedRefuelingRecord,
} from "../domain/refueling/form";

export const refuelingRecordFields: ReadonlySet<string> = new Set([
  ...Object.keys(numberFields), "occurredAtLocal", "fullTank", "lowFuelLight",
  "stationName", "fuelGrade", "orderNumber",
]);

export function readRecords(doc: LoroDoc): SavedRefuelingRecord[] {
  return doc.getMap("records").entries()
    .map(([id, value]) => {
      if (!(value instanceof LoroMap))
        throw new Error("记录格式不受支持，已保留本机数据。");
      // entries 保留特殊键和容器句柄；toJSON 会漏键，并把 Text/Counter 冒充为标量。
      const record = Object.fromEntries(value.entries()) as RefuelingRecord;
      for (const key of Object.keys(
        numberFields,
      ) as (keyof typeof numberFields)[]) {
        if (key === "invoiceableAmountCents" && record[key] === null) continue;
        if (
          typeof record[key] !== "number" ||
          !Number.isSafeInteger(record[key])
        )
          throw new Error("记录数值损坏，已保留本机数据。");
      }
      if (
        typeof record.fullTank !== "boolean" ||
        ![true, false, null].includes(record.lowFuelLight) ||
        !["occurredAtLocal", "stationName", "fuelGrade", "orderNumber"].every(
          (key) => typeof record[key as keyof RefuelingRecord] === "string",
        ) ||
        !validateDraft(createDraft(record)).record
      )
        throw new Error("记录字段损坏，已保留本机数据。");
      return { ...record, id };
    })
    .sort(
      (a, b) =>
        b.occurredAtLocal.localeCompare(a.occurredAtLocal) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

export function writeRecord(
  doc: LoroDoc,
  id: string,
  fields: Partial<RefuelingRecord>,
  creating: boolean,
): void {
  const records = doc.getMap("records");
  let record = records.get(id);
  if (!record) {
    if (!creating) throw new Error("记录已不存在，请保留表单并重新核对。");
    record = records.setContainer(id, new LoroMap());
  }
  if (!(record instanceof LoroMap)) throw new Error("记录格式不受支持。");
  for (const [key, value] of Object.entries(fields)) record.set(key, value);
  doc.commit();
  readRecords(doc);
}
