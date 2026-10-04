// 迁移激活竞争（R1/R2 二轮）：决策与激活之间存在异步边界——本窗口决定激活 G0
// 时，另一窗口可能已接收服务端新代次。激活必须带 CAS 前置复核，不能把共享
// activeGeneration 改回旧代次；竞争后由编排层重新决策（保护流程，不切换已挂载
// 旧工作区）。真实 v2 记录库（fake-indexeddb）+ Vue 自定义 renderer。

import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { deleteDB } from "idb";
import { createRenderer } from "vue";
import { LoroDoc } from "loro-crdt/web";
import { accountA, initializeTestLoro, syntheticRecord } from "./helpers/sync-fixtures";
import { openLocalRefuelingV2, type LocalRefuelingV2Repository } from "../src/data/local-refueling-v2";
import { useLocalRefueling } from "../src/composables/useLocalRefueling";
import { writeRecord } from "../src/data/refueling-document";
import {
  BOOTSTRAP_PATH,
  SYNC_PATH,
} from "../src/shared/sync-protocol";

vi.mock("../src/data/loro-runtime", () => ({ initializeLoro: async () => undefined }));

/** 在 activateGeneration 调用点注入跨窗口竞争（决策与激活之间）。 */
const activationHook = vi.hoisted(() => ({ interleave: null as ((repo: LocalRefuelingV2Repository) => Promise<void>) | null }));
vi.mock("../src/data/local-refueling-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/local-refueling-v2")>();
  return {
    ...actual,
    openLocalRefuelingV2: async (options: import("../src/data/local-refueling-v2").OpenLocalRefuelingV2Options) => {
      const repository = await actual.openLocalRefuelingV2(options);
      return {
        ...repository,
        activateGeneration: async (generation: string, expectedActive: string | null) => {
          if (activationHook.interleave !== null) {
            const interleave = activationHook.interleave;
            activationHook.interleave = null;
            await interleave(repository);
          }
          return repository.activateGeneration(generation, expectedActive);
        },
      };
    },
  };
});

const G0 = "00000000-0000-4000-8000-0000000000a1";
const G1 = "00000000-0000-4000-8000-0000000000a2";

function snapshotWith(mutate?: (doc: LoroDoc) => void): Uint8Array {
  const doc = new LoroDoc();
  try {
    writeRecord(doc, "one", syntheticRecord, true);
    mutate?.(doc);
    return doc.export({ mode: "snapshot" });
  } finally { doc.free(); }
}

/** 第一次 bootstrap 返回 G0（决策 activate）；竞争后服务端已推进，重试返回 G1。 */
let firstBootstrapDone = false;
const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const path = typeof input === "string" ? input : input.toString();
  if (path === BOOTSTRAP_PATH) {
    const generation = firstBootstrapDone ? G1 : G0;
    firstBootstrapDone = true;
    return new Response(JSON.stringify({
      accountId: accountA, documentGeneration: generation,
      legacyGeneration: G0, generationOrigin: { kind: "initial" },
      snapshotAvailable: true, restoreWritesAvailable: false,
    }), { status: 200, headers: { "X-Hako-Account": accountA } });
  }
  if (path === SYNC_PATH) return new Response(snapshotWith() as unknown as BodyInit, { status: 204 });
  throw new Error(`unexpected fetch: ${path}`);
});

const renderer = createRenderer({
  patchProp() {}, insert() {}, remove() {}, createElement: () => ({}),
  createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {},
  parentNode: () => null, nextSibling: () => null,
});
const unmounts: Array<() => void> = [];

beforeAll(initializeTestLoro);
beforeEach(() => {
  firstBootstrapDone = false;
  activationHook.interleave = null;
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { onLine: true, locks: { request: async (name: string, fn: () => Promise<unknown>) => {
    const promise = (locks.get(name) ?? Promise.resolve()).then(fn);
    locks.set(name, promise.catch(() => undefined)); return promise;
  } } });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  unmounts.splice(0).forEach((unmount) => unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const db of await indexedDB.databases()) if (db.name) await deleteDB(db.name);
});

it("决策激活 G0 期间另一窗口已接收 G1：CAS 拒绝改回旧代次，重新决策进入保护流程", async () => {
  // 预置迁移得到的 G0 数据（activeGeneration 仍为 null → 决策为 activate）。
  const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
  await repo.receiveGeneration(G0, snapshotWith(), null);
  const dbControl = { ...(await repo.readControl()) };
  // 模拟迁移后尚未激活：直接把共享活动代次清回 null（迁移路径的决策前置状态）。
  const { openDB } = await import("idb");
  const { accountStorageNamesV2 } = await import("../src/data/account-storage");
  const db = await openDB(accountStorageNamesV2(accountA).records);
  await db.put("control", { ...dbControl, activeGeneration: null }, "control");
  db.close();

  // 决策与激活之间：另一窗口接收服务端 G1（服务端此刻也已推进）。
  activationHook.interleave = async (hooked) => {
    await hooked.receiveGeneration(G1, snapshotWith((doc) => writeRecord(doc, "one", { stationName: "G1 记录" }, false)), null);
  };
  let local!: ReturnType<typeof useLocalRefueling>;
  const app = renderer.createApp({
    setup() {
      local = useLocalRefueling({ accountId: accountA, active: () => true, onSessionRejected() {} });
      return () => null;
    },
  });
  app.mount({});
  unmounts.push(() => app.unmount());
  await local.initialize();

  // CAS 拒绝旧激活：共享控制保持 G1；本窗口重新决策后进入保护流程，
  // 已挂载的 G0 工作区不被自动切换（记录仍是 G0 的）。
  const control = await repo.readControl();
  expect(control.activeGeneration).toBe(G1);
  await vi.waitFor(() => expect(local.generationFlow.value.phase).toBe("protected"));
  expect(local.generationFlow.value).toMatchObject({ localGeneration: G0, serverGeneration: G1 });
  expect(local.workspaceGeneration.value).toBe(G0);
  expect(local.records.value[0]?.stationName).toBe(syntheticRecord.stationName);
  repo.close();
});

it("无竞争时激活照常完成：CAS 前置状态匹配则写入并激活工作区", async () => {
  const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
  await repo.receiveGeneration(G0, snapshotWith(), null);
  const { openDB } = await import("idb");
  const { accountStorageNamesV2 } = await import("../src/data/account-storage");
  const db = await openDB(accountStorageNamesV2(accountA).records);
  const control = await db.get("control", "control");
  await db.put("control", { ...control!, activeGeneration: null }, "control");
  db.close();

  let local!: ReturnType<typeof useLocalRefueling>;
  const app = renderer.createApp({
    setup() {
      local = useLocalRefueling({ accountId: accountA, active: () => true, onSessionRejected() {} });
      return () => null;
    },
  });
  app.mount({});
  unmounts.push(() => app.unmount());
  await local.initialize();

  expect((await repo.readControl()).activeGeneration).toBe(G0);
  expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true });
  expect(local.records.value).toHaveLength(1);
  repo.close();
});
