// 独立草稿库测试：真实 IndexedDB 语义（fake-indexeddb）验证完整草稿往返、
// 事务完成确认、删除、以及不受支持/损坏条目的保留与统计。

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";
import {
  openRefuelingDraftStore,
  refuelingDraftDatabaseName,
  type RefuelingDraftStore,
} from "../src/data/refueling-draft-store";
import { createDraft, updateDraft, type RefuelingDraft } from "../src/domain/refueling/form";
import type { StoredRefuelingDraft } from "../src/domain/refueling/draft-recovery";

const T0 = Date.parse("2026-10-02T00:00:00.000Z");

function baseRecord(id: string) {
  return {
    id,
    odometerTenths: 100000,
    fuelVolumeMillilitres: 43000,
    unitPriceTenThousandths: 79400,
    amountPayableCents: 34142,
    couponDiscountCents: 0,
    amountPaidCents: 34142,
    invoiceableAmountCents: null,
    occurredAtLocal: "2026-08-08T14:49:42",
    fullTank: true,
    lowFuelLight: null,
    stationName: "测试站",
    fuelGrade: "92",
    orderNumber: "",
  };
}

function draftFixture(
  id: string,
  overrides: Partial<StoredRefuelingDraft> = {},
): StoredRefuelingDraft {
  const draft: RefuelingDraft = updateDraft(
    updateDraft(createDraft(undefined, new Date("2026-08-08T06:49:42Z")), "stationName", "测试站"),
    "amountPaidCents",
    "341.42",
  );
  const mode = overrides.mode ?? "create";
  const recordId = overrides.recordId ?? `record-${id}`;
  return {
    id,
    mode,
    recordId,
    // 编辑草稿必须带指向同一记录的基线，否则保存会退化成新增
    base: mode === "edit" ? baseRecord(recordId) : null,
    values: draft.values,
    sources: draft.sources,
    createdAt: T0,
    updatedAt: T0,
    formatVersion: 1,
    savedAt: null,
    ...overrides,
  };
}

let openStores: RefuelingDraftStore[] = [];

async function openStore(): Promise<RefuelingDraftStore> {
  const store = await openRefuelingDraftStore();
  openStores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of openStores) store.close();
  openStores = [];
  await deleteDB(refuelingDraftDatabaseName);
});

describe("独立草稿库", () => {
  it("往返保存完整原始输入（值、来源、模式、记录 id）", async () => {
    const store = await openStore();
    const draft = draftFixture("draft-1", {
      mode: "edit",
      recordId: "record-existing",
      base: {
        id: "record-existing",
        odometerTenths: 100000,
        fuelVolumeMillilitres: 43000,
        unitPriceTenThousandths: 79400,
        amountPayableCents: 34142,
        couponDiscountCents: 30000,
        amountPaidCents: 4142,
        invoiceableAmountCents: null,
        occurredAtLocal: "2026-08-08T14:49:42",
        fullTank: true,
        lowFuelLight: null,
        stationName: "",
        fuelGrade: "",
        orderNumber: "",
      },
    });
    await store.put(draft);

    const loaded = await store.get("draft-1");
    expect(loaded).toEqual(draft);
    // 半成品与人工修正的来源必须原样保留
    expect(loaded?.sources.stationName).toBe("manual");
    expect(loaded?.sources.occurredAtLocal).toBe("default");
    expect(loaded?.values.amountPaidCents).toBe("341.42");
  });

  it("写入在事务完成后才可见，删除后不可见", async () => {
    const store = await openStore();
    await store.put(draftFixture("draft-2"));
    const listed = await store.list();
    expect(listed.drafts.map((draft) => draft.id)).toEqual(["draft-2"]);

    await store.remove("draft-2");
    expect(await store.get("draft-2")).toBeNull();
    expect((await store.list()).drafts).toEqual([]);
  });

  it("多份草稿互不覆盖", async () => {
    const store = await openStore();
    await store.put(draftFixture("draft-a"));
    await store.put(draftFixture("draft-b", { mode: "edit", recordId: "record-b" }));
    const listed = await store.list();
    expect(listed.drafts.map((draft) => draft.id).sort()).toEqual(["draft-a", "draft-b"]);
    expect((await store.get("draft-a"))?.recordId).toBe("record-draft-a");
    expect((await store.get("draft-b"))?.recordId).toBe("record-b");
  });

  it("格式版本不支持或结构损坏的条目被统计并原样保留", async () => {
    const store = await openStore();
    await store.put(draftFixture("draft-good"));
    // 直接写入无法识别的条目，模拟更高版本或损坏数据
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(refuelingDraftDatabaseName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put({ id: "future", formatVersion: 99 }, "future");
      transaction.objectStore("drafts").put({ id: "broken" }, "broken");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const listed = await store.list();
    expect(listed.drafts.map((draft) => draft.id)).toEqual(["draft-good"]);
    expect(listed.unsupportedCount).toBe(2);
    // 再次读取仍然保留，没有被静默删除
    expect((await store.list()).unsupportedCount).toBe(2);
  });

  it("字段缺失或类型不符的表单值按不可用处理并保留", async () => {
    const store = await openStore();
    await store.put(draftFixture("draft-good"));
    const broken = draftFixture("draft-broken");
    const missing = draftFixture("draft-missing");
    delete (missing.values as Partial<Record<string, unknown>>).stationName;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(refuelingDraftDatabaseName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction
        .objectStore("drafts")
        .put({ ...broken, values: { ...broken.values, amountPaidCents: 34142 } }, "draft-broken");
      transaction.objectStore("drafts").put(missing, "draft-missing");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const listed = await store.list();
    expect(listed.drafts.map((draft) => draft.id)).toEqual(["draft-good"]);
    expect(listed.unsupportedCount).toBe(2);
    expect((await store.get("draft-broken"))).toBeNull();
    expect((await store.list()).unsupportedCount).toBe(2);
  });

  it("编辑草稿缺少匹配基线时按不可用处理并保留", async () => {
    const store = await openStore();
    const base = draftFixture("draft-edit").base;
    expect(base).toBeNull();
    const mismatched = draftFixture("draft-edit", {
      mode: "edit",
      recordId: "record-edit",
      base: baseRecord("record-other"),
    });
    await store.put(mismatched);

    const listed = await store.list();
    expect(listed.drafts).toEqual([]);
    expect(listed.unsupportedCount).toBe(1);
  });

  it("存储关闭后写入失败会抛出，不会假装成功", async () => {
    const store = await openStore();
    store.close();
    await expect(store.put(draftFixture("draft-closed"))).rejects.toBeTruthy();
  });
});
