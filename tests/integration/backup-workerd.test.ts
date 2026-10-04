// 独立备份的本地 workerd 集成验收：真实 alarm、真实 SQLite DO 事务、
// 真实 R2 模拟桶语义（条件创建/强一致读回）、真实进程崩溃与重启、
// 以及移除 DO 状态后仅凭 R2 完成标记的独立可读取性核心门禁。
// 逻辑层面的窗口／退避／裁剪矩阵在 tests/backup-engine.test.ts（真实 SQLite + 合成 R2）覆盖。

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  BACKUP_ENVIRONMENT,
  parseBundle,
  parseCommitMarkerKey,
  parseMarker,
  sha256Hex,
} from "../../src/worker/backup/backup-format";
import { PRODUCTION_BACKUP_SCHEDULE } from "../../src/worker/backup/backup-schedule";

const fastSchedule = {
  windowMs: 300,
  retryDelaysMs: [300, 1_000, 5_000, 10_000],
  hourlyRetryMs: 30_000,
  retentionCount: 30,
};

/**
 * 代次兼容基础（A）后的实测 SQL 计量（协议 v2 同步与备份生命周期）。
 * 数值以本套件连续多次全量运行的稳定读数为准（详见备份合同 §10 的更新记录）；
 * 计量取样口径不变：同步区间只含同步请求，alarm 区间按生命周期差值。
 */
const SQL_METERS = {
  sync: { rowsRead: 8, rowsWritten: 4 },
  firstBaselineAlarm: { rowsRead: 53, rowsWritten: 18, statements: 72 },
  windowMergeAlarm: { rowsRead: 56, rowsWritten: 18, statements: 73 },
  pruneAlarm: { rowsRead: 79, rowsWritten: 23, statements: 89 },
  retryFailedAlarm: { rowsRead: 29, rowsWritten: 7, statements: 36 },
  retryDoneAlarm: { rowsRead: 43, rowsWritten: 13, statements: 55 },
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
  persistDir = temporaryDirectory("hako-integration-persist-");
  worker = await startTestWorker({ bundleDir, persistDir });
  await worker.setSchedule(fastSchedule);
}

async function syncOk(account: { token: string; accountId: string }, snapshot: Uint8Array): Promise<Uint8Array> {
  const response = await worker.sync(account, snapshot);
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function completionCount(): Promise<number> {
  return ((await worker.debugState()).rows.completions ?? []).length;
}

async function waitForBackups(count: number, timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => (await completionCount()) >= count, timeoutMs);
}

async function publish(account: { token: string; accountId: string }, mutate: (working: LoroDoc, index: number) => void, index: number, last: Uint8Array): Promise<Uint8Array> {
  const before = await completionCount();
  const working = doc(last);
  mutate(working, index);
  const merged = await syncOk(account, working.export({ mode: "snapshot" }));
  await waitForBackups(before + 1);
  return merged;
}

function markerRevisionsOf(keys: string[]): number[] {
  return keys
    .map((key) => parseCommitMarkerKey(key)?.revision ?? -1)
    .sort((left, right) => left - right);
}

/** 独立验证：仅凭 R2 的完成标记定位包并读回，用全新 Loro 导入核对。 */
async function verifyStandaloneBundle(
  r2: Awaited<ReturnType<TestWorkerHandle["miniflare"]["getR2Bucket"]>>,
  markerKey: string,
): Promise<{ manifest: ReturnType<typeof parseBundle>["manifest"]; snapshot: Uint8Array }> {
  const markerBytes = await r2.get(markerKey);
  expect(markerBytes).not.toBeNull();
  const marker = parseMarker(new Uint8Array(await markerBytes!.bytes()));
  const bundleObject = await r2.get(marker.objectKey);
  expect(bundleObject).not.toBeNull();
  expect(bundleObject!.size).toBe(marker.bundleBytes);
  const bundleBytes = new Uint8Array(await bundleObject!.bytes());
  expect(await sha256Hex(bundleBytes)).toBe(marker.bundleSha256);
  const parsed = parseBundle(bundleBytes);
  expect(parsed.manifest.environment).toBe(BACKUP_ENVIRONMENT);
  expect(parsed.manifest.backupStreamId).toBe(marker.backupStreamId);
  expect(parsed.manifest.revision).toBe(marker.revision);
  expect(parsed.snapshot.byteLength).toBe(parsed.manifest.snapshotBytes);
  expect(await sha256Hex(parsed.snapshot)).toBe(parsed.manifest.snapshotSha256);
  const imported = doc();
  imported.import(parsed.snapshot);
  expect(readRecords(imported)).toHaveLength(parsed.manifest.recordCount);
  return { manifest: parsed.manifest, snapshot: parsed.snapshot };
}

/** 找到当前测试进程的 workerd 子进程（真实运行时进程）。 */
function findWorkerdChildPids(): number[] {
  const ps = execFileSync("ps", ["-axo", "pid,ppid,command"], { encoding: "utf8" });
  const pids: number[] = [];
  for (const line of ps.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) continue;
    const parentPid = Number.parseInt(match[2], 10);
    if (parentPid !== process.pid) continue;
    if (!match[3].includes("workerd")) continue;
    pids.push(Number.parseInt(match[1], 10));
  }
  return pids;
}

/** 强杀 workerd 进程，模拟崩溃（未提交事务丢弃，已提交状态保留在持久化目录）。 */
async function killWorkerdProcess(handle: TestWorkerHandle): Promise<void> {
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
  try {
    await handle.dispose();
  } catch {
    // 已被强杀的 Miniflare 实例关闭时可能抛错，忽略。
  }
}

async function restartWorker(): Promise<void> {
  worker = await startTestWorker({ bundleDir, persistDir });
  await worker.setSchedule(fastSchedule);
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

describe("独立备份 workerd 集成验收", () => {
  it("生产节奏：首次变化起固定 30 秒窗口，真实 alarm 触发完整备份", { timeout: 60_000 }, async () => {
    // 本测试使用生产节奏：重启独立实例且不覆盖 schedule。
    await worker.dispose();
    worker = await startTestWorker({ bundleDir, persistDir });
    const account = await worker.createSession();
    const before = Date.now();
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    // 协议 v2 客户端时序：bootstrap（应用打开时一次）在取样区间之外，
    // 取样区间内只有同步请求本身。
    await worker.bootstrap(account);
    const meterBeforeSync = (await worker.sqlMeter()).totals;
    await syncOk(account, working.export({ mode: "snapshot" }));
    // 一次同步（RPC 鉴证 + 代次核对 + 合并 + 待备责任 + 续期判定）的实际 SQL 用量：
    // 调试读取一律在区间之外。
    const meterAfterSync = (await worker.sqlMeter()).totals;
    const state = await worker.debugState();
    // alarm 固定在首次未覆盖变化 + 30 秒；不受后续编辑顺延。
    expect(state.alarm).not.toBeNull();
    expect(Math.abs((state.alarm! - 30_000) - before)).toBeLessThan(2_500);
    const syncSql = {
      rowsRead: meterAfterSync.rowsRead - meterBeforeSync.rowsRead,
      rowsWritten: meterAfterSync.rowsWritten - meterBeforeSync.rowsWritten,
    };
    expect(syncSql.rowsRead).toBe(SQL_METERS.sync.rowsRead);
    expect(syncSql.rowsWritten).toBe(SQL_METERS.sync.rowsWritten);
    // 计量完整性门禁：出现过累计异常（incomplete）时数值不可采纳。
    expect((await worker.sqlMeter()).incomplete).toBe(false);
    await waitForBackups(1, 40_000);
    // 一个备份生命周期（捕获→发布→确认→保留收尾→重排）的实际 SQL 用量；
    // 观测轮询被计量抑制排除，交错读取不改变该值。
    const meter = await worker.sqlMeter();
    expect(meter.active).toBe(true);
    expect(meter.incomplete).toBe(false);
    expect(meter.lastAlarm).not.toBeNull();
    expect(meter.lastAlarm!.rowsRead).toBe(SQL_METERS.firstBaselineAlarm.rowsRead);
    expect(meter.lastAlarm!.rowsWritten).toBe(SQL_METERS.firstBaselineAlarm.rowsWritten);
    expect(meter.lastAlarm!.statements).toBe(SQL_METERS.firstBaselineAlarm.statements);
    console.log("SQL_METER_PROD", JSON.stringify({ sync: syncSql, backupAlarm: meter.lastAlarm }));
    const after = await worker.debugState();
    expect(after.rows.completions).toEqual([{ revision: 1 }]);
    expect(after.rows.retention).toEqual([]);
    const keys = await listAllR2Keys(worker.r2, "hako-backup/");
    expect(keys).toHaveLength(2);
    const markerKey = keys.find((key) => key.includes("/commits/"))!;
    const { manifest } = await verifyStandaloneBundle(worker.r2, markerKey);
    expect(manifest.reason).toBe("baseline");
    expect(manifest.recordCount).toBe(1);
    expect(PRODUCTION_BACKUP_SCHEDULE.windowMs).toBe(30_000);
  });

  it("窗口内合并为一份、冻结期间新变化由下一份覆盖；实际 R2 调用数符合预算", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    let merged = await syncOk(account, working.export({ mode: "snapshot" }));
    // 窗口内第二个提交：合并为同一份备份。
    await new Promise((resolve) => setTimeout(resolve, 60));
    writeRecord(working, "two", { ...syntheticRecord, odometerTenths: 10500 }, true);
    merged = await syncOk(account, working.export({ mode: "snapshot" }));
    await waitForBackups(1);
    let state = await worker.debugState();
    expect(state.rows.completions).toEqual([{ revision: 2 }]);
    // 备份完成后下一份：新窗口。
    const copied = doc(merged);
    writeRecord(copied, "three", { ...syntheticRecord, odometerTenths: 11000 }, true);
    merged = await syncOk(account, copied.export({ mode: "snapshot" }));
    // 第二份备份的 alarm 等待期间交错显式调试 SQL（execSql）与只读观测轮询：
    // 调试 SQL 单列到独立调试计数器，业务计量不随调试/轮询频率变化。
    await waitFor(async () => {
      await worker.execSql("SELECT * FROM backup_frozen_task");
      return (await worker.debugState()).rows.completions.length >= 2;
    }, 20_000);
    state = await worker.debugState();
    expect(state.rows.completions).toEqual([{ revision: 2 }, { revision: 3 }]);

    // 每份备份：PUT 2 + LIST 2（PUT/LIST 均计 A 类）+ GET 2（B 类，包与标记读回）；
    // 无裁剪触发，无整套保留核查，DELETE 0。两份共 8 A / 4 B。
    const counters = await worker.r2Counters();
    expect(counters.put).toBe(4);
    expect(counters.delete).toBe(0);
    expect(counters.list).toBe(4);
    expect(counters.get).toBe(4);
    // 第二份备份（含窗口合并语义）的精确校准（合并场景行读高于单备份属预期）。
    const meter = await worker.sqlMeter();
    expect(meter.active).toBe(true);
    expect(meter.incomplete).toBe(false);
    expect(meter.lastAlarm!.rowsRead).toBe(SQL_METERS.windowMergeAlarm.rowsRead);
    expect(meter.lastAlarm!.rowsWritten).toBe(SQL_METERS.windowMergeAlarm.rowsWritten);
    expect(meter.lastAlarm!.statements).toBe(SQL_METERS.windowMergeAlarm.statements);
    console.log("SQL_METER_WINDOW", JSON.stringify(meter.lastAlarm));
    // 观测读取被计量抑制：debugState 轮询前后计量值完全不变——即使观测请求
    // 交错在 alarm 的外部 I/O 期间，也不进入生命周期差值（对照父侧合成实测：
    // 业务读 1 行 + 穿插 30 行调试查询曾使生命周期计数变成 31）。
    const totalsBeforeObservation = meter.totals;
    await worker.debugState();
    const totalsAfterObservation = (await worker.sqlMeter()).totals;
    expect(totalsAfterObservation).toEqual(totalsBeforeObservation);
    // 调试 SQL 的计量来源隔离（确定性校准）：完成后固定执行 3 次各 2 行的
    // 调试读取 → 调试计数器精确 +6 行读/+3 调用，业务累计完全不变。
    const debugTotalsBefore = (await worker.sqlMeter()).debugTotals;
    for (let index = 0; index < 3; index++) {
      await worker.execSql("SELECT * FROM backup_completions");
    }
    const meterAfterDebugSql = await worker.sqlMeter();
    expect(meterAfterDebugSql.debugIncomplete).toBe(false);
    expect(meterAfterDebugSql.debugTotals.rowsRead - debugTotalsBefore.rowsRead).toBe(6);
    expect(meterAfterDebugSql.debugTotals.statements - debugTotalsBefore.statements).toBe(3);
    expect(meterAfterDebugSql.totals).toEqual(totalsAfterObservation);
    const keys = await listAllR2Keys(worker.r2, "hako-backup/");
    expect(keys).toHaveLength(4);
    const newestMarker = keys.filter((key) => key.includes("/commits/")).sort().at(-1)!;
    const { manifest, snapshot } = await verifyStandaloneBundle(worker.r2, newestMarker);
    expect(manifest.revision).toBe(3);
    expect(manifest.recordCount).toBe(3);
    const imported = doc(snapshot);
    expect(readRecords(imported).map((record) => record.id).sort()).toEqual(["one", "three", "two"]);
  });

  it("上传前镜像守卫（workerd）：旧完成标记外部缺失时新备份先阻断，零新 PUT", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    let merged = await syncOk(account, working.export({ mode: "snapshot" }));
    await waitForBackups(1);
    // 外部删除 revision 1 的完成标记（R2 直删，绕过引擎）。
    const markerKey = (await listAllR2Keys(worker.r2, "hako-backup/")).find((key) => key.includes("/commits/"))!;
    await worker.r2.delete(markerKey);
    const putsBefore = (await worker.r2Counters()).put;
    // 新编辑 → 捕获 revision 2 → 序列检查在任何新 PUT 之前发现完成缓存与 R2
    // 标记镜像不一致（仅本任务自己的 revision 允许缺失）→ 进入 blocked。
    const copied = doc(merged);
    writeRecord(copied, "two", { ...syntheticRecord, odometerTenths: 12000 }, true);
    merged = await syncOk(account, copied.export({ mode: "snapshot" }));
    await waitFor(async () => {
      const current = await worker.debugState();
      return ((current.rows.cursor as Record<string, unknown>[])[0]?.blocked_error ?? null) === "sequence_conflict";
    }, 20_000);
    const state = await worker.debugState();
    expect(state.rows.completions).toEqual([{ revision: 1 }]);
    expect(state.rows.task).toHaveLength(1);
    expect(state.alarm).toBeNull();
    // 零新 PUT：新包与新标记都未写入；既有对象保留（旧包仍在，标记为外部所删）。
    expect((await worker.r2Counters()).put).toBe(putsBefore);
    const keys = await listAllR2Keys(worker.r2, "hako-backup/");
    expect(keys.filter((key) => key.includes("/objects/"))).toHaveLength(1);
    expect(keys.filter((key) => key.includes("/commits/"))).toHaveLength(0);
  });

  it("裁剪触发的备份生命周期 SQL 计量（加速节奏 retentionCount=2）", { timeout: 60_000 }, async () => {
    // 下一份备份前覆盖保留数量为 2：第 3 份完成后触发裁剪路径
    // （登记计划 + 核查保留对象 + 先删标记后删包 + 重新列出 + 结清）。
    await worker.setSchedule({ ...fastSchedule, retentionCount: 2 });
    const account = await worker.createSession();
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    let merged = await syncOk(account, working.export({ mode: "snapshot" }));
    await waitForBackups(1);
    for (const index of [2, 3]) {
      const copied = doc(merged);
      writeRecord(copied, `record-${index}`, { ...syntheticRecord, odometerTenths: 1000 * index }, true);
      merged = await syncOk(account, copied.export({ mode: "snapshot" }));
      if (index < 3) await waitForBackups(index);
    }
    // 第 3 份完成后触发裁剪：等待「已完成裁剪并结清」的稳定状态
    // （保留回到 2 份、无计划、无保留责任、调度停止），而非等待完成数增长。
    await waitFor(async () => {
      const settled = await worker.debugState();
      return settled.rows.completions.length === 2
        && settled.rows.plan.length === 0
        && settled.rows.retention.length === 0
        && settled.alarm === null;
    }, 20_000);
    const state = await worker.debugState();
    // 裁剪完成：保留最近 2 份，完成缓存与标记同步回到 2。
    expect(state.rows.completions).toEqual([{ revision: 2 }, { revision: 3 }]);
    expect((await listAllR2Keys(worker.r2, "hako-backup/")).filter((key) => key.includes("/commits/"))).toHaveLength(2);
    expect(state.alarm).toBeNull();
    // 第 3 份的 alarm 即「备份 + 触发裁剪 + 收尾」的完整生命周期 SQL 用量。
    const meter = await worker.sqlMeter();
    expect(meter.active).toBe(true);
    expect(meter.incomplete).toBe(false);
    expect(meter.lastAlarm!.rowsRead).toBe(SQL_METERS.pruneAlarm.rowsRead);
    expect(meter.lastAlarm!.rowsWritten).toBe(SQL_METERS.pruneAlarm.rowsWritten);
    expect(meter.lastAlarm!.statements).toBe(SQL_METERS.pruneAlarm.statements);
    console.log("SQL_METER_PRUNE", JSON.stringify(meter.lastAlarm));

    // 多行校准（30 行，与父侧 30 行探针同规模）：官方计量随游标消费逐步累计——
    // 完整消费后的 rowsRead 必须精确等于行数（exec 时快照只会读到 1），证明计量器
    // 按消费后终值计数。用无排序全表扫描（带 ORDER BY 的查询会把排序读数一并计入，
    // 2 行实测读 4）；校准表经 debugExecSql（显式测试 SQL，仍计量）建立。
    await worker.execSql("CREATE TABLE synthetic_sql_meter_calibration (id INTEGER PRIMARY KEY, value TEXT)");
    for (let id = 1; id <= 30; id++) {
      await worker.execSql(`INSERT INTO synthetic_sql_meter_calibration VALUES (${id}, 'synthetic')`);
    }
    const controlBefore = (await worker.sqlMeter()).debugTotals;
    const controlRows = await worker.execSql("SELECT * FROM synthetic_sql_meter_calibration");
    expect(controlRows).toHaveLength(30);
    const controlAfter = (await worker.sqlMeter()).debugTotals;
    console.log("SQL_METER_CONTROL", JSON.stringify({
      rows: controlRows.length,
      rowsRead: controlAfter.rowsRead - controlBefore.rowsRead,
      rowsWritten: controlAfter.rowsWritten - controlBefore.rowsWritten,
      statements: controlAfter.statements - controlBefore.statements,
    }));
    expect(controlAfter.rowsRead - controlBefore.rowsRead).toBe(30);
    expect(controlAfter.statements - controlBefore.statements).toBe(1);
    // 校准结束处的采样完整性门禁：累计出现过计量异常时上述读数不可采纳
    //（业务与调试两个计数器分别检查）。
    const meterAfterCalibration = await worker.sqlMeter();
    expect(meterAfterCalibration.active).toBe(true);
    expect(meterAfterCalibration.incomplete).toBe(false);
    expect(meterAfterCalibration.debugIncomplete).toBe(false);
  });

  it("R2 put 故障按真实退避重试后完成；写后丢失响应按同 key 读回核验，不生成第二份", { timeout: 30_000 }, async () => {
    const account = await worker.createSession();
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    let merged = await syncOk(account, working.export({ mode: "snapshot" }));
    // 窗口到期后的第一次尝试：包写入抛错 → 任务保留并按 fast 第 1 档退避（300ms）。
    await worker.setR2Fault({ op: "put", mode: "throw", once: true, skip: 0 });
    await waitFor(async () => {
      const state = await worker.debugState();
      return state.rows.task.length === 1
        && (state.rows.task[0] as { attempt_count: number }).attempt_count === 1;
    }, 10_000);
    let state = await worker.debugState();
    expect(state.rows.completions).toEqual([]);
    // 失败尝试的生命周期 SQL 用量（准备 + 失败 PUT + 善后重排）。
    const failedAttemptMeter = await worker.sqlMeter();
    expect(failedAttemptMeter.active).toBe(true);
    expect(failedAttemptMeter.incomplete).toBe(false);
    expect(failedAttemptMeter.lastAlarm!.rowsRead).toBe(SQL_METERS.retryFailedAlarm.rowsRead);
    expect(failedAttemptMeter.lastAlarm!.rowsWritten).toBe(SQL_METERS.retryFailedAlarm.rowsWritten);
    expect(failedAttemptMeter.lastAlarm!.statements).toBe(SQL_METERS.retryFailedAlarm.statements);
    console.log("SQL_METER_RETRY_FAILED", JSON.stringify(failedAttemptMeter.lastAlarm));
    await waitForBackups(1, 10_000);
    state = await worker.debugState();
    expect(state.rows.completions).toEqual([{ revision: 1 }]);
    // 成功重试的生命周期 SQL 用量（记录尝试 + 序列核对 + 条件创建/读回 + 确认 + 覆盖核对 + 收尾）。
    const retryMeter = await worker.sqlMeter();
    expect(retryMeter.active).toBe(true);
    expect(retryMeter.incomplete).toBe(false);
    expect(retryMeter.lastAlarm!.rowsRead).toBe(SQL_METERS.retryDoneAlarm.rowsRead);
    expect(retryMeter.lastAlarm!.rowsWritten).toBe(SQL_METERS.retryDoneAlarm.rowsWritten);
    expect(retryMeter.lastAlarm!.statements).toBe(SQL_METERS.retryDoneAlarm.statements);
    console.log("SQL_METER_RETRY_DONE", JSON.stringify(retryMeter.lastAlarm));

    // 写后丢失响应：包 PUT 已生效但抛错；重试时条件创建返回 null，读回核验一致后完成。
    const copied = doc(merged);
    writeRecord(copied, "two", syntheticRecord, true);
    merged = await syncOk(account, copied.export({ mode: "snapshot" }));
    await worker.setR2Fault({ op: "put", mode: "throw-after-write", once: true, skip: 0 });
    await waitForBackups(2, 10_000);
    const keys = await listAllR2Keys(worker.r2, "hako-backup/");
    expect(keys.filter((key) => key.includes("/objects/"))).toHaveLength(2);
    expect(keys.filter((key) => key.includes("/commits/"))).toHaveLength(2);
  });

  it("上传后读回前强杀 workerd：重启恢复同一任务，条件创建与读回核验后完成", { timeout: 60_000 }, async () => {
    const account = await worker.createSession();
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    await syncOk(account, working.export({ mode: "snapshot" }));
    // 窗口到期触发捕获与上传；在读回 GET 处挂起，模拟包已写入、进程在标记前崩溃。
    await worker.setR2Fault({ op: "get", mode: "hang", once: true, skip: 0 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const during = await worker.debugState();
    expect(during.rows.task.length).toBe(1);
    expect(during.rows.completions).toEqual([]);
    const objectsBefore = await listAllR2Keys(worker.r2, "hako-backup/").then((keys) => keys.filter((key) => key.includes("/objects/")));
    expect(objectsBefore).toHaveLength(1);

    await killWorkerdProcess(worker);
    await restartWorker();
    // 会话与待办任务跨重启持久：同一 key 条件创建返回 null，读回核验一致后完成。
    // （等待上限为错误检测上界，按全量并行负载留足余量，非性能断言。）
    await waitForBackups(1, 60_000);
    const state = await worker.debugState();
    expect(state.rows.completions).toEqual([{ revision: 1 }]);
    const objectsAfter = await listAllR2Keys(worker.r2, "hako-backup/").then((keys) => keys.filter((key) => key.includes("/objects/")));
    expect(objectsAfter).toEqual(objectsBefore);
  });

  it("完成确认后、首次保留检查 LIST 前强杀 workerd：重启先收尾且不发布第 32 份", { timeout: 90_000 }, async () => {
    const account = await worker.createSession();
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    let merged = await syncOk(account, working.export({ mode: "snapshot" }));
    await waitForBackups(1);
    for (let index = 2; index <= 30; index++) {
      merged = await publish(account, (instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index, merged);
    }
    expect(await completionCount()).toBe(30);
    // 第 31 份：确认事务提交后，保留检查 LIST 挂起（序列检查 LIST 放行一次）。
    await worker.setR2Fault({ op: "list", mode: "hang", once: true, skip: 1 });
    const copied = doc(merged);
    writeRecord(copied, "record-31", { ...syntheticRecord, odometerTenths: 30031 }, true);
    await syncOk(account, copied.export({ mode: "snapshot" }));
    await waitFor(async () => {
      const state = await worker.debugState();
      return state.rows.completions.length === 31 && state.rows.retention.length === 1 && state.rows.plan.length === 0;
    }, 15_000);
    const beforeKill = await worker.debugState();
    expect(beforeKill.rows.plan).toEqual([]);
    expect((beforeKill.rows.retention[0] as { pending_revision: number }).pending_revision).toBe(31);

    // 清理挂起期间新变化继续同步（R2 等待不阻塞同步），但不得提前捕获第 32 份。
    const duringCopy = doc(copied.export({ mode: "snapshot" }));
    writeRecord(duringCopy, "record-32", { ...syntheticRecord, odometerTenths: 30032 }, true);
    await syncOk(account, duringCopy.export({ mode: "snapshot" }));
    const duringHang = await worker.debugState();
    expect(duringHang.rows.task).toEqual([]);
    expect(duringHang.rows.completions.length).toBe(31);

    await killWorkerdProcess(worker);
    await restartWorker();
    // 保留检查责任跨重启持久：先收尾裁剪 revision 1，随后才捕获 revision 32；
    // 第 32 份发布后再裁剪 revision 2。最终保留集合恰为 revision 3..32。
    await waitFor(async () => {
      const state = await worker.debugState();
      if (state.rows.retention.length !== 0 || state.rows.plan.length !== 0 || state.rows.task.length !== 0) return false;
      const last = (state.rows.completions.at(-1) as { revision: number } | undefined)?.revision;
      return last === 32;
    }, 60_000);
    await waitFor(async () => {
      const markerRevisions = markerRevisionsOf((await listAllR2Keys(worker.r2, "hako-backup/"))
        .filter((key) => key.includes("/commits/")));
      return markerRevisions.length === 30 && markerRevisions[0] === 3 && markerRevisions.at(-1) === 32;
    }, 25_000);
    const finalState = await worker.debugState();
    expect(finalState.rows.completions.at(-1)).toEqual({ revision: 32 });
    expect(finalState.rows.completions).toHaveLength(30);
  });

  it("失败退避下限跨真实 workerd 重启：普通编辑不提前持久下限，恢复后完成", { timeout: 120_000 }, async () => {
    // 长退避档便于跨重启观察：第 1 档 2s，失败下限（第 2 档）30s。
    const restartSchedule = { windowMs: 300, retryDelaysMs: [2_000, 30_000, 60_000, 120_000], hourlyRetryMs: 300_000, retentionCount: 30 };
    await worker.setSchedule(restartSchedule);
    const account = await worker.createSession();
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    let merged = await syncOk(account, working.export({ mode: "snapshot" }));
    // 首次 R2 失败：任务冻结并按第 1 档（+2s）安排重试。
    await worker.setR2Fault({ op: "put", mode: "throw", once: true, skip: 0 });
    await waitFor(async () => (await worker.debugState()).rows.task.length === 1, 10_000);
    const deadline = ((await worker.debugState()).rows.task[0] as { next_attempt_at: number }).next_attempt_at;
    // 重试到期前安装持续失败触发器（随 DO SQLite 持久，跨重启保留）。
    await worker.execSql("CREATE TRIGGER fail_restart_floor BEFORE UPDATE ON backup_frozen_task BEGIN SELECT RAISE(ABORT, 'synthetic persistent failure'); END");
    // 到期 alarm 触发：UPDATE 失败 → 有界下限持久化（backup_cursor.retry_floor_at），
    // alarm 改为下限时间；尝试计数保持回滚残留值 1。
    await waitFor(async () => {
      const state = await worker.debugState();
      const task = (state.rows.task[0] ?? {}) as { attempt_count?: number };
      return state.alarm !== null && state.alarm > deadline + 20_000 && task.attempt_count === 1;
    }, 15_000);
    const floorAlarm = (await worker.debugState()).alarm!;

    // 强杀 workerd 并在同一持久化目录重启：SQLite（触发器与 retry_floor_at）、R2、
    // 会话与持久 alarm 全部保留。
    await killWorkerdProcess(worker);
    await restartWorker();
    await worker.setSchedule(restartSchedule);
    // 重启后一次普通编辑：不得把失败退避中的重试提前到当前时间（alarm 保持下限值）。
    const copied = doc(merged);
    writeRecord(copied, "after-restart", syntheticRecord, true);
    merged = await syncOk(account, copied.export({ mode: "snapshot" }));
    const afterSync = await worker.debugState();
    expect(afterSync.alarm).toBe(floorAlarm);

    // 移除触发器：下限时间 alarm 触发后按正常退避记录第 2 次尝试并完成，
    // 随后捕获重启后编辑（覆盖核对入口自动登记待备）。
    await worker.execSql("DROP TRIGGER fail_restart_floor");
    await waitForBackups(2, 60_000);
    const state = await worker.debugState();
    expect(state.rows.completions).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(state.alarm).toBeNull();
  });

  it("共享 alarm 跨真实 workerd 重启：较早的 B 窗口不绕过 A 的持久失败下限", { timeout: 120_000 }, async () => {
    // 长窗口给 B 留出强杀+重启时间；长退避档便于观察：第 1 档 2s，失败下限（第 2 档）30s。
    const schedule = { windowMs: 10_000, retryDelaysMs: [2_000, 30_000, 60_000, 120_000], hourlyRetryMs: 300_000, retentionCount: 30 };
    await worker.setSchedule(schedule);
    const subjectA = "shared-alarm-floor-a";
    const subjectB = "shared-alarm-floor-b";
    const accountA = await worker.createSession(subjectA);
    const accountB = await worker.createSession(subjectB);
    const syncA = async (snapshot: Uint8Array): Promise<Uint8Array> => {
      const response = await worker.syncDirect(subjectA, accountA, snapshot);
      expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    };
    const syncB = async (snapshot: Uint8Array): Promise<Uint8Array> => {
      const response = await worker.syncDirect(subjectB, accountB, snapshot);
      expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    };

    // A 首次变化：窗口到期后捕获，R2 一次失败 → 任务冻结并按第 1 档（+2s）安排重试。
    const workingA = doc();
    writeRecord(workingA, "a-one", syntheticRecord, true);
    await syncA(workingA.export({ mode: "snapshot" }));
    await worker.setR2Fault({ op: "put", mode: "throw", once: true, skip: 0 });
    await waitFor(async () => (await worker.debugState()).rows.task.length === 1, 15_000);
    // 重试到期前安装 A 账号作用域的持续失败触发器（随 DO SQLite 持久，跨重启保留；
    // B 的任务更新不受影响）。
    await worker.execSql(
      `CREATE TRIGGER fail_a_floor BEFORE UPDATE ON backup_frozen_task WHEN NEW.account_id = '${accountA.accountId}' BEGIN SELECT RAISE(ABORT, 'synthetic persistent failure'); END`,
    );
    // 到期 alarm 触发：A 的 UPDATE 失败 → 持久失败下限（第 2 档 +30s），alarm 改为下限时间。
    const retryDeadline = ((await worker.debugState()).rows.task[0] as { next_attempt_at: number }).next_attempt_at;
    await waitFor(async () => {
      const state = await worker.debugState();
      const task = (state.rows.task[0] ?? {}) as { attempt_count?: number };
      return state.alarm !== null && state.alarm > retryDeadline + 20_000 && task.attempt_count === 1;
    }, 15_000);
    const floorAlarm = (await worker.debugState()).alarm!;

    // B 的较早窗口：B 首次变化窗口 10s，早于 A 的 30s 下限 → 唯一共享 alarm 改为 B 的窗口到期时间。
    // 第二合成身份需绕过路由层固定 owner 校验直连 DO（认证边界由生产路由与既有回归覆盖）。
    const workingB = doc();
    writeRecord(workingB, "b-one", syntheticRecord, true);
    await syncB(workingB.export({ mode: "snapshot" }));
    expect((await worker.debugState()).alarm!).toBeLessThan(floorAlarm);

    // 强杀 workerd 并在同一持久化目录重启：B 的待备窗口与到期 alarm、A 的持久下限
    // （retry_floor_at）与冻结任务全部保留。
    await killWorkerdProcess(worker);
    await restartWorker();
    await worker.setSchedule(schedule);

    // 重启后共享 alarm 按 B 的较早时间触发：B 正常推进完成；A 在执行入口被有效下限
    // 门禁（不尝试、不计数、不清下限），alarm 回到 A 的下限时间。
    await waitFor(async () => {
      const rows = await worker.execSql("SELECT account_id, revision FROM backup_completions");
      return rows.some((row) => (row as { account_id: string; revision: number }).account_id === accountB.accountId);
    }, 30_000);
    const afterEarlyAlarm = await worker.debugState();
    const completionsByAccount = await worker.execSql("SELECT account_id, revision FROM backup_completions ORDER BY account_id, revision");
    expect(completionsByAccount).toEqual([{ account_id: accountB.accountId, revision: 1 }]);
    const taskA = afterEarlyAlarm.rows.task.find((row) => (row as { account_id: string }).account_id === accountA.accountId) as { attempt_count: number } | undefined;
    expect(taskA?.attempt_count).toBe(1);
    expect(afterEarlyAlarm.alarm).toBe(floorAlarm);

    // 移除 A 的触发器：下限时间 alarm 触发后记录第 2 次尝试并完成；两账号各一份、无残留调度。
    await worker.execSql("DROP TRIGGER fail_a_floor");
    await waitFor(async () => {
      const rows = await worker.execSql("SELECT account_id, revision FROM backup_completions");
      return rows.length === 2 && rows.some((row) => (row as { account_id: string }).account_id === accountA.accountId);
    }, 60_000);
    // 账号 UUID 的字典序不固定：按账号键断言各一份完成，不依赖排序。
    const finalCompletions = await worker.execSql("SELECT account_id, revision FROM backup_completions");
    expect(finalCompletions).toHaveLength(2);
    const revisionByAccount = new Map(finalCompletions.map((row) => {
      const { account_id, revision } = row as { account_id: string; revision: number };
      return [account_id, revision] as const;
    }));
    expect(revisionByAccount.get(accountA.accountId)).toBe(1);
    expect(revisionByAccount.get(accountB.accountId)).toBe(1);
    expect((await worker.debugState()).alarm).toBeNull();
  });

  it("真实 SQLite 触发器注入：启用冻结与确认事务失败时整体回滚，恢复后完成", { timeout: 60_000 }, async () => {
    const account = await worker.createSession();
    // 模拟部署前账号：先种入服务端文档，随即清除备份状态（窗口到期前）。
    const seed = doc();
    writeRecord(seed, "one", syntheticRecord, true);
    let merged = await syncOk(account, seed.export({ mode: "snapshot" }));
    for (const query of [
      "DELETE FROM backup_cursor",
      "DELETE FROM backup_frozen_task",
      "DELETE FROM backup_frozen_task_chunks",
      "DELETE FROM backup_completions",
      "DELETE FROM backup_retention_check",
      "DELETE FROM backup_prune_plan",
    ]) {
      await worker.execSql(query);
    }
    await waitFor(async () => (await worker.debugState()).alarm === null, 5_000);

    // 启用路径：冻结分块写失败 → 整个启用（游标、任务、alarm）回滚，同步 503。
    await worker.execSql(
      "CREATE TRIGGER fail_frozen BEFORE INSERT ON backup_frozen_task_chunks BEGIN SELECT RAISE(ABORT, 'synthetic frozen failure'); END",
    );
    const working = doc(merged);
    writeRecord(working, "one", { stationName: "启用后修改" }, false);
    const failed = await worker.sync(account, working.export({ mode: "snapshot" }));
    expect(failed.status).toBe(503);
    let state = await worker.debugState();
    expect(state.rows.cursor).toEqual([]);
    expect(state.rows.task).toEqual([]);
    expect(state.alarm).toBeNull();
    await worker.execSql("DROP TRIGGER fail_frozen");
    merged = await syncOk(account, working.export({ mode: "snapshot" }));
    // 基线完成后 pending 的 revision 2 由原始窗口立即补发一份。
    await waitForBackups(2, 15_000);
    state = await worker.debugState();
    expect(state.rows.completions).toEqual([{ revision: 1 }, { revision: 2 }]);

    // 确认事务失败：完成缓存不落库、任务保留、R2 已有包与标记；重试走“标记已存在”路径补记。
    const copied = doc(merged);
    writeRecord(copied, "three", syntheticRecord, true);
    await worker.execSql(
      "CREATE TRIGGER fail_confirm BEFORE INSERT ON backup_completions BEGIN SELECT RAISE(ABORT, 'synthetic confirm failure'); END",
    );
    await syncOk(account, copied.export({ mode: "snapshot" }));
    await waitFor(async () => {
      const current = await worker.debugState();
      return current.rows.task.length === 1
        && (current.rows.task[0] as { revision: number }).revision === 3
        && ((await listAllR2Keys(worker.r2, "hako-backup/")).filter((key) => key.includes("/objects/")).length === 3);
    }, 15_000);
    const during = await worker.debugState();
    expect(during.rows.completions).toEqual([{ revision: 1 }, { revision: 2 }]);
    await worker.execSql("DROP TRIGGER fail_confirm");
    await waitForBackups(3, 20_000);
    const finalState = await worker.debugState();
    expect(finalState.rows.completions).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
    const markers = (await listAllR2Keys(worker.r2, "hako-backup/")).filter((key) => key.includes("/commits/"));
    expect(markers).toHaveLength(3);
    const objects = (await listAllR2Keys(worker.r2, "hako-backup/")).filter((key) => key.includes("/objects/"));
    expect(objects).toHaveLength(3);
  });

  it("A/B 账号隔离：不同账号的备份在各自前缀下互不可见", { timeout: 30_000 }, async () => {
    const ownerA = await worker.createSession();
    const ownerB = await worker.createSession("synthetic-owner-b");
    expect(ownerA.accountId).not.toBe(ownerB.accountId);
    const a = doc();
    writeRecord(a, "a-only", syntheticRecord, true);
    await syncOk(ownerA, a.export({ mode: "snapshot" }));
    const b = doc();
    writeRecord(b, "b-only", { ...syntheticRecord, odometerTenths: 12000 }, true);
    // 第二合成身份绕过路由层固定 owner 校验直连 DO；认证边界由既有回归覆盖。
    const directResponse = await worker.syncDirect("synthetic-owner-b", ownerB, b.export({ mode: "snapshot" }));
    expect(directResponse.status).toBe(200);
    await waitForBackups(2);
    const keys = await listAllR2Keys(worker.r2, "hako-backup/");
    expect(keys.filter((key) => key.includes(`/accounts/${ownerA.accountId}/`))).toHaveLength(2);
    expect(keys.filter((key) => key.includes(`/accounts/${ownerB.accountId}/`))).toHaveLength(2);
    // A 的会话不能把数据写入 B 的账号（DO 内账号匹配拒绝）。
    const wrongAccount = await worker.syncDirect("synthetic-owner", { ...ownerA, accountId: ownerB.accountId }, a.export({ mode: "snapshot" }));
    expect(wrongAccount.status).toBe(409);
  });

  it("核心门禁：移除 DO 状态后仅凭本地 R2 完成标记读取并验证备份（空文档、并发历史、近 4 MiB）", { timeout: 240_000 }, async () => {
    // 账号 A：首次空快照 → 基线；随后记录、并发历史与编辑。
    const accountA = await worker.createSession();
    let mergedA = await syncOk(accountA, doc().export({ mode: "snapshot" }));
    await waitForBackups(1);
    const emptyMarker = (await listAllR2Keys(worker.r2, "hako-backup/")).find((key) => key.includes(`/accounts/${accountA.accountId}/`) && key.includes("/commits/"))!;
    const empty = await verifyStandaloneBundle(worker.r2, emptyMarker);
    expect(empty.manifest.recordCount).toBe(0);

    const base = doc(mergedA);
    writeRecord(base, "r1", syntheticRecord, true);
    mergedA = await syncOk(accountA, base.export({ mode: "snapshot" }));
    const historicalFrontier = base.frontiers();
    const historicalStation = syntheticRecord.stationName;
    // 并发历史：两个副本分别修改同一字段后依次合并（当前值一致但历史推进）。
    const copyOne = doc(mergedA);
    writeRecord(copyOne, "r1", { stationName: "并发站", orderNumber: "C-1" }, false);
    const copyTwo = doc(mergedA);
    writeRecord(copyTwo, "r1", { stationName: "并发站", fuelGrade: "95" }, false);
    mergedA = await syncOk(accountA, copyOne.export({ mode: "snapshot" }));
    mergedA = await syncOk(accountA, copyTwo.export({ mode: "snapshot" }));
    const copied = doc(mergedA);
    writeRecord(copied, "r2", { ...syntheticRecord, odometerTenths: 15000 }, true);
    mergedA = await syncOk(accountA, copied.export({ mode: "snapshot" }));
    // r1、两份并发副本与 r2 都落在同一窗口内：合并为一份完整历史备份。
    await waitForBackups(2, 30_000);
    const expectedA = readRecords(doc(mergedA));
    expect(expectedA).toHaveLength(2);

    // 账号 B：接近 4 MiB 的完整历史（字段长度遵守既有表单校验上限）。
    const accountB = await worker.createSession("independent-owner-b");
    const subjectB = "independent-owner-b";
    const big = doc();
    let bigSnapshot = new Uint8Array(0);
    let recordIndex = 0;
    while (bigSnapshot.byteLength < 3_300_000 && recordIndex < 60_000) {
      for (let batch = 0; batch < 100 && recordIndex < 60_000; batch++, recordIndex++) {
        const record = big.getMap("records").setContainer(`big-${recordIndex}`, new LoroMap());
        const fields = {
          ...syntheticRecord,
          stationName: "长".repeat(50),
          fuelGrade: "95".repeat(40),
          orderNumber: `order-${recordIndex}-`.padEnd(128, "x"),
        };
        for (const [key, value] of Object.entries(fields)) record.set(key, value);
      }
      big.commit();
      bigSnapshot = new Uint8Array(big.export({ mode: "snapshot" }));
    }
    readRecords(big);
    expect(bigSnapshot.byteLength).toBeGreaterThan(3_000_000);
    expect(bigSnapshot.byteLength).toBeLessThan(4 * 1024 * 1024);
    const directBig = await worker.syncDirect(subjectB, accountB, bigSnapshot);
    expect(directBig.status).toBe(200);
    const mergedB = new Uint8Array(await directBig.arrayBuffer());
    const expectedB = readRecords(doc(mergedB));
    await waitForBackups(3, 60_000);

    // 全部完成后停止调度，移除 DO 状态（SQLite 与 WAL），仅保留 R2。
    await waitFor(async () => (await worker.debugState()).alarm === null, 15_000);
    const persistBefore = readdirSync(persistDir);
    expect(persistBefore).toContain("do");
    await worker.dispose();
    rmSync(join(persistDir, "do"), { recursive: true, force: true });

    // 重启（DO 状态为空，R2 原样）：独立枚举完成标记并验证。
    const restarted = await startTestWorker({ bundleDir, persistDir });
    try {
      // DO 状态（含会话）已清除：状态路由不再认识旧会话；备份读取完全不依赖 DO。
      const statusResponse = await restarted.status(accountA);
      expect(statusResponse.status).toBe(401);

      const r2 = restarted.r2;
      for (const [account, expected] of [[accountA, expectedA], [accountB, expectedB]] as const) {
        const markerKeys = (await listAllR2Keys(r2, "hako-backup/"))
          .filter((key) => key.includes(`/accounts/${account.accountId}/`) && key.includes("/commits/"));
        expect(markerKeys.length).toBeGreaterThanOrEqual(1);
        const newestMarker = markerKeys.sort().at(-1)!;
        const verified = await verifyStandaloneBundle(r2, newestMarker);
        const imported = doc(verified.snapshot);
        // 逐字段核对当前记录。
        expect(readRecords(imported)).toEqual(expected);
        expect(verified.manifest.snapshotBytes).toBe(verified.snapshot.byteLength);
      }
      // checkout 已知历史点：账号 A 的最新备份包含完整历史，回到 r1 初始站名。
      const accountAMarkers = (await listAllR2Keys(r2, "hako-backup/"))
        .filter((key) => key.includes(`/accounts/${accountA.accountId}/`) && key.includes("/commits/"));
      const historyMarker = accountAMarkers.sort().at(-1)!;
      const historyVerified = await verifyStandaloneBundle(r2, historyMarker);
      const historyDoc = doc(historyVerified.snapshot);
      historyDoc.checkout(historicalFrontier);
      const historical = readRecords(historyDoc);
      expect(historical.find((record) => record.id === "r1")?.stationName).toBe(historicalStation);
    } finally {
      await restarted.dispose();
    }
  });

});
