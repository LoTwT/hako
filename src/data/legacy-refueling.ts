import { openDB } from "idb";
import { LoroDoc } from "loro-crdt/web";
import { initializeLoro } from "./loro-runtime";
import { readRecords } from "./refueling-document";

export const legacyDatabaseName = "hako-local-validation-v1";

/** 仅显式打开导入面板时读取。中止新库 upgrade，避免读取动作创建空旧库。 */
export async function readLegacyRefueling() {
  await initializeLoro();
  return navigator.locks.request(`${legacyDatabaseName}:document`, async () => {
    let absent = false;
    const database = await openDB(legacyDatabaseName, undefined, {
      upgrade(_db, _old, _next, transaction) {
        absent = true;
        void transaction.done.catch(() => undefined);
        transaction.abort();
      },
    }).catch((error) => { if (absent) return null; throw error; });
    if (!database) return [];
    const doc = new LoroDoc();
    try {
      const stored = await database.get("documents", "main");
      if (!stored) return [];
      if (stored.schemaVersion !== 1) throw new Error("旧验证数据版本不受支持，原库已保留。");
      doc.import(stored.snapshot);
      return readRecords(doc);
    } finally { doc.free(); database.close(); }
  });
}
