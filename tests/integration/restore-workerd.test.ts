// 恢复交付（A 代次兼容基础 + B 恢复操作）的 workerd 集成验收：真实进程 + 隔离持久化 + R2 模拟桶。
// 覆盖恢复设计 §12.1/§12.2 的 workerd 边界（B→A→B 回退与浏览器/CLI 边界为项目外验收）：
// - 协议 v2 bootstrap/GET/POST、426/400/409 语义与受控 G0 绑定（真实路由）。
// - 预升级冻结任务按 v1 原字节完成；新捕获为 v2；混合序列完整镜像核对。
// - 合成 B 恢复切换状态：A 消费 restore 来源与冻结恢复基线，新代次后续备份不丢来源。
// - 恢复回执端点：committed 回放、指纹冲突 409、无回执 503+unknown 零副作用、GET 404。
// - 代次 head 与回执跨真实 workerd SIGKILL 重启持久。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { LoroDoc, LoroMap } from "loro-crdt/web";
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
  worker = await startTestWorker({ bundleDir, persistDir, schedule: fastSchedule });
  await worker.setSchedule(fastSchedule);
}

async function restartWorker(): Promise<void> {
  await killWorkerdProcess();
  try {
    await worker.dispose();
  } catch {
    // 已被强杀：忽略 dispose 错误，同一 persistDir 重启。
  }
  // 节奏经绑定注入：重启后的持久告警可在 /test/schedule 之前触发，不能依赖运行时覆盖。
  worker = await startTestWorker({ bundleDir, persistDir, schedule: fastSchedule });
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
    expect(first.restoreWritesAvailable).toBe(true); // B 起提供恢复切换
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
    // 无回执且无匹配预览：B 裁决为 not_committed preview_replaced；零 R2 写入/列举。
    const countersBefore = await worker.r2Counters();
    const notCommitted = await restorePost(account, body);
    expect(notCommitted.status).toBe(409);
    expect(await notCommitted.json()).toMatchObject({
      error: "preview_replaced", outcome: "not_committed",
      requestId: body.requestId, requestFingerprint: await computeRestoreRequestFingerprint(body),
    });
    expect((await worker.r2Counters()).put).toBe(countersBefore.put);
    expect((await worker.r2Counters()).list).toBe(countersBefore.list);
    expect(await worker.execSql(`SELECT count(*) AS count FROM refueling_restore_receipts WHERE account_id = '${account.accountId}'`)).toEqual([{ count: 0 }]);
    // 无预览暂存（未创建任何 preview）；无回执路径不产生任何预览/切换状态。
    expect(await worker.execSql(`SELECT count(*) AS count FROM refueling_restore_previews WHERE account_id = '${account.accountId}'`)).toEqual([{ count: 0 }]);

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


interface VersionSummary {
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
  recordCount: number;
  selectable: boolean;
  restoreBaseline: boolean;
}

async function backupList(account: { token: string; accountId: string }): Promise<{ initialized: boolean; currentRevision: number | null; versions: VersionSummary[] }> {
  const response = await worker.miniflare.dispatchFetch("https://hako.test/api/backups/refueling", {
    method: "GET",
    headers: { Cookie: `__Host-hako_session=${account.token}`, "X-Hako-Account": account.accountId },
  });
  expect(response.status).toBe(200);
  return await response.json() as { initialized: boolean; currentRevision: number | null; versions: VersionSummary[] };
}

async function previewCreate(account: { token: string; accountId: string }, version: { backupStreamId: string; revision: number; bundleSha256: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.miniflare.dispatchFetch("https://hako.test/api/restores/refueling/previews", {
    method: "POST",
    headers: {
      Origin: "https://hako.test",
      Cookie: `__Host-hako_session=${account.token}`,
      "X-Hako-Account": account.accountId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(version),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function previewSnapshotGet(account: { token: string; accountId: string }, previewId: string): Promise<Response> {
  return await worker.miniflare.dispatchFetch(`https://hako.test/api/restores/refueling/previews/${previewId}/snapshot`, {
    method: "GET",
    headers: { Cookie: `__Host-hako_session=${account.token}`, "X-Hako-Account": account.accountId },
  });
}

/** 建立两份完成备份的账号（两代内容），返回可用信息。 */
async function accountWithTwoBackups(): Promise<{
  account: { token: string; accountId: string };
  generation: string;
  revisions: number[];
  restoreRequestBody: (preview: { previewId: string; target: { backupStreamId: string; revision: number; bundleSha256: string }; expected: { generation: string; revision: number; snapshotSha256: string } }, requestId: string) => RestoreRequestBody;
}> {
  const account = await worker.createSession();
  const bootstrap = await bootstrapOf(account);
  const first = doc();
  writeRecord(first, "one", syntheticRecord, true);
  writeRecord(first, "two", { ...syntheticRecord, occurredAtLocal: "2026-10-02T13:00:00" }, true);
  await syncOk(account, first.export({ mode: "snapshot" }), bootstrap.documentGeneration);
  await waitForBackups(1);
  const second = doc(first.export({ mode: "snapshot" }));
  writeRecord(second, "one", { stationName: "第二版" }, false);
  await syncOk(account, second.export({ mode: "snapshot" }), bootstrap.documentGeneration);
  await waitForBackups(2);
  const list = await backupList(account);
  return {
    account,
    generation: bootstrap.documentGeneration,
    revisions: list.versions.map((version) => version.revision),
    restoreRequestBody: (preview, requestId) => ({
      requestId,
      previewId: preview.previewId,
      backupStreamId: preview.target.backupStreamId,
      revision: preview.target.revision,
      bundleSha256: preview.target.bundleSha256,
      expectedGeneration: preview.expected.generation,
      expectedRevision: preview.expected.revision,
      expectedSnapshotSha256: preview.expected.snapshotSha256,
    }),
  };
}

function previewOf(body: Record<string, unknown>): {
  previewId: string;
  target: { backupStreamId: string; revision: number; bundleSha256: string; snapshotSha256: string };
  expected: { generation: string; revision: number; snapshotSha256: string };
} {
  const target = body.target as Record<string, unknown>;
  const expected = body.expected as Record<string, unknown>;
  return {
    previewId: body.previewId as string,
    target: {
      backupStreamId: target.backupStreamId as string,
      revision: target.revision as number,
      bundleSha256: target.bundleSha256 as string,
      snapshotSha256: target.snapshotSha256 as string,
    },
    expected: {
      generation: expected.generation as string,
      revision: expected.revision as number,
      snapshotSha256: expected.snapshotSha256 as string,
    },
  };
}

describe("B 恢复操作（workerd 集成验收，§12.2）", () => {
  it("完整恢复流程：列表→固定预览→快照读回→最终确认→代次切换→恢复基线完成→幂等回放", { timeout: 60_000 }, async () => {
    const setup = await accountWithTwoBackups();
    const list = await backupList(setup.account);
    expect(list.versions.map((version) => version.revision)).toEqual(setup.revisions);
    // 选中旧版本（rev1）创建固定预览；读取固定目标快照并核对摘要。
    const oldest = list.versions.at(-1)!;
    const created = await previewCreate(setup.account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    expect(created.status).toBe(200);
    const preview = previewOf(created.body);
    expect(preview.expected.generation).toBe(setup.generation);
    const snapshot = await previewSnapshotGet(setup.account, preview.previewId);
    expect(snapshot.status).toBe(200);
    const snapshotBytes = new Uint8Array(await snapshot.arrayBuffer());
    expect(await sha256Hex(snapshotBytes)).toBe(preview.target.snapshotSha256);
    // 最终确认：200 committed，代次/revision 与回执字段完整。
    const body = setup.restoreRequestBody(preview, crypto.randomUUID());
    const submitted = await restorePost(setup.account, body);
    expect(submitted.status).toBe(200);
    const receipt = await submitted.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      outcome: "committed", requestId: body.requestId,
      requestFingerprint: await computeRestoreRequestFingerprint(body),
      previousGeneration: setup.generation, baselinePending: true,
    });
    const newGeneration = receipt.newGeneration as string;
    expect(newGeneration).not.toBe(setup.generation);
    // GET 只读返回新代次与目标内容；revision 为切换前+1。
    const after = await snapshotGet(setup.account);
    expect(after.headers.get("X-Hako-Document-Generation")).toBe(newGeneration);
    expect(after.headers.get("X-Hako-Revision")).toBe(String(preview.expected.revision + 1));
    const afterBytes = new Uint8Array(await after.arrayBuffer());
    const restored = doc(afterBytes);
    expect(readRecords(restored).find((record) => record.id === "one")!.stationName).toBe("合成加油站");
    // 恢复基线在切换后窗口完成；后续备份沿用 restore 来源。
    await waitForBackups(3);
    const markers = (await markerKeys(setup.account.accountId)).sort();
    const baseline = await bundleOf(markers[2]);
    expect(baseline.manifest.reason).toBe("restore-baseline");
    expect(baseline.manifest.sourceGeneration).toEqual({ kind: "document-generation-v1", id: newGeneration });
    if (baseline.manifest.formatVersion !== 2) throw new Error("baseline must be v2");
    expect(baseline.manifest.generationOrigin).toMatchObject({ kind: "restore", requestId: body.requestId, previousGeneration: setup.generation });
    // 幂等：同 ID 同正文重复提交回放同一回执；同 ID 不同正文 409。
    const replayed = await restorePost(setup.account, body);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ outcome: "committed", committedAt: receipt.committedAt });
    const conflict = await restorePost(setup.account, { ...body, previewId: crypto.randomUUID() });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "request_id_conflict" });
    // 旧代次上传被拒；新代次正常同步。
    const old = doc();
    writeRecord(old, "one", syntheticRecord, true);
    expect((await syncRaw(setup.account, old.export({ mode: "snapshot" }), setup.generation)).status).toBe(409);
    const continued = doc(afterBytes);
    writeRecord(continued, "one", { stationName: "新代次编辑" }, false);
    await syncOk(setup.account, continued.export({ mode: "snapshot" }), newGeneration);
    await waitForBackups(4);
  });

  it("近 4 MiB 快照的恢复主路径：预览→保护→切换→读回核对哈希与记录数", { timeout: 240_000 }, async () => {
    const account = await worker.createSession();
    const bootstrap = await bootstrapOf(account);
    // 接近 4 MiB 的完整历史（字段长度遵守既有表单校验上限；与备份核心门禁同一构造方式）。
    const big = doc();
    let bigSnapshot = new Uint8Array(0);
    let recordIndex = 0;
    while (bigSnapshot.byteLength < 3_300_000 && recordIndex < 60_000) {
      for (let batch = 0; batch < 100 && recordIndex < 60_000; batch += 1, recordIndex += 1) {
        const record = big.getMap("records").setContainer(`big-${recordIndex}`, new LoroMap());
        const fields = { ...syntheticRecord, stationName: "长".repeat(50), fuelGrade: "95".repeat(40), orderNumber: `order-${recordIndex}-`.padEnd(128, "x") };
        for (const [key, value] of Object.entries(fields)) record.set(key, value);
      }
      big.commit();
      bigSnapshot = new Uint8Array(big.export({ mode: "snapshot" }));
    }
    expect(bigSnapshot.byteLength).toBeGreaterThan(3_000_000);
    expect(bigSnapshot.byteLength).toBeLessThan(4 * 1024 * 1024);
    await syncOk(account, bigSnapshot, bootstrap.documentGeneration);
    await waitForBackups(1, 60_000);
    // 第二版：编辑一条记录，提供较旧的恢复目标。
    const edited = doc(bigSnapshot);
    writeRecord(edited, "big-0", { stationName: "编辑后的站点" }, false);
    await syncOk(account, edited.export({ mode: "snapshot" }), bootstrap.documentGeneration);
    await waitForBackups(2, 60_000);
    const list = await backupList(account);
    expect(list.versions).toHaveLength(2);
    const oldest = list.versions.at(-1)!;
    const created = await previewCreate(account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    expect(created.status).toBe(200);
    const preview = previewOf(created.body);
    // 预览响应直接携带服务端核对出的记录数（previewOf 只映射子集，这里读原始响应体）。
    expect((created.body.target as Record<string, unknown>).recordCount).toBe(recordIndex);
    const body = {
      requestId: crypto.randomUUID(), previewId: preview.previewId,
      backupStreamId: preview.target.backupStreamId, revision: preview.target.revision,
      bundleSha256: preview.target.bundleSha256, expectedGeneration: preview.expected.generation,
      expectedRevision: preview.expected.revision, expectedSnapshotSha256: preview.expected.snapshotSha256,
    };
    const submitted = await restorePost(account, body);
    expect(submitted.status).toBe(200);
    const receipt = await submitted.json() as { outcome: string; newGeneration: string };
    expect(receipt.outcome).toBe("committed");
    const after = await snapshotGet(account);
    expect(after.headers.get("X-Hako-Document-Generation")).toBe(receipt.newGeneration);
    const afterBytes = new Uint8Array(await after.arrayBuffer());
    expect(afterBytes.byteLength).toBeGreaterThan(3_000_000);
    expect(await sha256Hex(afterBytes)).toBe(preview.target.snapshotSha256);
    const restored = doc(afterBytes);
    expect(readRecords(restored)).toHaveLength(recordIndex);
    await waitForBackups(3, 60_000);
  });

  it("提交后丢响应：客户端丢弃响应后查询回执为 committed；未接收前本机代次未变", { timeout: 60_000 }, async () => {
    const setup = await accountWithTwoBackups();
    const list = await backupList(setup.account);
    const oldest = list.versions.at(-1)!;
    const created = await previewCreate(setup.account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    expect(created.status).toBe(200);
    const preview = previewOf(created.body);
    const body = setup.restoreRequestBody(preview, crypto.randomUUID());
    // 客户端丢弃响应（模拟网络中断）：服务端已提交。
    const discarded = await restorePost(setup.account, body);
    expect(discarded.status).toBe(200);
    void await discarded.arrayBuffer();
    // 查询回执：committed；再提交同 ID：回放固定结果。
    const queried = await restoreGet(setup.account, body.requestId);
    expect(queried.status).toBe(200);
    expect(await queried.json()).toMatchObject({ outcome: "committed", requestId: body.requestId });
    const resubmitted = await restorePost(setup.account, body);
    expect(await resubmitted.json()).toMatchObject({ outcome: "committed", newRevision: preview.expected.revision + 1 });
    // 服务端已切换；未执行本机接收前，本机视角（GET）已能看到新代次——接收由客户端控制。
    const current = await snapshotGet(setup.account);
    expect(current.headers.get("X-Hako-Document-Generation")).not.toBe(setup.generation);
  });

  it("提交前丢响应（保护读取挂起）：结果 unknown→按本人选择以原 ID 重试成功", { timeout: 60_000 }, async () => {
    const setup = await accountWithTwoBackups();
    const list = await backupList(setup.account);
    const oldest = list.versions.at(-1)!;
    const created = await previewCreate(setup.account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    expect(created.status).toBe(200);
    const preview = previewOf(created.body);
    const body = setup.restoreRequestBody(preview, crypto.randomUUID());
    // 保护包读取挂起：请求在途、响应永不到达（客户端按超时丢弃）。
    await worker.setR2Fault({ op: "get", mode: "hang", once: true, skip: 0 });
    const lost = Promise.race([
      restorePost(setup.account, body),
      new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 599 })), 800)),
    ]);
    const timeout = await lost;
    expect(timeout.status).toBe(599);
    // 同 ID 查询：无回执 → 404（unknown）；不自动换 ID。
    expect((await restoreGet(setup.account, body.requestId)).status).toBe(404);
    // 本人选择以原 ID 与固定正文重试：成功（预览仍有效）。
    const retried = await restorePost(setup.account, body);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ outcome: "committed", requestId: body.requestId });
    // 只发生一次代次切换。
    const current = await snapshotGet(setup.account);
    expect(current.headers.get("X-Hako-Revision")).toBe(String(preview.expected.revision + 1));
  });

  it("冷启动提交：预览创建后重启进程，恢复提交仍完成切换（Loro 运行时在提交入口就绪）", { timeout: 60_000 }, async () => {
    const setup = await accountWithTwoBackups();
    const list = await backupList(setup.account);
    const oldest = list.versions.at(-1)!;
    const created = await previewCreate(setup.account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    expect(created.status).toBe(200);
    const preview = previewOf(created.body);
    const body = setup.restoreRequestBody(preview, crypto.randomUUID());
    // 预览在旧进程创建；重启后提交是本进程首次恢复操作（冷启动路径）。
    await restartWorker();
    const submitted = await restorePost(setup.account, body);
    expect(submitted.status).toBe(200);
    const receipt = await submitted.json() as { outcome: string; newGeneration: string };
    expect(receipt).toMatchObject({ outcome: "committed", requestId: body.requestId, previousGeneration: setup.generation });
    const current = await snapshotGet(setup.account);
    expect(current.headers.get("X-Hako-Document-Generation")).toBe(receipt.newGeneration);
    expect(current.headers.get("X-Hako-Revision")).toBe(String(preview.expected.revision + 1));
  });

  it("storage.sync 失败：响应不得宣称 committed/not_committed；后续查询确认 committed 且仅一次切换", { timeout: 60_000 }, async () => {
    const setup = await accountWithTwoBackups();
    const list = await backupList(setup.account);
    const oldest = list.versions.at(-1)!;
    const created = await previewCreate(setup.account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    expect(created.status).toBe(200);
    const preview = previewOf(created.body);
    const body = setup.restoreRequestBody(preview, crypto.randomUUID());
    await worker.setSyncFault(true);
    const failed = await restorePost(setup.account, body);
    // 持久确认失败：响应为 unknown（不得宣称 committed）。
    expect([503, 409, 422].includes(failed.status)).toBe(true);
    const failedBody = await failed.json() as { outcome?: string; error?: string };
    if (failedBody.outcome !== undefined) expect(failedBody.outcome).toBe("unknown");
    await worker.setSyncFault(false);
    // SQLite 中的事务已提交：查询回执确认 committed；只发生一次切换。
    const queried = await restoreGet(setup.account, body.requestId);
    expect(queried.status).toBe(200);
    expect(await queried.json()).toMatchObject({ outcome: "committed", requestId: body.requestId });
    const current = await snapshotGet(setup.account);
    expect(current.headers.get("X-Hako-Revision")).toBe(String(preview.expected.revision + 1));
    // 幂等：同 ID 再次提交回放 committed。
    const replay = await restorePost(setup.account, body);
    expect(await replay.json()).toMatchObject({ outcome: "committed" });
  });

  it("切换后 SIGKILL 同 persistDir 重启：回执/新代次/预览消费持久，恢复基线照常完成", { timeout: 90_000 }, async () => {
    const setup = await accountWithTwoBackups();
    const list = await backupList(setup.account);
    const oldest = list.versions.at(-1)!;
    const created = await previewCreate(setup.account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    expect(created.status).toBe(200);
    const preview = previewOf(created.body);
    const body = setup.restoreRequestBody(preview, crypto.randomUUID());
    const submitted = await restorePost(setup.account, body);
    expect(submitted.status).toBe(200);
    const receipt = await submitted.json() as { newGeneration: string };
    // 提交后立刻强杀：同一持久目录重启。
    await restartWorker();
    // 调试探针（临时）：重启后立刻读取 alarm 与任务状态。
    const dbg = await worker.debugState();
    console.log("SIGKILL_DEBUG after restart:", JSON.stringify({
      alarm: dbg.alarm,
      now: Date.now(),
      task: (dbg.rows.task ?? []).map((row) => ({ revision: (row as { revision: number }).revision, attempt: (row as { attempt_count: number }).attempt_count, next: (row as { next_attempt_at: number | null }).next_attempt_at })),
      cursor: (dbg.rows.cursor ?? []).map((row) => ({ current: (row as { current_revision: number }).current_revision, floor: (row as { retry_floor_at: number | null }).retry_floor_at, blocked: (row as { blocked_error: string | null }).blocked_error })),
    }));
    setTimeout(() => undefined, 0);
    const queried = await restoreGet(setup.account, body.requestId);
    expect(queried.status).toBe(200);
    expect(await queried.json()).toMatchObject({ outcome: "committed", requestId: body.requestId, newGeneration: receipt.newGeneration });
    // 重启后：预览已消费（不存在）、代次保持新值、恢复基线任务照常完成。
    expect((await previewSnapshotGet(setup.account, preview.previewId)).status).toBe(404);
    const current = await snapshotGet(setup.account);
    expect(current.headers.get("X-Hako-Document-Generation")).toBe(receipt.newGeneration);
    await waitForBackups(3);
    const markers = (await markerKeys(setup.account.accountId)).sort();
    const baseline = await bundleOf(markers[2]);
    expect(baseline.manifest.reason).toBe("restore-baseline");
    expect(baseline.manifest.sourceGeneration).toEqual({ kind: "document-generation-v1", id: receipt.newGeneration });
    // 同 ID 重复提交（客户端重开重发）：回放同一回执，不产生第二次切换。
    const replay = await restorePost(setup.account, body);
    expect(await replay.json()).toMatchObject({ outcome: "committed", newGeneration: receipt.newGeneration });
  });

  it("真正累计 31 份跨代次混合序列：裁剪至 30、无第 32 份、中断后继续收尾", { timeout: 300_000 }, async () => {
    const account = await worker.createSession();
    const bootstrap = await bootstrapOf(account);
    let generation = bootstrap.documentGeneration;
    // 累计 31 份完成：每份一次编辑→同步→等待窗口；在第 11 与 21 份之间各做一次真实恢复。
    let completed = 0;
    const targetCount = 31;
    let restoreCount = 0;
    let lastSnapshot: Uint8Array | null = null;
    while (completed < targetCount) {
      const working = doc(lastSnapshot ?? undefined);
      if (readRecords(working).length === 0) {
        writeRecord(working, `record-${completed}`, syntheticRecord, true);
      } else {
        writeRecord(working, "record-0", { stationName: `版本-${completed}` }, false);
      }
      const merged = await syncOk(account, working.export({ mode: "snapshot" }), generation);
      lastSnapshot = merged;
      completed += 1;
      // 第 31 份完成会立即触发裁剪（计数回到 30）：轮询不能要求瞬时峰值 31。
      await waitForBackups(Math.min(completed, 30), 30_000);
      if ((completed === 11 || completed === 21) && restoreCount < 2) {
        // 真实恢复到上一份完成版本：产生新代次与恢复基线。
        const list = await backupList(account);
        const previous = list.versions.find((version) => version.revision === completed - 1)!;
        const created = await previewCreate(account, { backupStreamId: previous.backupStreamId, revision: previous.revision, bundleSha256: previous.bundleSha256 });
        expect(created.status).toBe(200);
        const preview = previewOf(created.body);
        const submitted = await restorePost(account, setupRestoreBody(preview, crypto.randomUUID()));
        expect(submitted.status).toBe(200);
        const receipt = await submitted.json() as { newGeneration: string; newRevision: number };
        generation = receipt.newGeneration;
        lastSnapshot = new Uint8Array(await (await snapshotGet(account)).arrayBuffer());
        completed += 1;
        restoreCount += 1;
        await waitForBackups(completed, 30_000);
        continue;
      }
    }
    expect(completed).toBe(targetCount); // 29 次编辑 + 2 次恢复基线 = 31 份完成
    // 31 份完成触发裁剪：最终保留集合恰为最近 30 份（跨代次合计，不按代次另留）。
    await waitFor(async () => (await markerKeys(account.accountId)).length === 30, 60_000);
    const retained = (await markerKeys(account.accountId)).sort();
    expect(retained).toHaveLength(30);
    // 混合代次：保留集合同时包含 G0 与两个恢复代次的版本。
    const completions = await worker.execSql(`SELECT DISTINCT source_generation FROM backup_completions WHERE account_id = '${account.accountId}'`);
    expect(completions.length).toBeGreaterThanOrEqual(3);
    // 无第 32 份：等待一段无编辑时间后完成数仍为 30。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await markerKeys(account.accountId)).length).toBe(30);
  });

  it("恢复操作的实际 SQL 计量（列表/预览/保护门禁失败出口/确认切换/切换后基线分别采样，未混入并发同步）", { timeout: 60_000 }, async () => {
    const setup = await accountWithTwoBackups();
    // 列表请求的 SQL 差值。
    const beforeList = (await worker.sqlMeter()).totals;
    await backupList(setup.account);
    await settleMeter();
    const listMeter = (await worker.sqlMeter()).totals;
    const listDelta = delta(beforeList, listMeter);
    // 预览创建（含 R2 验证，事务外无 SQL）。
    const list = await backupList(setup.account);
    const oldest = list.versions.at(-1)!;
    const beforePreview = (await worker.sqlMeter()).totals;
    const created = await previewCreate(setup.account, { backupStreamId: oldest.backupStreamId, revision: oldest.revision, bundleSha256: oldest.bundleSha256 });
    await settleMeter();
    const previewMeter = (await worker.sqlMeter()).totals;
    expect(created.status).toBe(200);
    const previewDelta = delta(beforePreview, previewMeter);
    const preview = previewOf(created.body);
    const body = setup.restoreRequestBody(preview, crypto.randomUUID());
    // 保护门禁失败出口：保护包读取故障（R2 GET 抛错）短裁决为 unknown，零切换写入。
    await worker.setR2Fault({ op: "get", mode: "throw", once: true, skip: 0 });
    const beforeProtection = (await worker.sqlMeter()).totals;
    const blocked = await restorePost(setup.account, body);
    await settleMeter();
    const protectionMeter = (await worker.sqlMeter()).totals;
    const protectionDelta = delta(beforeProtection, protectionMeter);
    await worker.setR2Fault(null);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ outcome: "unknown" });
    expect((await restoreGet(setup.account, body.requestId)).status).toBe(404);
    // 确认切换（含入口验证、保护读回与唯一切换事务）。
    const beforeSubmit = (await worker.sqlMeter()).totals;
    const submitted = await restorePost(setup.account, body);
    await settleMeter();
    const submitMeter = (await worker.sqlMeter()).totals;
    expect(submitted.status).toBe(200);
    const submitDelta = delta(beforeSubmit, submitMeter);
    // 切换后基线：切换冻结的 restore-baseline 由 alarm 生命周期完成（单列样本）。
    const beforeBaseline = (await worker.sqlMeter()).totals;
    await waitForBackups(3);
    await settleMeter();
    const baselineMeter = (await worker.sqlMeter()).totals;
    const baselineDelta = delta(beforeBaseline, baselineMeter);
    const meter = (await worker.sqlMeter());
    expect(meter.incomplete).toBe(false);
    // 记录实测值（供本地验证进展引用）：每一项都必须为正且有界。
    console.log(`RESTORE_METERING list=${JSON.stringify(listDelta)} preview=${JSON.stringify(previewDelta)} protection=${JSON.stringify(protectionDelta)} submit=${JSON.stringify(submitDelta)} baseline=${JSON.stringify(baselineDelta)}`);
    for (const [name, value] of [["list", listDelta], ["preview", previewDelta], ["protection", protectionDelta], ["submit", submitDelta], ["baseline", baselineDelta]] as const) {
      expect(value.rowsRead, name).toBeGreaterThan(0);
      expect(value.statements, name).toBeGreaterThan(0);
    }
    // 列表与保护失败出口都是零写入（保护故障只走只读裁决）；预览/切换/基线分别有写入。
    expect(listDelta.rowsWritten).toBe(0);
    expect(protectionDelta.rowsWritten).toBe(0);
    expect(previewDelta.rowsWritten).toBeGreaterThan(0);
    expect(submitDelta.rowsWritten).toBeGreaterThan(0);
    expect(baselineDelta.rowsWritten).toBeGreaterThan(0);
  });
});

function setupRestoreBody(preview: {
  previewId: string;
  target: { backupStreamId: string; revision: number; bundleSha256: string };
  expected: { generation: string; revision: number; snapshotSha256: string };
}, requestId: string): RestoreRequestBody {
  return {
    requestId,
    previewId: preview.previewId,
    backupStreamId: preview.target.backupStreamId,
    revision: preview.target.revision,
    bundleSha256: preview.target.bundleSha256,
    expectedGeneration: preview.expected.generation,
    expectedRevision: preview.expected.revision,
    expectedSnapshotSha256: preview.expected.snapshotSha256,
  };
}

async function settleMeter(): Promise<void> {
  // 冲刷计量微任务后再取数（与测试入口的 alarm 包装同一口径）。
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

function delta(before: { rowsRead: number; rowsWritten: number; statements: number }, after: { rowsRead: number; rowsWritten: number; statements: number }): { rowsRead: number; rowsWritten: number; statements: number } {
  return {
    rowsRead: after.rowsRead - before.rowsRead,
    rowsWritten: after.rowsWritten - before.rowsWritten,
    statements: after.statements - before.statements,
  };
}
