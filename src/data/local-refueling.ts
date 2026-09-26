import { LoroDoc } from "loro-crdt/web";
import init from "loro-crdt/web/loro_wasm.js";
import wasmUrl from "loro-crdt/web/loro_wasm_bg.wasm?url";
import { openDB, type DBSchema } from "idb";
import { readRecords, writeRecord } from "./refueling-document";
import type { RefuelingRecord } from "../domain/refueling/form";

const databaseName = "hako-local-validation-v1";
const lockName = `${databaseName}:document`;
export const changeChannelName = `${databaseName}:changes`;
let initialization: Promise<unknown> | undefined;

interface LocalDatabase extends DBSchema {
  documents: {
    key: string;
    value: {
      schemaVersion: 1;
      snapshot: Uint8Array;
      version: Uint8Array;
      pendingSync: true;
    };
  };
}

export async function openLocalRefueling() {
  if (!navigator.locks)
    throw new Error(
      "此浏览器缺少安全写入所需的 Web Locks，请使用受支持的浏览器。",
    );
  initialization ??= init({ module_or_path: wasmUrl }).catch((error) => {
    initialization = undefined;
    throw error;
  });
  await initialization;
  const identity = new LoroDoc();
  const peerId = identity.peerId;
  identity.free();
  const database = await openDB<LocalDatabase>(databaseName, 1, {
    upgrade(db) {
      db.createObjectStore("documents");
    },
    blocking() {
      database.close();
    },
  });

  async function withDocument(fields?: {
    id: string;
    patch: Partial<RefuelingRecord>;
    creating: boolean;
  }) {
    return navigator.locks.request(lockName, async () => {
      const stored = await database.get("documents", "main");
      if (stored && stored.schemaVersion !== 1)
        throw new Error("本机数据版本不受支持，已保留数据，请更新应用。");
      const candidate = new LoroDoc();
      try {
        if (stored) candidate.import(stored.snapshot);
        candidate.setPeerId(peerId);
        readRecords(candidate);
        if (fields) {
          writeRecord(candidate, fields.id, fields.patch, fields.creating);
          const transaction = database.transaction("documents", "readwrite", {
            durability: "strict",
          });
          const version = candidate.version();
          const saved = {
            schemaVersion: 1 as const,
            snapshot: candidate.export({ mode: "snapshot" }),
            version: version.encode(),
            pendingSync: true as const,
          };
          version.free();
          try {
            await transaction.store.put(saved, "main");
            await transaction.done;
          } catch (error) {
            // Observe transaction completion even when the request itself fails.
            try {
              transaction.abort();
            } catch {
              /* It may already be complete. */
            }
            await transaction.done.catch(() => undefined);
            throw error;
          }
        }
        return readRecords(candidate);
      } finally {
        candidate.free();
      }
    });
  }

  return {
    load: () => withDocument(),
    save: (id: string, patch: Partial<RefuelingRecord>, creating: boolean) =>
      withDocument({ id, patch, creating }),
    close: () => database.close(),
  };
}
