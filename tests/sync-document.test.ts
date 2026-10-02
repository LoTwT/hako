import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt/web";
import { importSyncSnapshot, validateSyncDocument } from "../src/data/sync-document";
import { readRecords, writeRecord } from "../src/data/refueling-document";
import { initializeTestLoro, syntheticRecord, unsupportedDocumentCases } from "./helpers/sync-fixtures";

const documents: LoroDoc[] = [];
function document() { const doc = new LoroDoc(); documents.push(doc); return doc; }
beforeAll(initializeTestLoro);
afterEach(() => { for (const doc of documents.splice(0)) doc.free(); });

describe("同步文档的真实容器合同", () => {
  it.each(unsupportedDocumentCases)("拒绝 %s", (_name, mutate) => {
    const source = document(); writeRecord(source, "one", syntheticRecord, true);
    mutate(source); source.commit();
    expect(() => importSyncSnapshot(document(), source.export({ mode: "snapshot" }))).toThrow("invalid_document");
  });

  it.each(["Text", "List"])("没有正常记录时也拒绝空 %s 根", (kind) => {
    const source = document();
    if (kind === "Text") source.getText("records"); else source.getList("records");
    expect(() => importSyncSnapshot(document(), source.export({ mode: "snapshot" }))).toThrow("invalid_document");
  });

  it("空快照和标量并发兼容，字段竞争不会拼接超长文本，完整历史仍可读取", () => {
    const a = document(); const b = document();
    importSyncSnapshot(b, a.export({ mode: "snapshot" }));
    expect(readRecords(b)).toEqual([]);
    writeRecord(a, "one", syntheticRecord, true);
    const before = a.frontiers();
    importSyncSnapshot(b, a.export({ mode: "snapshot" }));
    writeRecord(a, "one", { stationName: "A".repeat(90), orderNumber: "A-1" }, false);
    writeRecord(b, "one", { stationName: "B".repeat(90), fuelGrade: "95" }, false);
    importSyncSnapshot(a, b.export({ mode: "snapshot" }));
    importSyncSnapshot(b, a.export({ mode: "snapshot" }));
    expect(readRecords(a)).toEqual(readRecords(b));
    expect(readRecords(a)[0]).toMatchObject({ orderNumber: "A-1", fuelGrade: "95" });
    expect(readRecords(a)[0].stationName).toHaveLength(90);
    validateSyncDocument(a);
    a.checkout(before);
    expect(readRecords(a)[0]).toMatchObject(syntheticRecord);
  });
});
