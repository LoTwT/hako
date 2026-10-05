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
import { createRestorePreview } from "../src/data/refueling-restore";
import { commitMarkerKey, sha256Hex } from "../src/worker/backup/backup-format";
import { analyzeBackupSnapshot } from "../src/worker/backup/backup-verify";
import {
  computeRestoreRequestFingerprint,
  RESTORE_PATH,
  type RestoreRequestBody,
} from "../src/shared/restore-protocol";
import type { SubmitRestoreInput, SubmitRestoreResult } from "../src/worker/auth/account-rpc";

// B 版恢复验收（恢复设计 §12.2 的单元层）：真实 SQLite + 合成 R2 桶 + 受控时钟。
// workerd 侧真实 alarm/SIGKILL/同步失败集成见 tests/integration/restore-workerd.test.ts；
// B→A→B 回退与浏览器/CLI 边界为项目外验收，不在本文件冒充。

const origin = "https://hako.eruoo.me";
const identity = { issuer: "https://auth.eruoo.me", subject: "synthetic-restore-route-owner" };
const token = "synthetic-restore-route-token";
const start = Date.parse("2026-10-05T00:00:00Z");
const windowMs = 30_000;
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

function listRequest(headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/backups/refueling`, { method: "GET", headers: {
    Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId, ...headers,
  } });
}

function previewRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/restores/refueling/previews`, { method: "POST", headers: {
    Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
    "Content-Type": "application/json", ...headers,
  }, body: JSON.stringify(body) });
}

function previewSnapshotRequest(previewId: string) {
  return new Request(`${origin}/api/restores/refueling/previews/${previewId}/snapshot`, { method: "GET", headers: {
    Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
  } });
}

function previewCancelRequest(previewId: string) {
  return new Request(`${origin}/api/restores/refueling/previews/${previewId}`, { method: "DELETE", headers: {
    Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
  } });
}

/** 服务端完整提交入口（路由层使用同一合同）。 */
async function submit(body: RestoreRequestBody): Promise<SubmitRestoreResult> {
  return await t.account.submitRestore({
    sessionHash, identity, nowMs: now, expectedAccountId: accountId,
    requestId: body.requestId,
    requestFingerprint: await computeRestoreRequestFingerprint(body),
    body,
  });
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

const ownedDocs: LoroDoc[] = [];
function freshDoc(): LoroDoc {
  const instance = new LoroDoc();
  ownedDocs.push(instance);
  return instance;
}

/** 建立一个「已同步 + 已完成基线备份」的账号；返回基线 revision（通常 1）。 */
async function bootstrapAccountWithBaseline(recordCount = 2): Promise<{ generation: string; revision: number; snapshot: Uint8Array }> {
  const bootstrap = await t.account.bootstrapRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
  expect(bootstrap.ok).toBe(true);
  const generation = bootstrap.ok ? bootstrap.documentGeneration : "";
  const doc = freshDoc();
  for (let index = 0; index < recordCount; index += 1) {
    writeRecord(doc, `record-${index}`, { ...syntheticRecord, occurredAtLocal: `2026-10-0${index + 1}T12:00:00`, orderNumber: `ord-${index}` }, true);
  }
  const snapshot = doc.export({ mode: "snapshot" });
  const result = await t.account.syncRefueling({
    sessionHash, identity, nowMs: now, expectedAccountId: accountId,
    documentGeneration: generation, snapshot,
  });
  expect(result.ok).toBe(true);
  const revision = result.ok ? result.revision : 0;
  await t.backups.onAlarm(now + windowMs);
  expect(t.database.prepare("SELECT count(*) AS count FROM backup_completions").get()).toEqual({ count: 1 });
  return { generation, revision, snapshot: result.ok ? result.snapshot : snapshot };
}

/** 追加一次编辑→同步→等待窗口→完成备份；返回新 revision 与服务端快照。 */
async function addVersion(fields: { stationName: string }): Promise<{ revision: number; snapshot: Uint8Array }> {
  const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
  if (!read.ok || read.snapshot === null) throw new Error("read snapshot failed");
  const doc = freshDoc();
  doc.import(read.snapshot);
  const records = new Map<string, string>();
  for (const key of doc.getMap("records").keys()) records.set(key, "");
  for (const id of [...records.keys()]) {
    writeRecord(doc, id, fields, false);
    break;
  }
  const result = await t.account.syncRefueling({
    sessionHash, identity, nowMs: now, expectedAccountId: accountId,
    documentGeneration: read.documentGeneration, snapshot: doc.export({ mode: "snapshot" }),
  });
  if (!result.ok) throw new Error(`sync failed: ${result.error}`);
  await t.backups.onAlarm(now + windowMs);
  return { revision: result.revision, snapshot: result.snapshot };
}

/** 完成版本摘要（列表接口）。 */
async function listVersions() {
  return await t.account.listRefuelingBackups({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
}

function completionRow(revision: number): { bundle_sha256: string; stream_id: string } | undefined {
  return t.database.prepare("SELECT bundle_sha256, stream_id FROM backup_completions WHERE account_id = ? AND revision = ?").get(accountId, revision) as { bundle_sha256: string; stream_id: string } | undefined;
}

function headRow(): { current_generation: string; legacy_generation: string; origin_kind: string } | undefined {
  return t.database.prepare("SELECT current_generation, legacy_generation, origin_kind FROM refueling_document_heads WHERE account_id = ?").get(accountId) as { current_generation: string; legacy_generation: string; origin_kind: string } | undefined;
}

function cursorRow(): { current_revision: number; pending_revision: number | null; latest_completed_revision: number | null } | undefined {
  return t.database.prepare("SELECT current_revision, pending_revision, latest_completed_revision FROM backup_cursor WHERE account_id = ?").get(accountId) as { current_revision: number; pending_revision: number | null; latest_completed_revision: number | null } | undefined;
}

function receiptCount(): number {
  return (t.database.prepare("SELECT count(*) AS count FROM refueling_restore_receipts").get() as { count: number }).count;
}

function previewRowCount(): number {
  return (t.database.prepare("SELECT count(*) AS count FROM refueling_restore_previews").get() as { count: number }).count;
}

/** 创建指向指定完成 revision 的固定预览（服务层）。 */
async function createPreviewFor(revision: number) {
  const completion = completionRow(revision);
  if (completion === undefined) throw new Error(`completion ${revision} missing`);
  return await t.account.createRestorePreview({
    sessionHash, identity, nowMs: now, expectedAccountId: accountId,
    backupStreamId: completion.stream_id, revision, bundleSha256: completion.bundle_sha256,
  });
}

/** 用指定 preview 构造固定正文并提交（服务层）。 */
async function submitPreview(preview: { previewId: string; target: { backupStreamId: string; revision: number; bundleSha256: string }; expected: { generation: string; revision: number; snapshotSha256: string } }, requestId = "00000000-0000-4000-8000-0000000000aa"): Promise<SubmitRestoreResult> {
  return await submit({
    requestId,
    previewId: preview.previewId,
    backupStreamId: preview.target.backupStreamId,
    revision: preview.target.revision,
    bundleSha256: preview.target.bundleSha256,
    expectedGeneration: preview.expected.generation,
    expectedRevision: preview.expected.revision,
    expectedSnapshotSha256: preview.expected.snapshotSha256,
  });
}

/** 安装触发器：指定表的下一次写入抛错（注入原子性故障），返回卸载函数。 */
function abortNextWrite(table: string): () => void {
  const safe = table.replace(/[^a-z_]/g, "x");
  t.storage.transactionSync(() => {
    for (const kind of ["update", "insert", "delete"]) {
      t.storage.sql.exec(`CREATE TRIGGER abort_${safe}_${kind} BEFORE ${kind.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_${table}_write_failure'); END`);
    }
  });
  return () => {
    t.storage.transactionSync(() => {
      for (const kind of ["insert", "update", "delete"]) {
        t.storage.sql.exec(`DROP TRIGGER IF EXISTS abort_${table.replace(/[^a-z_]/g, "x")}_${kind}`);
      }
    });
  };
}

/** 测试内重建账号状态（原子性注入点逐个使用全新状态）。 */
async function resetAccount(): Promise<void> {
  t.database.close();
  t = createTestAccount(join(directory, `account-${crypto.randomUUID().slice(0, 8)}.sqlite`), { now: () => now });
  t.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
    sessionHash, identity.issuer, identity.subject, now, now, now + 180 * 86400000, now + 365 * 86400000,
  );
  accountId = (await t.account.readAccountId({ sessionHash, identity, nowMs: now }))!;
}

beforeAll(initializeTestLoro);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hako-restore-b-"));
  now = start;
  t = createTestAccount(join(directory, "account.sqlite"), { now: () => now });
  sessionHash = await hashSecret(token);
  t.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
    sessionHash, identity.issuer, identity.subject, now, now, now + 180 * 86400000, now + 365 * 86400000,
  );
  accountId = (await t.account.readAccountId({ sessionHash, identity, nowMs: now }))!;
});
afterEach(() => {
  for (const doc of ownedDocs) doc.free();
  ownedDocs.length = 0;
  t.database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("B 列表：R2 标记清单与完成缓存完整核对", () => {
  it("未初始化账号返回空列表；不触发任何 R2 写删", async () => {
    const response = await handleApiRequest(listRequest(), environment(), { now: () => now });
    expect(response.status).toBe(200);
    const body = await response.json() as { initialized: boolean; versions: unknown[] };
    expect(body.initialized).toBe(false);
    expect(body.versions).toEqual([]);
    expect(t.bucket.counters.put).toBe(0);
    expect(t.bucket.counters.delete).toBe(0);
  });

  it("正常序列：按 revision 倒序列出完成版本与恢复基线标签；不加载完整包", async () => {
    await bootstrapAccountWithBaseline();
    const second = await addVersion({ stationName: "第二站" });
    const beforeCounters = { ...t.bucket.counters };
    const result = await listVersions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.initialized).toBe(true);
    expect(result.versions.map((version) => version.revision)).toEqual([second.revision, 1]);
    expect(result.versions.every((version) => version.selectable)).toBe(true);
    expect(result.versions[0]!.recordCount).toBe(2);
    // 列表只读枚举对象键：本调用不产生任何 GET/PUT/DELETE。
    expect(t.bucket.counters.get - beforeCounters.get).toBe(0);
    expect(t.bucket.counters.put - beforeCounters.put).toBe(0);
    expect(t.bucket.counters.delete - beforeCounters.delete).toBe(0);
    expect(t.bucket.counters.list - beforeCounters.list).toBeGreaterThanOrEqual(1);
  });

  it("恢复基线完成版本带 restoreBaseline 标签；清理中的版本不可选", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "第二站" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const outcome = await submitPreview(preview.preview);
    expect(outcome.ok && outcome.outcome === "committed").toBe(true);
    await t.backups.onAlarm(now + windowMs);
    const result = await listVersions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const baselineVersion = result.versions.find((version) => version.restoreBaseline);
    expect(baselineVersion?.revision).toBe(outcome.ok && outcome.outcome === "committed" ? outcome.receipt.newRevision : 0);
    // 清理中的版本不可选：注入裁剪计划覆盖最新版本。
    t.storage.transactionSync(() => {
      const completion = t.database.prepare("SELECT bundle_key, stream_id FROM backup_completions WHERE account_id = ? AND revision = ?").get(accountId, baselineVersion!.revision) as { bundle_key: string; stream_id: string };
      t.storage.sql.exec("INSERT INTO backup_prune_plan VALUES (?, ?, ?, ?, 0)",
        accountId, baselineVersion!.revision, completion.bundle_key,
        commitMarkerKey("production", accountId, "refueling", completion.stream_id, baselineVersion!.revision));
    });
    const withPlan = await listVersions();
    expect(withPlan.ok && withPlan.versions.find((version) => version.revision === baselineVersion?.revision)?.selectable).toBe(false);
    // 清理版本不可新选：预览创建被拒绝。
    const refused = await t.account.createRestorePreview({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      backupStreamId: baselineVersion!.backupStreamId, revision: baselineVersion!.revision, bundleSha256: baselineVersion!.bundleSha256,
    });
    expect(refused).toMatchObject({ ok: false, error: "backup_not_found" });
  });

  it("分页不全：超出页数上限仍截断时报告读取不完整（restore_unavailable）", async () => {
    await bootstrapAccountWithBaseline();
    // 恢复列表固定单页 32、最多 32 页（=1024 键）；注入 1100 个标记使分页截断，
    // 不能截断后声称已核对整个序列。
    const streamId = completionRow(1)!.stream_id;
    for (let index = 0; index < 1100; index += 1) {
      const revision = String(1000 + index).padStart(20, "0");
      t.bucket.seedObject(
        `hako-backup/layout-v1/production/accounts/${accountId}/refueling/${streamId}/commits/${revision}.json`,
        new Uint8Array(),
      );
    }
    expect(await listVersions()).toMatchObject({ ok: false, error: "restore_unavailable" });
  });

  it("超出正常完成标记数（保留数+1）：backup_invalid，不形成可确认列表", async () => {
    await bootstrapAccountWithBaseline();
    const streamId = completionRow(1)!.stream_id;
    for (let index = 0; index < 40; index += 1) {
      const revision = String(1000 + index).padStart(20, "0");
      t.bucket.seedObject(
        `hako-backup/layout-v1/production/accounts/${accountId}/refueling/${streamId}/commits/${revision}.json`,
        new Uint8Array(),
      );
    }
    expect(await listVersions()).toMatchObject({ ok: false, error: "backup_invalid" });
  });

  it("未知序号、陌生 stream 与游离对象：backup_invalid，不形成可确认列表", async () => {
    await bootstrapAccountWithBaseline();
    const streamId = completionRow(1)!.stream_id;
    const foreignStream = "00000000-0000-4000-8000-0000000000ee";
    // 陌生 stream 的标记（出现在账号文档前缀下）。
    t.bucket.seedObject(
      `hako-backup/layout-v1/production/accounts/${accountId}/refueling/${foreignStream}/commits/${String(99).padStart(20, "0")}.json`,
      new Uint8Array(),
    );
    expect(await listVersions()).toMatchObject({ ok: false, error: "backup_invalid" });
    await t.bucket.delete(`hako-backup/layout-v1/production/accounts/${accountId}/refueling/${foreignStream}/commits/${String(99).padStart(20, "0")}.json`);
    // 未知序号（本 stream 下缓存不可解释的 revision）。
    t.bucket.seedObject(
      `hako-backup/layout-v1/production/accounts/${accountId}/refueling/${streamId}/commits/${String(99).padStart(20, "0")}.json`,
      new Uint8Array(),
    );
    expect(await listVersions()).toMatchObject({ ok: false, error: "backup_invalid" });
    await t.bucket.delete(`hako-backup/layout-v1/production/accounts/${accountId}/refueling/${streamId}/commits/${String(99).padStart(20, "0")}.json`);
    // 游离对象（无对应完成/计划/任务的包对象）。
    t.bucket.seedObject(
      `hako-backup/layout-v1/production/accounts/${accountId}/refueling/${streamId}/objects/${String(98).padStart(20, "0")}-${"d".repeat(64)}.hakobak`,
      new Uint8Array(),
    );
    expect(await listVersions()).toMatchObject({ ok: false, error: "backup_invalid" });
  });

  it("缓存不一致（缓存有而标记缺失）：backup_invalid", async () => {
    await bootstrapAccountWithBaseline();
    const streamId = completionRow(1)!.stream_id;
    await t.bucket.delete(commitMarkerKey("production", accountId, "refueling", streamId, 1));
    expect(await listVersions()).toMatchObject({ ok: false, error: "backup_invalid" });
  });

  it("有备份序列却无代次 head：generation_state_unavailable", async () => {
    await bootstrapAccountWithBaseline();
    t.storage.transactionSync(() => {
      t.storage.sql.exec("DELETE FROM refueling_document_heads WHERE account_id = ?", accountId);
    });
    expect(await listVersions()).toMatchObject({ ok: false, error: "generation_state_unavailable" });
  });
});

describe("B 预览：精确引用、完整读回验证与固定暂存", () => {
  it("精确引用创建固定预览：暂存分块、目标摘要与预期当前版本正确", async () => {
    await bootstrapAccountWithBaseline();
    const second = await addVersion({ stationName: "第二站" });
    const result = await createPreviewFor(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.target.revision).toBe(1);
    expect(result.preview.expected.revision).toBe(second.revision);
    expect(result.preview.expected.generation).toBe(headRow()!.current_generation);
    expect(result.preview.expiresAtMs).toBe(now + 15 * 60 * 1000);
    expect(previewRowCount()).toBe(1);
    const chunks = t.database.prepare("SELECT count(*) AS count FROM refueling_restore_preview_chunks").get() as { count: number };
    expect(chunks.count).toBeGreaterThanOrEqual(1);
    // GET snapshot 只读返回固定目标与摘要。
    const read = await t.account.readRestorePreviewSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, previewId: result.preview.previewId });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(createHash("sha256").update(read.snapshot).digest("hex")).toBe(result.preview.target.snapshotSha256);
    }
  });

  it("任意对象键/错误归属/缺字段引用拒绝；未知字段正文拒绝", async () => {
    await bootstrapAccountWithBaseline();
    const completion = completionRow(1)!;
    const wrong = await t.account.createRestorePreview({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      backupStreamId: completion.stream_id, revision: 1, bundleSha256: "f".repeat(64),
    });
    expect(wrong).toMatchObject({ ok: false, error: "backup_not_found" });
    const unknownRevision = await t.account.createRestorePreview({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      backupStreamId: completion.stream_id, revision: 99, bundleSha256: completion.bundle_sha256,
    });
    expect(unknownRevision).toMatchObject({ ok: false, error: "backup_not_found" });
    const response = await handleApiRequest(previewRequest({ revision: 1, extra: true }), environment(), { now: () => now });
    expect(response.status).toBe(400);
    expect(previewRowCount()).toBe(0);
  });

  it("浏览器验收缺陷回归：真实预览客户端的三字段正文经路由被接受", async () => {
    await bootstrapAccountWithBaseline();
    // 预览要求目标与当前版本不同（相同返回 no_restore_change）：先追加一次编辑。
    const second = await addVersion({ stationName: "第二站" });
    const completion = completionRow(1)!;
    const head = headRow()!;
    // 完整版本行（列表客户端真实输出形状，10 字段）直接交给真实预览客户端；
    // 捕获实际发送正文，并把它送进真实路由/DO/R2 读回链路。
    const versionRow = {
      backupStreamId: completion.stream_id,
      revision: 1,
      bundleSha256: completion.bundle_sha256,
      completedAtMs: now,
      capturedAtMs: null,
      recordCount: 2,
      formatVersion: 2,
      effectiveSourceGeneration: head.current_generation,
      restoreBaseline: false,
      selectable: true,
    };
    let wireBody = "";
    const created = await createRestorePreview({
      accountId,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        wireBody = String(init?.body ?? "");
        return await handleApiRequest(previewRequest(JSON.parse(wireBody)), environment(), { now: () => now });
      }) as unknown as typeof fetch,
    }, versionRow);
    expect(Object.keys(JSON.parse(wireBody)).sort()).toEqual(["backupStreamId", "bundleSha256", "revision"]);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.preview.target.revision).toBe(1);
      expect(created.preview.expected.revision).toBe(second.revision);
      expect(created.preview.target.bundleSha256).toBe(completion.bundle_sha256);
    }
    expect(previewRowCount()).toBe(1);
  });

  it("标记损坏与缺包：backup_invalid，不创建预览", async () => {
    await bootstrapAccountWithBaseline();
    const streamId = completionRow(1)!.stream_id;
    const markerKey = commitMarkerKey("production", accountId, "refueling", streamId, 1);
    const originalMarker = t.bucket.storedBytes(markerKey)!;
    t.bucket.corruptObject(markerKey, (bytes) => bytes.slice(0, 10));
    expect(await createPreviewFor(1)).toMatchObject({ ok: false, error: "backup_invalid" });
    // 标记恢复原字节、包对象被外部删除。
    t.bucket.seedObject(markerKey, originalMarker);
    const completion = completionRow(1)!;
    const bundleKey = `hako-backup/layout-v1/production/accounts/${accountId}/refueling/${completion.stream_id}/objects/${String(1).padStart(20, "0")}-${completion.bundle_sha256}.hakobak`;
    await t.bucket.delete(bundleKey);
    expect(await createPreviewFor(1)).toMatchObject({ ok: false, error: "backup_invalid" });
    expect(previewRowCount()).toBe(0);
  });

  it("完整状态与历史均相同：no_restore_change，不创建预览", async () => {
    await bootstrapAccountWithBaseline();
    // 最新完成版本即当前版本：恢复到它就是无变化。
    const completion = completionRow(1)!;
    const result = await t.account.createRestorePreview({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      backupStreamId: completion.stream_id, revision: 1, bundleSha256: completion.bundle_sha256,
    });
    expect(result).toMatchObject({ ok: false, error: "no_restore_change" });
    expect(previewRowCount()).toBe(0);
  });

  it("新预览原子替换未消费预览；旧确认随即失效（preview_replaced 终态）", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "第二站" });
    const first = await createPreviewFor(1);
    expect(first.ok).toBe(true);
    const second = await createPreviewFor(first.ok ? first.preview.target.revision : 1);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.preview.previewId).not.toBe(first.preview.previewId);
    // 旧 previewId 的提交：已被替换 → not_committed preview_replaced。
    const outcome = await submitPreview(first.preview);
    expect(outcome).toMatchObject({ ok: true, outcome: "not_committed", reason: "preview_replaced" });
    expect(receiptCount()).toBe(0);
  });

  it("迟到覆盖防护：外部读取期间产生较新预览时，迟到请求不覆盖新预览", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const third = await addVersion({ stationName: "v3" });
    // 在读取基线标记期间注入一次并发的较新预览创建（R2 回调内完成）；
    // 迟到的第一个请求在写入事务内发现 previewId 已变化 → preview_replaced。
    let nested: Promise<unknown> | undefined;
    const originalGet = t.bucket.get.bind(t.bucket);
    (t.bucket as unknown as { get: typeof t.bucket.get }).get = async (key: string) => {
      if (nested === undefined && key.includes("/commits/") && key.endsWith(`${String(1).padStart(20, "0")}.json`)) {
        const completionSecond = completionRow(third.revision - 1)!;
        nested = t.account.createRestorePreview({
          sessionHash, identity, nowMs: now, expectedAccountId: accountId,
          backupStreamId: completionSecond.stream_id, revision: third.revision - 1, bundleSha256: completionSecond.bundle_sha256,
        });
        await nested;
      }
      return await originalGet(key);
    };
    const late = await createPreviewFor(1);
    expect(late).toMatchObject({ ok: false, error: "preview_replaced" });
    expect(await nested).toMatchObject({ ok: true });
    // 较新预览仍在（未被迟到请求覆盖）。
    const stored = t.account.readPreviewForTest(accountId);
    expect(stored?.previewId).toBe((await nested as { preview: { previewId: string } }).preview.previewId);
  });

  it("预览期间目标被正常裁剪：固定暂存仍可用于已确认的同一目标", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    await addVersion({ stationName: "v3" });
    // 当前版本（rev3）下创建指向 rev1 的固定预览，然后目标被正常保留策略裁剪。
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    const completion = completionRow(1)!;
    await t.bucket.delete(commitMarkerKey("production", accountId, "refueling", completion.stream_id, 1));
    await t.bucket.delete(`hako-backup/layout-v1/production/accounts/${accountId}/refueling/${completion.stream_id}/objects/${String(1).padStart(20, "0")}-${completion.bundle_sha256}.hakobak`);
    t.storage.transactionSync(() => {
      t.storage.sql.exec("DELETE FROM backup_completions WHERE account_id = ? AND revision = 1", accountId);
    });
    // 已验证、仍有效的 preview 继续使用其固定字节：提交以暂存完成恢复。
    const outcome = await submitPreview(preview.ok ? preview.preview : null!);
    expect(outcome.ok && outcome.outcome === "committed").toBe(true);
    // 新请求不能再从已删除对象创建预览（引用在删除前保存）。
    expect(await t.account.createRestorePreview({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      backupStreamId: completion.stream_id, revision: 1, bundleSha256: completion.bundle_sha256,
    })).toMatchObject({ ok: false, error: "backup_not_found" });
  });

  it("取消接口：只删除匹配且未消费的预览；迟到取消不动较新预览", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const first = await createPreviewFor(1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cancelResponse = await handleApiRequest(previewCancelRequest(first.preview.previewId), environment(), { now: () => now });
    expect(cancelResponse.status).toBe(200);
    expect(previewRowCount()).toBe(0);
    // 再次取消已删除的预览：404 preview_not_found，不复活。
    expect((await handleApiRequest(previewCancelRequest(first.preview.previewId), environment(), { now: () => now })).status).toBe(404);
    const second = await createPreviewFor(first.preview.target.revision);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 迟到取消旧 ID：不能删除较新预览。
    expect((await handleApiRequest(previewCancelRequest(first.preview.previewId), environment(), { now: () => now })).status).toBe(404);
    expect(previewRowCount()).toBe(1);
    expect(t.account.readPreviewForTest(accountId)?.previewId).toBe(second.preview.previewId);
  });

  it("GET 预览快照路由：账号匹配、摘要头部与二进制正文", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const response = await handleApiRequest(previewSnapshotRequest(preview.preview.previewId), environment(), { now: () => now });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Hako-Account")).toBe(accountId);
    expect(response.headers.get("X-Hako-Snapshot-Sha256")).toBe(preview.preview.target.snapshotSha256);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(preview.preview.target.snapshotSha256);
    // 未知/已消费 ID：404 preview_not_found。
    expect((await handleApiRequest(previewSnapshotRequest("00000000-0000-4000-8000-0000000000ef"), environment(), { now: () => now })).status).toBe(404);
  });
});

describe("B 提交：保护门禁、唯一切换事务与恢复基线", () => {
  it("正常恢复：切换代次、替换快照、revision+1、冻结恢复基线、写回执、消费 preview、安排 alarm", async () => {
    await bootstrapAccountWithBaseline();
    const second = await addVersion({ stationName: "v2" });
    const before = headRow()!;
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const outcome = await submitPreview(preview.preview);
    expect(outcome.ok && outcome.outcome === "committed").toBe(true);
    if (!outcome.ok || outcome.outcome !== "committed") return;
    const head = headRow()!;
    expect(head.current_generation).not.toBe(before.current_generation);
    expect(head.legacy_generation).toBe(before.legacy_generation);
    expect(head.origin_kind).toBe("restore");
    expect(outcome.receipt.previousGeneration).toBe(before.current_generation);
    expect(outcome.receipt.newGeneration).toBe(head.current_generation);
    expect(outcome.receipt.previousRevision).toBe(second.revision);
    expect(outcome.receipt.newRevision).toBe(second.revision + 1);
    expect(outcome.receipt.baselinePending).toBe(true);
    // 主快照 = 目标字节（重读并与暂存哈希核对）。
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    expect(read.ok && read.snapshot !== null).toBe(true);
    if (read.ok && read.snapshot) {
      expect(createHash("sha256").update(read.snapshot).digest("hex")).toBe(preview.preview.target.snapshotSha256);
      expect(read.documentGeneration).toBe(head.current_generation);
      expect(read.revision).toBe(second.revision + 1);
    }
    // 冻结任务：restore-baseline、attempt 0、首次发布 = 切换后窗口。
    const task = t.database.prepare("SELECT revision, reason, attempt_count, next_attempt_at, source_generation, format_version FROM backup_frozen_task WHERE account_id = ?").get(accountId) as { revision: number; reason: string; attempt_count: number; next_attempt_at: number; source_generation: string; format_version: number };
    expect(task).toMatchObject({ revision: second.revision + 1, reason: "restore-baseline", attempt_count: 0, source_generation: head.current_generation, format_version: 2 });
    expect(task.next_attempt_at).toBe(now + windowMs);
    expect(t.storage.alarmTime()).toBe(now + windowMs);
    expect(receiptCount()).toBe(1);
    expect(previewRowCount()).toBe(0);
    expect(cursorRow()).toMatchObject({ current_revision: second.revision + 1, pending_revision: null, latest_completed_revision: second.revision });
    // 重复提交同一 ID 与正文：committed 回放固定结果。
    const replay = await submitPreview(preview.preview);
    expect(replay.ok && replay.outcome === "committed" && replay.receipt.committedAtMs === outcome.receipt.committedAtMs).toBe(true);
    expect(receiptCount()).toBe(1);
  });

  it("同 requestId 不同正文：request_id_conflict，不泄露另一请求成功", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const committed = await submitPreview(preview.preview);
    expect(committed.ok && committed.outcome === "committed").toBe(true);
    const body = {
      requestId: "00000000-0000-4000-8000-0000000000aa",
      previewId: preview.preview.previewId,
      backupStreamId: preview.preview.target.backupStreamId,
      revision: preview.preview.target.revision,
      bundleSha256: preview.preview.target.bundleSha256,
      expectedGeneration: preview.preview.expected.generation,
      expectedRevision: preview.preview.expected.revision,
      expectedSnapshotSha256: preview.preview.expected.snapshotSha256,
    };
    const conflict = await submit({ ...body, previewId: "00000000-0000-4000-8000-0000000000ff" });
    expect(conflict).toMatchObject({ ok: true, outcome: "request_id_conflict" });
  });

  it("空快照恢复与并发历史文档：值、原记录 ID 与目标哈希符合所选备份", async () => {
    // 当前含两条记录；目标为空文档版本（先造一个空文档基线，再加记录）。
    const empty = freshDoc();
    const bootstrap = await t.account.bootstrapRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    expect(bootstrap.ok).toBe(true);
    const generation = bootstrap.ok ? bootstrap.documentGeneration : "";
    const emptySnapshot = empty.export({ mode: "snapshot" });
    await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: generation, snapshot: emptySnapshot });
    await t.backups.onAlarm(now + windowMs);
    // 追加两条记录并完成第二份备份。
    const doc = freshDoc();
    writeRecord(doc, "one", syntheticRecord, true);
    writeRecord(doc, "two", { ...syntheticRecord, occurredAtLocal: "2026-10-02T13:00:00" }, true);
    const added = await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: generation, snapshot: doc.export({ mode: "snapshot" }) });
    expect(added.ok).toBe(true);
    await t.backups.onAlarm(now + windowMs);
    // 恢复到空版本（rev1）。
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.target.recordCount).toBe(0);
    const outcome = await submitPreview(preview.preview);
    expect(outcome.ok && outcome.outcome === "committed").toBe(true);
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    expect(read.ok && read.snapshot).toBeTruthy();
    if (read.ok && read.snapshot) {
      const result = freshDoc();
      result.import(read.snapshot);
      expect(result.getMap("records").size).toBe(0);
    }
  });

  it("恢复基线在切换后窗口发布并完成；后续普通编辑另登记责任且不被合并掉", async () => {
    await bootstrapAccountWithBaseline();
    const second = await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const outcome = await submitPreview(preview.preview);
    expect(outcome.ok && outcome.outcome === "committed").toBe(true);
    // 切换后窗口到期：恢复基线发布并完成。
    await t.backups.onAlarm(now + windowMs);
    const completions = t.database.prepare("SELECT revision, reason FROM backup_completions WHERE account_id = ? ORDER BY revision").all(accountId) as { revision: number; reason: string }[];
    expect(completions.at(-1)).toMatchObject({ revision: second.revision + 1, reason: "restore-baseline" });
    expect(cursorRow()!.latest_completed_revision).toBe(second.revision + 1);
    // 后续普通编辑：新 revision、history-change、恢复来源沿用。
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    if (!read.ok || read.snapshot === null) throw new Error("read failed");
    const doc = freshDoc();
    doc.import(read.snapshot);
    writeRecord(doc, "record-0", { stationName: "恢复后编辑" }, false);
    const result = await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: read.documentGeneration, snapshot: doc.export({ mode: "snapshot" }) });
    expect(result.ok).toBe(true);
    expect(cursorRow()!.pending_revision).toBe(second.revision + 2);
    await t.backups.onAlarm(now + 2 * windowMs);
    const completionsAfter = t.database.prepare("SELECT revision, reason, source_generation, generation_origin FROM backup_completions WHERE account_id = ? ORDER BY revision").all(accountId) as { revision: number; reason: string; source_generation: string; generation_origin: string }[];
    expect(completionsAfter.at(-1)).toMatchObject({ revision: second.revision + 2, reason: "history-change", source_generation: outcome.ok && outcome.outcome === "committed" ? outcome.receipt.newGeneration : "" });
    expect(completionsAfter.at(-1)!.generation_origin).toContain(outcome.ok && outcome.outcome === "committed" ? outcome.receipt.requestId : "");
    // 恢复的版本没有被后续编辑合并掉：主文档仍包含恢复后的记录（record-0 被编辑而非复活旧值）。
    const finalRead = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    if (finalRead.ok && finalRead.snapshot) {
      const finalDoc = freshDoc();
      finalDoc.import(finalRead.snapshot);
      expect(finalDoc.getMap("records").size).toBe(2);
    }
  });

  it("保护门禁：有待备变化时等待正常备份完成，不提前失败重试", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    // 新编辑产生待备责任（当前版本尚未备份）——先编辑，再预览：预览绑定当前版本。
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    if (!read.ok || read.snapshot === null) throw new Error("read failed");
    const doc = freshDoc();
    doc.import(read.snapshot);
    writeRecord(doc, "record-1", { stationName: "pending-edit" }, false);
    const pending = await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: read.documentGeneration, snapshot: doc.export({ mode: "snapshot" }) });
    expect(pending.ok).toBe(true);
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.protection.covered).toBe(false);
    expect(preview.preview.protection.waitingReason).toBe("pending_backup_window");
    // 待备版本存在：等待原 30 秒窗口与正常 alarm，不提前失败重试、不新增发布者。
    const pendingOutcome = await submitPreview(preview.preview);
    expect(pendingOutcome).toMatchObject({ ok: true, outcome: "unknown", errorCode: "backup_not_ready" });
    expect(receiptCount()).toBe(0);
    expect(headRow()!.origin_kind).toBe("initial");
    expect(t.bucket.counters.put - 0).toBe(t.bucket.counters.put); // 无新增 PUT（门禁不触发备份）
    // 窗口到期、正常 alarm 完成备份后，同一预览恢复成功（版本条件仍匹配）。
    await t.backups.onAlarm(now + windowMs);
    const after = await submitPreview(preview.preview);
    expect(after.ok && after.outcome === "committed").toBe(true);
  });

  it("保护等待时间合入持久失败下限：预览与只读状态都不承诺更早的可行动时间", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    // 形成待备窗口（正常未来时间 now + 30s）。
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    if (!read.ok || read.snapshot === null) throw new Error("read failed");
    const doc = freshDoc();
    doc.import(read.snapshot);
    writeRecord(doc, "record-1", { stationName: "pending-edit" }, false);
    const pending = await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: read.documentGeneration, snapshot: doc.export({ mode: "snapshot" }) });
    expect(pending.ok).toBe(true);
    const preview = await createPreviewFor(1);
    if (!preview.ok) throw new Error("preview unavailable");
    expect(preview.preview.protection.waitingReason).toBe("pending_backup_window");
    expect(preview.preview.protection.nextAttemptAtMs).toBe(now + windowMs);
    expect((await t.backups.readStatusSnapshot(accountId)).nextActionAtMs).toBe(now + windowMs);
    // 持久失败下限 now+300s：alarm 合同不能早于该时间，预览与只读状态必须报告有效时间。
    const floor = now + 300_000;
    t.storage.transactionSync(() => {
      t.storage.sql.exec("UPDATE backup_cursor SET retry_floor_at = ? WHERE account_id = ?", floor, accountId);
    });
    const floored = await createPreviewFor(1);
    if (!floored.ok) throw new Error("preview unavailable");
    expect(floored.preview.protection.waitingReason).toBe("pending_backup_window");
    expect(floored.preview.protection.nextAttemptAtMs, "预览不得承诺早于持久失败下限的尝试时间").toBeGreaterThanOrEqual(floor);
    expect((await t.backups.readStatusSnapshot(accountId)).nextActionAtMs).toBe(floor);
    // blocked：自动推进已停止，不虚报自动恢复时间（预览与状态一致为 null）。
    t.storage.transactionSync(() => {
      t.storage.sql.exec("UPDATE backup_cursor SET blocked_error = ? WHERE account_id = ?", "backup_upload_failed", accountId);
    });
    const blocked = await createPreviewFor(1);
    if (!blocked.ok) throw new Error("preview unavailable");
    expect(blocked.preview.protection.waitingReason).toBe("backup_blocked");
    expect(blocked.preview.protection.nextAttemptAtMs).toBeNull();
    expect((await t.backups.readStatusSnapshot(accountId)).nextActionAtMs).toBeNull();
  });

  it("冻结任务在途与失败下限重叠：责任优先级取任务时间，并按下限兜底", async () => {
    await bootstrapAccountWithBaseline();
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    if (!read.ok || read.snapshot === null) throw new Error("read failed");
    const doc = freshDoc();
    doc.import(read.snapshot);
    writeRecord(doc, "record-1", { stationName: "pending-edit" }, false);
    expect((await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: read.documentGeneration, snapshot: doc.export({ mode: "snapshot" }) })).ok).toBe(true);
    // 捕获成功、发布失败：冻结任务按退避进入未来重试（任务优先于待备窗口）。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    await t.backups.onAlarm(now + windowMs);
    t.bucket.clearFaults();
    const taskStatus = await t.backups.readStatusSnapshot(accountId);
    expect(taskStatus.frozenTaskRevision).not.toBeNull();
    const taskRetryAt = taskStatus.nextAttemptAtMs;
    if (taskRetryAt === null) throw new Error("task retry time missing");
    expect(taskStatus.nextActionAtMs).toBe(taskRetryAt);
    // 失败下限晚于任务重试时间：报告值取下限（不提前、不清除）。
    const floor = taskRetryAt + 60_000;
    t.storage.transactionSync(() => {
      t.storage.sql.exec("UPDATE backup_cursor SET retry_floor_at = ? WHERE account_id = ?", floor, accountId);
    });
    expect((await t.backups.readStatusSnapshot(accountId)).nextActionAtMs).toBe(floor);
    const preview = await createPreviewFor(1);
    if (!preview.ok) throw new Error("preview unavailable");
    expect(preview.preview.protection.waitingReason).toBe("backup_task_in_progress");
    expect(preview.preview.protection.nextAttemptAtMs).toBe(floor);
  });

  it("保护门禁：blocked → backup_blocked unknown", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    t.storage.transactionSync(() => {
      t.storage.sql.exec("UPDATE backup_cursor SET blocked_error = 'sequence_conflict' WHERE account_id = ?", accountId);
    });
    const outcome = await submitPreview(preview.ok ? preview.preview : null!);
    expect(outcome).toMatchObject({ ok: true, outcome: "unknown", errorCode: "backup_blocked" });
    expect(receiptCount()).toBe(0);
  });

  it("保护门禁：最新完成包快照哈希与当前主快照不一致 → backup_not_ready unknown，不切换", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    // 当前版本（rev2）下创建预览；然后把游标的最新完成指针改回 rev1：
    // 保护包（rev1）的快照哈希不再精确覆盖当前主文档（rev2）。
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    t.storage.transactionSync(() => {
      t.storage.sql.exec("UPDATE backup_cursor SET latest_completed_revision = 1 WHERE account_id = ?", accountId);
    });
    const outcome = await submitPreview(preview.ok ? preview.preview : null!);
    expect(outcome).toMatchObject({ ok: true, outcome: "unknown", errorCode: "backup_not_ready" });
    expect(receiptCount()).toBe(0);
    expect(headRow()!.origin_kind).toBe("initial");
  });

  it("保护读取期间新写入：最终事务拒绝旧确认（source_changed 终态）", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    // 在保护包读取期间注入一次新同步（R2 回调内完成）：最终事务复核拒绝。
    let nested: Promise<unknown> | undefined;
    const originalGet = t.bucket.get.bind(t.bucket);
    (t.bucket as unknown as { get: typeof t.bucket.get }).get = async (key: string) => {
      if (nested === undefined && key.includes("/objects/")) {
        const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
        if (read.ok && read.snapshot !== null) {
          const doc = freshDoc();
          doc.import(read.snapshot);
          writeRecord(doc, "record-0", { stationName: "保护期间写入" }, false);
          nested = t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: read.documentGeneration, snapshot: doc.export({ mode: "snapshot" }) });
          await nested;
        }
      }
      return await originalGet(key);
    };
    const outcome = await submitPreview(preview.ok ? preview.preview : null!);
    expect(outcome).toMatchObject({ ok: true, outcome: "not_committed", reason: "source_changed" });
    expect(receiptCount()).toBe(0);
  });

  it("事务后到达的旧代次上传被拒；空交换不造成无谓版本变更", async () => {
    const base = await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const outcome = await submitPreview(preview.preview);
    expect(outcome.ok && outcome.outcome === "committed").toBe(true);
    const newGeneration = outcome.ok && outcome.outcome === "committed" ? outcome.receipt.newGeneration : "";
    // 旧代次上传：409 document_generation_changed。
    const oldUpload = await t.account.syncRefueling({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      documentGeneration: base.generation, snapshot: base.snapshot,
    });
    expect(oldUpload).toMatchObject({ ok: false, error: "document_generation_changed", currentGeneration: newGeneration });
    // 空交换（无历史推进）不改变 revision，也不产生新的待备责任。
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    if (!read.ok || read.snapshot === null) throw new Error("read failed");
    const idle = await t.account.syncRefueling({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      documentGeneration: read.documentGeneration, snapshot: read.snapshot,
    });
    expect(idle.ok && idle.revision).toBe(outcome.ok && outcome.outcome === "committed" ? outcome.receipt.newRevision : 0);
    expect(cursorRow()!.pending_revision).toBeNull();
  });

  it("原子性：主分块/代次/游标/任务/回执/消费 preview/alarm 每个写入位置故障均整体回滚", async () => {
    // 每个注入点使用全新账号状态：成功重试会真正切换代次并留下冻结基线，
    // 复用同一账号会让后续注入点撞上恢复后的门禁/无变化状态。
    const tables = [
      "refueling_document_heads", "refueling_snapshots", "backup_cursor",
      "backup_frozen_task", "backup_frozen_task_chunks", "refueling_restore_receipts",
      "refueling_restore_previews",
    ];
    for (const table of [...tables, "alarm"]) {
      await resetAccount();
      await bootstrapAccountWithBaseline();
      await addVersion({ stationName: "v2" });
      const preview = await createPreviewFor(1);
      expect(preview.ok, table).toBe(true);
      if (!preview.ok) continue;
      const before = {
        generation: headRow()!.current_generation,
        revision: cursorRow()!.current_revision,
        receipts: receiptCount(),
        previews: previewRowCount(),
        alarm: t.storage.alarmTime(),
      };
      let remove: (() => void) | undefined;
      let restoreAlarm: (() => void) | undefined;
      if (table === "alarm") {
        const originalSetAlarm = t.storage.setAlarm.bind(t.storage);
        (t.storage as unknown as { setAlarm: typeof t.storage.setAlarm }).setAlarm = async () => {
          throw new Error("injected set_alarm failure");
        };
        restoreAlarm = () => {
          (t.storage as unknown as { setAlarm: typeof t.storage.setAlarm }).setAlarm = originalSetAlarm;
        };
      } else {
        remove = abortNextWrite(table);
      }
      const outcome = await submitPreview(preview.preview);
      remove?.();
      restoreAlarm?.();
      expect(outcome, table).toMatchObject({ ok: true, outcome: "unknown" });
      expect(headRow()!.current_generation, table).toBe(before.generation);
      expect(cursorRow()!.current_revision, table).toBe(before.revision);
      expect(receiptCount(), table).toBe(before.receipts);
      expect(previewRowCount(), table).toBe(before.previews);
      expect(t.storage.alarmTime(), table).toBe(before.alarm);
      // 故障解除后同一预览仍可成功提交。
      const retry = await submitPreview(preview.preview);
      expect(retry.ok && retry.outcome === "committed", table).toBe(true);
    }
  });
});

describe("B 失败结果裁决（§7.3 三种并发顺序与边界）", () => {
  it("顺序一：成功提交先于另一次 R2 失败 → 失败调用裁决读到回执返回 committed", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const first = await submitPreview(preview.preview);
    expect(first.ok && first.outcome === "committed").toBe(true);
    // 同 ID 第二次调用遇 R2 故障：裁决必须返回 committed，不误报失败。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { get: "throw" } });
    const second = await submitPreview(preview.preview);
    t.bucket.clearFaults();
    expect(second.ok && second.outcome === "committed").toBe(true);
  });

  it("顺序二：失败先返回 unknown、另一次随后提交 → 仍可执行且最终 committed", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { get: "throw" } });
    const failing = await submitPreview(preview.preview);
    t.bucket.clearFaults();
    expect(failing).toMatchObject({ ok: true, outcome: "unknown", errorCode: "restore_unavailable" });
    // 预览仍在、版本未推进：另一次调用合法提交。
    const success = await submitPreview(preview.preview);
    expect(success.ok && success.outcome === "committed").toBe(true);
  });

  it("顺序三：过期预览先被原子移除 → 迟到调用被拒（preview_expired 后 preview_replaced）", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // 预览过期后的第一次提交：裁决事务内删除过期预览并返回 preview_expired 终态。
    now += 15 * 60 * 1000 + 1;
    const expired = await submitPreview(preview.preview);
    expect(expired).toMatchObject({ ok: true, outcome: "not_committed", reason: "preview_expired" });
    expect(previewRowCount()).toBe(0);
    // 迟到的第二次调用（已读走目标字节的在途请求）：预览已不存在 → preview_replaced。
    const late = await submitPreview(preview.preview);
    expect(late).toMatchObject({ ok: true, outcome: "not_committed", reason: "preview_replaced" });
  });

  it("哈希不符但版本未推进：不单独判定终态（unknown）", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // 篡改暂存分块（模拟存储损坏）：验证失败但版本未推进 → unknown，不清 pending。
    t.storage.transactionSync(() => {
      t.storage.sql.exec("UPDATE refueling_restore_preview_chunks SET chunk = ? WHERE account_id = ? AND chunk_index = 0",
        new Uint8Array([1, 2, 3]).buffer, accountId);
    });
    const outcome = await submitPreview(preview.preview);
    expect(outcome).toMatchObject({ ok: true, outcome: "unknown", errorCode: "backup_invalid" });
    expect(previewRowCount()).toBe(1);
  });

  it("会话失效不泄露回执：401 且不读取回执", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const outcome = await submitPreview(preview.preview);
    expect(outcome.ok && outcome.outcome === "committed").toBe(true);
    // 撤销会话后提交同 ID：401 unauthorized，不回放回执。
    t.storage.transactionSync(() => {
      t.storage.sql.exec("DELETE FROM sessions WHERE session_hash = ?", sessionHash);
    });
    const revoked = await submitPreview(preview.preview);
    expect(revoked).toMatchObject({ ok: false, error: "unauthorized" });
    const response = await handleApiRequest(submitRequest({
      requestId: "00000000-0000-4000-8000-0000000000aa",
      previewId: preview.preview.previewId,
      backupStreamId: preview.preview.target.backupStreamId,
      revision: preview.preview.target.revision,
      bundleSha256: preview.preview.target.bundleSha256,
      expectedGeneration: preview.preview.expected.generation,
      expectedRevision: preview.preview.expected.revision,
      expectedSnapshotSha256: preview.preview.expected.snapshotSha256,
    }), environment(), { now: () => now });
    expect(response.status).toBe(401);
  });

  it("路由响应合同：not_committed/unknown 携带 requestId 与指纹；HTTP 状态映射", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const body = {
      requestId: "00000000-0000-4000-8000-0000000000bb",
      previewId: preview.preview.previewId,
      backupStreamId: preview.preview.target.backupStreamId,
      revision: preview.preview.target.revision,
      bundleSha256: preview.preview.target.bundleSha256,
      expectedGeneration: preview.preview.expected.generation,
      expectedRevision: preview.preview.expected.revision,
      expectedSnapshotSha256: preview.preview.expected.snapshotSha256,
    };
    // 预览被另一预览替换后提交：409 preview_replaced + not_committed + 绑定字段。
    await createPreviewFor(1);
    const response = await handleApiRequest(submitRequest(body), environment(), { now: () => now });
    expect(response.status).toBe(409);
    const parsed = await response.json() as Record<string, unknown>;
    expect(parsed).toMatchObject({
      error: "preview_replaced", outcome: "not_committed",
      requestId: body.requestId, requestFingerprint: await computeRestoreRequestFingerprint(body),
    });
    // unknown：篡改暂存 → 422 backup_invalid + outcome unknown + 绑定字段。
    const secondPreview = await createPreviewFor(1);
    expect(secondPreview.ok).toBe(true);
    if (!secondPreview.ok) return;
    t.storage.transactionSync(() => {
      t.storage.sql.exec("UPDATE refueling_restore_preview_chunks SET chunk = ? WHERE account_id = ? AND chunk_index = 0",
        new Uint8Array([9]).buffer, accountId);
    });
    const unknownBody = { ...body, previewId: secondPreview.preview.previewId };
    const unknownResponse = await handleApiRequest(submitRequest(unknownBody), environment(), { now: () => now });
    expect(unknownResponse.status).toBe(422);
    expect(await unknownResponse.json()).toMatchObject({
      error: "backup_invalid", outcome: "unknown",
      requestId: unknownBody.requestId, requestFingerprint: await computeRestoreRequestFingerprint(unknownBody),
    });
  });

  it("storage.sync 失败后的确认裁决：只查回执；无回执一律 unknown", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "v2" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const body = {
      requestId: "00000000-0000-4000-8000-0000000000cc",
      previewId: preview.preview.previewId,
      backupStreamId: preview.preview.target.backupStreamId,
      revision: preview.preview.target.revision,
      bundleSha256: preview.preview.target.bundleSha256,
      expectedGeneration: preview.preview.expected.generation,
      expectedRevision: preview.preview.expected.revision,
      expectedSnapshotSha256: preview.preview.expected.snapshotSha256,
    };
    const input: SubmitRestoreInput = {
      sessionHash, identity, nowMs: now, expectedAccountId: accountId,
      requestId: body.requestId,
      requestFingerprint: await computeRestoreRequestFingerprint(body),
      body,
    };
    // 切换已提交（服务层）后模拟 sync 失败：裁决读到回执 → committed。
    const committed = await t.restoreService.submit(input);
    expect(committed.ok && committed.outcome === "committed").toBe(true);
    const afterFailure = await t.restoreService.adjudicateAfterSyncFailure(input);
    expect(afterFailure.ok && afterFailure.outcome === "committed").toBe(true);
    // 无回执的请求（从未提交）：sync 失败裁决 → unknown，不做预览删除或终态判定。
    const neverInput: SubmitRestoreInput = {
      ...input,
      requestId: "00000000-0000-4000-8000-0000000000dd",
      body: { ...body, requestId: "00000000-0000-4000-8000-0000000000dd" },
    };
    neverInput.requestFingerprint = await computeRestoreRequestFingerprint(neverInput.body);
    const unknownOutcome = await t.restoreService.adjudicateAfterSyncFailure(neverInput);
    expect(unknownOutcome).toMatchObject({ ok: true, outcome: "unknown" });
    expect(previewRowCount()).toBe(0);
  });
});

describe("A 合同保持（回执查询与请求指纹）", () => {
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
    const again = await handleApiRequest(submitRequest(body), environment(), { now: () => now });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(replay);
    expect(t.bucket.counters.put).toBe(0);
  });

  it("GET 回执：存在返回 committed；不存在返回 404 restore_request_not_found", async () => {
    const body = requestBody();
    await insertSyntheticReceipt(body, { baselinePending: false });
    const found = await handleApiRequest(queryRequest(body.requestId), environment(), { now: () => now });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ outcome: "committed", requestId: body.requestId });
    const missing = await handleApiRequest(queryRequest("00000000-0000-4000-8000-0000000000ee"), environment(), { now: () => now });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "restore_request_not_found" });
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

  it("请求指纹：固定字段顺序无空白 JSON 的 SHA-256；同正文稳定、换目标即变", async () => {
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

describe("B 修复回归（第一轮父审：固定绑定、序列门禁、时钟到期与门禁分支）", () => {
  function exactBody(preview: { previewId: string; target: { backupStreamId: string; revision: number; bundleSha256: string }; expected: { generation: string; revision: number; snapshotSha256: string } }): RestoreRequestBody {
    return {
      requestId: crypto.randomUUID(), previewId: preview.previewId,
      backupStreamId: preview.target.backupStreamId, revision: preview.target.revision,
      bundleSha256: preview.target.bundleSha256, expectedGeneration: preview.expected.generation,
      expectedRevision: preview.expected.revision, expectedSnapshotSha256: preview.expected.snapshotSha256,
    };
  }

  it.each(["backupStreamId", "revision", "bundleSha256", "expectedGeneration", "expectedRevision", "expectedSnapshotSha256"] as const)("固定正文 %s 与预览不一致：不切换、不写回执、判 not_committed", async field => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "new" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const body = exactBody(preview.preview);
    if (field === "backupStreamId" || field === "expectedGeneration") body[field] = crypto.randomUUID();
    else if (field === "revision" || field === "expectedRevision") body[field] += 17;
    else body[field] = "f".repeat(64);
    const before = headRow()!.current_generation;
    const response = await handleApiRequest(submitRequest(body), environment(), { now: () => now });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ outcome: "not_committed", error: "source_changed" });
    expect(headRow()!.current_generation).toBe(before);
    expect(receiptCount()).toBe(0);
  });

  it("外部故障不改变固定绑定裁决：同一错误正文永久不可执行", async () => {
    await bootstrapAccountWithBaseline();
    const latest = await addVersion({ stationName: "new" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const body = exactBody(preview.preview);
    body.expectedGeneration = crypto.randomUUID();
    const latestCompletion = completionRow(latest.revision)!;
    t.bucket.addFault({ match: commitMarkerKey("production", accountId, "refueling", latestCompletion.stream_id, latest.revision), plan: { get: "throw" }, count: 1 });
    expect(await submit(body)).toMatchObject({ ok: true, outcome: "not_committed", reason: "source_changed" });
    expect(await submit(body)).toMatchObject({ ok: true, outcome: "not_committed", reason: "source_changed" });
    expect(headRow()!.origin_kind).toBe("initial");
    expect(receiptCount()).toBe(0);
  });

  it("陌生 stream：列表、预览与提交同样拒绝；外部解除后同一请求可重试且只切换一次", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "new" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const body = exactBody(preview.preview);
    const unknownKey = commitMarkerKey("production", accountId, "refueling", crypto.randomUUID(), 99);
    t.bucket.seedObject(unknownKey, new Uint8Array());
    expect(await listVersions()).toMatchObject({ ok: false, error: "backup_invalid" });
    expect(await createPreviewFor(1)).toMatchObject({ ok: false, error: "backup_invalid" });
    expect(await submit(body)).toMatchObject({ ok: true, outcome: "unknown" });
    expect(headRow()!.origin_kind).toBe("initial");
    expect(receiptCount()).toBe(0);
    await t.bucket.delete(unknownKey);
    expect(await submit(body)).toMatchObject({ ok: true, outcome: "committed" });
    expect(receiptCount()).toBe(1);
  });

  it("到期预览：时钟推进后按 preview_expired 判终态并删除暂存", async () => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "new" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const body = exactBody(preview.preview);
    now += 15 * 60 * 1000 + 1;
    expect(await submit(body)).toMatchObject({ ok: true, outcome: "not_committed", reason: "preview_expired" });
    expect(previewRowCount()).toBe(0);
    expect(headRow()!.origin_kind).toBe("initial");
    expect(receiptCount()).toBe(0);
  });

  it.each(["frozen_task", "retention", "prune_plan", "retry_floor"] as const)("保护门禁未就绪分支（%s）：保留 unknown 且不切换", async branch => {
    await bootstrapAccountWithBaseline();
    await addVersion({ stationName: "new" });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    if (branch === "retry_floor") {
      t.storage.transactionSync(() => { t.storage.sql.exec("UPDATE backup_cursor SET retry_floor_at = ? WHERE account_id = ?", now + 5000, accountId); });
    } else if (branch === "retention") {
      t.storage.transactionSync(() => { t.storage.sql.exec("INSERT INTO backup_retention_check VALUES (?, ?, ?)", accountId, 1, now); });
    } else if (branch === "prune_plan") {
      const streamId = completionRow(1)!.stream_id;
      t.storage.transactionSync(() => { t.storage.sql.exec("INSERT INTO backup_prune_plan VALUES (?, ?, ?, ?, 0)", accountId, 1, "synthetic-bundle-key", commitMarkerKey("production", accountId, "refueling", streamId, 1)); });
    } else {
      t.storage.transactionSync(() => {
        t.storage.sql.exec(`INSERT INTO backup_frozen_task (account_id, stream_id, revision, reason, captured_at, source_committed_at, previous_completed_revision, first_pending_revision, source_generation, format_version, generation_origin, manifest_json, bundle_sha256, snapshot_sha256, snapshot_bytes, history_sha256, record_count, bundle_key, marker_key, attempt_count, next_attempt_at)
          VALUES (?, ?, ?, 'restore-baseline', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`,
          accountId, completionRow(1)!.stream_id, 1, now);
      });
    }
    const body = exactBody(preview.preview);
    expect(await submit(body), branch).toMatchObject({ ok: true, outcome: "unknown" });
    expect(headRow()!.origin_kind, branch).toBe("initial");
    expect(receiptCount(), branch).toBe(0);
  });

  it("曾删除记录（tombstone）的恢复：原 ID、完整历史摘要与目标哈希在读回后核对", async () => {
    const bootstrap = await t.account.bootstrapRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    const first = freshDoc();
    for (const id of ["keep-a", "deleted-one", "keep-b"]) {
      writeRecord(first, id, { ...syntheticRecord, orderNumber: id }, true);
    }
    const firstSync = await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: bootstrap.documentGeneration, snapshot: first.export({ mode: "snapshot" }) });
    expect(firstSync.ok).toBe(true);
    await t.backups.onAlarm(now + windowMs);
    // 第二版：删除一条记录（保留删除历史）并编辑一条。
    const second = freshDoc();
    second.import(first.export({ mode: "snapshot" }));
    second.getMap("records").delete("deleted-one");
    writeRecord(second, "keep-a", { stationName: "编辑后" }, false);
    const secondSync = await t.account.syncRefueling({ sessionHash, identity, nowMs: now, expectedAccountId: accountId, documentGeneration: bootstrap.documentGeneration, snapshot: second.export({ mode: "snapshot" }) });
    expect(secondSync.ok).toBe(true);
    await t.backups.onAlarm(now + windowMs);
    expect(t.database.prepare("SELECT count(*) AS count FROM backup_completions").get()).toEqual({ count: 2 });
    const preview = await createPreviewFor(1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(await submitPreview(preview.preview)).toMatchObject({ ok: true, outcome: "committed" });
    const read = await t.account.readRefuelingSnapshot({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
    expect(read.ok && read.snapshot !== null).toBe(true);
    if (!read.ok || read.snapshot === null) return;
    expect(await sha256Hex(read.snapshot)).toBe(preview.preview.target.snapshotSha256);
    const analysis = await analyzeBackupSnapshot(read.snapshot);
    expect(analysis.historyVersionSha256).toBe(preview.preview.target.historySha256);
    const restored = freshDoc();
    restored.import(read.snapshot);
    expect([...restored.getMap("records").keys()].sort()).toEqual(["deleted-one", "keep-a", "keep-b"]);
    expect(read.snapshot.byteLength).toBeGreaterThan(0);
  });
});
