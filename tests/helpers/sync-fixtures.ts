import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import init from "loro-crdt/web/loro_wasm.js";
import { LoroCounter, LoroDoc, LoroMap, LoroText } from "loro-crdt/web";
import type { RefuelingRecord } from "../../src/domain/refueling/form";

export const accountA = "00000000-0000-4000-8000-000000000001";
export const accountB = "00000000-0000-4000-8000-000000000002";
export const syntheticRecord: RefuelingRecord = {
  occurredAtLocal: "2026-10-02T12:00:00", odometerTenths: 10000,
  fuelVolumeMillilitres: 20000, unitPriceTenThousandths: 80000,
  amountPayableCents: 16000, couponDiscountCents: 0, amountPaidCents: 16000,
  invoiceableAmountCents: null, fullTank: true, lowFuelLight: null,
  stationName: "合成加油站", fuelGrade: "92", orderNumber: "",
};

/** 原始 CRDT 结构，不能用 JSON 投影替代这些输入。 */
export const unsupportedDocumentCases: [string, (doc: LoroDoc) => void][] = [
  ["records Text 根与正常 Map 并存", (doc) => { doc.getText("records").insert(0, "unsupported"); }],
  ["records List 根与正常 Map 并存", (doc) => { doc.getList("records").push("unsupported"); }],
  ["未知 __proto__ 根", (doc) => { doc.getMap("__proto__").set("hidden", true); }],
  ["空 __proto__ 根", (doc) => { doc.getMap("__proto__"); }],
  ["已清空的未知根仍在历史中", (doc) => {
    const root = doc.getMap("hidden"); root.set("value", 1); doc.commit(); doc.deleteRootContainer(root.id);
  }],
  ["__proto__ 记录缺必填字段", (doc) => { doc.getMap("records").setContainer("__proto__", new LoroMap()); }],
  ["__proto__ 记录非法数值", (doc) => {
    const record = doc.getMap("records").setContainer("__proto__", new LoroMap());
    for (const [key, value] of Object.entries({ ...syntheticRecord, fuelVolumeMillilitres: -1 })) record.set(key, value);
  }],
  ["记录内未知 __proto__ 字段", (doc) => { (doc.getMap("records").get("one") as LoroMap).set("__proto__", "hidden"); }],
  ["字符串字段为 Text 容器", (doc) => {
    (doc.getMap("records").get("one") as LoroMap).setContainer("stationName", new LoroText()).insert(0, "合法外观");
  }],
  ["数值字段为 Counter 容器", (doc) => {
    (doc.getMap("records").get("one") as LoroMap).setContainer("amountPaidCents", new LoroCounter()).increment(16000);
  }],
  ["记录为普通对象而非 Map", (doc) => { doc.getMap("records").set("object-record", syntheticRecord); }],
];

export async function initializeTestLoro() {
  const require = createRequire(import.meta.url);
  await init({ module_or_path: await readFile(join(dirname(require.resolve("loro-crdt/package.json")), "web/loro_wasm_bg.wasm")) });
}
