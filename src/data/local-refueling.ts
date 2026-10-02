import { LoroDoc, VersionVector } from "loro-crdt/web";
import { openDB, type DBSchema } from "idb";
import { readRecords, refuelingRecordFields, writeRecord } from "./refueling-document";
import { importSyncSnapshot, validateSyncDocument } from "./sync-document";
import { initializeLoro } from "./loro-runtime";
import { accountStorageNames } from "./account-storage";
import type { RefuelingRecord, SavedRefuelingRecord } from "../domain/refueling/form";

interface StoredDocument {
  schemaVersion: 1;
  snapshot: Uint8Array;
  version: Uint8Array;
  acknowledgedVersion: Uint8Array | null;
  pendingSync: boolean;
  legacyImports: Record<string, string>;
}
interface LocalDatabase extends DBSchema {
  documents: { key: string; value: StoredDocument };
}
export interface LocalRefuelingState {
  records: SavedRefuelingRecord[];
  pendingSync: boolean;
  confirmed: boolean;
  importedLegacyIds: string[];
}

export async function openLocalRefueling(accountId: string) {
  if (!navigator.locks) throw new Error("此浏览器缺少安全写入所需的 Web Locks，请使用受支持的浏览器。");
  const names = accountStorageNames(accountId);
  await initializeLoro();
  const identity = new LoroDoc();
  const peerId = identity.peerId;
  identity.free();
  const database = await openDB<LocalDatabase>(names.records, 1, {
    upgrade(db) { db.createObjectStore("documents"); },
    blocking() { database.close(); },
  });

  async function withDocument<T>(operation: (doc: LoroDoc, stored: StoredDocument) => Promise<T>): Promise<T> {
    return navigator.locks.request(names.documentLock, async () => {
      const existing = await database.get("documents", "main");
      if (existing && existing.schemaVersion !== 1) throw new Error("本机数据版本不受支持，已保留数据，请更新应用。");
      const candidate = new LoroDoc();
      try {
        if (existing) candidate.import(existing.snapshot);
        candidate.setPeerId(peerId);
        validateSyncDocument(candidate);
        return await operation(candidate, existing ?? {
          schemaVersion: 1, snapshot: new Uint8Array(), version: new Uint8Array(),
          acknowledgedVersion: null, pendingSync: false, legacyImports: {},
        });
      } finally { candidate.free(); }
    });
  }

  function project(doc: LoroDoc, stored: StoredDocument): LocalRefuelingState {
    return { records: readRecords(doc), pendingSync: stored.pendingSync,
      confirmed: stored.acknowledgedVersion !== null, importedLegacyIds: Object.keys(stored.legacyImports) };
  }

  async function persist(doc: LoroDoc, stored: StoredDocument): Promise<LocalRefuelingState> {
    // 所有本机写入都先满足下一次加载/同步的同一合同，旧数据导入也不能绕过。
    try { validateSyncDocument(doc); }
    catch { throw new Error("记录格式不受支持，未改动本机已保存的数据"); }
    const version = doc.version();
    try {
      stored.version = version.encode();
      const acknowledged = stored.acknowledgedVersion ? VersionVector.decode(stored.acknowledgedVersion) : null;
      try { stored.pendingSync = acknowledged === null ? version.length() > 0 : version.compare(acknowledged) !== 0; }
      finally { acknowledged?.free(); }
    } finally { version.free(); }
    stored.snapshot = doc.export({ mode: "snapshot" });
    const transaction = database.transaction("documents", "readwrite", { durability: "strict" });
    try {
      await transaction.store.put(stored, "main");
      await transaction.done;
    } catch (error) {
      try { transaction.abort(); } catch { /* Already finished. */ }
      await transaction.done.catch(() => undefined);
      throw error;
    }
    return project(doc, stored);
  }

  return {
    load: () => withDocument(async (doc, stored) => project(doc, stored)),
    save: (id: string, patch: Partial<RefuelingRecord>, creating: boolean) => withDocument(async (doc, stored) => {
      writeRecord(doc, id, patch, creating);
      return persist(doc, stored);
    }),
    prepareSync: () => withDocument(async (doc) => {
      const version = doc.version();
      try { return { snapshot: doc.export({ mode: "snapshot" }), version: version.encode() }; }
      finally { version.free(); }
    }),
    acceptSync: (snapshot: Uint8Array, sentVersion: Uint8Array, applies: () => boolean) => withDocument(async (doc, stored) => {
      if (!applies()) return null;
      const server = new LoroDoc();
      try {
        importSyncSnapshot(server, snapshot);
        const acknowledged = server.version();
        const sent = VersionVector.decode(sentVersion);
        try {
          const coverage = acknowledged.compare(sent);
          if (coverage === undefined || coverage < 0) throw new Error("服务端未确认本次发送的版本");
          stored.acknowledgedVersion = acknowledged.encode();
        } finally { acknowledged.free(); sent.free(); }
        importSyncSnapshot(doc, snapshot);
        if (!applies()) return null;
        return persist(doc, stored);
      } finally { server.free(); }
    }),
    importLegacy: (selected: SavedRefuelingRecord[]) => withDocument(async (doc, stored) => {
      for (const { id, ...record } of selected) {
        if (Object.hasOwn(stored.legacyImports, id)) continue;
        if (Object.keys(record).some((key) => !refuelingRecordFields.has(key))) {
          throw new Error("记录格式不受支持，未改动本机已保存的数据");
        }
        const fields = Object.fromEntries([...refuelingRecordFields].map((key) => [key, record[key as keyof RefuelingRecord]])) as RefuelingRecord;
        const targetId = crypto.randomUUID();
        writeRecord(doc, targetId, fields, true);
        // 映射与新记录同一事务；重试或多标签页导入不会再次创建/覆盖该记录。
        stored.legacyImports = { ...stored.legacyImports, [id]: targetId };
      }
      return persist(doc, stored);
    }),
    close: () => database.close(),
  };
}

export type LocalRefuelingRepository = Awaited<ReturnType<typeof openLocalRefueling>>;
