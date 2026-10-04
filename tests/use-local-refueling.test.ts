// 代次工作流编排层测试：真实 v2 记录库（fake-indexeddb）+ 可注入 fetch + Vue
// 自定义 renderer，验证 useLocalRefueling 的实际编排时序——离线打开、旧窗口漂移
// 保护、代次接收 CAS、回网重判与同步 409 保护流程。不冒充真实浏览器；真机与
// 双浏览器上下文验收边界由本地验证记录如实维护。

import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB, openDB } from "idb";
import { createRenderer } from "vue";
import { LoroDoc } from "loro-crdt/web";
import { accountA, initializeTestLoro, syntheticRecord } from "./helpers/sync-fixtures";
import { openLocalRefuelingV2 } from "../src/data/local-refueling-v2";
import { accountStorageNamesV2 } from "../src/data/account-storage";
import { useLocalRefueling } from "../src/composables/useLocalRefueling";
import { writeRecord } from "../src/data/refueling-document";
import {
  BOOTSTRAP_PATH,
  SYNC_CONTENT_TYPE,
  SYNC_PATH,
  SYNC_PROTOCOL,
} from "../src/shared/sync-protocol";

vi.mock("../src/data/loro-runtime", () => ({ initializeLoro: async () => undefined }));

/** 终态落盘注入（R10 四/五轮）：failResolve 计数抛配额错误；pauseResolve 挂起一次终态写入。 */
const restoreOutcomeHook = vi.hoisted(() => ({ failResolve: 0, pauseResolve: null as Promise<void> | null }));
vi.mock("../src/data/local-refueling-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/local-refueling-v2")>();
  return {
    ...actual,
    openLocalRefuelingV2: async (options: import("../src/data/local-refueling-v2").OpenLocalRefuelingV2Options) => {
      const repository = await actual.openLocalRefuelingV2(options);
      return {
        ...repository,
        resolveRestoreOutcome: async (outcome: import("../src/data/refueling-restore").RestoreOutcomeRecord) => {
          if (restoreOutcomeHook.pauseResolve !== null) {
            const waiting = restoreOutcomeHook.pauseResolve;
            restoreOutcomeHook.pauseResolve = null;
            await waiting;
          }
          if (restoreOutcomeHook.failResolve > 0) {
            restoreOutcomeHook.failResolve -= 1;
            throw new DOMException("quota", "QuotaExceededError");
          }
          return repository.resolveRestoreOutcome(outcome);
        },
      };
    },
  };
});
const G0 = "00000000-0000-4000-8000-0000000000a1";
const G1 = "00000000-0000-4000-8000-0000000000a2";
const G2 = "00000000-0000-4000-8000-0000000000a3";

function snapshotWith(mutate?: (doc: LoroDoc) => void): Uint8Array {
  const doc = new LoroDoc();
  try {
    writeRecord(doc, "one", syntheticRecord, true);
    mutate?.(doc);
    return doc.export({ mode: "snapshot" });
  } finally { doc.free(); }
}

/** bootstrap/同步/快照的可编程 fetch mock。 */
function createServerMock() {
  const state = {
    bootstrapGeneration: G0 as string,
    bootstrapLegacy: G0 as string,
    snapshotGeneration: G0 as string,
    offline: false,
    syncStatus: 200 as number,
    syncResponseGeneration: null as string | null,
  };
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, headers });
    if (state.offline) throw new TypeError("offline");
    if (path === BOOTSTRAP_PATH) {
      return new Response(JSON.stringify({
        accountId: accountA, documentGeneration: state.bootstrapGeneration,
        legacyGeneration: state.bootstrapLegacy, generationOrigin: { kind: "initial" },
        snapshotAvailable: true, restoreWritesAvailable: false,
      }), { status: 200, headers: { "X-Hako-Account": accountA } });
    }
    if (path === SYNC_PATH && init?.method === "GET") {
      return new Response(snapshotWith() as unknown as BodyInit, {
        status: 200,
        headers: {
          "X-Hako-Account": accountA, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
          "X-Hako-Document-Generation": state.snapshotGeneration, "X-Hako-Revision": "3",
          "Content-Type": SYNC_CONTENT_TYPE,
        },
      });
    }
    if (path === SYNC_PATH && init?.method === "POST") {
      if (state.syncStatus === 409) {
        return new Response(JSON.stringify({
          error: "document_generation_changed", currentGeneration: state.syncResponseGeneration ?? state.bootstrapGeneration,
          legacyGeneration: state.bootstrapLegacy, revision: 3,
        }), { status: 409 });
      }
      const body = new Uint8Array(await (new Response(init.body as BodyInit).arrayBuffer()));
      return new Response(body as unknown as BodyInit, {
        status: state.syncStatus,
        headers: {
          "X-Hako-Account": accountA, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
          "X-Hako-Document-Generation": state.syncResponseGeneration ?? headers["X-Hako-Document-Generation"],
          "X-Hako-Revision": "3", "Content-Type": SYNC_CONTENT_TYPE,
        },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
  return { state, fetch, calls };
}

/** 挂载一个使用 useLocalRefueling 的伪应用（无 DOM renderer）。 */
const renderer = createRenderer({
  patchProp() {}, insert() {}, remove() {}, createElement: () => ({}),
  createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {},
  parentNode: () => null, nextSibling: () => null,
});
const unmounts: Array<() => void> = [];
type LocalHandle = ReturnType<typeof useLocalRefueling>;
function mountLocal(fetchMock?: typeof fetch): LocalHandle {
  let local!: LocalHandle;
  const app = renderer.createApp({
    setup() {
      local = useLocalRefueling({ accountId: accountA, active: () => true, onSessionRejected() {} });
      return () => null;
    },
  });
  app.mount({});
  unmounts.push(() => app.unmount());
  // fetch 注入：composable 内 bootstrapRefueling/fetchRefuelingSnapshot 使用全局 fetch。
  if (fetchMock !== undefined) vi.stubGlobal("fetch", fetchMock);
  return local;
}

async function closeDatabases() {
  for (const db of await indexedDB.databases()) if (db.name) await deleteDB(db.name);
}

beforeAll(initializeTestLoro);
beforeEach(() => {
  restoreOutcomeHook.failResolve = 0;
  restoreOutcomeHook.pauseResolve = null;
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { onLine: true, locks: { request: async (name: string, fn: () => Promise<unknown>) => {
    const promise = (locks.get(name) ?? Promise.resolve()).then(fn);
    locks.set(name, promise.catch(() => undefined)); return promise;
  } } });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
});
afterEach(async () => {
  unmounts.splice(0).forEach((unmount) => unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await closeDatabases();
});

describe("代次工作流编排：离线与回网（R3）", () => {
  it("已持久 v2 工作区在离线时仍可打开；未知 legacy 绑定不随机生成", async () => {
    // 预置此前已 bootstrap 并接收过的本机副本（合成既有设备状态）。
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    await repo.save(G0, "one", { stationName: "离线前修改" }, false);
    repo.close();

    const server = createServerMock();
    server.state.offline = true;
    const local = mountLocal(server.fetch);
    await local.initialize();

    expect(local.ready.value).toBe(true);
    expect(local.records.value).toHaveLength(1);
    expect(local.records.value[0].stationName).toBe("离线前修改");
    const flow = local.generationFlow.value;
    expect(flow).toMatchObject({ phase: "active", generation: G0, serverConfirmed: false });
    expect(local.notice.value).toContain("代次待联网确认");

    // 回网：bootstrap 成功且服务端仍在本机代次 → 确认 active。
    server.state.offline = false;
    local.retryOpen();
    await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true }));
  });

  it("回网后发现服务端已恢复到新代次：进入保护流程，旧副本保留", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    repo.close();

    const server = createServerMock();
    server.state.offline = true;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: false });

    server.state.offline = false;
    server.state.bootstrapGeneration = G1;
    local.retryOpen();
    await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({
      phase: "protected", localGeneration: G0, serverGeneration: G1,
    }));
    // 本机工作区绑定仍是旧代次（记录可核对），保存由保护流程冻结。
    expect(local.workspaceGeneration.value).toBe(G0);
    expect(local.records.value).toHaveLength(1);
  });

  it("无本机数据且离线：进入可重试的失败流程，不打开空工作区", async () => {
    const server = createServerMock();
    server.state.offline = true;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.ready.value).toBe(false);
    expect(local.generationFlow.value).toMatchObject({ phase: "failed" });
  });

  it("仅有 v1 数据且尚未 bootstrap：离线不迁移；联网 bootstrap 后迁移并激活 G0", async () => {
    // 预置 v1 库（升级前正式账号）。
    const legacy = new LoroDoc();
    writeRecord(legacy, "pre", syntheticRecord, true);
    const v1 = await openDB(`hako-account-v1:${accountA}:refueling`, 1, { upgrade(db) { db.createObjectStore("documents"); } });
    await v1.put("documents", {
      schemaVersion: 1, snapshot: legacy.export({ mode: "snapshot" }),
      version: legacy.version().encode(), acknowledgedVersion: null,
      pendingSync: true, legacyImports: {},
    }, "main");
    v1.close();

    const server = createServerMock();
    server.state.offline = true;
    const offlineLocal = mountLocal(server.fetch);
    await offlineLocal.initialize();
    expect(offlineLocal.generationFlow.value).toMatchObject({ phase: "failed" });
    // 未随机生成代次：v2 库没有任何文档。
    const names = accountStorageNamesV2(accountA);
    const probe = await openDB(names.records);
    expect(await probe.count("documents")).toBe(0);
    probe.close();

    server.state.offline = false;
    offlineLocal.retryOpen();
    await vi.waitFor(() => expect(offlineLocal.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true }));
    expect(offlineLocal.records.value).toHaveLength(1);
    expect(offlineLocal.records.value[0].id).toBe("pre");
  });
});

describe("代次工作流编排：接收、漂移与保护（R1/R2）", () => {
  it("全新浏览器经 bootstrap 接收当前代次；随后同步 409 进入保护流程", async () => {
    const server = createServerMock();
    const local = mountLocal(server.fetch);
    await local.initialize();

    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true });
    expect(local.records.value).toHaveLength(1);
    // bootstrap→GET→接收 的请求时序与协议头。
    // GET 快照请求只带账号与协议头（不携带代次；响应才携带）。
    const snapshotCall = server.calls.find((call) => call.path === SYNC_PATH && call.headers["X-Hako-Sync-Protocol"] === SYNC_PROTOCOL && !call.headers["Origin"])!;
    expect(snapshotCall.headers["X-Hako-Account"]).toBe(accountA);
    const bootstrapCall = server.calls.find((call) => call.path === BOOTSTRAP_PATH)!;
    expect(bootstrapCall.headers["X-Hako-Account"]).toBe(accountA);

    // 服务端推进到 G1：下一次同步 409 → 保护流程（不触发登录循环）。
    server.state.syncStatus = 409;
    server.state.syncResponseGeneration = G1;
    await local.retrySync();
    await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({
      phase: "protected", localGeneration: G0, serverGeneration: G1,
    }));
    expect(local.workspaceGeneration.value).toBe(G0);
  });

  it("保护流程中打开恢复后数据：下载-接收成功切换工作区代次", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    repo.close();
    const server = createServerMock();
    server.state.bootstrapGeneration = G1;
    server.state.snapshotGeneration = G1;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "protected", localGeneration: G0, serverGeneration: G1 });

    const result = await local.openCurrentGeneration();
    expect(result.ok).toBe(true);
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G1, serverConfirmed: true });
    expect(local.workspaceGeneration.value).toBe(G1);
    expect(local.records.value).toHaveLength(1);
    // 旧副本保留可读。
    const summaries = await local.listRetainedGenerations(G1);
    expect(summaries.map((summary) => summary.generation)).toEqual([G0]);
  });

  it("下载期间服务端又推进：CAS 目标不匹配时重新提示，不接收旧目标", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    repo.close();
    const server = createServerMock();
    server.state.bootstrapGeneration = G1;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "protected", serverGeneration: G1 });

    // GET 返回比保护提示更新的代次（服务端又推进）：不能把旧目标写进本机。
    server.state.snapshotGeneration = G2;
    server.state.bootstrapGeneration = G2;
    const result = await local.openCurrentGeneration();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("更新");
    // 重新 bootstrap 决策后按 G2 重新提示，不接收旧目标。
    await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "protected", serverGeneration: G2 }));
    expect(local.workspaceGeneration.value).toBe(G0);
    // 本机未写入任何新代次副本。
    const repoCheck = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    expect((await repoCheck.listRetainedGenerations(null)).map((s) => s.generation)).toEqual([G0]);
    repoCheck.close();
    expect(local.workspaceGeneration.value).toBe(G0);
  });

  it("旧窗口在共享控制推进后保存：写回原代次保留副本并转入保护流程", async () => {
    // 预置两个"标签页"共享的本机状态：G0 已激活，另一窗口接收了 G1。
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    repo.close();
    const server = createServerMock();
    server.state.bootstrapGeneration = G1;
    const localA = mountLocal(server.fetch);
    await localA.initialize();
    expect(localA.generationFlow.value).toMatchObject({ phase: "protected", localGeneration: G0, serverGeneration: G1 });

    // 模拟未收到通知的旧窗口（无 BroadcastChannel 环境）：直接保存绑定 G0。
    // 编排层的保存经 mutate 绑定 workspaceGeneration；保护流程冻结保存——
    // 此处验证被保护后保存被拒绝，数据不进入新代次。
    const saved = await (localA.save as unknown as (id: string, patch: Record<string, unknown>, creating: boolean) => Promise<boolean>)("one", { stationName: "stale form" }, false);
    expect(saved).toBe(false);
    // 本机 G0 副本未被改动，也没有任何窗口把数据写进未知的新代次。
    const repoAfter = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    const current = await repoAfter.readGenerationState(G0);
    expect(current.records[0]?.stationName).toBe(syntheticRecord.stationName);
    expect((await repoAfter.listRetainedGenerations(null)).map((s) => s.generation)).toEqual([G0]);
    repoAfter.close();
  });

  it("活跃窗口的保存与同步确认绑定当前代次；接收确认后刷新记录", async () => {
    const server = createServerMock();
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0 });

    const saved = await (localA_save(local))("one", { stationName: "编排层修改" }, false);
    expect(saved).toBe(true);
    expect(local.records.value[0].stationName).toBe("编排层修改");
    expect(local.pendingSync.value).toBe(true);

    // 同步成功：请求头携带代次；确认落盘后不再待传。
    await local.retrySync();
    await vi.waitFor(() => expect(local.pendingSync.value).toBe(false));
    const syncCall = server.calls.filter((call) => call.path === SYNC_PATH).at(-1)!;
    expect(syncCall.headers["X-Hako-Document-Generation"]).toBe(G0);
  });
});

function localA_save(local: LocalHandle): (id: string, patch: Record<string, unknown>, creating: boolean) => Promise<boolean> {
  return local.save as unknown as (id: string, patch: Record<string, unknown>, creating: boolean) => Promise<boolean>;
}

describe("代次工作流编排：后台确认与已挂载旧工作区（R1/R2 二轮）", () => {
  it("迟到的 bootstrap 不得切换已挂载旧工作区：进入保护流程等待本人接收", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    // bootstrap 挂起：本窗口先按持久 G0 离线打开（已挂载 G0 表单/草稿）。
    let finishBootstrap!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { finishBootstrap = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => delayed));
    const local = mountLocal();
    await vi.waitFor(() => expect(local.workspaceGeneration.value).toBe(G0));

    // 另一窗口接收 G1，推进共享 control；随后本窗口迟到的 bootstrap 才返回 G1。
    await repo.receiveGeneration(G1, snapshotWith((doc) => writeRecord(doc, "one", { stationName: "new generation" }, false)), G0);
    finishBootstrap(new Response(JSON.stringify({
      accountId: accountA, documentGeneration: G1, legacyGeneration: G0,
      generationOrigin: { kind: "initial" }, snapshotAvailable: true, restoreWritesAvailable: false,
    }), { status: 200, headers: { "X-Hako-Account": accountA } }));
    await local.initialize();

    // 共享已接收 ≠ 本窗口已确认：旧工作区保持挂载，进入保护流程，记录仍是旧代次的。
    expect(local.workspaceGeneration.value).toBe(G0);
    expect(local.generationFlow.value.phase).toBe("protected");
    expect(local.records.value[0]?.stationName).toBe(syntheticRecord.stationName);
    repo.close();
  });

  it("共享控制提前推进：刷新进入保护流程，本人选择后才切换工作区", async () => {
    const server = createServerMock();
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true });

    // 另一窗口接收 G1（共享 control 推进）；本窗口聚焦刷新发现漂移。
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G1, snapshotWith((doc) => writeRecord(doc, "one", { stationName: "G1 记录" }, false)), G0);
    await local.refresh();
    expect(local.generationFlow.value).toMatchObject({ phase: "protected", localGeneration: G0, serverGeneration: G1 });
    expect(local.workspaceGeneration.value).toBe(G0);
    expect(local.records.value[0]?.stationName).toBe(syntheticRecord.stationName);

    // 本人选择打开恢复后数据：切换到 G1，旧副本保留。
    server.state.snapshotGeneration = G1;
    const result = await local.openCurrentGeneration();
    expect(result.ok).toBe(true);
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G1, serverConfirmed: true });
    expect(local.workspaceGeneration.value).toBe(G1);
    expect(local.records.value[0]?.stationName).toBe("G1 记录");
    repo.close();
  });

  it("重试打开失败不得先卸载已挂载旧工作区：key 与记录保持", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    repo.close();
    const server = createServerMock();
    server.state.offline = true;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: false });

    // 仍离线时显式重试：bootstrap 失败，已挂载的 G0 工作区不被先拆成 pending/opening。
    local.retryOpen();
    await local.initialize();
    expect(local.workspaceGeneration.value).toBe(G0);
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: false });
    expect(local.ready.value).toBe(true);
    expect(local.records.value).toHaveLength(1);
  });
});

describe("代次工作流编排：待确认恢复查询（R10）", () => {
  it("本机与服务端代次一致（active）时同样查询待确认回执并落盘终态", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    const requestId = "00000000-0000-4000-8000-0000000000c1";
    const fingerprint = "a".repeat(64);
    // B 已把本机接收为 G1，但终态落盘失败：pending 仍保留，控制活动代次为 G1。
    await repo.receiveGeneration(G1, snapshotWith(), null);
    await repo.setPendingRestore({
      requestId, requestFingerprint: fingerprint, createdAtMs: 1,
      body: { requestId, previewId: G2, backupStreamId: G2, revision: 1,
        bundleSha256: "b".repeat(64), expectedGeneration: G0,
        expectedRevision: 2, expectedSnapshotSha256: "c".repeat(64) },
    });
    repo.close();

    const server = createServerMock();
    server.state.bootstrapGeneration = G1;
    let receiptQueries = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/requests/")) {
        receiptQueries += 1;
        return new Response(JSON.stringify({
          outcome: "committed", requestId, requestFingerprint: fingerprint,
          previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
          baselinePending: true, committedAt: "2026-10-05T00:00:00.000Z",
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      return server.fetch(input, init);
    });
    const local = mountLocal(fetchMock);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G1, serverConfirmed: true });

    // active 状态同样发起了回执查询；committed 终态先落盘再解除待确认。
    await vi.waitFor(() => expect(receiptQueries).toBeGreaterThan(0));
    await vi.waitFor(async () => {
      const repoCheck = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
      const pending = (await repoCheck.readControl()).pendingRestore;
      repoCheck.close();
      expect(pending).toBeNull();
    });
    expect(local.pendingRestore.value).toBeNull();
  });

  it("迟到的回执响应不能把更新的待确认请求在内存里清掉", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    const first = {
      requestId: "00000000-0000-4000-8000-0000000000c1",
      requestFingerprint: "a".repeat(64), createdAtMs: 1,
      body: { requestId: "00000000-0000-4000-8000-0000000000c1", previewId: G2, backupStreamId: G2, revision: 1,
        bundleSha256: "b".repeat(64), expectedGeneration: G0,
        expectedRevision: 2, expectedSnapshotSha256: "c".repeat(64) },
    };
    await repo.receiveGeneration(G1, snapshotWith(), null);
    await repo.setPendingRestore(first);

    // 回执查询挂起：另一窗口在此期间确认了第一笔并留下了更新的第二笔待确认。
    let releaseQuery!: (response: Response) => void;
    const delayedQuery = new Promise<Response>((resolve) => { releaseQuery = resolve; });
    const server = createServerMock();
    server.state.bootstrapGeneration = G1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(`/requests/${first.requestId}`)) return delayedQuery;
      return server.fetch(input, init);
    });
    const local = mountLocal(fetchMock);
    await local.initialize();
    await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G1 }));

    const other = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await other.resolveRestoreOutcome({
      requestId: first.requestId, requestFingerprint: first.requestFingerprint,
      outcome: "committed", decidedAtMs: 2, newGeneration: G1,
      newRevision: 3, notCommittedReason: null,
    });
    const second = await other.setPendingRestore({
      requestId: "00000000-0000-4000-8000-0000000000c2",
      requestFingerprint: "d".repeat(64), createdAtMs: 3,
      body: { requestId: "00000000-0000-4000-8000-0000000000c2", previewId: G2, backupStreamId: G2, revision: 2,
        bundleSha256: "e".repeat(64), expectedGeneration: G1,
        expectedRevision: 3, expectedSnapshotSha256: "f".repeat(64) },
    });

    // 迟到的第一笔回执（committed）到达：不能在内存里清掉第二笔。
    releaseQuery(new Response(JSON.stringify({
      outcome: "committed", requestId: first.requestId, requestFingerprint: first.requestFingerprint,
      previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
      baselinePending: true, committedAt: "2026-10-05T00:00:00.000Z",
    }), { status: 200, headers: { "X-Hako-Account": accountA } }));
    await vi.waitFor(() => expect(local.pendingRestore.value?.requestId).toBe(second.requestId));
    expect((await other.readControl()).pendingRestore?.requestId).toBe(second.requestId);
    other.close();
    repo.close();
  });
});

describe("代次工作流编排：导入冲突按当前代次显示（R6 二轮）", () => {
  it("目标都已不存在的旧冲突不再显示为待核对；历史证据保留在 control", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    // 两个代次各自把同一来源导入到不同目标（同来源多目标）。
    const two = new LoroDoc();
    writeRecord(two, "target-one", syntheticRecord, true);
    writeRecord(two, "target-two", syntheticRecord, true);
    await repo.receiveGeneration(G0, two.export({ mode: "snapshot" }), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const g0 = await db.get("documents", G0);
    await db.put("documents", { ...g0!, legacyImports: { source: "target-one" } }, G0);
    await db.put("documents", { ...g0!, generation: G1, legacyImports: { source: "target-two" } }, G1);
    db.close();
    // 接收仍含两个目标的 G2：继承映射发现同来源双目标，持久记录冲突。
    await repo.receiveGeneration(G2, two.export({ mode: "snapshot" }), G0);
    two.free();
    expect(Object.keys((await repo.readControl()).importConflicts)).toContain("source");
    // 恢复到不含任一目标的 G3：旧冲突不再阻断当前代次的手动导入。
    const three = new LoroDoc();
    writeRecord(three, "unrelated", syntheticRecord, true);
    await repo.receiveGeneration(G3, three.export({ mode: "snapshot" }), G2);
    three.free();
    repo.close();

    const server = createServerMock();
    server.state.bootstrapGeneration = G3;
    server.state.snapshotGeneration = G3;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G3, serverConfirmed: true });

    // control 里历史冲突仍在；当前代次（G3）读结果的冲突视图已按仍存在目标过滤。
    const repoCheck = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    expect(Object.keys((await repoCheck.readControl()).importConflicts)).toContain("source");
    expect(local.importConflicts.value).toEqual({});

    // 重新导入该来源：G3 无仍存在目标 → 允许，生成新记录（新 ID）。
    const imported = await (localA_save_import(local))([{ ...syntheticRecord, id: "source" }]);
    expect(imported).toBe(true);
    expect(local.records.value).toHaveLength(2);
    expect(local.records.value.map((record) => record.id)).toContain("unrelated");
    expect(local.importedLegacyIds.value).toContain("source");
    repoCheck.close();
  });
});

const G3 = "00000000-0000-4000-8000-0000000000a4";

describe("代次工作流编排：重开生命周期（R1/R2/R11 三轮）", () => {
  /** 预置「迁移后待联网激活」状态：G0 已持久、active=null、legacy=G0——UI 显示重试确认。 */
  async function seedRetainedOnly() {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const control = await db.get("control", "control");
    await db.put("control", { ...control!, activeGeneration: null, legacyGeneration: G0 }, "control");
    db.close();
    return repo;
  }

  it("重开本机库失败（IndexedDB open 抛错）：已挂载工作区 key/记录保持，错误可重试", async () => {
    const repo = await seedRetainedOnly();
    const server = createServerMock();
    server.state.offline = true;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.workspaceGeneration.value).toBe(G0);
    expect(local.generationFlow.value).toMatchObject({ phase: "protected", serverGeneration: null });

    // UI「重试确认」触发重开；新连接打开失败（真实 IndexedDB open 边界抛 UnknownError）。
    const failOpen = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      throw new DOMException("transient open failure", "UnknownError");
    });
    try {
      local.retryOpen();
      await local.initialize();
      expect(local.error.value).toContain("transient open failure");
      // 已挂载工作区不被卸载：key 保持 G0，旧表单/草稿实例原样保留。
      // （retained-only 首开不加载主列表记录，重开失败同样不得改变既有状态。）
      expect(local.workspaceGeneration.value).toBe(G0);
      expect(local.generationFlow.value).toMatchObject({ phase: "protected", serverGeneration: null });
      expect(local.records.value).toEqual([]);
      expect(local.ready.value).toBe(true);
    } finally {
      failOpen.mockRestore();
    }

    // 瞬时故障恢复后重试成功：激活 G0（旧实例在此期间始终未被拆掉）。
    server.state.offline = false;
    local.retryOpen();
    await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true }));
    repo.close();
  });

  it("重开失败后旧 repository 仍可用：保存继续落在当前工作区", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    repo.close();
    const server = createServerMock();
    server.state.offline = true;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: false });

    const failOpen = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      throw new DOMException("reopen failed", "UnknownError");
    });
    try {
      local.retryOpen();
      await local.initialize();
      expect(local.error.value).toContain("reopen failed");
      // 失败重开不卸载工作区、不换绑 repository：保存照常工作。
      expect(local.workspaceGeneration.value).toBe(G0);
      const saved = await (localA_save(local))("one", { stationName: "重开失败后的修改" }, false);
      expect(saved).toBe(true);
      expect(local.records.value[0]?.stationName).toBe("重开失败后的修改");
    } finally {
      failOpen.mockRestore();
    }
  });

  it("重开替换同步客户端：旧实例停用且不可中途复活，新实例只绑当前 repository", async () => {
    const { RefuelingSyncClient } = await import("../src/data/refueling-sync");
    const clients = new Set<InstanceType<typeof RefuelingSyncClient>>();
    const original = RefuelingSyncClient.prototype.setEnabled;
    const hook = vi.spyOn(RefuelingSyncClient.prototype, "setEnabled").mockImplementation(function (this: InstanceType<typeof RefuelingSyncClient>, enabled: boolean) {
      clients.add(this);
      return original.call(this, enabled);
    });
    try {
      const repo = await seedRetainedOnly();
      const server = createServerMock();
      server.state.offline = true;
      const local = mountLocal(server.fetch);
      await local.initialize();
      const first = [...clients][0]!;
      expect(local.generationFlow.value).toMatchObject({ phase: "protected", serverGeneration: null });
      expect((first as unknown as { enabled: boolean }).enabled).toBe(false);

      // 用户点「重试确认」且已回网：重开成功激活 G0。旧客户端在整个重开过程中
      // 不得被再次启用（中途 setFlow(active) 不能复活绑定旧 repository 的实例）。
      server.state.offline = false;
      local.retryOpen();
      await local.initialize();
      await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true }));
      expect(clients.size).toBe(2);
      expect((first as unknown as { enabled: boolean }).enabled).toBe(false);
      const second = [...clients][1]!;
      expect((second as unknown as { enabled: boolean }).enabled).toBe(true);
      repo.close();
    } finally {
      for (const client of clients) original.call(client, false);
      hook.mockRestore();
    }
  });

  it("已启用同步时重开：旧客户端被停用中止，替换后只有新客户端运行", async () => {
    const { RefuelingSyncClient } = await import("../src/data/refueling-sync");
    const clients = new Set<InstanceType<typeof RefuelingSyncClient>>();
    const original = RefuelingSyncClient.prototype.setEnabled;
    const hook = vi.spyOn(RefuelingSyncClient.prototype, "setEnabled").mockImplementation(function (this: InstanceType<typeof RefuelingSyncClient>, enabled: boolean) {
      clients.add(this);
      return original.call(this, enabled);
    });
    try {
      const server = createServerMock();
      const local = mountLocal(server.fetch);
      await local.initialize();
      const first = [...clients][0]!;
      expect((first as unknown as { enabled: boolean }).enabled).toBe(true);

      // 离线重开（bootstrap 失败但工作区保持）：旧客户端停用，末尾装配的新客户端
      // 绑定当前 repository 并按 active 流程启用；旧实例不会再被启用。
      server.state.offline = true;
      local.retryOpen();
      await local.initialize();
      expect(clients.size).toBe(2);
      expect((first as unknown as { enabled: boolean }).enabled).toBe(false);
      expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: false });
      expect(local.workspaceGeneration.value).toBe(G0);
      const second = [...clients][1]!;
      expect((second as unknown as { enabled: boolean }).enabled).toBe(true);
    } finally {
      for (const client of clients) original.call(client, false);
      hook.mockRestore();
    }
  });
});

describe("代次工作流编排：唯一存活导入目标（R6 三轮）", () => {
  it("历史冲突只剩一个仍存在目标：不显示冲突、映射沿用幂等不建重复记录", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    const snap = (ids: string[]) => {
      const doc = new LoroDoc();
      try {
        for (const id of ids) writeRecord(doc, id, syntheticRecord, true);
        return doc.export({ mode: "snapshot" });
      } finally { doc.free(); }
    };
    // G0 两代次各自导入同来源到不同目标；接收仍含两目标的 G2 记录冲突。
    await repo.receiveGeneration(G0, snap(["target-one", "target-two"]), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const old = await db.get("documents", G0);
    await db.put("documents", { ...old!, legacyImports: { source: "target-one" } }, G0);
    await db.put("documents", { ...old!, generation: G1, legacyImports: { source: "target-two" } }, G1);
    db.close();
    await repo.receiveGeneration(G2, snap(["target-one", "target-two"]), G0);
    expect(Object.keys((await repo.readControl()).importConflicts)).toContain("source");
    // 恢复到只剩 target-one 的 G3：继承唯一映射，当前不再构成多目标冲突。
    await repo.receiveGeneration(G3, snap(["target-one"]), G2);
    repo.close();

    const server = createServerMock();
    server.state.bootstrapGeneration = G3;
    server.state.snapshotGeneration = G3;
    const local = mountLocal(server.fetch);
    await local.initialize();
    expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G3, serverConfirmed: true });
    expect(local.importedLegacyIds.value).toContain("source");
    // 历史冲突证据保留在 control；当前视图按仍存在目标过滤后无冲突。
    expect(local.importConflicts.value).toEqual({});
    const repoCheck = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    expect((await repoCheck.readControl()).importConflicts["source"]).toHaveLength(2);

    // 重复导入该来源：沿用唯一映射幂等，不创建重复记录。
    const outcome = await repoCheck.importLegacy(G3, [{ ...syntheticRecord, id: "source" }]);
    expect(outcome.records.map((record) => record.id)).toEqual(["target-one"]);
    repoCheck.close();
  });

  it("映射缺失但历史事实只剩唯一存活目标：补记映射，不创建第三个目标", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    const snap = (ids: string[]) => {
      const doc = new LoroDoc();
      try {
        for (const id of ids) writeRecord(doc, id, syntheticRecord, true);
        return doc.export({ mode: "snapshot" });
      } finally { doc.free(); }
    };
    await repo.receiveGeneration(G0, snap(["target-one", "target-two"]), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const old = await db.get("documents", G0);
    await db.put("documents", { ...old!, legacyImports: { source: "target-one" } }, G0);
    await db.put("documents", { ...old!, generation: G1, legacyImports: { source: "target-two" } }, G1);
    db.close();
    await repo.receiveGeneration(G2, snap(["target-one", "target-two"]), G0);
    await repo.receiveGeneration(G3, snap(["target-one"]), G2);
    // 带外破坏：抹掉 G3 继承到的映射（模拟映射缺失的历史状态）。
    const db3 = await openDB(accountStorageNamesV2(accountA).records);
    const g3 = await db3.get("documents", G3);
    await db3.put("documents", { ...g3!, legacyImports: {} }, G3);
    db3.close();
    const outcome = await repo.importLegacy(G3, [{ ...syntheticRecord, id: "source" }]);
    // 唯一存活目标 target-one：沿用映射，不创建第三个记录。
    expect(outcome.records.map((record) => record.id)).toEqual(["target-one"]);
    expect(outcome.importedLegacyIds).toContain("source");
    repo.close();
  });
});
function localA_save_import(local: LocalHandle): (selected: { id: string }[]) => Promise<boolean> {
  return local.importLegacy as unknown as (selected: { id: string }[]) => Promise<boolean>;
}

describe("代次工作流编排：异步出口收尾（R10/R11 四轮）", () => {
  it("持久性查询失败不产生第二个同步客户端；卸载后所有实例停用", async () => {
    const { RefuelingSyncClient } = await import("../src/data/refueling-sync");
    const clients = new Set<InstanceType<typeof RefuelingSyncClient>>();
    const original = RefuelingSyncClient.prototype.setEnabled;
    const hook = vi.spyOn(RefuelingSyncClient.prototype, "setEnabled").mockImplementation(function (this: InstanceType<typeof RefuelingSyncClient>, enabled: boolean) {
      clients.add(this);
      return original.call(this, enabled);
    });
    vi.stubGlobal("navigator", { ...navigator, storage: { persisted: async () => { throw new Error("persisted query failed"); } } });
    const server = createServerMock();
    const local = mountLocal(server.fetch);
    try {
      await local.initialize();
      expect(local.generationFlow.value).toMatchObject({ phase: "active", generation: G0, serverConfirmed: true });
      // 装配唯一：可选持久性查询失败不触发重装，运行实例恰好一个。
      const running = [...clients].filter((client) => (client as unknown as { enabled: boolean }).enabled);
      expect(running).toHaveLength(1);
      // 卸载后所有实例（含历史实例）都停用，无存活计时器。
      unmounts.splice(0).forEach((unmount) => unmount());
      expect([...clients].filter((client) => (client as unknown as { enabled: boolean }).enabled)).toHaveLength(0);
    } finally {
      for (const client of clients) original.call(client, false);
      hook.mockRestore();
    }
  });

  it("committed 回执终态落盘失败：保留原请求、failed 可重试，重试成功后终态确认", async () => {
    // 有效迁移后状态：G0 已持久、active=null、legacy=G0（离线 retained-only），
    // 并有待确认恢复请求；回执端点返回 committed。
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const control = await db.get("control", "control");
    await db.put("control", { ...control!, activeGeneration: null, legacyGeneration: G0 }, "control");
    db.close();
    const requestId = "00000000-0000-4000-8000-0000000000c1";
    const fingerprint = "a".repeat(64);
    await repo.setPendingRestore({
      requestId, requestFingerprint: fingerprint, createdAtMs: 1,
      body: { requestId, previewId: G2, backupStreamId: G2, revision: 1,
        bundleSha256: "b".repeat(64), expectedGeneration: G0,
        expectedRevision: 2, expectedSnapshotSha256: "c".repeat(64) },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/requests/")) {
        return new Response(JSON.stringify({
          outcome: "committed", requestId, requestFingerprint: fingerprint,
          previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
          baselinePending: true, committedAt: "2026-10-05T00:00:00.000Z",
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      throw new TypeError("offline");
    });
    // 挂载前注入一次终态落盘失败：首开的自动回执查询即命中配额错误。
    restoreOutcomeHook.failResolve = 1;
    const local = mountLocal(fetchMock);
    try {
      await local.initialize();
      expect(local.generationFlow.value).toMatchObject({ phase: "protected", serverGeneration: null });
      await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "protected", receipt: "failed" }));
      // 原请求保留、未虚报终态；错误可读；离开 checking。
      expect(local.pendingRestore.value?.requestId).toBe(requestId);
      expect(local.error.value).toContain("本机保存恢复结果失败");
      const repoCheck = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
      expect((await repoCheck.readControl()).pendingRestore?.requestId).toBe(requestId);
      expect((await repoCheck.readControl()).restoreOutcomes[requestId]).toBeUndefined();
      repoCheck.close();

      // 释放空间后重查：落盘成功 → 终态确认、待确认解除。
      local.recheckRestoreReceipt();
      await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "protected", receipt: "committed" }));
      const repoAfter = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
      await vi.waitFor(async () => {
        const pending = (await repoAfter.readControl()).pendingRestore;
        expect(pending).toBeNull();
      });
      expect((await repoAfter.readControl()).restoreOutcomes[requestId]?.outcome).toBe("committed");
      repoAfter.close();
      expect(local.pendingRestore.value).toBeNull();
      // 本请求重试成功清除本请求的旧错误：页面不再同时显示成功与失败。
      expect(local.error.value).toBe("");
    } finally {
      repo.close();
    }
  });

  it("无关错误不被回执查询成功清除：重试成功只清回执自己的错误文本", async () => {
    // 落盘失败（回执拥有错误文本）后，再触发一个真实的无关错误（重开本机库
    // 失败——重开错误占用 error 位）；重试成功只清回执自己的错误文本。
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const control = await db.get("control", "control");
    await db.put("control", { ...control!, activeGeneration: null, legacyGeneration: G0 }, "control");
    db.close();
    const requestId = "00000000-0000-4000-8000-0000000000c1";
    const fingerprint = "a".repeat(64);
    await repo.setPendingRestore({
      requestId, requestFingerprint: fingerprint, createdAtMs: 1,
      body: { requestId, previewId: G2, backupStreamId: G2, revision: 1,
        bundleSha256: "b".repeat(64), expectedGeneration: G0,
        expectedRevision: 2, expectedSnapshotSha256: "c".repeat(64) },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/requests/")) {
        return new Response(JSON.stringify({
          outcome: "committed", requestId, requestFingerprint: fingerprint,
          previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
          baselinePending: true, committedAt: "2026-10-05T00:00:00.000Z",
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      throw new TypeError("offline");
    });
    restoreOutcomeHook.failResolve = 1;
    const local = mountLocal(fetchMock);
    try {
      await local.initialize();
      await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "protected", receipt: "failed" }));
      expect(local.error.value).toContain("本机保存恢复结果失败");
      // 真实无关错误：重开本机库失败（工作区保持），error 位被重开错误占据。
      const failOpen = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
        throw new DOMException("unrelated reopen failure", "UnknownError");
      });
      try {
        local.retryOpen();
        await local.initialize();
        expect(local.error.value).toContain("unrelated reopen failure");
      } finally {
        failOpen.mockRestore();
      }
      // 回执重试成功：committed，但只清除回执自己的旧错误文本——error 位上的
      // 无关重开错误原样保留。
      local.recheckRestoreReceipt();
      await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "protected", receipt: "committed" }));
      expect(local.error.value).toContain("unrelated reopen failure");
    } finally {
      repo.close();
    }
  });
  it("P1 终态写入在途时新请求 P2 取代：迟到的落盘失败不更新 P2 的界面", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const control = await db.get("control", "control");
    await db.put("control", { ...control!, activeGeneration: null, legacyGeneration: G0 }, "control");
    db.close();
    const first = {
      requestId: "00000000-0000-4000-8000-0000000000c1",
      requestFingerprint: "a".repeat(64), createdAtMs: 1,
      body: { requestId: "00000000-0000-4000-8000-0000000000c1", previewId: G2, backupStreamId: G2, revision: 1,
        bundleSha256: "b".repeat(64), expectedGeneration: G0,
        expectedRevision: 2, expectedSnapshotSha256: "c".repeat(64) },
    };
    await repo.setPendingRestore(first);
    // 内部终态类型（直接落盘用）与 HTTP 回执线格式（committedAt ISO 字符串）分开。
    const receipt = {
      requestId: first.requestId, requestFingerprint: first.requestFingerprint,
      previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
      baselinePending: true, committedAtMs: 2,
    };
    const wireReceipt = {
      outcome: "committed", ...receipt, committedAt: "2026-10-05T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/requests/")) {
        return new Response(JSON.stringify(wireReceipt), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      throw new TypeError("offline");
    });
    // P1 的终态写入挂起（受控 Promise）。
    let rejectOld!: (error: Error) => void;
    restoreOutcomeHook.pauseResolve = new Promise<void>((_, reject) => { rejectOld = reject; });
    const local = mountLocal(fetchMock);
    try {
      await local.initialize();
      expect(local.generationFlow.value).toMatchObject({ phase: "protected", serverGeneration: null });
      // 写入在途期间：另一窗口确认 P1 并登记新请求 P2；本窗口刷新已看到 P2。
      await vi.waitFor(() => expect(restoreOutcomeHook.pauseResolve).toBeNull());
      const { outcomeFromCommittedReceipt } = await import("../src/data/refueling-restore");
      await repo.resolveRestoreOutcome(outcomeFromCommittedReceipt(first, receipt));
      const second = await repo.setPendingRestore({
        requestId: "00000000-0000-4000-8000-0000000000c2",
        requestFingerprint: "d".repeat(64), createdAtMs: 3,
        body: { requestId: "00000000-0000-4000-8000-0000000000c2", previewId: G2, backupStreamId: G2, revision: 2,
          bundleSha256: "e".repeat(64), expectedGeneration: G1,
          expectedRevision: 3, expectedSnapshotSha256: "f".repeat(64) },
      });
      await local.refresh();
      expect(local.pendingRestore.value?.requestId).toBe(second.requestId);

      // P1 的终态写入此刻才以配额错误拒绝：迟到的失败归属 P1，不得更新 P2 界面。
      rejectOld(new DOMException("late quota error", "QuotaExceededError"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(local.pendingRestore.value?.requestId).toBe(second.requestId);
      expect(local.error.value).toBe("");
      expect(local.generationFlow.value).not.toMatchObject({ receipt: "failed" });
      // P2 的持久数据未被删除。
      expect((await repo.readControl()).pendingRestore?.requestId).toBe(second.requestId);
    } finally {
      repo.close();
    }
  });

  it("迟到的 committed 回执不把旧结果标给新 pending：回位 idle 并跟进查询新请求", async () => {
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    const db = await openDB(accountStorageNamesV2(accountA).records);
    const control = await db.get("control", "control");
    await db.put("control", { ...control!, activeGeneration: null, legacyGeneration: G0 }, "control");
    db.close();
    const first = {
      requestId: "00000000-0000-4000-8000-0000000000c1",
      requestFingerprint: "a".repeat(64), createdAtMs: 1,
      body: { requestId: "00000000-0000-4000-8000-0000000000c1", previewId: G2, backupStreamId: G2, revision: 1,
        bundleSha256: "b".repeat(64), expectedGeneration: G0,
        expectedRevision: 2, expectedSnapshotSha256: "c".repeat(64) },
    };
    await repo.setPendingRestore(first);
    const receipt = {
      requestId: first.requestId, requestFingerprint: first.requestFingerprint,
      previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
      baselinePending: true, committedAtMs: 2,
    };
    // P1 的回执查询挂起：期间另一窗口确认 P1 并登记 P2，本窗口刷新看到 P2。
    let releaseQuery!: (response: Response) => void;
    const delayedQuery = new Promise<Response>((resolve) => { releaseQuery = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes(`/requests/${first.requestId}`)) return delayedQuery;
      if (String(input).includes("/requests/")) {
        // P2 的跟进查询：服务端没有 P2 的回执（404 → unknown）。
        return new Response("{}", { status: 404, headers: { "X-Hako-Account": accountA } });
      }
      throw new TypeError("offline");
    });
    const local = mountLocal(fetchMock);
    try {
      await local.initialize();
      await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "protected", receipt: "checking" }));
      const { outcomeFromCommittedReceipt } = await import("../src/data/refueling-restore");
      await repo.resolveRestoreOutcome(outcomeFromCommittedReceipt(first, receipt));
      const second = await repo.setPendingRestore({
        requestId: "00000000-0000-4000-8000-0000000000c2",
        requestFingerprint: "d".repeat(64), createdAtMs: 3,
        body: { requestId: "00000000-0000-4000-8000-0000000000c2", previewId: G2, backupStreamId: G2, revision: 2,
          bundleSha256: "e".repeat(64), expectedGeneration: G1,
          expectedRevision: 3, expectedSnapshotSha256: "f".repeat(64) },
      });
      await local.refresh();
      expect(local.pendingRestore.value?.requestId).toBe(second.requestId);

      // P1 迟到的 committed 到达：不得把 committed 标给 P2——回位 idle 后由
      // 跟进查询处理 P2（本场景服务端无 P2 回执 → unknown）。
      releaseQuery(new Response(JSON.stringify({
        outcome: "committed", requestId: receipt.requestId, requestFingerprint: receipt.requestFingerprint,
        previousGeneration: G0, newGeneration: receipt.newGeneration, previousRevision: 2, newRevision: receipt.newRevision,
        baselinePending: receipt.baselinePending, committedAt: "2026-10-05T00:00:00.000Z",
      }), { status: 200, headers: { "X-Hako-Account": accountA } }));
      await vi.waitFor(() => expect(local.pendingRestore.value?.requestId).toBe(second.requestId));
      await vi.waitFor(() => expect(local.generationFlow.value).toMatchObject({ phase: "protected", receipt: "unknown" }));
      expect(local.generationFlow.value).not.toMatchObject({ receipt: "committed" });
      expect((await repo.readControl()).pendingRestore?.requestId).toBe(second.requestId);
    } finally {
      repo.close();
    }
  });
});
