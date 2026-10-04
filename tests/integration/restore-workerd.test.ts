// 恢复代次兼容基础（A 版本）的 workerd 集成验收：真实进程 + 隔离持久化 + R2 模拟桶。
// 覆盖恢复设计 §12.1 的「回退兼容基础」与协议/格式边界：
// - 协议 v2 bootstrap/GET/POST、426/400/409 语义与受控 G0 绑定（真实路由）。
// - 预升级冻结任务按 v1 原字节完成；新捕获为 v2；混合序列完整镜像核对。
// - 合成 B 恢复切换状态：A 消费 restore 来源与冻结恢复基线，新代次后续备份不丢来源。
// - 恢复回执端点：committed 回放、指纹冲突 409、无回执 503+unknown 零副作用、GET 404。
// - 代次 head 与回执跨真实 workerd SIGKILL 重启持久。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { LoroDoc } from "loro-crdt/web";
import {
  buildTestWorkerBundle,
  listAllR2Keys,
  removeDirectory,
  startTestWorker,
  temporaryDirectory,
  waitFor,
  type TestWorkerHandle,
} from "./harness";
import { initializeTestLoro, syntheticRecord } from "../helpers/sync-fixtures";
import { readRecords, writeRecord } from "../../src/data/refueling-document";
import {
  parseBundle,
  parseMarker,
  sha256Hex,
} from "../../src/worker/backup/backup-format";
import { computeRestoreRequestFingerprint, type RestoreRequestBody } from "../../src/shared/restore-protocol";

const fastSchedule = {
  windowMs: 300,
  retryDelaysMs: [300, 1_000, 5_000, 10_000],
  hourlyRetryMs: 30_000,
  retentionCount: 30,
};

let bundleDir: string;
let worker: TestWorkerHandle;
let persistDir: string;
const docs: LoroDoc[] = [];

function doc(snapshot?: Uint8Array): LoroDoc {
  const instance = new LoroDoc();
  docs.push(instance);
  if (snapshot) instance.import(snapshot);
  return instance;
}

async function startWorker(): Promise<void> {
  persistDir = temporaryDirectory("hako-restore-persist-");
  worker = await startTestWorker({ bundleDir, persistDir });
  await worker.setSchedule(fastSchedule);
}

async function restartWorker(): Promise<void> {
  await killWorkerdProcess();
  try {
    await worker.dispose();
  } catch {
    // 已被强杀：忽略 dispose 错误，同一 persistDir 重启。
  }
  worker = await startTestWorker({ bundleDir, persistDir });
  await worker.setSchedule(fastSchedule);
}

/** 找到当前测试进程的 workerd 子进程（真实运行时进程）。 */
function findWorkerdChildPids(): number[] {
  const ps = execFileSync("ps", ["-axo", "pid,ppid,command"], { encoding: "utf8" });
  const pids: number[] = [];
  for (const psLine of ps.split("\n")) {
    const match = psLine.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) continue;
    if (Number.parseInt(match[2], 10) !== process.pid) continue;
    if (!match[3].includes("workerd")) continue;
    pids.push(Number.parseInt(match[1], 10));
  }
  return pids;
}

/** 强杀 workerd 进程，模拟崩溃（未提交事务丢弃，已提交状态保留在持久化目录）。 */
async function killWorkerdProcess(): Promise<void> {
  const pids = findWorkerdChildPids();
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已退出。
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function bootstrapOf(account: { token: string; accountId: string }): Promise<{ documentGeneration: string; legacyGeneration: string; snapshotAvailable: boolean; restoreWritesAvailable: boolean }> {
  const response = await worker.miniflare.dispatchFetch("https://hako.test/api/sync/refueling/bootstrap", {
    method: "POST",
    headers: {
      Origin: "https://hako.test",
      Cookie: `__Host-hako_session=${account.token}`,
      "X-Hako-Account": account.accountId,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  return await response.json() as { documentGeneration: string; legacyGeneration: string; snapshotAvailable: boolean; restoreWritesAvailable: boolean };
}

async function syncRaw(account: { token: string; accountId: string }, snapshot: Uint8Array, generation: string, headers: Record<string, string> = {}): Promise<Response> {
  return await worker.miniflare.dispatchFetch("https://hako.test/api/sync/refueling", {
    method: "POST",
    headers: {
      Origin: "https://hako.test",
      Cookie: `__Host-hako_session=${account.token}`,
      "X-Hako-Account": account.accountId,
      "X-Hako-Sync-Protocol": "2",
      "X-Hako-Document-Generation": generation,
      "Content-Type": "application/octet-stream",
      ...headers,
    },
    body: new Uint8Array(snapshot) as unknown as BodyInit,
  });
}

async function syncOk(account: { token: string; accountId: string }, snapshot: Uint8Array, generation: string): Promise<Uint8Array> {
  const response = await syncRaw(account, snapshot, generation);
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function snapshotGet(account: { token: string; accountId: string }): Promise<Response> {
  return await worker.miniflare.dispatchFetch("https://hako.test/api/sync/refueling", {
    method: "GET",
    headers: {
      Cookie: `__Host-hako_session=${account.token}`,
      "X-Hako-Account": account.accountId,
      "X-Hako-Sync-Protocol": "2",
    },
  });
}

async function restorePost(account: { token: string; accountId: string }, body: RestoreRequestBody): Promise<Response> {
  return await worker.miniflare.dispatchFetch("https://hako.test/api/restores/refueling", {
    method: "POST",
    headers: {
      Origin: "https://hako.test",
      Cookie: `__Host-hako_session=${account.token}`,
      "X-Hako-Account": account.accountId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function restoreGet(account: { token: string; accountId: string }, requestId: string): Promise<Response> {
  return await worker.miniflare.dispatchFetch(`https://hako.test/api/restores/refueling/requests/${requestId}`, {
    method: "GET",
    headers: {
      Cookie: `__Host-hako_session=${account.token}`,
      "X-Hako-Account": account.accountId,
    },
  });
}

async function completionCount(): Promise<number> {
  return ((await worker.debugState()).rows.completions ?? []).length;
}

async function waitForBackups(count: number, timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => (await completionCount()) >= count, timeoutMs);
}

async function markerKeys(accountId: string): Promise<string[]> {
  return (await listAllR2Keys(worker.r2, `hako-backup/layout-v1/production/accounts/${accountId}/refueling/`))
    .filter((key) => key.includes("/commits/"));
}

async function bundleOf(markerKey: string): Promise<ReturnType<typeof parseBundle>> {
  const markerBytes = await worker.r2.get(markerKey);
  expect(markerBytes).not.toBeNull();
  const marker = parseMarker(new Uint8Array(await markerBytes!.bytes()));
  const bundleObject = await worker.r2.get(marker.objectKey);
  expect(bundleObject).not.toBeNull();
  const bundleBytes = new Uint8Array(await bundleObject!.bytes());
  expect(await sha256Hex(bundleBytes)).toBe(marker.bundleSha256);
  return parseBundle(bundleBytes);
}

async function seedPreUpgradeBackupState(accountId: string, streamId: string, snapshot: Uint8Array, nowMs: number): Promise<void> {
  await worker.execSql(`DELETE FROM refueling_snapshots WHERE account_id = '${accountId}'`);
  for (let offset = 0; offset < snapshot.byteLength; offset += 512 * 1024) {
    const chunk = snapshot.slice(offset, offset + 512 * 1024);
    await worker.execSql(`INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES ('${accountId}', ${Math.floor(offset / (512 * 1024))}, x'${Buffer.from(chunk).toString("hex")}', NULL)`);
  }
  await worker.execSql(`INSERT INTO backup_cursor (account_id, stream_id, created_at, current_revision, last_commit_at,
      latest_completed_revision, latest_completed_history_sha256, latest_completed_generation,
      pending_revision, pending_first_revision, pending_first_at, window_due_at,
      cleanup_attempt_count, cleanup_next_attempt_at, blocked_error, retry_floor_at)
    VALUES ('${accountId}', '${streamId}', ${nowMs}, 1, ${nowMs}, NULL, NULL, NULL, 1, 1, ${nowMs}, ${nowMs - 1000}, 0, NULL, NULL, NULL)`);
  // 升级前冻结的任务：无捕获代次/格式/来源（NULL），按 legacy 来源完成 v1。
  await worker.execSql(`INSERT INTO backup_frozen_task (account_id, stream_id, revision, reason, captured_at, source_committed_at,
      previous_completed_revision, first_pending_revision, source_generation, format_version, generation_origin,
      manifest_json, bundle_sha256, snapshot_sha256, snapshot_bytes, history_sha256, record_count,
      bundle_key, marker_key, attempt_count, next_attempt_at)
    VALUES ('${accountId}', '${streamId}', 1, 'baseline', ${nowMs}, NULL, NULL, 1, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`);
  await worker.execSql(`INSERT INTO backup_frozen_task_chunks (account_id, chunk_index, chunk)
    SELECT '${accountId}', chunk_index, snapshot FROM refueling_snapshots WHERE account_id = '${accountId}'`);
}

interface SwitchSeed {
  accountId: string;
  previousGeneration: string;
  newGeneration: string;
  requestId: string;
  streamId: string;
  snapshot: Uint8Array;
  baseRevision: number;
  nowMs: number;
}

/** 合成 B 的恢复切换事务结果：换 head、替换分块、写回执并冻结恢复基线任务。 */
async function seedSyntheticSwitch(seed: SwitchSeed): Promise<void> {
  const originJson = JSON.stringify({
    kind: "restore",
    requestId: seed.requestId,
    previousGeneration: seed.previousGeneration,
    targetBackup: { backupStreamId: seed.streamId, revision: seed.baseRevision, bundleSha256: "a".repeat(64) },
    protectionBackup: { backupStreamId: seed.streamId, revision: seed.baseRevision, bundleSha256: "b".repeat(64) },
  });
  const nextRevision = seed.baseRevision + 1;
  await worker.execSql(`INSERT OR REPLACE INTO refueling_document_heads
      (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
    VALUES ('${seed.accountId}', '${seed.newGeneration}', '${seed.previousGeneration}', 'restore', '${originJson.replace(/'/g, "''")}', ${seed.nowMs})`);
  await worker.execSql(`DELETE FROM refueling_snapshots WHERE account_id = '${seed.accountId}'`);
  for (let offset = 0; offset < seed.snapshot.byteLength; offset += 512 * 1024) {
    const chunk = seed.snapshot.slice(offset, offset + 512 * 1024);
    await worker.execSql(`INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES ('${seed.accountId}', ${Math.floor(offset / (512 * 1024))}, x'${Buffer.from(chunk).toString("hex")}', '${seed.newGeneration}')`);
  }
  await worker.execSql(`UPDATE backup_cursor SET current_revision = ${nextRevision}, last_commit_at = ${seed.nowMs},
      pending_revision = NULL, pending_first_revision = NULL, pending_first_at = NULL, window_due_at = NULL
    WHERE account_id = '${seed.accountId}'`);
  await worker.execSql(`INSERT INTO backup_frozen_task (account_id, stream_id, revision, reason, captured_at, source_committed_at,
      previous_completed_revision, first_pending_revision, source_generation, format_version, generation_origin,
      manifest_json, bundle_sha256, snapshot_sha256, snapshot_bytes, history_sha256, record_count,
      bundle_key, marker_key, attempt_count, next_attempt_at)
    VALUES ('${seed.accountId}', '${seed.streamId}', ${nextRevision}, 'restore-baseline', ${seed.nowMs}, ${seed.nowMs},
      (SELECT latest_completed_revision FROM backup_cursor WHERE account_id = '${seed.accountId}'), NULL,
      '${seed.newGeneration}', 2, '${originJson.replace(/'/g, "''")}',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`);
  await worker.execSql(`INSERT INTO backup_frozen_task_chunks (account_id, chunk_index, chunk)
    SELECT '${seed.accountId}', chunk_index, snapshot FROM refueling_snapshots WHERE account_id = '${seed.accountId}'`);
}

function restoreBody(requestId: string, generation: string, revision: number): RestoreRequestBody {
  return {
    requestId,
    previewId: "00000000-0000-4000-8000-0000000000f2",
    backupStreamId: "00000000-0000-4000-8000-0000000000f3",
    revision: 3,
    bundleSha256: "a".repeat(64),
    expectedGeneration: generation,
    expectedRevision: revision,
    expectedSnapshotSha256: "b".repeat(64),
  };
}

async function seedReceipt(accountId: string, body: RestoreRequestBody, overrides: Partial<{ previousGeneration: string; newGeneration: string; previousRevision: number; newRevision: number; baselinePending: number; committedAtMs: number }>): Promise<void> {
  const fingerprint = await computeRestoreRequestFingerprint(body);
  await worker.execSql(`INSERT INTO refueling_restore_receipts
      (account_id, request_id, request_fingerprint, previous_generation, new_generation,
       previous_revision, new_revision, source_backup, protection_backup, baseline_pending, committed_at_ms)
    VALUES ('${accountId}', '${body.requestId}', '${fingerprint}',
      '${overrides.previousGeneration ?? "00000000-0000-4000-8000-0000000000e1"}',
      '${overrides.newGeneration ?? "00000000-0000-4000-8000-0000000000e2"}',
      ${overrides.previousRevision ?? 3}, ${overrides.newRevision ?? 4},
      '${JSON.stringify({ backupStreamId: body.backupStreamId, revision: body.revision, bundleSha256: body.bundleSha256 })}',
      '${JSON.stringify({ backupStreamId: body.backupStreamId, revision: body.revision + 1, bundleSha256: "c".repeat(64) })}',
      ${overrides.baselinePending ?? 1}, ${overrides.committedAtMs ?? Date.now()})`);
}

beforeAll(async () => {
  await initializeTestLoro();
  bundleDir = await buildTestWorkerBundle();
}, 180_000);

beforeEach(startWorker);

afterEach(async () => {
  for (const instance of docs.splice(0)) instance.free();
  try {
    await worker.dispose();
  } catch {
    // 忽略已失效实例的关闭错误。
  }
  removeDirectory(persistDir);
});

afterAll(() => removeDirectory(bundleDir));

describe("恢复代次兼容基础（A）workerd 集成验收", () => {
  it("协议 v2：幂等 bootstrap、GET 快照、426/400 拒绝与受控 G0；代次漂移后 409 附元数据", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const first = await bootstrapOf(account);
    expect(first.restoreWritesAvailable).toBe(false);
    expect(first.documentGeneration).toBe(first.legacyGeneration);
    expect((await bootstrapOf(account)).documentGeneration).toBe(first.documentGeneration);

    // 无主文档：GET 返回 204，代次信息仍有效，revision 为 0。
    const empty = await snapshotGet(account);
    expect(empty.status).toBe(204);
    expect(empty.headers.get("X-Hako-Document-Generation")).toBe(first.documentGeneration);
    expect(empty.headers.get("X-Hako-Revision")).toBe("0");

    // 协议 1 与缺代次上传：426；格式错误代次：400（真实路由边界）。
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    const snapshot = working.export({ mode: "snapshot" });
    expect((await syncRaw(account, snapshot, first.documentGeneration, { "X-Hako-Sync-Protocol": "1" })).status).toBe(426);
    expect((await syncRaw(account, snapshot, "not-a-uuid")).status).toBe(400);
    const merged = await syncOk(account, snapshot, first.documentGeneration);
    expect(readRecords(doc(merged))).toHaveLength(1);

    // GET 返回完整快照与已持久 revision。
    const current = await snapshotGet(account);
    expect(current.status).toBe(200);
    expect(current.headers.get("X-Hako-Revision")).toBe("1");
    expect(readRecords(doc(new Uint8Array(await current.arrayBuffer())))).toHaveLength(1);

    // 合法但非当前代次：409 附当前代次元数据，不附业务快照。
    const stale = "00000000-0000-4000-8000-0000000000aa";
    const changed = await syncRaw(account, snapshot, stale);
    expect(changed.status).toBe(409);
    const body = await changed.json() as { error: string; currentGeneration: string; revision: number };
    expect(body).toMatchObject({ error: "document_generation_changed", currentGeneration: first.documentGeneration, revision: 1 });

    // head 缺失但分块已带代次：受控初始化拒绝（不随机补建 G0）。
    await worker.execSql(`DELETE FROM refueling_document_heads WHERE account_id = '${account.accountId}'`);
    const broken = await worker.miniflare.dispatchFetch("https://hako.test/api/sync/refueling/bootstrap", {
      method: "POST",
      headers: {
        Origin: "https://hako.test",
        Cookie: `__Host-hako_session=${account.token}`,
        "X-Hako-Account": account.accountId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual({ error: "generation_state_unavailable" });
  });

  it("预升级冻结任务按 v1 原格式完成；升级后新捕获为 v2；混合序列完整镜像", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const legacy = doc();
    writeRecord(legacy, "pre-upgrade", syntheticRecord, true);
    const streamId = crypto.randomUUID();
    await seedPreUpgradeBackupState(account.accountId, streamId, legacy.export({ mode: "snapshot" }), Date.now() - 60_000);

    // 升级路径：bootstrap 绑定 legacy 分块到 G0；同步推进历史并调度窗口。
    const bootstrap = await bootstrapOf(account);
    expect(bootstrap.snapshotAvailable).toBe(true);
    writeRecord(legacy, "after-upgrade", syntheticRecord, true);
    await syncOk(account, legacy.export({ mode: "snapshot" }), bootstrap.documentGeneration);

    // 快节奏下两份（升级前冻结的 v1 与升级后的 v2）先后完成；按 revision 定位。
    await waitForBackups(2);
    const allMarkers = (await markerKeys(account.accountId)).sort();
    expect(allMarkers).toHaveLength(2);
    // 升级前冻结的任务按 v1 完成：legacy 来源、协议 1、HAKOBK1 魔数。
    const v1 = await bundleOf(allMarkers[0]);
    expect(v1.manifest.revision).toBe(1);
    expect(v1.formatVersion).toBe(1);
    expect(v1.manifest.formatVersion).toBe(1);
    expect(v1.manifest.sourceGeneration).toEqual({ kind: "legacy-account-v1", id: account.accountId });
    expect(v1.manifest.syncProtocol).toBe(1);
    expect(v1.manifest.reason).toBe("baseline");

    // 升级后的新捕获为 v2：document-generation 来源、initial 来源、协议 2。
    const v2 = await bundleOf(allMarkers[1]);
    expect(v2.formatVersion).toBe(2);
    expect(v2.manifest.formatVersion).toBe(2);
    expect(v2.manifest.sourceGeneration).toEqual({ kind: "document-generation-v1", id: bootstrap.documentGeneration });
    if (v2.manifest.formatVersion !== 2) throw new Error("post-upgrade backup must be v2");
    expect(v2.manifest.generationOrigin).toEqual({ kind: "initial" });
    expect(v2.manifest.syncProtocol).toBe(2);
    expect(v2.manifest.reason).toBe("history-change");
  });

  it("合成 B 切换状态：A 消费 restore 来源与恢复基线任务；新代次只读/同步与来源沿用", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const bootstrap = await bootstrapOf(account);
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    await syncOk(account, working.export({ mode: "snapshot" }), bootstrap.documentGeneration);
    await waitForBackups(1);

    // 合成 B 的恢复切换：新代次 + 回执 + 冻结恢复基线任务（restore 来源）。
    const restored = doc();
    writeRecord(restored, "restored", { ...syntheticRecord, stationName: "恢复后" }, true);
    const newGeneration = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await seedSyntheticSwitch({
      accountId: account.accountId,
      previousGeneration: bootstrap.documentGeneration,
      newGeneration,
      requestId,
      streamId: ((await worker.execSql(`SELECT stream_id AS stream_id FROM backup_cursor WHERE account_id = '${account.accountId}'`))[0] as { stream_id: string }).stream_id,
      snapshot: restored.export({ mode: "snapshot" }),
      baseRevision: 1,
      nowMs: Date.now(),
    });

    // 旧代次上传在合并前被拒（附新代次元数据）；GET 只读返回新代次。
    expect((await syncRaw(account, working.export({ mode: "snapshot" }), bootstrap.documentGeneration)).status).toBe(409);
    const afterSwitch = await snapshotGet(account);
    expect(afterSwitch.headers.get("X-Hako-Document-Generation")).toBe(newGeneration);
    expect(readRecords(doc(new Uint8Array(await afterSwitch.arrayBuffer())))[0].stationName).toBe("恢复后");

    // 新代次上的普通编辑推进 revision 并调度窗口：alarm 先消费冻结的恢复基线任务。
    const edited = doc(restored.export({ mode: "snapshot" }));
    writeRecord(edited, "restored", { orderNumber: "新代次编辑" }, false);
    await syncOk(account, edited.export({ mode: "snapshot" }), newGeneration);

    // A 消费冻结的恢复基线：恢复基线以 v2 restore-baseline 发布，携带 restore 来源。
    await waitForBackups(2);
    const markers = (await markerKeys(account.accountId)).sort();
    const baseline = await bundleOf(markers[1]);
    expect(baseline.manifest.formatVersion).toBe(2);
    expect(baseline.manifest.reason).toBe("restore-baseline");
    expect(baseline.manifest.sourceGeneration).toEqual({ kind: "document-generation-v1", id: newGeneration });
    if (baseline.manifest.formatVersion !== 2) throw new Error("restore baseline must be v2");
    expect(baseline.manifest.generationOrigin).toEqual({
      kind: "restore",
      requestId,
      previousGeneration: bootstrap.documentGeneration,
      targetBackup: { backupStreamId: expect.any(String), revision: 1, bundleSha256: "a".repeat(64) },
      protectionBackup: { backupStreamId: expect.any(String), revision: 1, bundleSha256: "b".repeat(64) },
    });

    // 新代次后续普通编辑的备份：v2 沿用 restore 来源，不丢失。
    await waitForBackups(3);
    const finalMarkers = (await markerKeys(account.accountId)).sort();
    const followUp = await bundleOf(finalMarkers[2]);
    expect(followUp.manifest.reason).toBe("history-change");
    expect(followUp.manifest.sourceGeneration).toEqual({ kind: "document-generation-v1", id: newGeneration });
    if (followUp.manifest.formatVersion !== 2 || baseline.manifest.formatVersion !== 2) {
      throw new Error("follow-up and baseline backups must be v2");
    }
    expect(followUp.manifest.generationOrigin).toEqual(baseline.manifest.generationOrigin);
  });

  it("bootstrap 的 G0 绑定失败在真实 workerd 中整体回滚：不留下半完成 head，重试幂等", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const legacy = doc();
    writeRecord(legacy, "pre-upgrade", syntheticRecord, true);
    const snapshot = legacy.export({ mode: "snapshot" });
    // 模拟升级前主文档：legacy 分块（无代次标签）。
    await worker.execSql(`DELETE FROM refueling_snapshots WHERE account_id = '${account.accountId}'`);
    await worker.execSql(`INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES ('${account.accountId}', 0, X'${Buffer.from(snapshot).toString("hex")}', NULL)`);
    // 注入绑定故障：head 已插入但分块标签更新被中止。
    await worker.execSql("CREATE TRIGGER reject_generation_binding BEFORE UPDATE OF document_generation ON refueling_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END");
    const failed = await worker.miniflare.dispatchFetch("https://hako.test/api/sync/refueling/bootstrap", {
      method: "POST",
      headers: {
        Origin: "https://hako.test",
        Cookie: `__Host-hako_session=${account.token}`,
        "X-Hako-Account": account.accountId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(failed.status).toBe(503);
    // 事务回滚：head 未留下，分块仍是 legacy NULL——不存在半完成的初始化状态。
    expect(await worker.execSql(`SELECT current_generation FROM refueling_document_heads WHERE account_id = '${account.accountId}'`)).toEqual([]);
    expect(await worker.execSql(`SELECT document_generation FROM refueling_snapshots WHERE account_id = '${account.accountId}'`)).toEqual([{ document_generation: null }]);
    // 解除故障后重试：同一请求幂等完成绑定。
    await worker.execSql("DROP TRIGGER reject_generation_binding");
    const retried = await bootstrapOf(account);
    expect(retried.snapshotAvailable).toBe(true);
    expect(retried.documentGeneration).toBe(retried.legacyGeneration);
    expect(await worker.execSql(`SELECT document_generation FROM refueling_snapshots WHERE account_id = '${account.accountId}'`))
      .toEqual([{ document_generation: retried.documentGeneration }]);
  });

  it("恢复回执端点：committed 回放、指纹冲突 409、无回执 503+unknown 零副作用、GET 404", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const bootstrap = await bootstrapOf(account);
    const body = restoreBody("00000000-0000-4000-8000-0000000000c1", bootstrap.documentGeneration, 1);
    // 无回执：503 restore_unavailable + unknown；零 R2 写入/列举，回执表不变。
    const countersBefore = await worker.r2Counters();
    const unknown = await restorePost(account, body);
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({
      error: "restore_unavailable", outcome: "unknown",
      requestId: body.requestId, requestFingerprint: await computeRestoreRequestFingerprint(body),
    });
    expect((await worker.r2Counters()).put).toBe(countersBefore.put);
    expect((await worker.r2Counters()).list).toBe(countersBefore.list);
    expect(await worker.execSql(`SELECT count(*) AS count FROM refueling_restore_receipts WHERE account_id = '${account.accountId}'`)).toEqual([{ count: 0 }]);
    // A 无预览暂存实现（B 交付）；无回执路径也不产生任何预览/切换状态。
    expect(await worker.execSql(`SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'refueling_restore_pre%'`)).toEqual([{ count: 0 }]);

    // 注入合成 B 回执后：同指纹 POST 回放 committed；同 ID 不同正文 409 冲突。
    await seedReceipt(account.accountId, body, {
      previousGeneration: bootstrap.documentGeneration,
      newGeneration: "00000000-0000-4000-8000-0000000000e2",
      previousRevision: 1, newRevision: 2, baselinePending: 1,
      committedAtMs: Date.parse("2026-10-04T12:00:00Z"),
    });
    const committed = await restorePost(account, body);
    expect(committed.status).toBe(200);
    const replay = await committed.json() as Record<string, unknown>;
    expect(replay).toMatchObject({
      outcome: "committed", requestId: body.requestId,
      requestFingerprint: await computeRestoreRequestFingerprint(body),
      previousGeneration: bootstrap.documentGeneration,
      newGeneration: "00000000-0000-4000-8000-0000000000e2",
      previousRevision: 1, newRevision: 2, baselinePending: true,
      committedAt: "2026-10-04T12:00:00.000Z",
    });
    // 幂等：重复提交回放同一结果；GET 同样返回 committed。
    const replayed = await restorePost(account, body);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ outcome: "committed", requestId: body.requestId });
    const queried = await restoreGet(account, body.requestId);
    expect(queried.status).toBe(200);
    expect(await queried.json()).toMatchObject({ outcome: "committed", requestId: body.requestId });
    const conflictBody = { ...body, previewId: "00000000-0000-4000-8000-0000000000ff" };
    const conflict = await restorePost(account, conflictBody);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "request_id_conflict" });

    // GET 不存在的回执：404 restore_request_not_found（不证明请求未提交）。
    const missing = await restoreGet(account, "00000000-0000-4000-8000-0000000000ee");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "restore_request_not_found" });
    // 404 不改变回执状态。
    expect(await worker.execSql(`SELECT count(*) AS count FROM refueling_restore_receipts WHERE account_id = '${account.accountId}'`)).toEqual([{ count: 1 }]);
  });

  it("代次 head 与回执跨真实 workerd SIGKILL 重启持久；bootstrap 返回同一 G0", { timeout: 60_000 }, async () => {
    const account = await worker.createSession();
    const bootstrap = await bootstrapOf(account);
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    await syncOk(account, working.export({ mode: "snapshot" }), bootstrap.documentGeneration);
    const body = restoreBody("00000000-0000-4000-8000-0000000000d1", bootstrap.documentGeneration, 1);
    await seedReceipt(account.accountId, body, { newGeneration: "00000000-0000-4000-8000-0000000000d2" });

    await restartWorker();
    // 重启后：同一持久目录上 head/回执/主分块完整，bootstrap 幂等返回同一 G0。
    const afterRestart = await bootstrapOf(account);
    expect(afterRestart.documentGeneration).toBe(bootstrap.documentGeneration);
    const receipt = await restoreGet(account, body.requestId);
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ outcome: "committed", requestId: body.requestId });
    const snapshot = await snapshotGet(account);
    expect(snapshot.headers.get("X-Hako-Document-Generation")).toBe(bootstrap.documentGeneration);
    expect(readRecords(doc(new Uint8Array(await snapshot.arrayBuffer())))).toHaveLength(1);
    await syncOk(account, working.export({ mode: "snapshot" }), bootstrap.documentGeneration);
    await waitForBackups(1);
    const markers = await markerKeys(account.accountId);
    expect(markers).toHaveLength(1);
    const bundle = await bundleOf(markers[0]);
    expect(bundle.manifest.formatVersion).toBe(2);
    expect(bundle.manifest.sourceGeneration).toEqual({ kind: "document-generation-v1", id: bootstrap.documentGeneration });
    // 环境卫生：临时持久目录由 afterEach 清理。
    expect(readdirSync(persistDir).length).toBeGreaterThan(0);
  });
});
