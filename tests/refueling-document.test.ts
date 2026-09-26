import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import init, { LoroDoc } from "loro-crdt/web/loro_wasm.js";
import { readRecords, writeRecord } from "../src/data/refueling-document";
import type { RefuelingRecord } from "../src/domain/refueling/form";

const base: RefuelingRecord = {
  occurredAtLocal: "2026-08-08T14:49:42",
  odometerTenths: 100000,
  fuelVolumeMillilitres: 43000,
  unitPriceTenThousandths: 79400,
  amountPayableCents: 34142,
  couponDiscountCents: 30000,
  amountPaidCents: 4142,
  invoiceableAmountCents: null,
  fullTank: true,
  lowFuelLight: null,
  stationName: "",
  fuelGrade: "",
  orderNumber: "",
};
const documents: LoroDoc[] = [];
function document(snapshot?: Uint8Array) {
  const doc = new LoroDoc();
  documents.push(doc);
  if (snapshot) doc.import(snapshot);
  return doc;
}
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await init({
    module_or_path: await readFile(
      join(
        dirname(require.resolve("loro-crdt/package.json")),
        "web/loro_wasm_bg.wasm",
      ),
    ),
  });
});
afterEach(() => {
  for (const doc of documents.splice(0)) doc.free();
});

describe("real Loro replicas", () => {
  it("round trips a complete snapshot and preserves historical values", () => {
    const original = document();
    writeRecord(original, "record-1", base, true);
    const past = original.frontiers();
    writeRecord(original, "record-1", { stationName: "新站" }, false);
    const restored = document(original.export({ mode: "snapshot" }));
    expect(readRecords(restored)[0].stationName).toBe("新站");
    restored.checkout(past);
    expect(readRecords(restored)[0].stationName).toBe("");
    restored.checkoutToLatest();
    expect(readRecords(restored)[0].stationName).toBe("新站");
  });
  it("merges independent fields and converges same-field competition under duplicate and reversed delivery", () => {
    const initial = document();
    writeRecord(initial, "record-1", base, true);
    const snapshot = initial.export({ mode: "snapshot" });
    const a = document(snapshot);
    const b = document(snapshot);
    expect(a.peerId).not.toBe(b.peerId);
    writeRecord(
      a,
      "record-1",
      { stationName: "A站", orderNumber: "000123" },
      false,
    );
    writeRecord(
      b,
      "record-1",
      { stationName: "B站", fuelGrade: "92号" },
      false,
    );
    const updateA = a.export({ mode: "update" });
    const updateB = b.export({ mode: "update" });
    const c = document(snapshot);
    const d = document(snapshot);
    c.import(updateA);
    c.import(updateB);
    c.import(updateA);
    d.import(updateB);
    d.import(updateA);
    d.import(updateB);
    expect(readRecords(c)).toEqual(readRecords(d));
    expect(readRecords(c)[0]).toMatchObject({
      orderNumber: "000123",
      fuelGrade: "92号",
    });
    expect(["A站", "B站"]).toContain(readRecords(c)[0].stationName);
  });
  it("retains independently created records and does not duplicate retried IDs", () => {
    const a = document();
    const b = document();
    writeRecord(a, "a", base, true);
    writeRecord(b, "b", base, true);
    a.import(b.export({ mode: "update" }));
    writeRecord(a, "a", base, true);
    expect(
      readRecords(a)
        .map((record) => record.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
  it("rejects a corrupted snapshot and invalid field types", () => {
    const doc = document();
    expect(() => doc.import(new Uint8Array([1, 2, 3]))).toThrow();
    writeRecord(doc, "record-1", base, true);
    expect(() =>
      writeRecord(doc, "record-1", { fuelVolumeMillilitres: -1 }, false),
    ).toThrow();
  });
});
