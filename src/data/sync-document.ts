import { decodeImportBlobMeta, LoroDoc, LoroMap } from "loro-crdt/web";
import { readRecords, refuelingRecordFields } from "./refueling-document";
import { MAX_SYNC_BYTES } from "../shared/sync-protocol";

const recordsRootId = "cid:root-records:Map";

export class InvalidSyncDocument extends Error {
  constructor() { super("invalid_document"); }
}

export function validateSyncDocument(doc: LoroDoc): void {
  if (doc.isShallow()) throw new Error("invalid_document");
  // JSONPath 返回原始根句柄数组，保留 __proto__；getMap 不可用于探测根类型。
  for (const root of doc.JSONPath("$.*")) {
    if (!(root instanceof LoroMap) || root.id !== recordsRootId) throw new Error("invalid_document");
  }
  // 同名不同类型的根可能在当前投影中被遮挡；已写入/清空的非法根也不能留在完整历史中。
  doc.commit();
  const history = doc.oplogVersion();
  try {
    for (const [peer, length] of history.toJSON()) {
      for (const id of doc.getChangedContainersIn({ peer, counter: 0 }, length)) {
        if (id.startsWith("cid:root-") && id !== recordsRootId) throw new Error("invalid_document");
      }
    }
  } finally { history.free(); }
  const records = doc.getMap("records");
  for (const [id, record] of records.entries()) {
    if (!id || id.length > 128 || !(record instanceof LoroMap)
      || record.keys().some((key) => !refuelingRecordFields.has(key))) throw new Error("invalid_document");
  }
  // 数值、字段格式硬校验；金额关系/里程异常仍由既有 warnings 展示，不阻断合并。
  readRecords(doc);
}

export function importSyncSnapshot(doc: LoroDoc, snapshot: Uint8Array): void {
  if (snapshot.byteLength > MAX_SYNC_BYTES) throw new Error("document_too_large");
  try {
  const metadata = decodeImportBlobMeta(snapshot, true);
  try {
    if (metadata.mode !== "snapshot") throw new Error("invalid_document");
  } finally {
    metadata.partialStartVersionVector.free();
    metadata.partialEndVersionVector.free();
  }
  const imported = doc.import(snapshot);
  if (imported.pending?.size) throw new Error("invalid_document");
  validateSyncDocument(doc);
  } catch {
    throw new InvalidSyncDocument();
  }
}

export function exportSyncSnapshot(doc: LoroDoc): Uint8Array {
  const snapshot = doc.export({ mode: "snapshot" });
  if (snapshot.byteLength > MAX_SYNC_BYTES) throw new Error("document_too_large");
  return snapshot;
}
