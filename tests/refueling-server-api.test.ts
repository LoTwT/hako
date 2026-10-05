// 服务端读取客户端（bootstrap/只读快照）测试：响应绑定与失败分类。
// bootstrap 与 GET 都必须核对账号头与代次格式；204 与网络错误按合同分类。

import { describe, expect, it } from "vitest";
import { bootstrapRefueling, fetchBackupStatus, fetchRefuelingSnapshot } from "../src/data/refueling-server-api";
import { accountA } from "./helpers/sync-fixtures";

const generation = "00000000-0000-4000-8000-0000000000a1";

/** 注入固定响应的 fetch 选项（响应体只能读一次，每个断言独立构造）。 */
function fetchOf(response: Response): { accountId: string; fetch: typeof fetch } {
  return { accountId: accountA, fetch: (async () => response) as unknown as typeof fetch };
}

function bootstrapResponse(account = accountA, status = 200) {
  return new Response(JSON.stringify({
    accountId: accountA,
    documentGeneration: generation,
    legacyGeneration: generation,
    generationOrigin: { kind: "initial" },
    snapshotAvailable: false,
    restoreWritesAvailable: false,
  }), { status, headers: { "X-Hako-Account": account } });
}

function snapshotResponse(options: { status?: number; account?: string; generation?: string | null; revision?: string | null } = {}) {
  const status = options.status ?? 200;
  return new Response(new Uint8Array([1, 2, 3]), {
    status,
    headers: {
      "X-Hako-Account": options.account ?? accountA,
      "X-Hako-Sync-Protocol": "2",
      "X-Hako-Document-Generation": options.generation === undefined ? generation : options.generation ?? "",
      "X-Hako-Revision": options.revision === undefined ? "3" : options.revision ?? "",
    },
  });
}

describe("bootstrap 客户端", () => {
  it("成功响应按账号头绑定并返回完整代次信息；restoreWritesAvailable 原样透传", async () => {
    const result = await bootstrapRefueling(fetchOf(bootstrapResponse()));
    expect(result).toEqual({
      ok: true,
      info: {
        accountId: accountA,
        documentGeneration: generation,
        legacyGeneration: generation,
        generationOrigin: { kind: "initial" },
        snapshotAvailable: false,
        restoreWritesAvailable: false,
      },
    });
    const restoreAvailable = new Response(JSON.stringify({
      accountId: accountA, documentGeneration: generation, legacyGeneration: generation,
      generationOrigin: { kind: "initial" }, snapshotAvailable: true, restoreWritesAvailable: true,
    }), { status: 200, headers: { "X-Hako-Account": accountA } });
    const next = await bootstrapRefueling(fetchOf(restoreAvailable));
    expect(next.ok && next.info.restoreWritesAvailable).toBe(true);
  });

  it("账号头不匹配、坏代次格式与坏来源都拒绝；401/409/503/网络按固定错误分类", async () => {
    expect(await bootstrapRefueling(fetchOf(bootstrapResponse("00000000-0000-4000-8000-0000000000ff"))))
      .toEqual({ ok: false, error: "account_changed" });

    const badGeneration = new Response(JSON.stringify({
      accountId: accountA, documentGeneration: "not-a-uuid", legacyGeneration: generation,
      generationOrigin: { kind: "initial" }, snapshotAvailable: false, restoreWritesAvailable: false,
    }), { status: 200, headers: { "X-Hako-Account": accountA } });
    expect(await bootstrapRefueling(fetchOf(badGeneration))).toEqual({ ok: false, error: "unavailable" });

    const badOrigin = new Response(JSON.stringify({
      accountId: accountA, documentGeneration: generation, legacyGeneration: generation,
      generationOrigin: { kind: "other" }, snapshotAvailable: false, restoreWritesAvailable: false,
    }), { status: 200, headers: { "X-Hako-Account": accountA } });
    expect(await bootstrapRefueling(fetchOf(badOrigin))).toEqual({ ok: false, error: "unavailable" });

    expect(await bootstrapRefueling(fetchOf(new Response("{}", { status: 401 })))).toEqual({ ok: false, error: "unauthorized" });
    expect(await bootstrapRefueling(fetchOf(new Response("{}", { status: 409 })))).toEqual({ ok: false, error: "account_changed" });
    expect(await bootstrapRefueling(fetchOf(new Response("{}", { status: 503 })))).toEqual({ ok: false, error: "generation_state_unavailable" });
    expect(await bootstrapRefueling(fetchOf(new Response("{}", { status: 500 })))).toEqual({ ok: false, error: "unavailable" });
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await bootstrapRefueling({ accountId: accountA, fetch: failing })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("只读快照客户端", () => {
  it("200 返回快照与 revision；204 返回 snapshot=null；账号/代次/revision 绑定失败按合同分类", async () => {
    const result = await fetchRefuelingSnapshot(fetchOf(snapshotResponse()));
    expect(result).toEqual({ ok: true, snapshot: { documentGeneration: generation, revision: 3, snapshot: new Uint8Array([1, 2, 3]) } });

    const empty = new Response(null, { status: 204, headers: { "X-Hako-Account": accountA, "X-Hako-Document-Generation": generation, "X-Hako-Revision": "0" } });
    expect(await fetchRefuelingSnapshot(fetchOf(empty)))
      .toEqual({ ok: true, snapshot: { documentGeneration: generation, revision: 0, snapshot: null } });

    expect(await fetchRefuelingSnapshot(fetchOf(snapshotResponse({ account: "00000000-0000-4000-8000-0000000000ff" }))))
      .toEqual({ ok: false, error: "account_changed" });
    expect(await fetchRefuelingSnapshot(fetchOf(snapshotResponse({ generation: "bad" }))))
      .toEqual({ ok: false, error: "unavailable" });
    expect(await fetchRefuelingSnapshot(fetchOf(snapshotResponse({ revision: "x" }))))
      .toEqual({ ok: false, error: "unavailable" });
    expect(await fetchRefuelingSnapshot(fetchOf(new Response("{}", { status: 401 })))).toEqual({ ok: false, error: "unauthorized" });
    expect(await fetchRefuelingSnapshot(fetchOf(new Response("{}", { status: 503 })))).toEqual({ ok: false, error: "generation_state_unavailable" });
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await fetchRefuelingSnapshot({ accountId: accountA, fetch: failing })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("备份状态元数据客户端（面板轮询用）", () => {
  function statusResponse(overrides: Record<string, unknown> = {}, account = accountA) {
    return new Response(JSON.stringify({
      initialized: true,
      state: "current_backed_up",
      currentRevision: 3,
      currentGeneration: generation,
      frozenTaskRevision: null,
      latestCompletedRevision: 3,
      latestCompletedGeneration: generation,
      pendingFromRevision: null,
      pendingToRevision: null,
      pendingSinceMs: null,
      windowDueAtMs: null,
      nextAttemptAtMs: null,
      nextActionAtMs: null,
      blockedError: null,
      cleanupPendingCount: 0,
      currentBackedUp: true,
      ...overrides,
    }), { status: 200, headers: { "X-Hako-Account": account } });
  }

  it("200 解析只读元数据；不下载完整快照字段", async () => {
    const result = await fetchBackupStatus(fetchOf(statusResponse()));
    expect(result).toEqual({
      ok: true,
      status: {
        initialized: true, state: "current_backed_up", currentRevision: 3, currentGeneration: generation,
        frozenTaskRevision: null, latestCompletedRevision: 3, latestCompletedGeneration: generation,
        pendingFromRevision: null, pendingToRevision: null, windowDueAtMs: null, nextAttemptAtMs: null,
        nextActionAtMs: null,
        blockedError: null, cleanupPendingCount: 0, currentBackedUp: true,
      },
    });
    // 有效可行动时间（责任优先级 + 持久失败下限）必须显式解析：客户端不得用窗口时间推算。
    const floored = await fetchBackupStatus(fetchOf(statusResponse({ windowDueAtMs: 1_000, nextAttemptAtMs: 1_000, nextActionAtMs: 900_000 })));
    expect(floored.ok && floored.status.nextActionAtMs).toBe(900_000);
    expect(await fetchBackupStatus(fetchOf(statusResponse({ nextActionAtMs: "soon" }))))
      .toEqual({ ok: false, error: "unavailable" });
    const blocked = await fetchBackupStatus(fetchOf(statusResponse({ state: "blocked", blockedError: "backup_upload_failed", currentBackedUp: false, latestCompletedRevision: 2 })));
    expect(blocked.ok && blocked.status.state).toBe("blocked");
    expect(blocked.ok && blocked.status.blockedError).toBe("backup_upload_failed");
  });

  it("账号头/形状/状态码的网络与解析失败都按错误返回，不产生部分状态", async () => {
    expect(await fetchBackupStatus(fetchOf(statusResponse({}, "00000000-0000-4000-8000-0000000000ff"))))
      .toEqual({ ok: false, error: "account_changed" });
    expect(await fetchBackupStatus(fetchOf(statusResponse({ cleanupPendingCount: "0" }))))
      .toEqual({ ok: false, error: "unavailable" });
    expect(await fetchBackupStatus(fetchOf(statusResponse({ latestCompletedRevision: "3" }))))
      .toEqual({ ok: false, error: "unavailable" });
    expect(await fetchBackupStatus(fetchOf(statusResponse({ initialized: "yes" }))))
      .toEqual({ ok: false, error: "unavailable" });
    expect(await fetchBackupStatus(fetchOf(new Response("{}", { status: 401 })))).toEqual({ ok: false, error: "unauthorized" });
    expect(await fetchBackupStatus(fetchOf(new Response("{}", { status: 503 })))).toEqual({ ok: false, error: "unavailable" });
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await fetchBackupStatus({ accountId: accountA, fetch: failing })).toEqual({ ok: false, error: "unavailable" });
  });
});
