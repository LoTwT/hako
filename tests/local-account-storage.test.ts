import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB, openDB } from "idb";
import { LoroDoc } from "loro-crdt/web";
import { accountA, accountB, initializeTestLoro, syntheticRecord, unsupportedDocumentCases } from "./helpers/sync-fixtures";
import {
  openLocalRefuelingV2,
  type LocalRefuelingV2Repository,
} from "../src/data/local-refueling-v2";
import { accountStorageNames, accountStorageNamesV2 } from "../src/data/account-storage";
import { writeRecord } from "../src/data/refueling-document";
import { computeRestoreRequestFingerprint, type RestoreRequestBody } from "../src/shared/restore-protocol";
import { notCommittedOutcome, outcomeFromCommittedReceipt, type PendingRestoreRequest } from "../src/data/refueling-restore";
import { openRefuelingDraftStore, listRefuelingDraftsReadOnly } from "../src/data/refueling-draft-store";
import { listRetainedDraftSources } from "../src/data/retained-content";
import { createDraft } from "../src/domain/refueling/form";
import { decideWorkspaceOpen } from "../src/composables/useLocalRefueling";

vi.mock("../src/data/loro-runtime", () => ({ initializeLoro: async () => undefined }));
const generationG0 = "00000000-0000-4000-8000-0000000000a1";
const generationG1 = "00000000-0000-4000-8000-0000000000a2";
const generationG2 = "00000000-0000-4000-8000-0000000000a3";
const repositories: LocalRefuelingV2Repository[] = [];
async function repository(generation: string | null = generationG0, accountId = accountA) {
  const repo = await openLocalRefuelingV2({ accountId, legacyGeneration: generation }); repositories.push(repo); return repo;
}
function snapshotOf(doc: LoroDoc): Uint8Array { return doc.export({ mode: "snapshot" }); }
function versionOf(doc: LoroDoc): Uint8Array { const version = doc.version(); try { return version.encode(); } finally { version.free(); } }
function snapshotWith(ids: string[] = ["one"]): Uint8Array {
  const doc = new LoroDoc();
  try {
    for (const id of ids) writeRecord(doc, id, syntheticRecord, true);
    return doc.export({ mode: "snapshot" });
  } finally { doc.free(); }
}

/** 直接写入旧 v1 库，模拟升级前的正式账号数据或旧标签页的迟到写入。 */
async function seedV1Document(accountId: string, value: {
  snapshot: Uint8Array; version: Uint8Array; acknowledgedVersion?: Uint8Array | null;
  pendingSync?: boolean; legacyImports?: Record<string, string>;
}): Promise<void> {
  const database = await openDB(accountStorageNames(accountId).records, 1, {
    upgrade(db) { db.createObjectStore("documents"); },
  });
  try {
    await database.put("documents", {
      schemaVersion: 1, snapshot: value.snapshot, version: value.version,
      acknowledgedVersion: value.acknowledgedVersion ?? null,
      pendingSync: value.pendingSync ?? true,
      legacyImports: value.legacyImports ?? {},
    }, "main");
  } finally { database.close(); }
}
async function readV1Document(accountId: string) {
  const database = await openDB(accountStorageNames(accountId).records, 1);
  try { return await database.get("documents", "main"); } finally { database.close(); }
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

describe("v2 本机副本：保存、同步确认与导入", () => {
  it("全新账号：无 v1 库时不创建旧库；激活后保存、确认与导入映射一起落盘", async () => {
    const repo = await repository();
    expect((await repo.readControl()).activeGeneration).toBeNull();
    expect(await repo.hasAnyGeneration()).toBe(false);
    const activated = await repo.activateGeneration(generationG0, null);
    expect(activated.status).toBe("activated");
    if (activated.status !== "activated") throw new Error("expected activated");
    expect(activated.state).toMatchObject({ generation: generationG0, records: [], confirmed: false, pendingSync: false });
    const saved = await repo.save(generationG0, "one", syntheticRecord, true);
    expect(saved.records).toHaveLength(1);
    expect(saved.pendingSync).toBe(true);
    expect(saved.inactive).toBe(false);
    await repo.importLegacy(generationG0, [{ ...syntheticRecord, id: "legacy" }]);
    expect((await repo.load()).importedLegacyIds).toEqual(["legacy"]);
    const outgoing = await repo.prepareSync(generationG0);
    expect(outgoing?.generation).toBe(generationG0);
    const server = new LoroDoc();
    server.import(outgoing!.snapshot);
    const accepted = await repo.acceptSync(generationG0, snapshotOf(server), outgoing!.version, () => true);
    expect(accepted?.pendingSync).toBe(false);
    expect(accepted?.confirmed).toBe(true);
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(accountStorageNames(accountA).records);
  });

  it("拒绝非法远端候选与本机特殊键写入，快照、确认和导入映射一起保留", async () => {
    const repo = await repository();
    await repo.activateGeneration(generationG0, null);
    await repo.save(generationG0, "one", syntheticRecord, true);
    await repo.importLegacy(generationG0, [{ ...syntheticRecord, id: "legacy" }]);
    const sent = (await repo.prepareSync(generationG0))!;
    await repo.acceptSync(generationG0, sent.snapshot, sent.version, () => true);
    const names = accountStorageNamesV2(accountA);
    const database = await openDB(names.records);
    try {
      const before = await database.get("documents", generationG0);
      const controlBefore = await database.get("control", "control");
      for (const [name, mutate] of unsupportedDocumentCases) {
        const invalid = new LoroDoc();
        try {
          invalid.import(sent.snapshot); mutate(invalid); invalid.commit();
          await expect(repo.acceptSync(generationG0, invalid.export({ mode: "snapshot" }), sent.version, () => true), name).rejects.toThrow("invalid_document");
        } finally { invalid.free(); }
        expect(await database.get("documents", generationG0), name).toEqual(before);
      }
      await expect(repo.save(generationG0, "__proto__", { fuelVolumeMillilitres: -1 }, true)).rejects.toThrow();
      expect(await database.get("documents", generationG0)).toEqual(before);
      expect(await database.get("control", "control")).toEqual(controlBefore);
      repo.close();
      const reopened = await repository();
      expect(await reopened.load()).toMatchObject({ generation: generationG0, confirmed: true, pendingSync: false, importedLegacyIds: ["legacy"] });
    } finally { database.close(); }
  });

  it("请求在途发生新修改，旧确认仅覆盖已发送版本；失活代次的迟到确认不写入", async () => {
    const repo = await repository();
    await repo.activateGeneration(generationG0, null);
    await repo.save(generationG0, "one", syntheticRecord, true);
    const sent = (await repo.prepareSync(generationG0))!;
    await repo.save(generationG0, "one", { stationName: "发送之后" }, false);
    await repo.save(generationG0, "two", syntheticRecord, true);
    const accepted = await repo.acceptSync(generationG0, sent.snapshot, sent.version, () => true);
    expect(accepted?.pendingSync).toBe(true);
    expect(accepted?.records.find((r) => r.id === "one")?.stationName).toBe("发送之后");
    // 切到新代次后，旧代次的迟到确认不能写入新代次或更新其确认游标。
    const received = new LoroDoc();
    received.import(sent.snapshot);
    await repo.receiveGeneration(generationG1, snapshotOf(received), generationG0);
    expect(await repo.acceptSync(generationG0, sent.snapshot, sent.version, () => true)).toBeNull();
    const afterSwitch = await repo.load();
    expect(afterSwitch.generation).toBe(generationG1);
    expect(afterSwitch.confirmed).toBe(true);
    expect(afterSwitch.pendingSync).toBe(false);
  });
});

describe("实例代次绑定与迟到下载（R1/R2 回归）", () => {
  it("旧窗口保存/导入只写原代次保留副本，绝不写入或重贴新活动代次", async () => {
    const oldWindow = await repository();
    await oldWindow.receiveGeneration(generationG0, snapshotWith(), null);
    const newWindow = await repository();
    await newWindow.receiveGeneration(generationG1, snapshotWith(), generationG0);
    // 旧窗口的表单仍属 G0：保存报告失活，写入保留在 G0 副本，G1 内容不变。
    const saved = await oldWindow.save(generationG0, "one", { stationName: "stale G0 form" }, false);
    expect(saved.inactive).toBe(true);
    expect((await newWindow.load()).records[0].stationName).toBe(syntheticRecord.stationName);
    const retainedG0 = await oldWindow.readRetainedGeneration(generationG0);
    expect(retainedG0?.records[0].stationName).toBe("stale G0 form");
    // 导入同样绑定：写进 G0 保留副本，新代次记录数不变。
    const imported = await oldWindow.importLegacy(generationG0, [{ ...syntheticRecord, id: "legacy" }]);
    expect(imported.inactive).toBe(true);
    expect((await newWindow.load()).records).toHaveLength(1);
    expect((await oldWindow.readRetainedGeneration(generationG0))?.importedLegacyIds).toEqual(["legacy"]);
    // 旧实例不再替新代次准备同步上传。
    expect(await oldWindow.prepareSync(generationG0)).toBeNull();
    expect((await newWindow.prepareSync(generationG1))?.generation).toBe(generationG1);
    // 绑定代次在本机没有副本且非活动时拒绝写入（输入留在表单/草稿）。
    await expect(oldWindow.save(generationG2, "one", syntheticRecord, true)).rejects.toThrow("没有副本");
  });

  it("迟到的代次下载不回退 activeGeneration、不覆盖保留副本的未同步编辑", async () => {
    const repo = await repository();
    const downloadedG1 = snapshotWith();
    await repo.receiveGeneration(generationG1, downloadedG1, null);
    await repo.save(generationG1, "one", { stationName: "G1 unsynced edit" }, false);
    expect((await repo.receiveGeneration(generationG2, snapshotWith(), generationG1)).status).toBe("received");
    // 下载发起时本机活动代次仍为 G1 的旧请求此刻到达：前置已推进到 G2，拒绝。
    const late = await repo.receiveGeneration(generationG1, downloadedG1, generationG1);
    expect(late.status).toBe("stale");
    // 即便误传了新前置：目标副本已存在（含未同步编辑），同样拒绝覆盖/重新激活。
    const wrongPrecondition = await repo.receiveGeneration(generationG1, downloadedG1, generationG2);
    expect(wrongPrecondition.status).toBe("stale");
    expect.soft((await repo.load()).generation).toBe(generationG2);
    expect.soft((await repo.readRetainedGeneration(generationG1))?.records[0].stationName).toBe("G1 unsynced edit");
    // 目标已是活动代次：幂等读回，不覆盖未同步编辑。
    const editedG2 = new LoroDoc();
    editedG2.import(snapshotWith());
    writeRecord(editedG2, "one", { stationName: "G2 unsynced edit" }, false);
    await repo.save(generationG2, "one", { stationName: "G2 unsynced edit" }, false);
    const idempotent = await repo.receiveGeneration(generationG2, snapshotWith(), generationG1);
    expect(idempotent.status).toBe("already-active");
    expect((await repo.readRetainedGeneration(generationG1))?.records[0].stationName).toBe("G1 unsynced edit");
    expect((await repo.load()).records[0].stationName).toBe("G2 unsynced edit");
  });

  it("保护流程中旧活动副本进入保留清单（接收前可查看）", async () => {
    const repo = await repository();
    await repo.receiveGeneration(generationG0, snapshotWith(), null);
    // 保护流程：共享 activeGeneration 仍是 G0；查看入口必须列出被保护的旧副本。
    expect((await repo.listRetainedGenerations(null)).map((copy) => copy.generation)).toContain(generationG0);
    // 接收新代次后：排除当前活动代次，保留清单仍包含 G0。
    await repo.receiveGeneration(generationG1, snapshotWith(), generationG0);
    expect((await repo.listRetainedGenerations(generationG1)).map((copy) => copy.generation)).toEqual([generationG0]);
    expect((await repo.listRetainedGenerations(null)).map((copy) => copy.generation).sort()).toEqual([generationG0, generationG1].sort());
  });
});

describe("v1 → v2 迁移与迟到写入", () => {
  it("未知 legacy 绑定（尚未 bootstrap）不迁移、不随机生成代次", async () => {
    const legacy = new LoroDoc();
    writeRecord(legacy, "pre", syntheticRecord, true);
    await seedV1Document(accountA, { snapshot: snapshotOf(legacy), version: versionOf(legacy) });
    const repo = await repository(null);
    const migration = await repo.migrateFromV1();
    expect(migration).toEqual({ changed: false, pendingMergeError: null });
    expect((await repo.readControl()).activeGeneration).toBeNull();
    expect((await repo.readControl()).legacyGeneration).toBeNull();
    expect(await repo.hasAnyGeneration()).toBe(false);
    // bootstrap 后补齐绑定再迁移：正常复制。
    repo.setLegacyBinding(generationG0);
    expect((await repo.migrateFromV1()).pendingMergeError).toBeNull();
    expect((await repo.readRetainedGeneration(generationG0))?.records).toHaveLength(1);
  });

  it("首次迁移：复制旧副本及确认信息进 G0；v1 库与字节原样保留", async () => {
    const legacy = new LoroDoc();
    writeRecord(legacy, "pre", syntheticRecord, true);
    const snapshot = snapshotOf(legacy);
    await seedV1Document(accountA, { snapshot, version: versionOf(legacy), acknowledgedVersion: versionOf(legacy), pendingSync: false, legacyImports: { source: "pre" } });
    const repo = await repository();
    const migration = await repo.migrateFromV1();
    expect(migration).toEqual({ changed: false, pendingMergeError: null });
    const control = await repo.readControl();
    expect(control.legacyGeneration).toBe(generationG0);
    expect(control.migrationFingerprint).not.toBeNull();
    expect(control.activeGeneration).toBeNull();
    const view = await repo.readRetainedGeneration(generationG0);
    expect(view?.records).toHaveLength(1);
    expect(view?.importedLegacyIds).toEqual(["source"]);
    // v1 库字节原样保留。
    const stored = await readV1Document(accountA);
    expect(stored.snapshot).toEqual(snapshot);
    // 重复迁移：指纹一致时不改写。
    expect((await repo.migrateFromV1()).changed).toBe(false);
    expect(await readV1Document(accountA)).toEqual(stored);
  });

  it("再次迁移合并旧库新历史：保留 G0 确认向量、重算待传、合并不覆盖新增映射", async () => {
    const legacy = new LoroDoc();
    writeRecord(legacy, "pre", syntheticRecord, true);
    await seedV1Document(accountA, { snapshot: snapshotOf(legacy), version: versionOf(legacy) });
    const repo = await repository();
    await repo.migrateFromV1();
    await repo.activateGeneration(generationG0, null);
    // G0 上产生 v2 独有修改与新增导入映射（未上传）。
    await repo.save(generationG0, "pre", { stationName: "v2 修改" }, false);
    await repo.importLegacy(generationG0, [{ ...syntheticRecord, id: "new-source" }]);
    // 旧标签页继续写 v1 库：新增一条历史。
    const lateWrite = new LoroDoc();
    lateWrite.import(snapshotOf(legacy));
    writeRecord(lateWrite, "pre", { orderNumber: "旧页面补充" }, false);
    const lateSnapshot = snapshotOf(lateWrite);
    await seedV1Document(accountA, { snapshot: lateSnapshot, version: versionOf(lateWrite) });
    const migration = await repo.migrateFromV1();
    expect(migration.changed).toBe(true);
    const loaded = await repo.load();
    const pre = loaded.records.find((record) => record.id === "pre")!;
    expect(pre.stationName).toBe("v2 修改");
    expect(pre.orderNumber).toBe("旧页面补充");
    expect(loaded.importedLegacyIds).toContain("new-source");
    expect(loaded.pendingSync).toBe(true);
  });

  it("再迁移的同来源映射冲突持久记录；唯一仍存在目标沿用映射幂等不产生第三条", async () => {
    const legacy = new LoroDoc();
    writeRecord(legacy, "pre", syntheticRecord, true);
    // 首次迁移：v1 库尚无导入映射。
    await seedV1Document(accountA, { snapshot: snapshotOf(legacy), version: versionOf(legacy) });
    const repo = await repository();
    await repo.migrateFromV1();
    await repo.activateGeneration(generationG0, null);
    // G0 上把该来源导入到 v2 新目标。
    await repo.importLegacy(generationG0, [{ ...syntheticRecord, id: "source" }]);
    expect((await repo.readControl()).importConflicts).toEqual({});
    // 旧库出现新历史且带同来源的不同目标（旧窗口也导入了该来源）。
    const lateWrite = new LoroDoc();
    lateWrite.import(snapshotOf(legacy));
    writeRecord(lateWrite, "pre", { orderNumber: "冲突触发" }, false);
    await seedV1Document(accountA, { snapshot: snapshotOf(lateWrite), version: versionOf(lateWrite), legacyImports: { source: "v1-target" } });
    await repo.migrateFromV1();
    const control = await repo.readControl();
    const conflictTargets = control.importConflicts["source"];
    expect(conflictTargets).toBeDefined();
    expect(conflictTargets).toHaveLength(2);
    // 冲突事实持久保留（不丢失两边映射）。当前代次只有一个仍存在的目标
    // （G0 导入目标；v1 映射目标不是本代次记录）→ 唯一目标沿用映射幂等：
    // 重复导入不抛错、不产生第三条记录，历史冲突证据保留。
    const outcome = await repo.importLegacy(generationG0, [{ ...syntheticRecord, id: "source" }]);
    expect(outcome.records).toHaveLength(2);
    expect(outcome.importedLegacyIds).toContain("source");
    expect((await repo.readControl()).importConflicts["source"]).toHaveLength(2);
    // 旧窗口隐藏落盘/再次迁移不清除冲突记录。
    await repo.migrateFromV1();
    expect((await repo.readControl()).importConflicts["source"]).toHaveLength(2);
  });

  it("合并写失败保留两份原数据与旧指纹，显示待处理", async () => {
    const legacy = new LoroDoc();
    writeRecord(legacy, "pre", syntheticRecord, true);
    await seedV1Document(accountA, { snapshot: snapshotOf(legacy), version: versionOf(legacy) });
    const repo = await repository();
    await repo.migrateFromV1();
    const controlBefore = await repo.readControl();
    // 旧库出现新历史后，注入一次 IndexedDB 写失败（配额不足等价路径）。
    const lateWrite = new LoroDoc();
    lateWrite.import(snapshotOf(legacy));
    writeRecord(lateWrite, "pre", { orderNumber: "旧页面补充" }, false);
    await seedV1Document(accountA, { snapshot: snapshotOf(lateWrite), version: versionOf(lateWrite) });
    const v1AfterLateWrite = await readV1Document(accountA);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("test", "QuotaExceededError");
    });
    await expect(repo.migrateFromV1()).rejects.toThrow();
    const control = await repo.readControl();
    expect(control.migrationFingerprint).toBe(controlBefore.migrationFingerprint);
    expect((await repo.readRetainedGeneration(generationG0))?.records).toHaveLength(1);
    expect((await readV1Document(accountA)).snapshot).toEqual(v1AfterLateWrite.snapshot);
    // 解除故障后重试成功合并，指纹推进。
    const merged = await repo.migrateFromV1();
    expect(merged.pendingMergeError).toBeNull();
    expect((await repo.readControl()).migrationFingerprint).not.toBe(controlBefore.migrationFingerprint);
    expect((await repo.readRetainedGeneration(generationG0))?.records[0].orderNumber).toBe("旧页面补充");
  });

  it("当前已恢复到其他代次时旧库只归 G0 保留副本；不上传、不改活动代次", async () => {
    const legacy = new LoroDoc();
    writeRecord(legacy, "pre", syntheticRecord, true);
    await seedV1Document(accountA, { snapshot: snapshotOf(legacy), version: versionOf(legacy), pendingSync: true });
    const server = new LoroDoc();
    writeRecord(server, "restored", { ...syntheticRecord, stationName: "恢复后" }, true);
    const repo = await repository();
    // 先迁移（服务端已在别处恢复到 G1，本机尚未激活任何代次）。
    await repo.migrateFromV1();
    await repo.receiveGeneration(generationG1, snapshotOf(server), null);
    const control = await repo.readControl();
    expect(control.activeGeneration).toBe(generationG1);
    const retained = await repo.readRetainedGeneration(generationG0);
    expect(retained?.pendingSync).toBe(true);
    expect(retained?.records).toHaveLength(1);
    const summaries = await repo.listRetainedGenerations(generationG1);
    expect(summaries.map((summary) => summary.generation)).toEqual([generationG0]);
    expect(summaries[0]).toMatchObject({ legacyGeneration: true, pendingSync: true, recordCount: 1 });
    // 旧库后续写入仍追加到保留的 G0 副本，不进入当前代次。
    const lateWrite = new LoroDoc();
    lateWrite.import(snapshotOf(legacy));
    writeRecord(lateWrite, "late", syntheticRecord, true);
    await seedV1Document(accountA, { snapshot: snapshotOf(lateWrite), version: versionOf(lateWrite) });
    const migration = await repo.migrateFromV1();
    expect(migration.changed).toBe(false);
    expect((await repo.readRetainedGeneration(generationG0))?.records).toHaveLength(2);
    expect((await repo.load()).records).toHaveLength(1);
  });
});

describe("代次切换接收与导入映射继承", () => {
  it("receiveGeneration 保留旧副本、继承目标仍存在的映射、多目标冲突持久记录", async () => {
    const repo = await repository();
    await repo.receiveGeneration(generationG0, snapshotWith(["one"]), null);
    await repo.save(generationG0, "extra", syntheticRecord, true);
    await repo.importLegacy(generationG0, [{ ...syntheticRecord, id: "source-kept" }]);
    await repo.importLegacy(generationG0, [{ ...syntheticRecord, id: "source-dropped" }]);
    const outgoing = (await repo.prepareSync(generationG0))!;
    const names = accountStorageNamesV2(accountA);
    const database = await openDB(names.records);
    let g0Imports: Record<string, string>;
    try { g0Imports = ((await database.get("documents", generationG0))!).legacyImports; } finally { await database.close(); }
    const keptTarget = g0Imports["source-kept"];
    const droppedTarget = g0Imports["source-dropped"];
    expect(keptTarget).toBeDefined();
    expect(droppedTarget).toBeDefined();
    // 服务端新代次快照：保留 one 与 keptTarget，不含 droppedTarget。
    const server = new LoroDoc();
    server.import(outgoing.snapshot);
    server.getMap("records").delete(droppedTarget);
    server.commit();
    const received = await repo.receiveGeneration(generationG1, snapshotOf(server), generationG0);
    expect(received.status).toBe("received");
    if (received.status !== "received") throw new Error("expected received");
    expect(received.state.generation).toBe(generationG1);
    expect(received.state.confirmed).toBe(true);
    expect(received.state.pendingSync).toBe(false);
    expect(received.state.records.map((record) => record.id).sort()).toEqual(["extra", "one", keptTarget].sort());
    // 目标已不存在的映射不自动补回；目标仍存在的映射继承到新代次。
    const databaseAfter = await openDB(names.records);
    try {
      const g1Doc = (await databaseAfter.get("documents", generationG1))!;
      expect(g1Doc.legacyImports).toEqual({ "source-kept": keptTarget });
      const control = (await databaseAfter.get("control", "control"))!;
      expect(control.activeGeneration).toBe(generationG1);
    } finally { await databaseAfter.close(); }
    // 旧副本登记为保留副本，不上传（one + extra + 两个导入目标）。
    const retained = await repo.readRetainedGeneration(generationG0);
    expect(retained?.retainedAtMs).not.toBeNull();
    expect(retained?.records).toHaveLength(4);
    // 幂等：目标已是活动代次时直接读回，不再改写。
    const again = await repo.receiveGeneration(generationG1, snapshotOf(server), generationG0);
    expect(again.status).toBe("already-active");
    if (again.status === "already-active" || again.status === "received") {
      expect(again.state.records.map((record) => record.id).sort()).toEqual(["extra", "one", keptTarget].sort());
    } else {
      throw new Error("expected already-active");
    }
  });

  it("多份保留映射对同来源指向多个仍存在的目标时持久冲突且禁止自动导入", async () => {
    const repo = await repository();
    // 构造两个代次对同一来源各有一份仍存在的目标：G0 与 G1（第二份保留副本）。
    const first = new LoroDoc();
    writeRecord(first, "one", syntheticRecord, true);
    await repo.receiveGeneration(generationG0, snapshotOf(first), null);
    const firstOutgoing = (await repo.prepareSync(generationG0))!;
    const second = new LoroDoc();
    second.import(firstOutgoing.snapshot);
    writeRecord(second, "two", syntheticRecord, true);
    await repo.receiveGeneration(generationG1, snapshotOf(second), generationG0);
    // 在两个代次上各写同一来源的映射（目标 one 与 two 都仍存在）。
    const names = accountStorageNamesV2(accountA);
    const database = await openDB(names.records, 1);
    try {
      for (const generation of [generationG0, generationG1]) {
        const doc = (await database.get("documents", generation))!;
        const edited = new LoroDoc();
        edited.import(doc.snapshot);
        doc.legacyImports = { ...doc.legacyImports, "shared-source": generation === generationG0 ? "one" : "two" };
        await database.put("documents", doc, generation);
      }
    } finally { await database.close(); }
    // 新代次快照包含两个目标：同来源指向多个目标，不自动继承，持久记录冲突。
    const serverDoc = new LoroDoc();
    const outgoing = (await repo.prepareSync(generationG1))!;
    serverDoc.import(outgoing.snapshot);
    serverDoc.commit();
    const nextGeneration = "00000000-0000-4000-8000-0000000000a4";
    const received = await repo.receiveGeneration(nextGeneration, snapshotOf(serverDoc), generationG1);
    expect(received.status).toBe("received");
    if (received.status !== "received") throw new Error("expected received");
    const control = await repo.readControl();
    expect(control.importConflicts["shared-source"]).toEqual(["one", "two"]);
    const databaseAfter = await openDB(names.records);
    try {
      const nextDoc = (await databaseAfter.get("documents", nextGeneration))!;
      expect(nextDoc.legacyImports).toEqual({});
    } finally { await databaseAfter.close(); }
    // 冲突来源禁止再次自动导入：整批拒绝，不产生第三条记录。
    await expect(repo.importLegacy(nextGeneration, [{ ...syntheticRecord, id: "shared-source" }])).rejects.toThrow("需人工核对");
    expect((await repo.load()).records).toHaveLength(2);
  });

  it("草稿库按账号+代次隔离；只读列表不创建、不占用锁、不清理", async () => {
    const namesA = accountStorageNamesV2(accountA);
    const draftG0 = await openRefuelingDraftStore(namesA.draftsFor(generationG0));
    await draftG0.put({ ...createDraft(), id: "same-draft-id", recordId: "one", mode: "create", base: null,
      createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null });
    const draftG1 = await openRefuelingDraftStore(namesA.draftsFor(generationG1));
    expect((await draftG1.list()).drafts).toEqual([]);
    const draftB = await openRefuelingDraftStore(accountStorageNamesV2(accountB).draftsFor(generationG0));
    expect((await draftB.list()).drafts).toEqual([]);
    expect((await draftG0.list()).drafts).toHaveLength(1);
    draftG0.close(); draftG1.close(); draftB.close();
    // 只读列表：不存在的库返回 null（不创建）；存在的库只读返回。
    expect(await listRefuelingDraftsReadOnly("hako-missing-drafts")).toBeNull();
    const readOnly = await listRefuelingDraftsReadOnly(namesA.draftsFor(generationG0));
    expect(readOnly?.drafts).toHaveLength(1);
    expect(readOnly?.drafts[0].values.stationName).toBe("");
    // 保留草稿来源枚举：v1 库 + 保留代次库（排除当前代次）。
    const v1Drafts = await openRefuelingDraftStore(accountStorageNames(accountA).drafts);
    await v1Drafts.put({ ...createDraft(), id: "v1-draft", recordId: "pre", mode: "create", base: null,
      createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null });
    v1Drafts.close();
    const sources = await listRetainedDraftSources(accountA, generationG1);
    expect(sources.map((source) => source.kind + (source.generation ?? ""))).toContain("v1");
    expect(sources.map((source) => source.generation)).toContain(generationG0);
    expect(sources.map((source) => source.generation)).not.toContain(generationG1);
  });
});

describe("本机待确认恢复与终态结构", () => {
  function pendingBody(requestId: string): RestoreRequestBody {
    return {
      requestId, previewId: "00000000-0000-4000-8000-0000000000b1",
      backupStreamId: "00000000-0000-4000-8000-0000000000b2",
      revision: 3, bundleSha256: "a".repeat(64),
      expectedGeneration: generationG0, expectedRevision: 5, expectedSnapshotSha256: "b".repeat(64),
    };
  }
  async function pending(requestId: string): Promise<PendingRestoreRequest> {
    const body = pendingBody(requestId);
    return { requestId, body, requestFingerprint: await computeRestoreRequestFingerprint(body), createdAtMs: 1 };
  }

  it("待确认请求多标签页复用；终态落盘按 requestId+指纹复核，旧响应不覆盖", async () => {
    const repo = await repository();
    const first = await pending("00000000-0000-4000-8000-0000000000c1");
    expect(await repo.setPendingRestore(first)).toEqual(first);
    // 另一标签页不能用另一请求覆盖 control。
    const second = await pending("00000000-0000-4000-8000-0000000000c2");
    expect(await repo.setPendingRestore(second)).toEqual(first);
    expect((await repo.readControl()).pendingRestore).toEqual(first);
    // 不同指纹的响应不能解除待确认。
    const mismatchedFingerprint = { ...first, requestFingerprint: "c".repeat(64) };
    const fakeCommitted = outcomeFromCommittedReceipt(mismatchedFingerprint, {
      requestId: first.requestId, requestFingerprint: "c".repeat(64),
      previousGeneration: generationG0, newGeneration: generationG1,
      previousRevision: 5, newRevision: 6, baselinePending: true, committedAtMs: 2,
    });
    expect(await repo.resolveRestoreOutcome(fakeCommitted)).toBe(false);
    expect((await repo.readControl()).pendingRestore).toEqual(first);
    // 指纹一致的终态先落盘、再解除待确认；持久保存后可查回。
    const outcome = outcomeFromCommittedReceipt(first, {
      requestId: first.requestId, requestFingerprint: first.requestFingerprint,
      previousGeneration: generationG0, newGeneration: generationG1,
      previousRevision: 5, newRevision: 6, baselinePending: true, committedAtMs: 2,
    });
    expect(await repo.resolveRestoreOutcome(outcome)).toBe(true);
    expect((await repo.readControl()).pendingRestore).toBeNull();
    expect(await repo.readRestoreOutcome(first.requestId)).toMatchObject({ outcome: "committed", newGeneration: generationG1 });
    // 普通保存/代次接收/迁移不把未知结果的请求清掉（终态只经 resolveRestoreOutcome）。
    const third = await pending("00000000-0000-4000-8000-0000000000c3");
    await repo.setPendingRestore(third);
    await repo.activateGeneration(generationG0, null);
    await repo.save(generationG0, "one", syntheticRecord, true);
    expect((await repo.readControl()).pendingRestore).toEqual(third);
    const notCommitted = notCommittedOutcome(third, "preview_expired");
    expect(await repo.resolveRestoreOutcome(notCommitted)).toBe(true);
    expect((await repo.readControl()).pendingRestore).toBeNull();
    expect(await repo.readRestoreOutcome(third.requestId)).toMatchObject({ outcome: "not_committed", notCommittedReason: "preview_expired" });
  });

  it("落盘中止不报成功且可重复接收；切换中写失败保留旧副本与待确认记录", async () => {
    const repo = await repository();
    await repo.receiveGeneration(generationG0, snapshotWith(), null);
    await repo.save(generationG0, "one", { stationName: "待确认修改" }, false);
    const sent = (await repo.prepareSync(generationG0))!;
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      const result = original.apply(this, args);
      result.addEventListener("success", () => this.transaction.abort());
      return result;
    });
    await expect(repo.acceptSync(generationG0, sent.snapshot, sent.version, () => true)).rejects.toThrow();
    expect((await repo.load()).pendingSync).toBe(true);
    expect((await repo.acceptSync(generationG0, sent.snapshot, sent.version, () => true))?.pendingSync).toBe(false);
    // 代次切换接收写失败：旧副本与活动代次保持原状，不显示已接收。
    const pendingRequest = await pending("00000000-0000-4000-8000-0000000000c9");
    await repo.setPendingRestore(pendingRequest);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      const result = original.apply(this, args);
      result.addEventListener("success", () => this.transaction.abort());
      return result;
    });
    const restored = new LoroDoc();
    writeRecord(restored, "restored", syntheticRecord, true);
    await expect(repo.receiveGeneration(generationG1, snapshotOf(restored), generationG0)).rejects.toThrow();
    const after = await repo.load();
    expect(after.generation).toBe(generationG0);
    expect(after.records).toHaveLength(1);
    // 待确认请求与旧副本原样保留；重试切换成功。
    expect((await repo.readControl()).pendingRestore).toEqual(pendingRequest);
    const received = await repo.receiveGeneration(generationG1, snapshotOf(restored), generationG0);
    expect(received.status).toBe("received");
    expect((await repo.readControl()).pendingRestore).toEqual(pendingRequest);
  });
});

describe("工作流决策（bootstrap × 本机控制状态）", () => {
  const decide = decideWorkspaceOpen;
  it("活动代次与服务端一致 → normal；全新浏览器 → receive", () => {
    expect(decide({
      activeGeneration: generationG0, legacyGeneration: generationG0, hasLocalData: true,
      serverGeneration: generationG0, serverLegacyGeneration: generationG0,
    })).toEqual({ action: "normal" });
    expect(decide({
      activeGeneration: null, legacyGeneration: null, hasLocalData: false,
      serverGeneration: generationG0, serverLegacyGeneration: generationG0,
    })).toEqual({ action: "receive" });
    // 全新浏览器但服务端已在其他代次：同样直接接收当前代次（无本机副本可保护）。
    expect(decide({
      activeGeneration: null, legacyGeneration: null, hasLocalData: false,
      serverGeneration: generationG1, serverLegacyGeneration: generationG0,
    })).toEqual({ action: "receive" });
  });

  it("有本地数据且服务端仍在 legacy 代次 → activate；服务端已推进 → 保护流程", () => {
    expect(decide({
      activeGeneration: null, legacyGeneration: generationG0, hasLocalData: true,
      serverGeneration: generationG0, serverLegacyGeneration: generationG0,
    })).toEqual({ action: "activate" });
    expect(decide({
      activeGeneration: null, legacyGeneration: null, hasLocalData: true,
      serverGeneration: generationG0, serverLegacyGeneration: generationG0,
    })).toEqual({ action: "activate" });
    expect(decide({
      activeGeneration: null, legacyGeneration: generationG0, hasLocalData: true,
      serverGeneration: generationG1, serverLegacyGeneration: generationG0,
    })).toEqual({ action: "generation-changed" });
    expect(decide({
      activeGeneration: generationG0, legacyGeneration: generationG0, hasLocalData: true,
      serverGeneration: generationG1, serverLegacyGeneration: generationG0,
    })).toEqual({ action: "generation-changed" });
  });
});

describe("激活 CAS 与导入冲突按操作代次判定（R1/R2/R6 二轮）", () => {
  it("决策与激活之间共享控制被推进：CAS 拒绝把活动代次改回旧值；同目标幂等", async () => {
    const repo = await repository();
    await repo.receiveGeneration(generationG0, snapshotWith(["one"]), null);
    // 决策时读到的前置状态：activeGeneration=null（迁移后待激活）。
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const control = await db.get("control", "control");
    await db.put("control", { ...control!, activeGeneration: null }, "control");
    db.close();
    // 决策与激活之间另一窗口接收 G1。
    const raced = await repository();
    await raced.receiveGeneration(generationG1, snapshotWith(["one"]), null);
    const stale = await repo.activateGeneration(generationG0, null);
    expect(stale.status).toBe("stale");
    if (stale.status === "stale") expect(stale.message).toContain("其他窗口");
    expect((await repo.readControl()).activeGeneration).toBe(generationG1);
    // 前置状态匹配（null）且目标即当前活动代次：幂等激活，不改写任何字节。
    const idempotent = await repo.activateGeneration(generationG1, null);
    expect(idempotent.status).toBe("activated");
    if (idempotent.status !== "activated") throw new Error("expected activated");
    expect(idempotent.state.generation).toBe(generationG1);
    expect((await repo.readControl()).activeGeneration).toBe(generationG1);
    repo.close();
    raced.close();
  });

  it("过时的导入冲突在目标都不存在于操作代次时不再阻断；证据保留", async () => {
    const repo = await repository();
    // G0 上两个代次各自把同一来源导入到不同目标。
    await repo.receiveGeneration(generationG0, snapshotWith(["target-one", "target-two"]), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const g0 = await db.get("documents", generationG0);
    await db.put("documents", { ...g0!, legacyImports: { source: "target-one" } }, generationG0);
    await db.put("documents", { ...g0!, generation: generationG1, legacyImports: { source: "target-two" } }, generationG1);
    db.close();
    // 接收仍含两个目标的 G2：继承时发现同来源双目标，持久记录冲突。
    const generationG2 = "00000000-0000-4000-8000-0000000000a3";
    await repo.receiveGeneration(generationG2, snapshotWith(["target-one", "target-two"]), generationG0);
    expect(Object.keys((await repo.readControl()).importConflicts)).toContain("source");
    // 恢复到不含任一目标的 G3：重新导入该来源应被允许（§6.1 本人重新选取）。
    const generationG3 = "00000000-0000-4000-8000-0000000000a4";
    await repo.receiveGeneration(generationG3, snapshotWith(["unrelated"]), generationG2);
    const result = await repo.importLegacy(generationG3, [{ ...syntheticRecord, id: "source" }]);
    expect(result.records).toHaveLength(2);
    // 历史冲突证据保留，不清除。
    expect(Object.keys((await repo.readControl()).importConflicts)).toContain("source");
    repo.close();
  });

  it("冲突目标仍存在于操作代次时继续阻断自动导入", async () => {
    const repo = await repository();
    await repo.receiveGeneration(generationG0, snapshotWith(["target-one", "target-two"]), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const g0 = await db.get("documents", generationG0);
    await db.put("documents", { ...g0!, legacyImports: { source: "target-one" } }, generationG0);
    await db.put("documents", { ...g0!, generation: generationG1, legacyImports: { source: "target-two" } }, generationG1);
    db.close();
    const generationG2 = "00000000-0000-4000-8000-0000000000a3";
    // G2 快照仍含两个目标：同来源双目标冲突在操作代次仍成立 → 阻断自动导入。
    await repo.receiveGeneration(generationG2, snapshotWith(["target-one", "target-two"]), generationG0);
    expect(Object.keys((await repo.readControl()).importConflicts)).toContain("source");
    await expect(repo.importLegacy(generationG2, [{ ...syntheticRecord, id: "source" }])).rejects.toThrow("多个仍存在的导入目标");
    expect((await repo.load()).records.map((record) => record.id).sort()).toEqual(["target-one", "target-two"].sort());
    repo.close();
  });
});
