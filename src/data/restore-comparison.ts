// 恢复预览的比较逻辑（恢复设计 §7.1）：把固定目标快照与当前服务端快照分别导入
// 两个独立只读 Loro 文档，按稳定记录 ID 比较「将增加、将移除、字段不同、相同」
// 与逐条字段差异；复用统一业务字段清单与标签。历史是否相同按版本向量比较——
// 字段相同而历史不同不能说完全无变化；完整状态与历史均相同才提示无需恢复。

import { LoroDoc } from "loro-crdt/web";
import { readRecords } from "./refueling-document";
import { importSyncSnapshot } from "./sync-document";
import { numberFields, unscale, type SavedRefuelingRecord } from "../domain/refueling/form";

export type RestoreRecordStatus = "added" | "removed" | "changed" | "same";

export interface RestoreFieldEntry {
  field: string;
  label: string;
  /** 当前值（目标为 removed 时为空）。 */
  before: string;
  /** 恢复后的值（目标为 added 时为空）。 */
  after: string;
  differs: boolean;
}

export interface RestoreComparisonRecord {
  recordId: string;
  status: RestoreRecordStatus;
  fields: RestoreFieldEntry[];
}

export interface RestoreComparison {
  added: number;
  removed: number;
  changed: number;
  same: number;
  /** 字段层面完全一致（不含历史）。 */
  stateIdentical: boolean;
  /** 版本向量完全一致（历史一致）。 */
  historyIdentical: boolean;
  records: RestoreComparisonRecord[];
}

const TEXT_FIELD_LABELS: Record<string, string> = {
  occurredAtLocal: "时间",
  fullTank: "是否加满",
  lowFuelLight: "油灯",
  stationName: "加油站",
  fuelGrade: "油品",
  orderNumber: "订单号",
};

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "（空）";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (field in numberFields) {
    return `${unscale(value as number, numberFields[field as keyof typeof numberFields].decimals)}${numberFields[field as keyof typeof numberFields].unit}`;
  }
  return String(value);
}

function fieldEntries(field: string, current: unknown, target: unknown): RestoreFieldEntry {
  const label = field in numberFields
    ? numberFields[field as keyof typeof numberFields].label
    : TEXT_FIELD_LABELS[field] ?? field;
  return {
    field,
    label,
    before: formatValue(field, current),
    after: formatValue(field, target),
    differs: formatValue(field, current) !== formatValue(field, target),
  };
}

/** 记录的全部字段（统一业务字段清单；顺序与保留副本视图一致）。 */
function recordFields(record: SavedRefuelingRecord): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const field of Object.keys(numberFields)) entries.push([field, record[field as keyof typeof record]]);
  for (const field of ["occurredAtLocal", "fullTank", "lowFuelLight", "stationName", "fuelGrade", "orderNumber"]) {
    entries.push([field, (record as unknown as Record<string, unknown>)[field]]);
  }
  return entries;
}

/**
 * 比较目标快照与当前快照；导入或结构校验失败返回 null（不能以部分结果冒充比较）。
 * 调用方负责先完成 initializeLoro。
 */
export function compareRestoreSnapshots(targetSnapshot: Uint8Array, currentSnapshot: Uint8Array): RestoreComparison | null {
  const target = new LoroDoc();
  const current = new LoroDoc();
  try {
    try {
      importSyncSnapshot(target, targetSnapshot);
      importSyncSnapshot(current, currentSnapshot);
    } catch {
      return null;
    }
    let historyIdentical = false;
    const targetVersion = target.version();
    const currentVersion = current.version();
    try {
      historyIdentical = targetVersion.compare(currentVersion) === 0;
    } finally {
      targetVersion.free();
      currentVersion.free();
    }
    const targetRecords = new Map(readRecords(target).map((record) => [record.id, record]));
    const currentRecords = new Map(readRecords(current).map((record) => [record.id, record]));
    const records: RestoreComparisonRecord[] = [];
    let added = 0;
    let removed = 0;
    let changed = 0;
    let same = 0;
    const allIds = [...new Set([...currentRecords.keys(), ...targetRecords.keys()])];
    for (const recordId of allIds.sort()) {
      const currentRecord = currentRecords.get(recordId);
      const targetRecord = targetRecords.get(recordId);
      if (currentRecord === undefined && targetRecord === undefined) continue;
      if (currentRecord === undefined) {
        added += 1;
        records.push({
          recordId,
          status: "added",
          fields: recordFields(targetRecord!).map(([field, value]) => fieldEntries(field, null, value)),
        });
        continue;
      }
      if (targetRecord === undefined) {
        removed += 1;
        records.push({
          recordId,
          status: "removed",
          fields: recordFields(currentRecord).map(([field, value]) => fieldEntries(field, value, null)),
        });
        continue;
      }
      const fields = recordFields(targetRecord).map(([field, targetValue]) => {
        const currentValue = (currentRecord as unknown as Record<string, unknown>)[field];
        return fieldEntries(field, currentValue, targetValue);
      });
      if (fields.some((entry) => entry.differs)) {
        changed += 1;
        records.push({ recordId, status: "changed", fields });
      } else {
        same += 1;
        records.push({ recordId, status: "same", fields });
      }
    }
    return {
      added,
      removed,
      changed,
      same,
      stateIdentical: added === 0 && removed === 0 && changed === 0,
      historyIdentical,
      records,
    };
  } finally {
    target.free();
    current.free();
  }
}

/** 字段级差异摘要（变更记录默认只显示不同字段；面板按需展开全部）。 */
export function differingFields(record: RestoreComparisonRecord): RestoreFieldEntry[] {
  return record.fields.filter((entry) => entry.differs);
}
