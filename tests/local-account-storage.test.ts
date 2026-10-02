import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB, openDB } from "idb";
import { LoroDoc } from "loro-crdt/web";
import { accountA, accountB, initializeTestLoro, syntheticRecord, unsupportedDocumentCases } from "./helpers/sync-fixtures";
import { openLocalRefueling, type LocalRefuelingRepository } from "../src/data/local-refueling";
import { readLegacyRefueling, legacyDatabaseName } from "../src/data/legacy-refueling";
import { writeRecord } from "../src/data/refueling-document";
import { accountStorageNames } from "../src/data/account-storage";
import { openRefuelingDraftStore } from "../src/data/refueling-draft-store";
import { createDraft } from "../src/domain/refueling/form";

vi.mock("../src/data/loro-runtime", () => ({ initializeLoro: async () => undefined }));
const repositories: LocalRefuelingRepository[] = [];
async function repository(accountId = accountA) {
  const repo = await openLocalRefueling(accountId); repositories.push(repo); return repo;
}
beforeAll(initializeTestLoro);
beforeEach(() => {
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { locks: { request: async (name: string, callback: () => Promise<unknown>) => {
    const operation = (locks.get(name) ?? Promise.resolve()).then(callback);
    locks.set(name, operation.catch(() => undefined));
    return operation;
  } } });
});
afterEach(async () => {
  for (const repo of repositories.splice(0)) repo.close();
  for (const db of await indexedDB.databases()) if (db.name) await deleteDB(db.name);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("账号本机副本与主动导入", () => {
  it("拒绝非法远端候选与本机特殊键写入，快照、确认和导入映射一起保留", async () => {
    const repo = await repository();
    await repo.save("one", syntheticRecord, true);
    await repo.importLegacy([{ ...syntheticRecord, id: "legacy" }]);
    const sent = await repo.prepareSync();
    await repo.acceptSync(sent.snapshot, sent.version, () => true);
    const database = await openDB(accountStorageNames(accountA).records);
    try {
      const before = await database.get("documents", "main");
      for (const [name, mutate] of unsupportedDocumentCases) {
        const invalid = new LoroDoc();
        try {
          invalid.import(sent.snapshot); mutate(invalid); invalid.commit();
          await expect(repo.acceptSync(invalid.export({ mode: "snapshot" }), sent.version, () => true), name).rejects.toThrow("invalid_document");
        } finally { invalid.free(); }
        expect(await database.get("documents", "main"), name).toEqual(before);
      }
      await expect(repo.save("__proto__", { fuelVolumeMillilitres: -1 }, true)).rejects.toThrow();
      expect(await database.get("documents", "main")).toEqual(before);
      repo.close();
      expect((await (await repository()).load())).toMatchObject({ confirmed: true, pendingSync: false, importedLegacyIds: ["legacy"] });
    } finally { database.close(); }
  });

  it("正式账号不打开旧库，账号记录与草稿库分别隔离", async () => {
    const a = await repository(); const b = await repository(accountB);
    await a.save("one", syntheticRecord, true);
    expect((await b.load()).records).toEqual([]);
    const draftA = await openRefuelingDraftStore(accountStorageNames(accountA).drafts);
    const draftB = await openRefuelingDraftStore(accountStorageNames(accountB).drafts);
    await draftA.put({ ...createDraft(), id: "same-draft-id", recordId: "one", mode: "create", base: null,
      createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null });
    expect((await draftA.list()).drafts).toHaveLength(1);
    expect((await draftB.list()).drafts).toEqual([]);
    draftA.close(); draftB.close();
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(legacyDatabaseName);
  });

  it("无旧库时读取不创建；只导入勾选记录，原快照/历史不变且重试不覆盖编辑", async () => {
    expect(await readLegacyRefueling()).toEqual([]);
    expect(await indexedDB.databases()).toEqual([]);
    const legacy = new LoroDoc();
    writeRecord(legacy, "selected", syntheticRecord, true);
    writeRecord(legacy, "unselected", { ...syntheticRecord, stationName: "不导入" }, true);
    writeRecord(legacy, "selected", { orderNumber: "旧历史" }, false);
    const snapshot = legacy.export({ mode: "snapshot" }); legacy.free();
    const old = await openDB(legacyDatabaseName, 1, { upgrade(db) { db.createObjectStore("documents"); } });
    await old.put("documents", { schemaVersion: 1, snapshot }, "main");
    const preview = await readLegacyRefueling();
    const repo = await repository();
    expect((await repo.load()).records).toEqual([]);
    await repo.importLegacy(preview.filter((record) => record.id === "selected"));
    const imported = (await repo.load()).records;
    expect(imported).toHaveLength(1);
    expect(imported[0].id).not.toBe("selected");
    await repo.save(imported[0].id, { stationName: "正式新修改" }, false);
    await repo.importLegacy(preview.filter((record) => record.id === "selected"));
    expect((await repo.load()).records).toHaveLength(1);
    expect((await repo.load()).records[0].stationName).toBe("正式新修改");
    expect((await old.get("documents", "main")).snapshot).toEqual(snapshot);
    old.close();
  });

  it("请求在途发生新修改，旧确认仅覆盖已发送版本；新记录/字段不被覆盖", async () => {
    const repo = await repository();
    await repo.save("one", syntheticRecord, true);
    const sent = await repo.prepareSync();
    await repo.save("one", { stationName: "发送之后" }, false);
    await repo.save("two", syntheticRecord, true);
    const accepted = await repo.acceptSync(sent.snapshot, sent.version, () => true);
    expect(accepted?.pendingSync).toBe(true);
    expect(accepted?.records).toHaveLength(2);
    expect(accepted?.records.find((r) => r.id === "one")?.stationName).toBe("发送之后");
    const latest = await repo.prepareSync();
    expect((await repo.acceptSync(latest.snapshot, latest.version, () => true))?.pendingSync).toBe(false);
  });

  it("旧记录含额外字段时整批拒绝，正式库、导入映射及原旧库均不变", async () => {
    const legacy = new LoroDoc();
    const extraFields = { ...syntheticRecord, memo: "不属于正式记录的旧字段" };
    writeRecord(legacy, "unsupported", extraFields, true);
    writeRecord(legacy, "supported", syntheticRecord, true);
    const snapshot = legacy.export({ mode: "snapshot" }); legacy.free();
    const old = await openDB(legacyDatabaseName, 1, { upgrade(db) { db.createObjectStore("documents"); } });
    try {
      await old.put("documents", { schemaVersion: 1, snapshot }, "main");
      const preview = await readLegacyRefueling();
      const repo = await repository();
      await repo.save("healthy", syntheticRecord, true);
      const before = await repo.prepareSync();
      // 先写有效候选，再遇到额外字段，整批也不能留下任何记录或映射。
      const selected = [preview.find((record) => record.id === "supported")!, preview.find((record) => record.id === "unsupported")!];
      await expect(repo.importLegacy(selected)).rejects.toThrow("格式");
      expect((await repo.load()).records.map((record) => record.id)).toEqual(["healthy"]);
      expect((await repo.load()).importedLegacyIds).toEqual([]);
      expect((await repo.prepareSync()).snapshot).toEqual(before.snapshot);
      expect((await old.get("documents", "main")).snapshot).toEqual(snapshot);
      await repo.importLegacy(selected.slice(0, 1));
      expect((await repo.load()).records).toHaveLength(2);
    } finally { old.close(); }
  });

  it("旧世代及未覆盖提交的响应不能确认；落盘中止不报成功并可重复接收", async () => {
    const repo = await repository();
    await repo.save("one", syntheticRecord, true);
    const first = await repo.prepareSync();
    expect(await repo.acceptSync(first.snapshot, first.version, () => false)).toBeNull();
    await repo.save("two", syntheticRecord, true);
    const second = await repo.prepareSync();
    await expect(repo.acceptSync(first.snapshot, second.version, () => true)).rejects.toThrow("未确认");
    expect((await repo.load()).pendingSync).toBe(true);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      const result = original.apply(this, args);
      result.addEventListener("success", () => this.transaction.abort());
      return result;
    });
    await expect(repo.acceptSync(second.snapshot, second.version, () => true)).rejects.toThrow();
    expect((await repo.load()).pendingSync).toBe(true);
    expect((await repo.acceptSync(second.snapshot, second.version, () => true))?.pendingSync).toBe(false);
    repo.close();
    expect((await (await repository()).load()).pendingSync).toBe(false);
  });

  it("同账号多窗口保存串行合并；导入写失败后映射与记录一起回滚", async () => {
    const a = await repository(); const b = await repository();
    await a.save("one", syntheticRecord, true);
    await Promise.all([a.save("one", { stationName: "A" }, false), b.save("one", { fuelGrade: "95" }, false)]);
    expect((await a.load()).records[0]).toMatchObject({ stationName: "A", fuelGrade: "95" });
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new DOMException("test", "QuotaExceededError"); });
    const selected = [{ ...syntheticRecord, id: "legacy" }];
    await expect(a.importLegacy(selected)).rejects.toThrow();
    expect((await a.load()).importedLegacyIds).toEqual([]);
    await Promise.all([a.importLegacy(selected), b.importLegacy(selected)]);
    expect((await a.load()).records).toHaveLength(2);
  });
});
