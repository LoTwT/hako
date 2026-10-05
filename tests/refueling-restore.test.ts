// 恢复协议客户端（B 版本）测试：回执查询、备份列表、固定预览与恢复提交的响应
// 绑定规则。只有账号、requestId 与固定正文指纹都能绑定的响应才可能产生终态；
// 网络错误、404、无 outcome 与不可绑定响应一律保留 unknown，不自动换 ID。
// not_committed 只接受 source_changed/preview_replaced/preview_expired 且必须绑定指纹。

import { describe, expect, it, vi } from "vitest";
import {
  computeRestoreRequestFingerprint,
  type RestoreRequestBody,
} from "../src/shared/restore-protocol";
import {
  cancelRestorePreview,
  createRestorePreview,
  fetchRestorePreviewSnapshot,
  fingerprintRestoreRequest,
  listRefuelingBackups,
  notCommittedOutcome,
  outcomeFromCommittedReceipt,
  parseCommittedReceipt,
  queryRestoreReceipt,
  submitRestoreRequest,
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

describe("恢复提交客户端（B）", () => {
  it("同指纹回执返回 committed；指纹不匹配/账号不符的 200 响应按 unknown 处理", async () => {
    const good = await committedWithFingerprint();
    const result = await submitRestoreRequest({ accountId: accountA, fetch: (async () => good) as unknown as typeof fetch }, body());
    expect(result).toMatchObject({ status: "committed", receipt: { newGeneration } });

    const mismatched = await committedWithFingerprint({ requestFingerprint: "c".repeat(64) });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => mismatched) as unknown as typeof fetch }, body()))
      .toMatchObject({ status: "unknown" });

    const wrongAccount = await committedWithFingerprint({}, "00000000-0000-4000-8000-0000000000ff");
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => wrongAccount) as unknown as typeof fetch }, body()))
      .toMatchObject({ status: "unknown" });
  });

  it("409 request_id_conflict 返回冲突；其他 409/503/网络错误一律 unknown", async () => {
    const conflict = new Response(JSON.stringify({ error: "request_id_conflict" }), { status: 409, headers: { "X-Hako-Account": accountA } });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => conflict) as unknown as typeof fetch }, body()))
      .toEqual({ status: "request_id_conflict" });

    const unavailable = new Response(JSON.stringify({ error: "restore_unavailable", outcome: "unknown" }), { status: 503, headers: { "X-Hako-Account": accountA } });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => unavailable) as unknown as typeof fetch }, body()))
      .toMatchObject({ status: "unknown" });

    const accountChanged = new Response(JSON.stringify({ error: "account_changed" }), { status: 409, headers: { "X-Hako-Account": accountA } });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => accountChanged) as unknown as typeof fetch }, body()))
      .toMatchObject({ status: "unknown" });

    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await submitRestoreRequest({ accountId: accountA, fetch: failing }, body())).toMatchObject({ status: "unknown" });
  });

  it("请求体按固定字段携带协议头与正文；POST 请求形状正确", async () => {
    const fetch = vi.fn(async () => await committedWithFingerprint());
    await submitRestoreRequest({ accountId: accountA, fetch: fetch as unknown as typeof fetch }, body());
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

describe("B 备份列表客户端", () => {
  it("解析已核对列表：initialized/当前代次/版本条目；不可绑定与错误响应按错误返回", async () => {
    const payload = {
      initialized: true,
      currentGeneration: generation,
      currentRevision: 7,
      versions: [
        {
          backupStreamId: "00000000-0000-4000-8000-0000000000b3",
          revision: 6,
          bundleSha256: "a".repeat(64),
          completedAt: "2026-10-05T12:00:00.000Z",
          capturedAt: "2026-10-05T11:59:30.000Z",
          recordCount: 12,
          formatVersion: 2,
          effectiveSourceGeneration: generation,
          generationOrigin: { kind: "initial" },
          reason: "baseline",
          restoreBaseline: false,
          snapshotSha256: "c".repeat(64),
          selectable: true,
        },
        {
          backupStreamId: "00000000-0000-4000-8000-0000000000b3",
          revision: 5,
          bundleSha256: "d".repeat(64),
          completedAt: "2026-10-05T11:00:00.000Z",
          capturedAt: null,
          recordCount: 11,
          formatVersion: null,
          effectiveSourceGeneration: generation,
          generationOrigin: null,
          reason: null,
          restoreBaseline: true,
          snapshotSha256: null,
          selectable: false,
        },
      ],
    };
    const good = new Response(JSON.stringify(payload), { status: 200, headers: { "X-Hako-Account": accountA } });
    const result = await listRefuelingBackups({ accountId: accountA, fetch: (async () => good) as unknown as typeof fetch });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.list.initialized).toBe(true);
      expect(result.list.currentRevision).toBe(7);
      expect(result.list.versions).toHaveLength(2);
      expect(result.list.versions[0]).toMatchObject({ revision: 6, recordCount: 12, selectable: true, restoreBaseline: false, capturedAtMs: Date.parse("2026-10-05T11:59:30.000Z") });
      expect(result.list.versions[1]).toMatchObject({ revision: 5, selectable: false, restoreBaseline: true, capturedAtMs: null });
    }
    const wrongAccount = new Response(JSON.stringify(payload), { status: 200, headers: { "X-Hako-Account": "00000000-0000-4000-8000-0000000000ff" } });
    expect(await listRefuelingBackups({ accountId: accountA, fetch: (async () => wrongAccount) as unknown as typeof fetch }))
      .toMatchObject({ ok: false, error: "account_changed" });
    const invalid = new Response(JSON.stringify({ initialized: true, versions: [{ revision: "x" }] }), { status: 200, headers: { "X-Hako-Account": accountA } });
    expect(await listRefuelingBackups({ accountId: accountA, fetch: (async () => invalid) as unknown as typeof fetch }))
      .toMatchObject({ ok: false, error: "unavailable" });
  });
});

describe("B 预览客户端", () => {
  const previewPayload = {
    previewId: "00000000-0000-4000-8000-0000000000c1",
    expiresAt: "2026-10-05T12:15:00.000Z",
    createdAt: "2026-10-05T12:00:00.000Z",
    target: {
      backupStreamId: "00000000-0000-4000-8000-0000000000b3",
      revision: 3,
      bundleSha256: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
      historySha256: "e".repeat(64),
      recordCount: 12,
      capturedAt: null,
    },
    expected: {
      generation,
      revision: 7,
      snapshotSha256: "f".repeat(64),
      historySha256: "9".repeat(64),
    },
    protection: { covered: false, waitingReason: "pending_backup_window", nextAttemptAt: "2026-10-05T12:00:30.000Z", protectionRevision: 3 },
  };

  it("创建预览：解析目标/预期/保护等待；错误码透传", async () => {
    const good = new Response(JSON.stringify(previewPayload), { status: 200, headers: { "X-Hako-Account": accountA } });
    const created = await createRestorePreview(
      { accountId: accountA, fetch: (async () => good) as unknown as typeof fetch },
      { backupStreamId: "00000000-0000-4000-8000-0000000000b3", revision: 3, bundleSha256: "a".repeat(64) },
    );
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.preview.previewId).toBe(previewPayload.previewId);
      expect(created.preview.expected.revision).toBe(7);
      expect(created.preview.protection.waitingReason).toBe("pending_backup_window");
      expect(created.preview.protection.protectionRevision).toBe(3);
      expect(created.preview.target.capturedAtMs).toBeNull();
    }
    const noChange = new Response(JSON.stringify({ error: "no_restore_change" }), { status: 422, headers: { "X-Hako-Account": accountA } });
    expect(await createRestorePreview(
      { accountId: accountA, fetch: (async () => noChange) as unknown as typeof fetch },
      { backupStreamId: "00000000-0000-4000-8000-0000000000b3", revision: 3, bundleSha256: "a".repeat(64) },
    )).toMatchObject({ ok: false, error: "no_restore_change" });
  });

  it("快照读取：摘要头部核对与二进制正文；错误按错误码返回", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await crypto.subtle.digest("SHA-256", bytes).then((value) => Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join(""));
    const good = new Response(bytes, { status: 200, headers: { "X-Hako-Account": accountA, "X-Hako-Snapshot-Sha256": digest } });
    const result = await fetchRestorePreviewSnapshot({ accountId: accountA, fetch: (async () => good) as unknown as typeof fetch }, previewPayload.previewId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot).toEqual(bytes);
      expect(result.snapshotSha256).toBe(digest);
    }
    const missing = new Response(JSON.stringify({ error: "preview_not_found" }), { status: 404, headers: { "X-Hako-Account": accountA } });
    expect(await fetchRestorePreviewSnapshot({ accountId: accountA, fetch: (async () => missing) as unknown as typeof fetch }, previewPayload.previewId))
      .toMatchObject({ ok: false, error: "preview_not_found" });
  });

  it("取消预览：200 返回 cancelled；404/网络错误返回错误", async () => {
    const good = new Response(JSON.stringify({ cancelled: true }), { status: 200, headers: { "X-Hako-Account": accountA } });
    expect(await cancelRestorePreview({ accountId: accountA, fetch: (async () => good) as unknown as typeof fetch }, previewPayload.previewId))
      .toEqual({ cancelled: true, error: null });
    const missing = new Response(JSON.stringify({ error: "preview_not_found" }), { status: 404, headers: { "X-Hako-Account": accountA } });
    expect(await cancelRestorePreview({ accountId: accountA, fetch: (async () => missing) as unknown as typeof fetch }, previewPayload.previewId))
      .toMatchObject({ cancelled: false, error: "preview_not_found" });
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await cancelRestorePreview({ accountId: accountA, fetch: failing }, previewPayload.previewId))
      .toMatchObject({ cancelled: false, error: "unavailable" });
  });
});

describe("B 提交终态绑定", () => {
  it("not_committed：409/410 且绑定 requestId 与指纹才返回终态；否则 unknown", async () => {
    const fingerprint = await computeRestoreRequestFingerprint(body());
    const make = (status: number, payload: Record<string, unknown>) =>
      new Response(JSON.stringify(payload), { status, headers: { "X-Hako-Account": accountA } });
    for (const reason of ["source_changed", "preview_replaced"] as const) {
      const response = make(409, { error: reason, outcome: "not_committed", requestId: body().requestId, requestFingerprint: fingerprint });
      expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => response) as unknown as typeof fetch }, body()))
        .toEqual({ status: "not_committed", reason });
    }
    const expired = make(410, { error: "preview_expired", outcome: "not_committed", requestId: body().requestId, requestFingerprint: fingerprint });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => expired) as unknown as typeof fetch }, body()))
      .toEqual({ status: "not_committed", reason: "preview_expired" });
    // 指纹不匹配：不可绑定 → unknown（不能把另一正文的结果当作本请求终态）。
    const mismatched = make(410, { error: "preview_expired", outcome: "not_committed", requestId: body().requestId, requestFingerprint: "c".repeat(64) });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => mismatched) as unknown as typeof fetch }, body()))
      .toEqual({ status: "unknown", errorCode: null });
    // 非 not_committed 错误码：unknown 且保留错误码。
    const gate = make(409, { error: "backup_not_ready", outcome: "unknown", requestId: body().requestId, requestFingerprint: fingerprint });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => gate) as unknown as typeof fetch }, body()))
      .toEqual({ status: "unknown", errorCode: "backup_not_ready" });
    // 不可绑定的 unknown 响应（缺指纹）：unknown 且不带错误码。
    const unbound = make(503, { error: "restore_unavailable", outcome: "unknown" });
    expect(await submitRestoreRequest({ accountId: accountA, fetch: (async () => unbound) as unknown as typeof fetch }, body()))
      .toEqual({ status: "unknown", errorCode: null });
  });
});
