import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTestAccount, type TestAccount } from "./helpers/account-state-sqlite";
import { initializeTestLoro, syntheticRecord } from "./helpers/sync-fixtures";
import { LoroDoc } from "loro-crdt/web";
import { writeRecord } from "../src/data/refueling-document";
import { handleApiRequest } from "../src/worker/api";
import { hashSecret } from "../src/worker/auth/secrets";
import {
  computeRestoreRequestFingerprint,
  RESTORE_PATH,
  type RestoreRequestBody,
} from "../src/shared/restore-protocol";

const origin = "https://hako.eruoo.me";
const identity = { issuer: "https://auth.eruoo.me", subject: "synthetic-restore-route-owner" };
const token = "synthetic-restore-route-token";
const start = Date.parse("2026-10-04T00:00:00Z");
let now: number;
let t: TestAccount;
let sessionHash: string;
let accountId: string;
let directory: string;

function environment() {
  return {
    HAKO_LOGIN: { origin, issuer: identity.issuer, clientId: "hako-web", resource: "https://auth.eruoo.me/api" },
    HAKO_OWNER_SUBJECT: identity.subject,
    HAKO_ACCOUNT: { getByName: () => t.account },
  };
}

function requestBody(overrides: Partial<RestoreRequestBody> = {}): RestoreRequestBody {
  return {
    requestId: "00000000-0000-4000-8000-0000000000f1",
    previewId: "00000000-0000-4000-8000-0000000000f2",
    backupStreamId: "00000000-0000-4000-8000-0000000000f3",
    revision: 3,
    bundleSha256: "a".repeat(64),
    expectedGeneration: "00000000-0000-4000-8000-0000000000f4",
    expectedRevision: 5,
    expectedSnapshotSha256: "b".repeat(64),
    ...overrides,
  };
}

function submitRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}${RESTORE_PATH}`, { method: "POST", headers: {
    Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
    "Content-Type": "application/json", ...headers,
  }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function queryRequest(requestId: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}${RESTORE_PATH}/requests/${requestId}`, { method: "GET", headers: {
    Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId, ...headers,
  } });
}

async function insertSyntheticReceipt(body: RestoreRequestBody, overrides: Partial<{
  previousGeneration: string; newGeneration: string; previousRevision: number; newRevision: number;
  baselinePending: boolean;
}> = {}) {
  await t.account.insertRestoreReceiptForTest({
    accountId,
    requestId: body.requestId,
    requestFingerprint: await computeRestoreRequestFingerprint(body),
    previousGeneration: overrides.previousGeneration ?? "00000000-0000-4000-8000-0000000000e1",
    newGeneration: overrides.newGeneration ?? "00000000-0000-4000-8000-0000000000e2",
    previousRevision: overrides.previousRevision ?? 5,
    newRevision: overrides.newRevision ?? 6,
    sourceBackup: { backupStreamId: body.backupStreamId, revision: body.revision, bundleSha256: body.bundleSha256 },
    protectionBackup: { backupStreamId: body.backupStreamId, revision: body.revision + 1, bundleSha256: "c".repeat(64) },
    baselinePending: overrides.baselinePending ?? true,
    committedAtMs: start + 1000,
  });
}

beforeAll(initializeTestLoro);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hako-restore-route-"));
  t = createTestAccount(join(directory, "account.sqlite"), { now: () => now });
  now = start;
  sessionHash = await hashSecret(token);
  t.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
    sessionHash, identity.issuer, identity.subject, now, now, now + 180 * 86400000, now + 365 * 86400000,
  );
  accountId = (await t.account.readAccountId({ sessionHash, identity, nowMs: now }))!;
});
afterEach(() => {
  t.database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("A 版本恢复端点：只查重 POST 与回执 GET", () => {
  it("无回执：503 restore_unavailable + outcome unknown；零写入、不删除任何预览", async () => {
    const response = await handleApiRequest(submitRequest(requestBody()), environment(), { now: () => now });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; outcome: string; requestId: string; requestFingerprint: string };
    expect(body).toMatchObject({ error: "restore_unavailable", outcome: "unknown", requestId: requestBody().requestId });
    expect(body.requestFingerprint).toBe(await computeRestoreRequestFingerprint(requestBody()));
    expect(response.headers.get("X-Hako-Account")).toBe(accountId);
    // 零写入：无回执、无预览表、无任务/游标变化。
    expect(t.database.prepare("SELECT count(*) AS count FROM refueling_restore_receipts").get()).toEqual({ count: 0 });
    expect(t.bucket.counters.put).toBe(0);
  });

  it("已有同指纹回执：200 committed 回放固定结果（持久边界）", async () => {
    const body = requestBody();
    await insertSyntheticReceipt(body, { baselinePending: true });
    const response = await handleApiRequest(submitRequest(body), environment(), { now: () => now });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Hako-Account")).toBe(accountId);
    const replay = await response.json() as Record<string, unknown>;
    expect(replay).toMatchObject({
      outcome: "committed",
      requestId: body.requestId,
      requestFingerprint: await computeRestoreRequestFingerprint(body),
      previousRevision: 5,
      newRevision: 6,
      baselinePending: true,
      committedAt: new Date(start + 1000).toISOString(),
    });
    // 同一请求再次提交仍回放同一结果（幂等）。
    const again = await handleApiRequest(submitRequest(body), environment(), { now: () => now });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(replay);
    expect(t.bucket.counters.put).toBe(0);
  });

  it("同 requestId 不同正文：409 request_id_conflict；不同 requestId 互不影响", async () => {
    const committed = requestBody();
    await insertSyntheticReceipt(committed);
    const conflict = requestBody({ previewId: "00000000-0000-4000-8000-0000000000ff" });
    const response = await handleApiRequest(submitRequest(conflict), environment(), { now: () => now });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "request_id_conflict" });
    // 原 requestId 的回执不受冲突请求影响。
    const replay = await handleApiRequest(submitRequest(committed), environment(), { now: () => now });
    expect(replay.status).toBe(200);
  });

  it("GET 回执：存在返回 committed；不存在返回 404 restore_request_not_found", async () => {
    const body = requestBody();
    await insertSyntheticReceipt(body, { baselinePending: false });
    const found = await handleApiRequest(queryRequest(body.requestId), environment(), { now: () => now });
    expect(found.status).toBe(200);
    expect(found.headers.get("X-Hako-Account")).toBe(accountId);
    expect(await found.json()).toMatchObject({
      outcome: "committed", requestId: body.requestId,
      requestFingerprint: await computeRestoreRequestFingerprint(body),
      baselinePending: false,
    });
    const missing = await handleApiRequest(queryRequest("00000000-0000-4000-8000-0000000000ee"), environment(), { now: () => now });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "restore_request_not_found" });
    // 404 不证明请求未提交：不写任何状态。
    expect(t.database.prepare("SELECT count(*) AS count FROM refueling_restore_receipts").get()).toEqual({ count: 1 });
  });

  it("正文边界：未知字段、非法值、超限与非 JSON 都拒绝；Origin 与会话边界", async () => {
    const bad: [string, unknown][] = [
      ["未知字段", { ...requestBody(), extra: 1 }],
      ["缺字段", { requestId: requestBody().requestId }],
      ["非 UUID requestId", requestBody({ requestId: "not-a-uuid" })],
      ["非法哈希", requestBody({ bundleSha256: "z".repeat(64) })],
      ["负 revision", requestBody({ revision: -1 })],
      ["非对象", [requestBody()]],
      ["坏 JSON", "{not-json"],
    ];
    for (const [name, body] of bad) {
      const response = await handleApiRequest(submitRequest(body), environment(), { now: () => now });
      expect(response.status, name).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const tooLarge = await handleApiRequest(submitRequest(`${"x".repeat(16 * 1024 + 1)}`), environment(), { now: () => now });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: "body_too_large" });
    expect((await handleApiRequest(submitRequest(requestBody(), { Origin: "https://other.example" }), environment(), { now: () => now })).status).toBe(403);
    expect((await handleApiRequest(submitRequest(requestBody(), { Cookie: "" }), environment(), { now: () => now })).status).toBe(401);
    expect((await handleApiRequest(submitRequest(requestBody(), { "X-Hako-Account": crypto.randomUUID() }), environment(), { now: () => now })).status).toBe(409);
    expect((await handleApiRequest(new Request(`${origin}${RESTORE_PATH}`, { method: "GET", headers: { Cookie: `__Host-hako_session=${token}` } }), environment(), { now: () => now })).status).toBe(405);
    expect((await handleApiRequest(new Request(`${origin}${RESTORE_PATH}/requests/not-a-uuid`, { method: "GET", headers: { Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId } }), environment(), { now: () => now })).status).toBe(400);
    expect((await handleApiRequest(new Request(`${origin}${RESTORE_PATH}/unknown`, { method: "POST", headers: { Cookie: `__Host-hako_session=${token}`, Origin: origin } }), environment(), { now: () => now })).status).toBe(404);
  });

  it("A 提交路径对 B 合成状态零副作用：有真实备份/冻结任务时无回执仍返回 unknown，不触发任何 R2", async () => {
    const doc = new LoroDoc();
    writeRecord(doc, "one", syntheticRecord, true);
    const bootstrap = await t.account.bootstrapRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    expect(bootstrap.ok).toBe(true);
    await t.account.syncRefueling({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      documentGeneration: bootstrap.ok ? bootstrap.documentGeneration : "",
      snapshot: doc.export({ mode: "snapshot" }),
    });
    const response = await handleApiRequest(submitRequest(requestBody({ expectedGeneration: bootstrap.ok ? bootstrap.documentGeneration : "" })), environment(), { now: () => now });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { outcome: string }).outcome).toBe("unknown");
    expect(t.bucket.counters.put).toBe(0);
    expect(t.bucket.counters.list).toBe(0);
    expect(t.database.prepare("SELECT count(*) AS count FROM backup_frozen_task").get()).toEqual({ count: 0 });
    doc.free();
  });
});

describe("请求指纹", () => {
  it("固定字段顺序无空白 JSON 的 SHA-256；同正文稳定、换目标即变", async () => {
    const body = requestBody();
    const digest = await computeRestoreRequestFingerprint(body);
    expect(digest).toBe(createHash("sha256").update(new TextEncoder().encode(JSON.stringify({
      requestId: body.requestId, previewId: body.previewId, backupStreamId: body.backupStreamId,
      revision: body.revision, bundleSha256: body.bundleSha256, expectedGeneration: body.expectedGeneration,
      expectedRevision: body.expectedRevision, expectedSnapshotSha256: body.expectedSnapshotSha256,
    }))).digest("hex"));
    expect(await computeRestoreRequestFingerprint({ ...body })).toBe(digest);
    expect(await computeRestoreRequestFingerprint(requestBody({ revision: body.revision + 1 }))).not.toBe(digest);
    expect(await computeRestoreRequestFingerprint(requestBody({ previewId: "00000000-0000-4000-8000-0000000000fa" }))).not.toBe(digest);
  });
});
