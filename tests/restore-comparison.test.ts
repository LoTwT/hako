// 比较逻辑（恢复设计 §7.1）单元：增加/移除/字段不同/相同计数、字段级差异、
// 历史相同/不同判定与无变化提示基础。
import { beforeAll, describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt/web";
import { initializeTestLoro, syntheticRecord } from "./helpers/sync-fixtures";
import { writeRecord } from "../src/data/refueling-document";
import { compareRestoreSnapshots, differingFields } from "../src/data/restore-comparison";

const docs: LoroDoc[] = [];
function fresh(): LoroDoc {
  const instance = new LoroDoc();
  docs.push(instance);
  return instance;
}

beforeAll(async () => {
  await initializeTestLoro();
});

describe("恢复预览比较", () => {
  it("增加/移除/字段不同/相同与逐条字段差异；字段相同历史不同不算无变化", () => {
    const target = fresh();
    writeRecord(target, "one", { ...syntheticRecord, stationName: "旧站" }, true);
    writeRecord(target, "two", syntheticRecord, true);
    const current = fresh();
    writeRecord(current, "one", { ...syntheticRecord, stationName: "新站" }, true);
    writeRecord(current, "three", syntheticRecord, true);
    const comparison = compareRestoreSnapshots(target.export({ mode: "snapshot" }), current.export({ mode: "snapshot" }));
    expect(comparison).not.toBeNull();
    if (comparison === null) return;
    expect(comparison.added).toBe(1);
    expect(comparison.removed).toBe(1);
    expect(comparison.changed).toBe(1);
    expect(comparison.same).toBe(0);
    expect(comparison.stateIdentical).toBe(false);
    expect(comparison.historyIdentical).toBe(false);
    const changed = comparison.records.find((record) => record.status === "changed")!;
    expect(differingFields(changed).map((entry) => entry.field)).toEqual(["stationName"]);
    expect(changed.fields.find((entry) => entry.field === "stationName")).toMatchObject({ before: "新站", after: "旧站", differs: true });
    const added = comparison.records.find((record) => record.status === "added")!;
    expect(added.recordId).toBe("two");
  });

  it("完整状态与历史均相同：stateIdentical 与 historyIdentical 同时为真", () => {
    const target = fresh();
    writeRecord(target, "one", syntheticRecord, true);
    const current = fresh();
    current.import(target.export({ mode: "snapshot" }));
    const comparison = compareRestoreSnapshots(target.export({ mode: "snapshot" }), current.export({ mode: "snapshot" }));
    expect(comparison).not.toBeNull();
    if (comparison === null) return;
    expect(comparison.stateIdentical).toBe(true);
    expect(comparison.historyIdentical).toBe(true);
    expect(comparison.same).toBe(1);
  });

  it("字段相同但历史不同：stateIdentical 为真、historyIdentical 为假", () => {
    // 两个独立文档各自写入相同字段的 one 记录：字段一致、历史（PeerID）不同。
    const target = fresh();
    writeRecord(target, "one", syntheticRecord, true);
    const current = fresh();
    writeRecord(current, "one", syntheticRecord, true);
    const comparison = compareRestoreSnapshots(target.export({ mode: "snapshot" }), current.export({ mode: "snapshot" }));
    expect(comparison).not.toBeNull();
    if (comparison === null) return;
    expect(comparison.stateIdentical).toBe(true);
    expect(comparison.historyIdentical).toBe(false);
    expect(comparison.same).toBe(1);
  });
});
