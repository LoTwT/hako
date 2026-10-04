// 恢复协议客户端（A 版本）测试：回执查询与只查重提交的响应绑定规则。
// 只有账号、requestId 与固定正文指纹都能绑定的响应才可能产生终态；
// 网络错误、404、无 outcome 与不可绑定响应一律保留 unknown，不自动换 ID。

import { describe, expect, it, vi } from "vitest";
import {
  computeRestoreRequestFingerprint,
  type RestoreRequestBody,
} from "../src/shared/restore-protocol";
import {
  fingerprintRestoreRequest,
  notCommittedOutcome,
  outcomeFromCommittedReceipt,
  parseCommittedReceipt,
  queryRestoreReceipt,
  submitRestoreDedup,
  type PendingRestoreRequest,
} from "../src/data/refueling-restore";
import { accountA } from "./helpers/sync-fixtures";

const generation = "00000000-0000-4000-8000-0000000000a1";
const newGeneration = "00000000-0000-4000-8000-0000000000a2";

function body(requestId = "00000000-0000-4000-8000-0000000000b1"): RestoreRequestBody {
  return {
    requestId,
    previewId: "00000000-0000-4000-8000-0000000000b2",
    backupStreamId: "00000000-0000-4000-8000-0000000000b3",
    revision: 3,
    bundleSha256: "a".repeat(64),
    expectedGeneration: generation,
    expectedRevision: 5,
    expectedSnapshotSha256: "b".repeat(64),
  };
}

async function committedWithFingerprint(overrides: Record<string, unknown> = {}, account = accountA) {
  const payload = {
    outcome: "committed",
    requestId: "00000000-0000-4000-8000-0000000000b1",
    requestFingerprint: await computeRestoreRequestFingerprint(body()),
    previousGeneration: generation,
    newGeneration,
    previousRevision: 5,
    newRevision: 6,
    baselinePending: true,
    committedAt: "2026-10-04T12:00:00.000Z",
    ...overrides,
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "X-Hako-Account": account } });
}

describe("回执查询客户端", () => {
  it("200 committed 按账号/requestId 绑定返回；404、网络错误与不可绑定响应均为 unknown", async () => {
    const committed = await committedWithFingerprint();
    expect(await queryRestoreReceipt({ accountId: accountA, fetch: (async () => committed) as unknown as typeof fetch }, body().requestId))
      .toMatchObject({ status: "committed", receipt: { requestId: body().requestId, newGeneration, newRevision: 6 } });

    const notFound = new Response(JSON.stringify({ error: "restore_request_not_found" }), { status: 404, headers: { "X-Hako-Account": accountA } });
    expect(await queryRestoreReceipt({ accountId: accountA, fetch: (async () => notFound) as unknown as typeof fetch }, body().requestId))
      .toEqual({ status: "unknown" });

    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await queryRestoreReceipt({ accountId: accountA, fetch: failing }, body().requestId)).toEqual({ status: "unknown" });

    // 错误账号头或不同 requestId 的响应不可绑定：unknown，不产生终态。
    const wrongAccount = await committedWithFingerprint({}, "00000000-0000-4000-8000-0000000000ff");
    expect(await queryRestoreReceipt({ accountId: accountA, fetch: (async () => wrongAccount) as unknown as typeof fetch }, body().requestId))
      .toEqual({ status: "unknown" });
    const otherRequest = await committedWithFingerprint({ requestId: "00000000-0000-4000-8000-0000000000ee" });
    expect(await queryRestoreReceipt({ accountId: accountA, fetch: (async () => otherRequest) as unknown as typeof fetch }, body().requestId))
      .toEqual({ status: "unknown" });
  });
});

describe("只查重提交客户端（A）", () => {
  it("同指纹回执返回 committed；指纹不匹配/账号不符的 200 响应按 unknown 处理", async () => {
    const good = await committedWithFingerprint();
    const result = await submitRestoreDedup({ accountId: accountA, fetch: (async () => good) as unknown as typeof fetch }, body());
    expect(result).toMatchObject({ status: "committed", receipt: { newGeneration } });

    const mismatched = await committedWithFingerprint({ requestFingerprint: "c".repeat(64) });
    expect(await submitRestoreDedup({ accountId: accountA, fetch: (async () => mismatched) as unknown as typeof fetch }, body()))
      .toEqual({ status: "unknown" });

    const wrongAccount = await committedWithFingerprint({}, "00000000-0000-4000-8000-0000000000ff");
    expect(await submitRestoreDedup({ accountId: accountA, fetch: (async () => wrongAccount) as unknown as typeof fetch }, body()))
      .toEqual({ status: "unknown" });
  });

  it("409 request_id_conflict 返回冲突；其他 409/503/网络错误一律 unknown", async () => {
    const conflict = new Response(JSON.stringify({ error: "request_id_conflict" }), { status: 409, headers: { "X-Hako-Account": accountA } });
    expect(await submitRestoreDedup({ accountId: accountA, fetch: (async () => conflict) as unknown as typeof fetch }, body()))
      .toEqual({ status: "request_id_conflict" });

    const unavailable = new Response(JSON.stringify({ error: "restore_unavailable", outcome: "unknown" }), { status: 503, headers: { "X-Hako-Account": accountA } });
    expect(await submitRestoreDedup({ accountId: accountA, fetch: (async () => unavailable) as unknown as typeof fetch }, body()))
      .toEqual({ status: "unknown" });

    const accountChanged = new Response(JSON.stringify({ error: "account_changed" }), { status: 409, headers: { "X-Hako-Account": accountA } });
    expect(await submitRestoreDedup({ accountId: accountA, fetch: (async () => accountChanged) as unknown as typeof fetch }, body()))
      .toEqual({ status: "unknown" });

    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await submitRestoreDedup({ accountId: accountA, fetch: failing }, body())).toEqual({ status: "unknown" });
  });

  it("请求体按固定字段携带协议头与正文；POST 请求形状正确", async () => {
    const fetch = vi.fn(async () => await committedWithFingerprint());
    await submitRestoreDedup({ accountId: accountA, fetch: fetch as unknown as typeof fetch }, body());
    const [input, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(input).toBe("/api/restores/refueling");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "X-Hako-Account": accountA, "X-Hako-Sync-Protocol": "2", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(body());
  });
});

describe("回执解析与终态构造", () => {
  it("parseCommittedReceipt 校验 outcome/UUID/哈希/revision/时间；非法输入返回 null", () => {
    const receipt = {
      outcome: "committed",
      requestId: "00000000-0000-4000-8000-0000000000b1",
      requestFingerprint: "a".repeat(64),
      previousGeneration: generation,
      newGeneration,
      previousRevision: 5,
      newRevision: 6,
      baselinePending: false,
      committedAt: "2026-10-04T12:00:00.000Z",
    };
    expect(parseCommittedReceipt(receipt)).toEqual({
      requestId: receipt.requestId, requestFingerprint: receipt.requestFingerprint,
      previousGeneration: generation, newGeneration, previousRevision: 5, newRevision: 6,
      baselinePending: false, committedAtMs: Date.parse(receipt.committedAt),
    });
    expect(parseCommittedReceipt({ ...receipt, outcome: "unknown" })).toBeNull();
    expect(parseCommittedReceipt({ ...receipt, requestId: "not-a-uuid" })).toBeNull();
    expect(parseCommittedReceipt({ ...receipt, requestFingerprint: "z".repeat(64) })).toBeNull();
    expect(parseCommittedReceipt({ ...receipt, newRevision: 1.5 })).toBeNull();
    expect(parseCommittedReceipt({ ...receipt, committedAt: "not-a-date" })).toBeNull();
    expect(parseCommittedReceipt(null)).toBeNull();
  });

  it("终态记录由待确认请求与回执构造：指纹绑定；not_committed 保留原因", async () => {
    const pending: PendingRestoreRequest = {
      requestId: body().requestId, body: body(),
      requestFingerprint: await fingerprintRestoreRequest(body()), createdAtMs: 1,
    };
    const committed = {
      requestId: pending.requestId, requestFingerprint: pending.requestFingerprint,
      previousGeneration: generation, newGeneration, previousRevision: 5, newRevision: 6,
      baselinePending: true, committedAtMs: 2,
    };
    expect(outcomeFromCommittedReceipt(pending, committed)).toMatchObject({
      outcome: "committed", newGeneration, newRevision: 6, notCommittedReason: null,
    });
    expect(notCommittedOutcome(pending, "preview_expired")).toMatchObject({
      outcome: "not_committed", newGeneration: null, notCommittedReason: "preview_expired",
    });
  });
});
