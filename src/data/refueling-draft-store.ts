// 表单草稿的独立 IndexedDB 存储。
// 正式使用者传入账号隔离库名；默认旧库名仅保留给历史格式测试与只读工具。
// 草稿不是正式记录。写入使用严格持久性事务，并且只有事务完成
// （transaction.done）才视为保存成功，与 local-refueling.ts 的约定一致。
// 无法识别的格式版本只统计、不删除，避免静默丢失用户草稿。

import { openDB, type DBSchema } from "idb";
import { numberFields, type NumberField, type RefuelingDraft, type SavedRefuelingRecord } from "../domain/refueling/form";
import type { StoredRefuelingDraft } from "../domain/refueling/draft-recovery";

export const refuelingDraftDatabaseName = "hako-refueling-drafts-v1";
export const refuelingDraftFormatVersion = 1;

interface RefuelingDraftDatabase extends DBSchema {
  drafts: {
    key: string;
    value: StoredRefuelingDraft;
  };
}

export interface RefuelingDraftList {
  drafts: StoredRefuelingDraft[];
  /** 格式版本不受支持的条目数量；这些条目被保留在库中。 */
  unsupportedCount: number;
}

export interface RefuelingDraftStore {
  list(): Promise<RefuelingDraftList>;
  get(id: string): Promise<StoredRefuelingDraft | null>;
  /** 写入并等待事务完成。 */
  put(draft: StoredRefuelingDraft): Promise<void>;
  remove(id: string): Promise<void>;
  close(): void;
}

export async function openRefuelingDraftStore(databaseName = refuelingDraftDatabaseName): Promise<RefuelingDraftStore> {
  const database = await openDB<RefuelingDraftDatabase>(databaseName, 1, {
    upgrade(db) {
      db.createObjectStore("drafts");
    },
    blocking() {
      database.close();
    },
  });

  return {
    async list() {
      const transaction = database.transaction("drafts", "readonly");
      const values = await transaction.store.getAll();
      await transaction.done;
      const drafts: StoredRefuelingDraft[] = [];
      let unsupportedCount = 0;
      for (const value of values) {
        const normalized = normalizeDraft(value);
        if (normalized === null) unsupportedCount += 1;
        else drafts.push(normalized);
      }
      return { drafts, unsupportedCount };
    },
    async get(id) {
      const transaction = database.transaction("drafts", "readonly");
      const value = await transaction.store.get(id);
      await transaction.done;
      return value === undefined ? null : normalizeDraft(value);
    },
    async put(draft) {
      const transaction = database.transaction("drafts", "readwrite", { durability: "strict" });
      try {
        await transaction.store.put({ ...draft, formatVersion: refuelingDraftFormatVersion }, draft.id);
        await transaction.done;
      } catch (error) {
        // 请求失败也要等待事务收尾，避免留下未确认的写入
        try {
          transaction.abort();
        } catch {
          /* 可能已经结束 */
        }
        await transaction.done.catch(() => undefined);
        throw error;
      }
    },
    async remove(id) {
      const transaction = database.transaction("drafts", "readwrite", { durability: "strict" });
      try {
        await transaction.store.delete(id);
        await transaction.done;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* 可能已经结束 */
        }
        await transaction.done.catch(() => undefined);
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}

/** 校验并归一化存储条目；结构不可用或版本不受支持时返回 null（保留原数据）。 */
function normalizeDraft(value: unknown): StoredRefuelingDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const draft = value as Partial<StoredRefuelingDraft>;
  if (draft.formatVersion !== refuelingDraftFormatVersion) return null;
  if (typeof draft.id !== "string" || draft.id === "") return null;
  if (draft.mode !== "create" && draft.mode !== "edit") return null;
  const recordId = draft.recordId;
  if (typeof recordId !== "string" || recordId === "") return null;
  if (!isUsableFormValues(draft.values)) return null;
  if (typeof draft.sources !== "object" || draft.sources === null) return null;
  const base = draft.base ?? null;
  // 编辑草稿必须带指向同一条记录的基线：缺少基线时保存会退化成新增
  if (draft.mode === "edit" && !isMatchingBase(base, recordId)) return null;
  if (draft.mode === "create" && base !== null) return null;
  return {
    id: draft.id,
    mode: draft.mode,
    recordId,
    base: base as SavedRefuelingRecord | null,
    values: draft.values,
    sources: draft.sources as RefuelingDraft["sources"],
    createdAt: typeof draft.createdAt === "number" ? draft.createdAt : 0,
    updatedAt: typeof draft.updatedAt === "number" ? draft.updatedAt : 0,
    formatVersion: refuelingDraftFormatVersion,
    savedAt: typeof draft.savedAt === "number" ? draft.savedAt : null,
  };
}

const numberFieldKeys = Object.keys(numberFields) as NumberField[];
const yesNoFields = ["fullTank", "lowFuelLight"] as const;
const textFields = ["stationName", "fuelGrade", "orderNumber"] as const;

/**
 * 表单值必须字段齐备且类型正确：表单按字段渲染，缺字段或被改写会让用户
 * 看到空值或错误的金额，进而把损坏内容保存成记录。
 */
function isUsableFormValues(value: unknown): value is RefuelingDraft["values"] {
  if (typeof value !== "object" || value === null) return false;
  const values = value as Record<string, unknown>;
  for (const key of numberFieldKeys) {
    if (typeof values[key] !== "string") return false;
  }
  if (typeof values.occurredAtLocal !== "string") return false;
  for (const key of yesNoFields) {
    const marker = values[key];
    if (marker !== "" && marker !== "yes" && marker !== "no") return false;
  }
  for (const key of textFields) {
    if (typeof values[key] !== "string") return false;
  }
  return true;
}

function isMatchingBase(value: unknown, recordId: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { id?: unknown }).id === recordId;
}
