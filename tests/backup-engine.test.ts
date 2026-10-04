import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAccount, type TestAccount } from "./helpers/account-state-sqlite";
import { initializeTestLoro, syntheticRecord } from "./helpers/sync-fixtures";
import { hashSecret } from "../src/worker/auth/secrets";
import { readRecords, writeRecord } from "../src/data/refueling-document";
import type { SyncRefuelingResult } from "../src/worker/auth/account-rpc";
import { AccountDocuments } from "../src/worker/sync/account-documents";
import { AccountSync } from "../src/worker/sync/account-sync";
import { BackupEngine } from "../src/worker/backup/backup-engine";
import { R2BackupObjectStore } from "../src/worker/backup/backup-object-store";
import { PRODUCTION_BACKUP_SCHEDULE } from "../src/worker/backup/backup-schedule";
import { BACKUP_ENVIRONMENT, parseBundle } from "../src/worker/backup/backup-format";

// 引擎单元验收：真实 SQLite 语义 + 合成 R2 桶 + 受控时钟与生产节奏常量。
// workerd 侧的真实 alarm/R2 集成见 tests/integration/backup-workerd.test.ts。

const identity = { issuer: "https://auth.eruoo.me", subject: "synthetic-backup-owner" };
const secondIdentity = { issuer: "https://auth.eruoo.me", subject: "synthetic-backup-owner-b" };
const token = "synthetic-backup-session-token";
const start = Date.parse("2026-10-04T00:00:00Z");
const windowMs = PRODUCTION_BACKUP_SCHEDULE.windowMs;
const retryDelays = PRODUCTION_BACKUP_SCHEDULE.retryDelaysMs;

let now: number;
let t: TestAccount;
let sessionHash: string;
let secondSessionHash: string;
let accountId: string;
const docs: LoroDoc[] = [];

function doc(snapshot?: Uint8Array): LoroDoc {
  const instance = new LoroDoc();
  docs.push(instance);
  if (snapshot) instance.import(snapshot);
  return instance;
}

function seedSession(hash: string, subject: string): void {
  t.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
    hash, identity.issuer, subject, now, now, now + 180 * 86400000, now + 365 * 86400000,
  );
}

async function setupAccount(): Promise<void> {
  sessionHash = await hashSecret(token);
  seedSession(sessionHash, identity.subject);
  secondSessionHash = await hashSecret("synthetic-backup-second-token");
  seedSession(secondSessionHash, secondIdentity.subject);
  accountId = (await t.account.readAccountId({ sessionHash, identity, nowMs: now }))!;
}

async function syncWith(hash: string, subject: string, snapshot: Uint8Array, expected: string): Promise<SyncRefuelingResult> {
  // 协议 v2：每次交换先以受控 bootstrap 取得当前代次（幂等，含 legacy 绑定），
  // 再携带代次上传；与生产客户端的 bootstrap→同步顺序一致。
  const bootstrap = await t.account.bootstrapRefueling({
    sessionHash: hash, identity: { issuer: identity.issuer, subject }, nowMs: now, expectedAccountId: expected,
  });
  if (!bootstrap.ok) throw new Error(`bootstrap failed: ${bootstrap.error}`);
  return await t.account.syncRefueling({
    sessionHash: hash,
    identity: { issuer: identity.issuer, subject },
    nowMs: now,
    expectedAccountId: expected,
    documentGeneration: bootstrap.documentGeneration,
    snapshot,
  });
}

async function sync(snapshot: Uint8Array): Promise<Uint8Array> {
  const result = await syncWith(sessionHash, identity.subject, snapshot, accountId);
  if (!result.ok) throw new Error(`sync failed: ${result.ok ? "" : result.error}`);
  return result.snapshot;
}

async function syncB(snapshot: Uint8Array): Promise<Uint8Array> {
  const secondAccountId = t.database.prepare(
    "SELECT account_id FROM account_data_ids WHERE subject = ?",
  ).get(secondIdentity.subject) as { account_id: string } | undefined;
  const result = await syncWith(secondSessionHash, secondIdentity.subject, snapshot, secondAccountId!.account_id);
  if (!result.ok) throw new Error(`sync b failed: ${result.ok ? "" : result.error}`);
  return result.snapshot;
}

async function fireAlarm(): Promise<void> {
  await t.backups.onAlarm(now);
}

/**
 * 模拟部署回退窗口的旧版本服务端写入：推进主库但不带代次标签（旧版 merge 的
 * 显式三列插入），也不更新 revision/待备责任；升级后的读取按回退窗口语义接受
 * 全 NULL 标签分块。
 */
function legacyWriteMainSnapshot(snapshot: Uint8Array): void {
  t.storage.transactionSync(() => {
    t.storage.sql.exec("DELETE FROM refueling_snapshots WHERE account_id = ?", accountId);
    for (let offset = 0; offset < snapshot.byteLength; offset += 512 * 1024) {
      t.storage.sql.exec(
        "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, ?, ?, NULL)",
        accountId,
        Math.floor(offset / (512 * 1024)),
        snapshot.slice(offset, offset + 512 * 1024).buffer,
      );
    }
  });
}

function cursorRow(): Record<string, unknown> {
  return t.database.prepare("SELECT * FROM backup_cursor WHERE account_id = ?").get(accountId) as Record<string, unknown>;
}

function taskRow(): Record<string, unknown> | undefined {
  return t.database.prepare("SELECT * FROM backup_frozen_task WHERE account_id = ?").get(accountId) as
    | Record<string, unknown>
    | undefined;
}

function completions(): { revision: number }[] {
  return t.database.prepare(
    "SELECT revision FROM backup_completions WHERE account_id = ? ORDER BY revision",
  ).all(accountId) as { revision: number }[];
}

function planRows(): { revision: number; marker_deleted: number }[] {
  return t.database.prepare(
    "SELECT revision, marker_deleted FROM backup_prune_plan WHERE account_id = ? ORDER BY revision",
  ).all(accountId) as { revision: number; marker_deleted: number }[];
}

function retentionRow(): { pending_revision: number } | undefined {
  return t.database.prepare(
    "SELECT pending_revision FROM backup_retention_check WHERE account_id = ?",
  ).get(accountId) as { pending_revision: number } | undefined;
}

function frozenTaskBytes(): Uint8Array | null {
  const rows = t.database.prepare(
    "SELECT chunk FROM backup_frozen_task_chunks WHERE account_id = ? ORDER BY chunk_index",
  ).all(accountId) as { chunk: Uint8Array }[];
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + row.chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const row of rows) {
    joined.set(row.chunk, offset);
    offset += row.chunk.byteLength;
  }
  return joined;
}

function markerKeys(): string[] {
  return t.bucket.storedKeys().filter((key) => key.includes("/commits/"));
}

function bundleKeys(): string[] {
  return t.bucket.storedKeys().filter((key) => key.includes("/objects/"));
}

/** 提交一次会推进历史的变化，并等待窗口到期后触发 alarm 完成一次备份。 */
async function publishBackup(mutate: (working: LoroDoc, index: number) => void, index: number): Promise<void> {
  const before = completions().length;
  const working = doc(lastMerged);
  mutate(working, index);
  lastMerged = await sync(working.export({ mode: "snapshot" }));
  now += windowMs;
  await fireAlarm();
  const after = completions();
  // 正常每次净增一份；第 31 份发布后同轮裁剪最旧一份，总数回到 30。
  if (after.length !== before + 1 && after.length !== 30) {
    throw new Error(`unexpected completions after publish #${index}: ${after.length} (before ${before})`);
  }
}

/** 从包字节读取业务记录（独立解析包容器，不直接当 Loro 快照导入）。 */
function recordsFromBundleKey(key: string): number {
  const parsed = parseBundle(t.bucket.storedBytes(key)!);
  return readRecords(doc(parsed.snapshot)).length;
}

let lastMerged: Uint8Array;
let currentDirectory: string;
const databasePath = (): string => join(currentDirectory, "account.sqlite");

beforeAll(initializeTestLoro);
beforeEach(async () => {
  currentDirectory = mkdtempSync(join(tmpdir(), "hako-backup-"));
  t = createTestAccount(databasePath(), { now: () => now });
  now = start;
  await setupAccount();
  lastMerged = new Uint8Array();
});
afterEach(() => {
  for (const instance of docs.splice(0)) instance.free();
  t.database.close();
  rmSync(currentDirectory, { recursive: true, force: true });
});

describe("版本判定与待备责任", () => {
  it("首次持久保存创建 revision 1 与 30 秒窗口；重复相同快照零变化零 R2", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const row = cursorRow();
    expect(row.current_revision).toBe(1);
    expect(row.pending_revision).toBe(1);
    expect(row.window_due_at).toBe(now + windowMs);
    expect(t.storage.alarmTime()).toBe(now + windowMs);
    expect(t.bucket.counters.put).toBe(0);

    const before = cursorRow();
    now += 2000;
    await sync(lastMerged);
    expect(cursorRow()).toEqual(before);
    expect(t.storage.alarmTime()).toBe(before.window_due_at);
    expect(t.bucket.counters.put).toBe(0);
    expect(t.bucket.counters.list).toBe(0);
  });

  it("被 LWW 隐藏的并发操作推进版本；A→B→A 两次提交、旧副本重试不增版", async () => {
    const a = doc();
    writeRecord(a, "one", syntheticRecord, true);
    lastMerged = await sync(a.export({ mode: "snapshot" }));
    const b = doc(lastMerged);
    // 两份副本写相同新值：第二次合并当前值不变，但历史推进。
    writeRecord(a, "one", { stationName: "并发站", orderNumber: "A-1" }, false);
    writeRecord(b, "one", { stationName: "并发站", orderNumber: "A-1" }, false);
    lastMerged = await sync(a.export({ mode: "snapshot" }));
    expect(cursorRow().current_revision).toBe(2);
    lastMerged = await sync(b.export({ mode: "snapshot" }));
    expect(cursorRow().current_revision).toBe(3);
    expect(cursorRow().pending_revision).toBe(3);
    expect(cursorRow().window_due_at).toBe(now + windowMs);
    // 旧副本（不含新历史）重试：不增版。
    const stale = a.export({ mode: "snapshot" });
    await sync(stale);
    expect(cursorRow().current_revision).toBe(3);
  });

  it("非法文档整体回滚：revision、窗口与 alarm 不变，不留下部分责任", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const before = cursorRow();
    const alarmBefore = t.storage.alarmTime();
    const invalid = doc(lastMerged);
    invalid.getMap("credentials").set("token", "synthetic-forbidden");
    invalid.commit();
    const result = await syncWith(sessionHash, identity.subject, invalid.export({ mode: "snapshot" }), accountId);
    expect(result).toEqual({ ok: false, error: "invalid_document" });
    expect(cursorRow()).toEqual(before);
    expect(t.storage.alarmTime()).toBe(alarmBefore);
    // 无效输入不创建新映射或任何备份状态。
    expect(t.database.prepare("SELECT count(*) AS count FROM account_data_ids").get()).toEqual({ count: 1 });
  });

  it("部署回退窗口由旧代码写入的主历史：空闲同步补登记待备并完成覆盖", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(t.storage.alarmTime()).toBeNull();

    // 模拟回退到不认识备份的旧版本代码：设备写入新历史后，旧版服务端用同一
    // AccountDocuments.merge 在持久事务里推进主库（旧版没有 onSuccessfulMerge，
    // revision 计数器与待备责任不更新）。
    writeRecord(working, "legacy-window", syntheticRecord, true);
    legacyWriteMainSnapshot(working.export({ mode: "snapshot" }));

    // 升级回新版本后客户端按当前快照空闲同步（无新历史）：合并结果包含旧版
    // 写入的历史，在同一同步事务内补登记为新的服务端 revision 并开启窗口，
    // 而不是停留在 coverage_mismatch 观察态。
    now += 1000;
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const row = cursorRow();
    expect(row.current_revision).toBe(2);
    expect(row.pending_revision).toBe(2);
    expect(row.window_due_at).toBe(now + windowMs);
    expect(t.storage.alarmTime()).toBe(now + windowMs);

    // 窗口到期后捕获并完成覆盖；备份包含旧代码写入的完整历史。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    const covered = parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!);
    expect(readRecords(doc(covered.snapshot)).map((record) => record.id).sort()).toEqual(["legacy-window", "one"]);

    // 覆盖完成后的空闲同步不再产生新责任、新窗口或任何 R2 调用。
    now += 1000;
    const counters = { ...t.bucket.counters };
    lastMerged = await sync(lastMerged);
    await fireAlarm();
    expect(t.bucket.counters).toEqual(counters);
    expect(t.storage.alarmTime()).toBeNull();
  });
});

describe("固定窗口与捕获", () => {
  it("窗口内合并为一份备份，窗口锚定首次未覆盖变化且不顺延", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const dueAt = now + windowMs;
    // 窗口内第二、三次提交：只更新最新待备版本，不后移到期时间。
    for (let index = 0; index < 2; index++) {
      now += 5000;
      writeRecord(working, `extra-${index}`, { ...syntheticRecord, odometerTenths: 10000 + index }, true);
      lastMerged = await sync(working.export({ mode: "snapshot" }));
      expect(cursorRow().current_revision).toBe(2 + index);
      expect(cursorRow().window_due_at).toBe(dueAt);
    }
    now = dueAt;
    await fireAlarm();
    // 冻结的是窗口内最新版本（revision 3），一份备份覆盖 2 与 3。
    expect(completions()).toEqual([{ revision: 3 }]);
    expect(cursorRow().pending_revision).toBeNull();
    expect(cursorRow().latest_completed_revision).toBe(3);
    // 覆盖区间从首次未覆盖变化（revision 1，含初始文档）开始。
    const bundle = t.bucket.storedBytes(bundleKeys()[0])!;
    const bundleHeader = parseBundle(bundle);
    expect(bundleHeader.manifest.revision).toBe(3);
    expect(bundleHeader.manifest.firstPendingRevision).toBe(1);
    expect(bundleHeader.manifest.snapshotBytes).toBe(bundleHeader.snapshot.byteLength);
    expect(t.bucket.storedKeys()).toHaveLength(2);
  });

  it("两个窗口分别完成两份备份；无变化且无未完任务时零新增 R2 且停止调度", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(t.bucket.storedKeys()).toHaveLength(2);
    expect(t.storage.alarmTime()).toBeNull();

    const putBefore = t.bucket.counters.put;
    const listBefore = t.bucket.counters.list;
    now += 1000;
    writeRecord(working, "two", { ...syntheticRecord, odometerTenths: 10500 }, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(t.storage.alarmTime()).toBeNull();

    // 完全无变化的重复同步与 alarm 不产生任何 R2 调用。
    const counters = { ...t.bucket.counters };
    now += 5000;
    await sync(lastMerged);
    await fireAlarm();
    expect(t.bucket.counters).toEqual(counters);
    expect(t.bucket.counters.put).toBe(putBefore + 2);
    expect(t.bucket.counters.list).toBe(listBefore + 2);
  });

  it("合法完整空快照首次作为基线捕获一次，之后空副本轮询不新增", async () => {
    const empty = doc();
    lastMerged = await sync(empty.export({ mode: "snapshot" }));
    expect(cursorRow().current_revision).toBe(1);
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    const emptyBundle = parseBundle(t.bucket.storedBytes(bundleKeys()[0])!);
    expect(emptyBundle.manifest.recordCount).toBe(0);
    expect(emptyBundle.manifest.reason).toBe("baseline");
    const counters = { ...t.bucket.counters };
    now += 5000;
    await sync(doc().export({ mode: "snapshot" }));
    await fireAlarm();
    expect(t.bucket.counters).toEqual(counters);
  });

  it("启用前已有文档：同一提交冻结启用前快照为基线，推进则另留待备责任", async () => {
    const working = doc();
    writeRecord(working, "legacy", syntheticRecord, true);
    const preEnablementBytes = await sync(working.export({ mode: "snapshot" }));
    // 模拟部署前的账号：已有服务端文档、从未启用备份（清空备份状态与调度）。
    t.database.exec(`
      DELETE FROM backup_cursor;
      DELETE FROM backup_frozen_task;
      DELETE FROM backup_frozen_task_chunks;
      DELETE FROM backup_completions;
      DELETE FROM backup_retention_check;
      DELETE FROM backup_prune_plan;
    `);
    await t.storage.deleteAlarm();

    // 首次启用同步推进历史：基线任务冻结启用前字节，revision 2 留待备责任。
    now += 1000;
    writeRecord(working, "legacy", { stationName: "启用后修改" }, false);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const row = cursorRow();
    expect(row.current_revision).toBe(2);
    expect(row.pending_revision).toBe(2);
    expect(row.window_due_at).toBe(now + windowMs);
    const task = taskRow();
    expect(task).toBeDefined();
    expect(task!.revision).toBe(1);
    expect(task!.reason).toBe("baseline");
    expect(frozenTaskBytes()).toEqual(preEnablementBytes);
    // 基线任务需要立即处理：alarm 已按优先级安排到当前时间。
    expect(t.storage.alarmTime()).toBe(now);
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    // 基线完成后窗口到期，捕获最新版本。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it("启用前已有文档且首次同步不推进历史：仍冻结基线，无待备责任", async () => {
    const working = doc();
    writeRecord(working, "legacy", syntheticRecord, true);
    const preEnablementBytes = await sync(working.export({ mode: "snapshot" }));
    t.database.exec("DELETE FROM backup_cursor; DELETE FROM backup_completions;");
    await t.storage.deleteAlarm();
    const bytes = working.export({ mode: "snapshot" });
    lastMerged = await sync(bytes);
    const row = cursorRow();
    expect(row.current_revision).toBe(1);
    expect(row.pending_revision).toBeNull();
    expect(taskRow()!.revision).toBe(1);
    expect(frozenTaskBytes()).toEqual(preEnablementBytes);
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("冻结后到达的新同步不改冻结字节，保留待备责任与原始到期时间；完成后补最新", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const dueAt = now + windowMs;
    now = dueAt;
    // 捕获窗口到期，但暂停 R2（上传失败一次）以在冻结期间制造新提交。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    await fireAlarm();
    expect(taskRow()).toBeDefined();
    const frozen = frozenTaskBytes();
    now += 1000;
    writeRecord(working, "two", { ...syntheticRecord, odometerTenths: 10800 }, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 冻结任务字节不变；revision 2 的责任保留原始窗口语义（到期时间不再后移）。
    expect(frozenTaskBytes()).toEqual(frozen);
    expect(cursorRow().pending_revision).toBe(2);
    expect(cursorRow().window_due_at).toBe(dueAt + 1000 + windowMs);
    // 故障退避期间新编辑不重置退避：alarm 保持任务重试时间。
    t.bucket.clearFaults();
    now += retryDelays[0];
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    // 原窗口已过：下一轮立即捕获 revision 2。
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(recordsFromBundleKey(bundleKeys().at(-1)!)).toBe(2);
    expect(readRecords(doc(parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!).snapshot)).map((record) => record.id).sort()).toEqual(["one", "two"]);
  });

  it("待备责任的权威主文档缺失：invalid_source_document、停止调度、不造空基线；同步与其他账号不受影响", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 模拟捕获前权威主快照丢失（主表损坏或错误维护）：待备责任仍在。
    t.database.exec("DELETE FROM refueling_snapshots");
    now += windowMs;
    await fireAlarm();
    // 明确的源文档故障：进入 blocked，保留责任，不虚构空基线。
    expect(cursorRow().blocked_error).toBe("invalid_source_document");
    expect(cursorRow().pending_revision).toBe(1);
    expect(taskRow()).toBeUndefined();
    expect(t.storage.alarmTime()).toBeNull();
    expect(t.bucket.counters.put).toBe(0);

    // 正常有效同步继续：客户端完整快照按「文档重建」语义恢复服务端主文档
    // （非历史推进：revision 与待备责任保持原值）；blocked 不解除，也不触发任何自动 R2。
    const putsBefore = t.bucket.counters.put;
    writeRecord(working, "two", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow().current_revision).toBe(1);
    expect(cursorRow().pending_revision).toBe(1);
    expect(cursorRow().blocked_error).toBe("invalid_source_document");
    expect(t.database.prepare("SELECT count(*) AS count FROM refueling_snapshots").get()).toEqual({ count: 1 });
    await fireAlarm();
    expect(t.bucket.counters.put).toBe(putsBefore);
    expect(t.storage.alarmTime()).toBeNull();

    // 其他账号不受影响：B 的映射照常创建，备份照常完成。
    const secondAccountId = await t.account.readAccountId({
      sessionHash: secondSessionHash, identity: secondIdentity, nowMs: now,
    });
    const b = doc();
    writeRecord(b, "b-only", syntheticRecord, true);
    await syncB(b.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    const bCursor = t.database.prepare("SELECT * FROM backup_cursor WHERE account_id = ?").get(secondAccountId) as Record<string, unknown>;
    expect(bCursor.pending_revision).toBeNull();
    expect(bCursor.latest_completed_revision).toBe(1);
    const prefixB = `hako-backup/layout-v1/${BACKUP_ENVIRONMENT}/accounts/${secondAccountId}/`;
    expect(t.bucket.storedKeys().filter((key) => key.startsWith(prefixB))).toHaveLength(2);
  });
});

describe("幂等、退避与长期故障", () => {
  it("包写成功但响应丢失：按相同 key 读回核验后完成，不生成第二份", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw_after_write" } });
    await fireAlarm();
    expect(taskRow()).toBeDefined();
    expect(bundleKeys()).toHaveLength(1);
    const expectedRetry = now + retryDelays[0];
    expect(taskRow()!.next_attempt_at).toBe(expectedRetry);
    now = expectedRetry;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(bundleKeys()).toHaveLength(1);
    expect(markerKeys()).toHaveLength(1);
  });

  it("完成标记已存在而 DO 确认丢失：重试核验并补记完成", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.database.exec(
      "CREATE TRIGGER fail_confirm BEFORE INSERT ON backup_completions BEGIN SELECT RAISE(ABORT, 'synthetic confirm failure'); END",
    );
    await fireAlarm();
    // 确认事务失败整体回滚：无完成缓存、任务保留、标记已在 R2。
    expect(completions()).toEqual([]);
    expect(markerKeys()).toHaveLength(1);
    expect(taskRow()).toBeDefined();
    expect(taskRow()!.next_attempt_at).toBe(now + retryDelays[0]);
    t.database.exec("DROP TRIGGER fail_confirm");
    now += retryDelays[0];
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(markerKeys()).toHaveLength(1);
    expect(bundleKeys()).toHaveLength(1);
    expect(taskRow()).toBeUndefined();
  });

  it("退避节奏精确为 1、5、15、60 分钟后每小时，超过平台重试次数仍持续调度", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", count: 100, plan: { put: "throw" } });
    await fireAlarm();
    const expected = [...retryDelays];
    for (let attempt = 1; attempt <= 12; attempt++) {
      const task = taskRow()!;
      expect(task.attempt_count).toBe(attempt);
      const delay = attempt <= expected.length ? expected[attempt - 1] : PRODUCTION_BACKUP_SCHEDULE.hourlyRetryMs;
      expect(task.next_attempt_at).toBe(now + delay);
      expect(t.storage.alarmTime()).toBe(now + delay);
      now += delay;
      // 退避期间新编辑不重置失败次数，也不把重试提前。
      if (attempt === 3) {
        writeRecord(working, `during-failure-${attempt}`, syntheticRecord, true);
        lastMerged = await sync(working.export({ mode: "snapshot" }));
        expect(taskRow()!.attempt_count).toBe(attempt);
        expect(t.storage.alarmTime()).toBe(now);
      }
      await fireAlarm();
    }
    // 循环最后一次 fireAlarm 已登记第 13 次尝试。
    expect(taskRow()!.attempt_count).toBe(13);
    t.bucket.clearFaults();
    now += PRODUCTION_BACKUP_SCHEDULE.hourlyRetryMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
  });

  it("连续 130 个变化的故障期间仍同步：单一冻结任务 + 最新待备，恢复后保留完整历史", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", count: 1000, plan: { put: "throw" } });
    await fireAlarm();
    const frozen = frozenTaskBytes();
    for (let index = 0; index < 130; index++) {
      now += 1000;
      writeRecord(working, `record-${index}`, { ...syntheticRecord, odometerTenths: 20000 + index }, true);
      lastMerged = await sync(working.export({ mode: "snapshot" }));
    }
    const row = cursorRow();
    expect(row.current_revision).toBe(131);
    expect(row.pending_revision).toBe(131);
    expect(frozenTaskBytes()).toEqual(frozen);
    expect(bundleKeys()).toHaveLength(0);
    // 恢复 R2：先完成冻结版（revision 1），再捕获最新（revision 131）。
    t.bucket.clearFaults();
    now += retryDelays[0];
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 131 }]);
    const latestBundle = t.bucket.storedBytes(bundleKeys().at(-1)!)!;
    expect(readRecords(doc(parseBundle(latestBundle).snapshot))).toHaveLength(131);
  });

  it("重试责任持久化失败（任务路径）：不把已过期旧责任重设成过去 alarm，恢复后继续退避", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一次 R2 尝试失败：attempt 1 与 +60s 重试已持久。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    now += windowMs;
    await fireAlarm();
    const firstDeadline = taskRow()!.next_attempt_at as number;
    expect(taskRow()!.attempt_count).toBe(1);

    // 重试时间到达后，对 backup_frozen_task 的 UPDATE 持续失败：
    // 回滚残留的过期 next_attempt_at 不能被重设成 alarm（会变成立即循环）。
    now = firstDeadline;
    t.database.exec(
      "CREATE TRIGGER fail_task_attempt BEFORE UPDATE ON backup_frozen_task BEGIN SELECT RAISE(ABORT, 'synthetic persistent task write failure'); END",
    );
    for (let round = 0; round < 3; round++) {
      await fireAlarm();
      // 尝试计数与重试时间保持回滚后的旧持久值（无法写入新责任）。
      expect(taskRow()!.attempt_count).toBe(1);
      expect(taskRow()!.next_attempt_at).toBe(firstDeadline);
      // alarm 必须是有界的未来时间（当前尝试计数 + 下一档退避），绝不落在过去；
      // 下限到期前的提前触发不推进也不重排（首轮建立后保持不变）。
      expect(t.storage.alarmTime()).toBeGreaterThan(now);
      expect(t.storage.alarmTime()).toBe(firstDeadline + retryDelays[1]);
      now += 1;
    }
    expect(t.storage.alarmTime()).toBeGreaterThan(now);

    // 存储恢复（R2 故障已在首轮消耗）：正常持久 attempt 2 并完成，不再立即循环。
    t.database.exec("DROP TRIGGER fail_task_attempt");
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(taskRow()).toBeUndefined();
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("重试责任持久化失败（清理路径）：同样有界重排，恢复后先收尾清理", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 确认后、保留检查 LIST 失败（序列检查 LIST 先放行一次）：清理责任待收尾。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" }, skip: 1 });
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(retentionRow()).toEqual({ pending_revision: 1 });
    const firstDeadline = (cursorRow().cleanup_next_attempt_at as number);
    expect(firstDeadline).toBe(now + retryDelays[0]);

    // 清理重试时间到达后，对 backup_cursor 的 UPDATE 持续失败：过期清理责任不得重设成过去 alarm。
    now = firstDeadline;
    t.database.exec(
      "CREATE TRIGGER fail_cleanup_attempt BEFORE UPDATE ON backup_cursor BEGIN SELECT RAISE(ABORT, 'synthetic persistent cleanup write failure'); END",
    );
    for (let round = 0; round < 3; round++) {
      await fireAlarm();
      expect(cursorRow().cleanup_attempt_count).toBe(1);
      expect(cursorRow().cleanup_next_attempt_at).toBe(firstDeadline);
      // 下限到期前的提前触发不推进也不重排（首轮建立后保持不变）。
      expect(t.storage.alarmTime()).toBe(firstDeadline + retryDelays[1]);
      expect(t.storage.alarmTime()).toBeGreaterThan(now);
      now += 1;
    }
    expect(t.storage.alarmTime()).toBeGreaterThan(now);

    // 存储恢复：清理收尾、责任结清、调度停止。
    t.database.exec("DROP TRIGGER fail_cleanup_attempt");
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(retentionRow()).toBeUndefined();
    expect(markerKeys()).toHaveLength(1);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("冻结任务在途期间旧版写入：成功同步当场持久待备责任（含启用基线变体）", async () => {
    // 变体一：已有完成版本 + 冻结 rev2 重试中 + 旧版推进第三段历史。
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    writeRecord(working, "two", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    now += windowMs;
    await fireAlarm();
    const frozenTask = taskRow()!;
    expect(frozenTask.revision).toBe(2);
    expect(frozenTask.attempt_count).toBe(1);
    expect(cursorRow().pending_revision).toBeNull();
    const frozenBytes = frozenTaskBytes();

    // 回退窗口旧版服务端推进主库至第三段历史（客户端设备已写入并同步给旧版）。
    writeRecord(working, "old-code-three", syntheticRecord, true);
    legacyWriteMainSnapshot(working.export({ mode: "snapshot" }));

    // 升级后旧客户端按既有快照同步（incoming 无新增）：合并结果未被冻结历史
    // 覆盖 → 成功同步的当场登记新的 revision/pending（不触碰冻结字节与重试计划），
    // 客户端随即关闭也不再依赖未来前台访问。
    now += 1000;
    lastMerged = await sync(lastMerged);
    const afterSync = cursorRow();
    expect(afterSync.current_revision).toBe(3);
    expect(afterSync.pending_revision).toBe(3);
    expect(afterSync.window_due_at).toBe(now + windowMs);
    expect(taskRow()!.attempt_count).toBe(1);
    expect(taskRow()!.next_attempt_at).toBe(frozenTask.next_attempt_at);
    expect(frozenTaskBytes()).toEqual(frozenBytes);

    // 重试完成冻结版（revision 2，不含第三段）；登记的 revision 3 责任保留，
    // 窗口到期后捕获并完成，最终当前版本有已验证备份。
    t.bucket.clearFaults();
    now = taskRow()!.next_attempt_at as number;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(cursorRow().pending_revision).toBe(3);
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
    const covered = parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!);
    expect(readRecords(doc(covered.snapshot)).map((record) => record.id).sort()).toEqual(["old-code-three", "one", "two"]);
  });

  it("未准备基线：同步按设计跳过，确认内登记失败整体回滚并恢复（父审剩余分支）", async () => {
    // 启用前已有文档：首次同步冻结未准备基线（尚无历史摘要）。
    const working = doc();
    writeRecord(working, "legacy-base", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    t.database.exec("DELETE FROM backup_cursor; DELETE FROM backup_completions;");
    await t.storage.deleteAlarm();
    const enablementInput = working.export({ mode: "snapshot" });
    lastMerged = await sync(enablementInput);
    expect(taskRow()!.revision).toBe(1);
    expect(taskRow()!.history_sha256).toBeNull();
    expect(cursorRow().pending_revision).toBeNull();

    // 未准备基线在途时旧版推进主库；旧客户端同步无法比对（无摘要）按设计跳过——
    // 该分支由确认内登记兜底。
    writeRecord(working, "old-code-while-unprepared", syntheticRecord, true);
    legacyWriteMainSnapshot(working.export({ mode: "snapshot" }));
    now += 1000;
    lastMerged = await sync(enablementInput);
    expect(cursorRow().pending_revision).toBeNull();

    // 确认内覆盖登记遇到一次 SQL 错误：整个确认事务回滚（任务保留、无假完成），
    // 不出现「待办清空而新历史未备份」。
    t.database.exec(
      "CREATE TRIGGER fail_unprepared_register BEFORE UPDATE OF pending_revision, pending_first_revision, pending_first_at, window_due_at ON backup_cursor BEGIN SELECT RAISE(ABORT, 'synthetic register failure'); END",
    );
    now = (cursorRow().window_due_at as number | null) ?? now + windowMs;
    await fireAlarm();
    expect(completions()).toEqual([]);
    expect(taskRow()).toBeDefined();
    expect(cursorRow().latest_completed_revision).toBeNull();
    expect(cursorRow().pending_revision).toBeNull();

    // 存储恢复：重试的确认与覆盖登记原子完成（零前台同步），随后捕获并覆盖新历史。
    t.database.exec("DROP TRIGGER fail_unprepared_register");
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(cursorRow().pending_revision).toBe(2);
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    const covered = parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!);
    expect(readRecords(doc(covered.snapshot)).map((record) => record.id).sort()).toEqual(["legacy-base", "old-code-while-unprepared"]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("启用基线冻结重试中旧版写入：成功同步当场登记（无 latestCompleted 路径）", async () => {
    // 启用前已有文档：首次同步冻结启用前快照为基线任务（尚无完成版本）。
    const working = doc();
    writeRecord(working, "legacy-base", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    t.database.exec("DELETE FROM backup_cursor; DELETE FROM backup_completions;");
    await t.storage.deleteAlarm();
    const enablementInput = working.export({ mode: "snapshot" });
    lastMerged = await sync(enablementInput);
    expect(taskRow()!.revision).toBe(1);
    expect(cursorRow().pending_revision).toBeNull();
    // 基线任务首次 R2 尝试失败：已准备（有历史摘要）并进入重试等待。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    await fireAlarm();
    expect(taskRow()!.attempt_count).toBe(1);
    expect(taskRow()!.history_sha256).not.toBeNull();
    const baselineFrozen = frozenTaskBytes();

    // 回退窗口旧版服务端推进主库（客户端设备写入并同步给旧版）。
    writeRecord(working, "old-code-during-baseline", syntheticRecord, true);
    legacyWriteMainSnapshot(working.export({ mode: "snapshot" }));

    // 升级后旧客户端按启用时快照同步（incoming 无新增）：合并结果未被冻结基线
    // 覆盖 → 成功同步当场登记 revision 2/pending（无 latestCompleted 也适用），
    // 冻结基线字节不变。
    now += 1000;
    lastMerged = await sync(enablementInput);
    expect(cursorRow().current_revision).toBe(2);
    expect(cursorRow().pending_revision).toBe(2);
    expect(frozenTaskBytes()).toEqual(baselineFrozen);

    // 重试完成基线；登记的 revision 2 随后捕获并完成，含旧版写入的完整历史。
    t.bucket.clearFaults();
    now = taskRow()!.next_attempt_at as number;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(cursorRow().pending_revision).toBe(2);
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    const covered = parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!);
    expect(readRecords(doc(covered.snapshot)).map((record) => record.id).sort()).toEqual(["legacy-base", "old-code-during-baseline"]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("冻结任务在途期间旧版写入：确认后自动补登记待备，无需前台同步", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 首次 R2 失败冻结 revision 1，任务进入重试等待。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    now += windowMs;
    await fireAlarm();
    expect(taskRow()).toBeDefined();
    expect(taskRow()!.revision).toBe(1);

    // 冻结任务在途期间，回退到不认识备份的旧版本代码推进主库
    // （真实 AccountDocuments.merge，模拟旧版服务端行为，不产生待备责任）。
    writeRecord(working, "legacy-during-frozen", syntheticRecord, true);
    legacyWriteMainSnapshot(working.export({ mode: "snapshot" }));

    // 恢复 R2：重试完成冻结版本（revision 1，内容为冻结时字节，不含旧版写入）。
    // 确认后立即按当前主文档核对覆盖：旧版写入的历史在完成时刻登记为
    // revision 2 待备责任并安排窗口——不需要再来一次前台同步。
    t.bucket.clearFaults();
    now += retryDelays[0];
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    const row = cursorRow();
    expect(row.pending_revision).toBe(2);
    expect(row.window_due_at).toBe(now + windowMs);
    expect(t.storage.alarmTime()).toBe(now + windowMs);
    const covered = parseBundle(t.bucket.storedBytes(bundleKeys()[0])!);
    expect(readRecords(doc(covered.snapshot)).map((record) => record.id)).toEqual(["one"]);

    // 窗口到期后捕获 revision 2，备份包含旧版写入的完整历史。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    const second = parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!);
    expect(readRecords(doc(second.snapshot)).map((record) => record.id).sort()).toEqual(["legacy-during-frozen", "one"]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("有界失败下限跨重启与并发同步：新同步不提前下限，重启后仍保持有界退避", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    now += windowMs;
    await fireAlarm();
    const deadline = taskRow()!.next_attempt_at as number;
    t.bucket.clearFaults();
    // 重试责任持久化持续失败：到期触发后建立有界失败下限（当前尝试计数 + 下一档退避）。
    now = deadline;
    t.database.exec(
      "CREATE TRIGGER fail_task_attempt_restart BEFORE UPDATE ON backup_frozen_task BEGIN SELECT RAISE(ABORT, 'synthetic persistent task write failure'); END",
    );
    await fireAlarm();
    const boundedAlarm = t.storage.alarmTime()!;
    expect(boundedAlarm).toBe(now + retryDelays[1]);
    expect(taskRow()!.attempt_count).toBe(1);

    // 下限期间的新同步（同步事务不经过 backup_frozen_task 表，可正常成功）不能把
    // alarm 提前到下限之前：退避不被新编辑重置，也不被推迟到更晚。
    now += 1000;
    writeRecord(working, "during-floor", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(t.storage.alarmTime()).toBe(boundedAlarm);
    expect(taskRow()!.attempt_count).toBe(1);

    // 模拟进程重启：同一 SQLite 与 R2 桶重建引擎（触发器随库文件持久）。
    // 持久化的有界下限跨重建生效：重启后、下限时间之前的一次普通新同步
    // 不得把失败退避中的重试提前到立即执行（alarm 保持下限值不变）。
    const path = databasePath();
    const persistentBucket = t.bucket;
    t.database.close();
    t = createTestAccount(path, { now: () => now, bucket: persistentBucket });
    now = boundedAlarm - 1000;
    writeRecord(working, "after-restart", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(t.storage.alarmTime()).toBe(boundedAlarm);
    expect(taskRow()!.attempt_count).toBe(1);
    // 下限时间驱动重启后的处理器：仍不出现过去/立即 alarm，再次有界重排。
    now = boundedAlarm;
    await fireAlarm();
    expect(taskRow()!.attempt_count).toBe(1);
    expect(taskRow()!.next_attempt_at).toBe(deadline);
    expect(t.storage.alarmTime()).toBe(now + retryDelays[1]);
    expect(t.storage.alarmTime()).toBeGreaterThan(now);

    // 存储恢复：正常持久第 2 次尝试并完成冻结版本；窗口内累积的编辑
    // （下限期间与重启后各一次）随后照常捕获为 revision 3。
    t.database.exec("DROP TRIGGER fail_task_attempt_restart");
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 3 }]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("仅重建引擎对象（对象驱逐模拟）：普通编辑不绕过持久失败下限（任务与清理两路）", async () => {
    for (const path of ["task", "cleanup"] as const) {
      // 每路独立建库：受控时钟从固定起点开始。
      const directory = mkdtempSync(join(tmpdir(), "hako-backup-recreate-"));
      const savedT = t;
      const savedNow = now;
      const savedAccountId = accountId;
      const savedLastMerged = lastMerged;
      const savedSessionHash = sessionHash;
      t = createTestAccount(join(directory, "account.sqlite"), { now: () => now });
      now = start;
      try {
        await setupAccount();
        const working = doc();
        writeRecord(working, "one", syntheticRecord, true);
        lastMerged = await sync(working.export({ mode: "snapshot" }));
        if (path === "cleanup") {
          t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" }, skip: 1 });
        } else {
          t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
        }
        now += windowMs;
        await fireAlarm();
        const deadline = (t.storage.alarmTime())!;
        // 重试到期：持续 SQL 失败 → 有界下限持久化（backup_cursor.retry_floor_at）。
        now = deadline + 1;
        t.database.exec(path === "cleanup"
          ? "CREATE TRIGGER fail_recreate_attempt BEFORE UPDATE OF cleanup_attempt_count ON backup_cursor BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END"
          : "CREATE TRIGGER fail_recreate_attempt BEFORE UPDATE ON backup_frozen_task BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END");
        await fireAlarm();
        const failureFloor = t.storage.alarmTime()!;
        expect(failureFloor).toBe(now + retryDelays[1]);
        t.bucket.clearFaults();

        // 模拟对象驱逐：同一 SQLite/R2/持久 alarm 上仅重建引擎与同步包装。
        // 重建后的普通编辑不得把失败退避中的重试提前到当前时间。
        const documents = new AccountDocuments(t.storage);
        const backups = new BackupEngine({
          storage: t.storage,
          objectStore: new R2BackupObjectStore(t.bucket),
          snapshotSource: documents,
          schedule: PRODUCTION_BACKUP_SCHEDULE,
          now: () => now,
          log: () => undefined,
        });
        const recreated = new AccountSync(t.storage, t.state, documents, backups);
        now += 1000;
        writeRecord(working, "one", { stationName: "普通编辑" }, false);
        const bootstrap = await recreated.bootstrap({ sessionHash, identity, nowMs: now, expectedAccountId: accountId });
        expect(bootstrap.ok).toBe(true);
        const result = await recreated.exchange({
          sessionHash, identity, nowMs: now, expectedAccountId: accountId,
          documentGeneration: bootstrap.ok ? bootstrap.documentGeneration : "",
          snapshot: working.export({ mode: "snapshot" }),
        });
        expect(result.ok).toBe(true);
        expect(t.storage.alarmTime()).toBe(failureFloor);
        // 下限写入用列作用域隔离：cleanup 路径的下限持久化不受 cleanup 列触发器影响。
        expect((cursorRow().retry_floor_at as number)).toBe(failureFloor);

        // 存储恢复：下限时间驱动仍正常推进并完成。
        t.database.exec("DROP TRIGGER fail_recreate_attempt");
        now = failureFloor;
        await backups.onAlarm(now);
        if (path === "task") {
          expect(completions()).toEqual([{ revision: 1 }]);
        } else {
          expect(retentionRow()).toBeUndefined();
          expect(markerKeys()).toHaveLength(1);
        }
      } finally {
        for (const instance of docs.splice(0)) instance.free();
        t.database.close();
        rmSync(directory, { recursive: true, force: true });
        t = savedT;
        now = savedNow;
        accountId = savedAccountId;
        lastMerged = savedLastMerged;
        sessionHash = savedSessionHash;
      }
    }
  });

  it("共享 alarm 不提前退避中的账号：其他账号触发时下限保护仍生效（任务路径）", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    now += windowMs;
    await fireAlarm();
    expect(taskRow()!.attempt_count).toBe(1);
    const deadline = taskRow()!.next_attempt_at as number;
    t.bucket.clearFaults();

    // 持久化持续失败（仅限 A 账号，避免误伤 B 的任务写入）：
    // 到期触发后建立并持久化有界下限。
    t.database.exec(
      `CREATE TRIGGER fail_shared_attempt BEFORE UPDATE ON backup_frozen_task WHEN NEW.account_id = '${accountId}' BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END`,
    );
    now = deadline;
    await fireAlarm();
    const failureFloor = (await Promise.resolve(cursorRow().retry_floor_at)) as number;
    expect(failureFloor).toBe(now + retryDelays[1]);
    expect(t.storage.alarmTime()).toBe(failureFloor);

    // 另一账号 B 的待备窗口早于 A 的下限：共享 alarm 为 B 触发时，A 的退避
    // 不得被提前执行（尝试计数与下限保持不变）。
    const secondAccountId = await t.account.readAccountId({
      sessionHash: secondSessionHash, identity: secondIdentity, nowMs: now,
    });
    const b = doc();
    writeRecord(b, "b-only", syntheticRecord, true);
    await syncB(b.export({ mode: "snapshot" }));
    expect(t.storage.alarmTime()).toBe(now + windowMs);
    now += windowMs;
    await fireAlarm();
    // B 正常完成；A 未被提前推进。
    const bCompleted = t.database.prepare(
      "SELECT count(*) AS count FROM backup_completions WHERE account_id = ?",
    ).get(secondAccountId) as { count: number };
    expect(bCompleted.count).toBe(1);
    expect(taskRow()!.attempt_count).toBe(1);
    expect(cursorRow().retry_floor_at).toBe(failureFloor);
    expect(t.storage.alarmTime()).toBe(failureFloor);

    // 到达 A 的下限后仍按既有语义有界重排；存储恢复后完成。
    now = failureFloor;
    await fireAlarm();
    expect(taskRow()!.attempt_count).toBe(1);
    expect(t.storage.alarmTime()).toBe(failureFloor + retryDelays[1]);
    t.database.exec("DROP TRIGGER fail_shared_attempt");
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
  });

  /** 待捕获路径的下限武装：删除主文档快照使捕获进入阻断态失败，触发器拦截
   * blocked_error 持久化 → 有界下限落地（无任务、无阻断态、待备窗口保留）。 */
  async function armPendingCaptureFloor(): Promise<number> {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    t.database.prepare("DELETE FROM refueling_snapshots WHERE account_id = ?").run(accountId);
    t.database.exec(
      `CREATE TRIGGER fail_capture_block BEFORE UPDATE OF blocked_error ON backup_cursor WHEN NEW.account_id = '${accountId}' BEGIN SELECT RAISE(ABORT, 'synthetic blocked state persistence failure'); END`,
    );
    now += windowMs;
    await fireAlarm();
    const floor = cursorRow().retry_floor_at as number;
    expect(floor).toBe(now + retryDelays[0]);
    expect(taskRow()).toBeUndefined();
    expect(cursorRow().blocked_error).toBeNull();
    expect(cursorRow().pending_revision).toBe(1);
    return floor;
  }

  it("共享 alarm 不提前退避中的账号：其他账号触发时下限保护仍生效（待捕获路径）", async () => {
    const failureFloor = await armPendingCaptureFloor();

    // 另一账号 B 的待备窗口早于 A 的下限：共享 alarm 为 B 触发时，A 的待捕获
    // 推进不得执行（下限不被改写、无提前阻断态重排）。
    const secondAccountId = await t.account.readAccountId({
      sessionHash: secondSessionHash, identity: secondIdentity, nowMs: now,
    });
    const b = doc();
    writeRecord(b, "b-only", syntheticRecord, true);
    await syncB(b.export({ mode: "snapshot" }));
    now += windowMs;
    expect(now).toBeLessThan(failureFloor);
    expect(t.storage.alarmTime()).toBe(now);
    await fireAlarm();
    // B 正常完成；A 未被提前捕获（持续故障下也不改写仍有效的下限）。
    const bCompleted = t.database.prepare(
      "SELECT count(*) AS count FROM backup_completions WHERE account_id = ?",
    ).get(secondAccountId) as { count: number };
    expect(bCompleted.count).toBe(1);
    expect(completions()).toHaveLength(0);
    expect(taskRow()).toBeUndefined();
    expect(cursorRow().retry_floor_at).toBe(failureFloor);
    expect(t.storage.alarmTime()).toBe(failureFloor);
  });

  it("待捕获失败下限：主文档恢复后仍等到下限时间才捕获，不提前发布", async () => {
    const failureFloor = await armPendingCaptureFloor();

    // 普通合法同步在下限仍有效期间重建缺失的主文档；B 的较早窗口触发共享 alarm。
    lastMerged = await sync(lastMerged);
    expect(cursorRow().retry_floor_at).toBe(failureFloor);
    const secondAccountId = await t.account.readAccountId({
      sessionHash: secondSessionHash, identity: secondIdentity, nowMs: now,
    });
    const b = doc();
    writeRecord(b, "b-only", syntheticRecord, true);
    await syncB(b.export({ mode: "snapshot" }));
    now += windowMs;
    expect(now).toBeLessThan(failureFloor);
    await fireAlarm();
    // B 正常完成；A 即使已可捕获也不得早于自己的下限发布（下限与待备保留）。
    const bCompleted = t.database.prepare(
      "SELECT count(*) AS count FROM backup_completions WHERE account_id = ?",
    ).get(secondAccountId) as { count: number };
    expect(bCompleted.count).toBe(1);
    expect(completions()).toHaveLength(0);
    expect(cursorRow().retry_floor_at).toBe(failureFloor);
    expect(t.storage.alarmTime()).toBe(failureFloor);

    // 下限时间到：待捕获窗口正当其时，捕获并发布（阻断态解除路径不再受故障影响）。
    t.database.exec("DROP TRIGGER fail_capture_block");
    now = failureFloor;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("共享 alarm 不提前退避中的账号：其他账号触发时下限保护仍生效（清理路径）", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hako-backup-shared-"));
    const savedT = t;
    const savedNow = now;
    const savedAccountId = accountId;
    const savedLastMerged = lastMerged;
    t = createTestAccount(join(directory, "account.sqlite"), { now: () => now });
    now = start;
    try {
      await setupAccount();
      const working = doc();
      writeRecord(working, "one", syntheticRecord, true);
      lastMerged = await sync(working.export({ mode: "snapshot" }));
      // A 确认后清理 LIST 失败：清理责任待收尾（重试 +60s）。
      t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" }, skip: 1 });
      now += windowMs;
      await fireAlarm();
      expect(completions()).toEqual([{ revision: 1 }]);
      expect(retentionRow()).toEqual({ pending_revision: 1 });
      const deadline = cursorRow().cleanup_next_attempt_at as number;
      t.bucket.clearFaults();

      // 清理重试责任持久化持续失败（列作用域 + 仅 A 账号，不拦下限写入与 B 的流程）。
      t.database.exec(
        `CREATE TRIGGER fail_shared_cleanup BEFORE UPDATE OF cleanup_attempt_count ON backup_cursor WHEN NEW.account_id = '${accountId}' BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END`,
      );
      now = deadline;
      await fireAlarm();
      const failureFloor = cursorRow().retry_floor_at as number;
      expect(failureFloor).toBe(now + retryDelays[1]);

      // B 的窗口早于 A 的下限：共享 alarm 为 B 触发时 A 的清理不被提前执行。
      const secondAccountId = await t.account.readAccountId({
        sessionHash: secondSessionHash, identity: secondIdentity, nowMs: now,
      });
      const b = doc();
      writeRecord(b, "b-only", syntheticRecord, true);
      await syncB(b.export({ mode: "snapshot" }));
      now += windowMs;
      await fireAlarm();
      const bCompleted = t.database.prepare(
        "SELECT count(*) AS count FROM backup_completions WHERE account_id = ?",
      ).get(secondAccountId) as { count: number };
      expect(bCompleted.count).toBe(1);
      expect(cursorRow().cleanup_attempt_count).toBe(1);
      expect(cursorRow().retry_floor_at).toBe(failureFloor);
      expect(retentionRow()).toEqual({ pending_revision: 1 });

      // 下限到达后重排；存储恢复后收尾清理。
      now = failureFloor;
      await fireAlarm();
      expect(cursorRow().cleanup_attempt_count).toBe(1);
      t.database.exec("DROP TRIGGER fail_shared_cleanup");
      now = t.storage.alarmTime()!;
      await fireAlarm();
      expect(retentionRow()).toBeUndefined();
      // A 的清理收尾完成；标记数含 A 与 B 各自的完成标记。
      expect(markerKeys()).toHaveLength(2);
      expect(t.storage.alarmTime()).toBeNull();
    } finally {
      for (const instance of docs.splice(0)) instance.free();
      t.database.close();
      rmSync(directory, { recursive: true, force: true });
      t = savedT;
      now = savedNow;
      accountId = savedAccountId;
      lastMerged = savedLastMerged;
    }
  });

  it("确认与覆盖登记原子：登记失败整体回滚，重试后一并完成（无崩溃窗口）", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 冻结 revision 1 并进入重试等待。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    now += windowMs;
    await fireAlarm();
    expect(taskRow()!.revision).toBe(1);

    // 冻结在途期间旧版推进主库（真实 AccountDocuments.merge）。
    writeRecord(working, "legacy-during-frozen", syntheticRecord, true);
    legacyWriteMainSnapshot(working.export({ mode: "snapshot" }));

    // 覆盖登记（backup_cursor 的 pending 列更新）持续失败：确认事务整体回滚，
    // 不存在「确认已提交、补登记未做」的中间状态。
    t.bucket.clearFaults();
    t.database.exec(
      "CREATE TRIGGER fail_uncovered_register BEFORE UPDATE OF pending_revision, pending_first_revision, pending_first_at, window_due_at ON backup_cursor BEGIN SELECT RAISE(ABORT, 'synthetic register failure'); END",
    );
    now = taskRow()!.next_attempt_at as number;
    await fireAlarm();
    expect(completions()).toEqual([]);
    expect(taskRow()).toBeDefined();
    expect(cursorRow().latest_completed_revision).toBeNull();
    expect(cursorRow().pending_revision).toBeNull();
    expect(taskRow()!.attempt_count).toBe(2);

    // 存储恢复：确认与覆盖登记在同一事务原子完成——无需任何前台同步。
    t.database.exec("DROP TRIGGER fail_uncovered_register");
    now = taskRow()!.next_attempt_at as number;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(cursorRow().pending_revision).toBe(2);
    expect(cursorRow().window_due_at).toBe(now + windowMs);
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    const covered = parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!);
    expect(readRecords(doc(covered.snapshot)).map((record) => record.id).sort()).toEqual(["legacy-during-frozen", "one"]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("重试到期后到达的普通编辑不重开退避：alarm 立即可行动，随后按既有语义完成", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    await fireAlarm();
    const deadline = taskRow()!.next_attempt_at as number;
    expect(taskRow()!.attempt_count).toBe(1);
    t.bucket.clearFaults();

    // 重试时间已过后，普通编辑的同步不得把到期重试推迟一档退避（否则持续编辑
    // 会让备份永远无法重试）；到期重试＝正当其时，alarm 不晚于当前时间。
    for (let index = 1; index <= 3; index++) {
      now = deadline + index * 1000;
      writeRecord(working, `normal-edit-${index}`, syntheticRecord, true);
      lastMerged = await sync(working.export({ mode: "snapshot" }));
      expect(t.storage.alarmTime()).toBeLessThanOrEqual(now);
    }

    // alarm 立即可行动：触发后记录第 2 次尝试并完成冻结版本，随后捕获窗口内累积的编辑。
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(taskRow()).toBeUndefined();
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 4 }]);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("清理重试到期后到达的普通编辑不重开退避：alarm 立即可行动并收尾", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" }, skip: 1 });
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(retentionRow()).toEqual({ pending_revision: 1 });
    const deadline = cursorRow().cleanup_next_attempt_at as number;
    t.bucket.clearFaults();

    for (let index = 1; index <= 3; index++) {
      now = deadline + index * 1000;
      writeRecord(working, `normal-edit-${index}`, syntheticRecord, true);
      lastMerged = await sync(working.export({ mode: "snapshot" }));
      expect(t.storage.alarmTime()).toBeLessThanOrEqual(now);
    }

    // 到期清理＝正当其时：立即收尾，不推迟一档退避；随后按窗口捕获累积的编辑。
    await fireAlarm();
    expect(retentionRow()).toBeUndefined();
    expect(markerKeys()).toHaveLength(1);
    now = t.storage.alarmTime()!;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 4 }]);
    expect(t.storage.alarmTime()).toBeNull();
  });
});

describe("最近 30 份与裁剪", () => {
  it("31 份备份触发精确裁剪：先删旧标记后删旧包，保留最新 30 份；未触发裁剪时不做整套保留核查", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);

    // 后续 29 份：每份 2 次 PUT + 2 次 LIST（PUT/LIST 均计 A 类）与 2 次 GET（B 类），
    // 无整套保留对象核查。
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    expect(completions()).toHaveLength(30);
    expect(markerKeys()).toHaveLength(30);
    expect(bundleKeys()).toHaveLength(30);
    // 每份备份 2 次 GET（B 类：包读回 + 标记读回），无保留对象 GET。
    expect(t.bucket.counters.get).toBe(60);
    expect(t.bucket.counters.delete).toBe(0);

    const putsBeforePrune = t.bucket.counters.put;
    const getsBeforePrune = t.bucket.counters.get;
    const listsBeforePrune = t.bucket.counters.list;
    await publishBackup((instance, i) => {
      writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
    }, 31);
    expect(completions()).toHaveLength(30);
    expect(markerKeys()).toHaveLength(30);
    expect(bundleKeys()).toHaveLength(30);
    // 第 31 份触发裁剪的精确调用混合（与审阅探针一致）：PUT 2 + LIST 4（均 A 类）
    // + GET 62（B 类：2 次读回 + 30 份保留对象各 1 次标记与包核查）+ DELETE 2（免费）。
    expect(t.bucket.counters.put).toBe(putsBeforePrune + 2);
    expect(t.bucket.counters.get).toBe(getsBeforePrune + 62);
    expect(t.bucket.counters.list).toBe(listsBeforePrune + 4);
    expect(t.bucket.counters.delete).toBe(2);
    // 最旧的 revision 1 已退出保留集合；revision 2..31 保留。
    const revisions = completions().map((entry) => entry.revision);
    expect(revisions[0]).toBe(2);
    expect(revisions.at(-1)).toBe(31);
    expect(revisions).toHaveLength(30);
    const markerRevisions = markerKeys().map((key) => Number.parseInt(key.match(/(\d{20})\.json$/)![1], 10)).sort((a, b) => a - b);
    expect(markerRevisions).toEqual(revisions);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("完成确认后、首次 LIST 前中断：重启先收尾且不发布第 32 份", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成，随后每个窗口各一份。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    // 第 31 份：确认事务提交后，保留检查的 LIST 失败（模拟在 LIST 前崩溃）；
    // 序列检查的 LIST（同一生命周期内先发生）放行一次，清理重试的 LIST 再失败一次。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" }, skip: 1, count: 2 });
    await publishBackup((instance, i) => {
      writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
    }, 31);
    // 保留检查责任仍在，未建立裁剪计划。
    expect(retentionRow()).toEqual({ pending_revision: 31 });
    expect(planRows()).toEqual([]);
    expect(markerKeys()).toHaveLength(31);

    // 清理未收尾期间新变化继续同步，但不得提前捕获下一份。
    now += 1000;
    writeRecord(working, "after-crash", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow().pending_revision).toBe(32);
    const expectedRetry = now + retryDelays[0];
    expect(taskRow()).toBeUndefined();
    now = expectedRetry;
    await fireAlarm();
    expect(taskRow()).toBeUndefined();
    expect(markerKeys()).toHaveLength(31);
    expect(bundleKeys()).toHaveLength(31);

    // 清理重试收尾：裁剪超额的第 1 份，集合回到 30 份；随后才捕获 revision 32。
    t.bucket.clearFaults();
    now += retryDelays[1];
    await fireAlarm();
    expect(retentionRow()).toBeUndefined();
    expect(markerKeys()).toHaveLength(30);
    expect(completions()).toHaveLength(30);
    await fireAlarm();
    expect(completions()).toHaveLength(30);
    expect(completions().at(-1)).toEqual({ revision: 32 });
    expect(markerKeys()).toHaveLength(30);
    expect(bundleKeys()).toHaveLength(30);
  });

  it("裁剪各阶段中断由原计划继续清理；长期删除失败不增对象但同步继续，修复后追上", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成，随后每个窗口各一份。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    // 第 31 份触发裁剪后，超额版的标记删除失败：计划保留 marker_deleted=0。
    const overflowMarkerKey = commitMarkerKeyOf(1);
    t.bucket.addFault({ match: overflowMarkerKey, count: 1000, plan: { delete: "throw" } });
    await publishBackup((instance, i) => {
      writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
    }, 31);
    expect(markerKeys()).toHaveLength(31);
    expect(bundleKeys()).toHaveLength(31);
    expect(planRows()).toEqual([{ revision: 1, marker_deleted: 0 }]);

    // 删除持续失败：清理待完成、新变化不发布、同步继续。
    for (let round = 0; round < 3; round++) {
      now += 1000;
      writeRecord(working, `stuck-${round}`, syntheticRecord, true);
      lastMerged = await sync(working.export({ mode: "snapshot" }));
      now += PRODUCTION_BACKUP_SCHEDULE.hourlyRetryMs;
      await fireAlarm();
      expect(planRows()).toEqual([{ revision: 1, marker_deleted: 0 }]);
      expect(markerKeys()).toHaveLength(31);
    }

    // 修复删除：先删标记、再删包、结清计划与责任，然后追上最新版本。
    t.bucket.clearFaults();
    now += PRODUCTION_BACKUP_SCHEDULE.hourlyRetryMs;
    await fireAlarm();
    expect(planRows()).toEqual([]);
    expect(retentionRow()).toBeUndefined();
    expect(markerKeys()).toHaveLength(30);
    expect(bundleKeys()).toHaveLength(30);
    await fireAlarm();
    expect(completions().at(-1)).toEqual({ revision: 34 });
    expect(markerKeys()).toHaveLength(30);
  });

  it("裁剪包删除阶段中断：标记已删的计划行恢复后只补删包；缓存行同步清理", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成，随后每个窗口各一份。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    const overflowBundleKey = bundleKeyOf(1);
    t.bucket.addFault({ match: overflowBundleKey, count: 1000, plan: { delete: "throw" } });
    await publishBackup((instance, i) => {
      writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
    }, 31);
    // 标记已删除并持久；包删除失败：候选集合已回到 30 份，残留已登记旧包。
    expect(planRows()).toEqual([{ revision: 1, marker_deleted: 1 }]);
    expect(markerKeys()).toHaveLength(30);
    expect(bundleKeys()).toHaveLength(31);
    t.bucket.clearFaults();
    now += PRODUCTION_BACKUP_SCHEDULE.hourlyRetryMs;
    await fireAlarm();
    expect(planRows()).toEqual([]);
    expect(bundleKeys()).toHaveLength(30);
    expect(completions().map((entry) => entry.revision)[0]).toBe(2);
  });

  it("裁剪计划恢复时保留标记被外部删除：停止一切删除、保留计划与对象并进入 blocked", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成，随后每个窗口各一份。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    // 第 31 份触发裁剪：超额版（revision 1）标记删除成功、包删除失败，
    // 计划持久为 marker_deleted=1；重试之前，最新保留版（revision 31）的标记被外部误删。
    const victimBundleKey = bundleKeyOf(1);
    t.bucket.addFault({ match: victimBundleKey, count: 1000, plan: { delete: "throw" } });
    await publishBackup((instance, i) => {
      writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
    }, 31);
    expect(planRows()).toEqual([{ revision: 1, marker_deleted: 1 }]);
    expect(markerKeys()).toHaveLength(30);
    await t.bucket.delete(commitMarkerKeyOf(31));
    t.bucket.clearFaults();

    // 恢复计划时必须核对完整应保留集合与完成缓存镜像：不可解释的保留标记缺失
    // 停止破坏性步骤，不删旧包、保留计划与剩余对象，并进入 blocked。
    const deletesBeforeRetry = t.bucket.counters.delete;
    now += PRODUCTION_BACKUP_SCHEDULE.hourlyRetryMs;
    await fireAlarm();
    expect(cursorRow().blocked_error).toBe("sequence_conflict");
    expect(t.bucket.counters.delete).toBe(deletesBeforeRetry);
    expect(t.bucket.storedBytes(victimBundleKey)).toBeDefined();
    expect(planRows()).toEqual([{ revision: 1, marker_deleted: 1 }]);
    expect(retentionRow()).toEqual({ pending_revision: 31 });
    expect(completions()).toHaveLength(31);
    expect(t.storage.alarmTime()).toBeNull();

    // blocked 保留正常同步能力：新变化仍可同步，但不再自动 R2。
    const putsBefore = t.bucket.counters.put;
    now += 1000;
    writeRecord(working, "after-blocked", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow().pending_revision).toBe(32);
    await fireAlarm();
    expect(t.bucket.counters.put).toBe(putsBefore);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("重试前复核保留集合：保留对象被篡改时停止裁剪并保留超额对象", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成，随后每个窗口各一份。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    // 第 31 份触发裁剪，但保留检查 LIST 失败推迟（序列检查 LIST 放行一次）；
    // 期间篡改一份保留包。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" }, skip: 1 });
    await publishBackup((instance, i) => {
      writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
    }, 31);
    const retainedBundleKey = bundleKeyOf(2);
    t.bucket.corruptObject(retainedBundleKey, (bytes) => {
      const corrupted = new Uint8Array(bytes);
      corrupted[corrupted.byteLength - 1] ^= 0xff;
      return corrupted;
    });
    t.bucket.clearFaults();
    now += retryDelays[0];
    await fireAlarm();
    // 保留对象校验失败：blocked；精确计划已登记但未执行任何删除，超额对象保留。
    expect(cursorRow().blocked_error).toBe("retention_verify_failed");
    expect(markerKeys()).toHaveLength(31);
    expect(bundleKeys()).toHaveLength(31);
    expect(planRows()).toEqual([{ revision: 1, marker_deleted: 0 }]);
    // blocked 保留同步能力：新变化仍可同步，但不再自动 R2。
    now += 1000;
    writeRecord(working, "after-blocked", syntheticRecord, true);
    const putsBefore = t.bucket.counters.put;
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow().pending_revision).toBe(32);
    await fireAlarm();
    expect(t.bucket.counters.put).toBe(putsBefore);
    expect(t.storage.alarmTime()).toBeNull();
  });

  it("保留对象缺失（外部删除标记）时停止裁剪；未知序列与未知归属进入 blocked", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成，随后每个窗口各一份。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    // 外部删除一份保留标记：第 31 份的序列检查在上传前即发现完成缓存与 R2
    // 标记镜像不一致，进入 blocked；超额对象不删除，保留尚存对象，
    // 第 31 份的新包与新标记也不写入。
    const retainedMarkerKey = commitMarkerKeyOf(3);
    await t.bucket.delete(retainedMarkerKey);
    await publishBackup((instance, i) => {
      writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
    }, 31);
    expect(cursorRow().blocked_error).toBe("sequence_conflict");
    expect(markerKeys()).toHaveLength(29);
    expect(bundleKeys()).toHaveLength(30);
    expect(completions()).toHaveLength(30);
  });

  it("DO 元数据回退（完成缓存丢失）后不执行落后计划，未解释标记进入 blocked", async () => {
    const working = doc();
    writeRecord(working, "seed", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    // 第一份备份（revision 1）先完成，随后每个窗口各一份。
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    for (let index = 2; index <= 30; index++) {
      await publishBackup((instance, i) => {
        writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
      }, index);
    }
    // 模拟 DO 备份表回退：R2 仍有 30 份标记，本地缓存只剩最近一份。
    t.database.exec("DELETE FROM backup_completions WHERE revision < 30");
    now += 1000;
    writeRecord(working, "after-rollback", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(cursorRow().blocked_error).toBe("sequence_conflict");
    expect(taskRow()).toBeDefined();
    expect(bundleKeys()).toHaveLength(30);
  });

  it("新序列接入时同账号前缀已有对象则拒绝（不能把已有桶当空桶）", async () => {
    // 直接在 R2 的该账号前缀下放置外来对象，模拟旧数据或他人写入。
    const foreignKey = `hako-backup/layout-v1/${BACKUP_ENVIRONMENT}/accounts/${accountId}/refueling/00000000-0000-4000-8000-0000000000ff/commits/00000000000000000001.json`;
    await t.bucket.put(foreignKey, new TextEncoder().encode("{}"), { onlyIf: { etagDoesNotMatch: "*" }, sha256: await sha256Of(new TextEncoder().encode("{}")) });
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(cursorRow().blocked_error).toBe("ownership_conflict");
    expect(bundleKeys()).toHaveLength(0);
  });

  it("已完成标记在上传前缺失：新备份先阻断，不写入任何新包或标记", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    // 外部删除 revision 1 的完成标记后，下一份备份在任何新 PUT 之前即阻断，
    // 而不是先写入新包与新标记、再由保留检查事后发现。
    await t.bucket.delete(commitMarkerKeyOf(1));
    const putsBefore = t.bucket.counters.put;
    writeRecord(working, "two", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(cursorRow().blocked_error).toBe("sequence_conflict");
    expect(t.bucket.counters.put).toBe(putsBefore);
    expect(bundleKeys()).toHaveLength(1);
    expect(markerKeys()).toHaveLength(0);
    // blocked 保留冻结任务（其覆盖的待备责任由任务持有）与既有对象。
    expect(taskRow()).toBeDefined();
    expect(taskRow()!.revision).toBe(2);
    expect(cursorRow().pending_revision).toBeNull();
  });

  it("仅身份映射丢失（旧游标仍在）：孤儿账号前缀同样拒绝新账号序列", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(t.bucket.storedKeys()).toHaveLength(2);
    const originalAccountId = accountId;

    // 模拟仅身份映射丢失：删除 account_data_ids 行，保留备份游标与完成缓存。
    // 同一身份再次同步会生成新 accountId；旧账号虽有游标但已无身份可达，
    // 是孤儿状态，其 R2 前缀对新序列不可解释。
    t.database.prepare("DELETE FROM account_data_ids WHERE account_id = ?").run(originalAccountId);
    const reRegistered = await t.account.readAccountId({ sessionHash, identity, nowMs: now });
    expect(reRegistered).not.toBe(originalAccountId);
    accountId = reRegistered!;
    const fresh = doc();
    writeRecord(fresh, "one", syntheticRecord, true);
    lastMerged = await sync(fresh.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(cursorRow().blocked_error).toBe("ownership_conflict");
    expect(t.bucket.counters.put).toBe(2);
    expect(t.bucket.storedKeys()).toHaveLength(2);
    expect(taskRow()).toBeDefined();
  });

  it("映射丢失后重建的新账号不得把已有桶当空桶：未知账号前缀进入 ownership_conflict", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(t.bucket.storedKeys()).toHaveLength(2);
    const originalAccountId = accountId;

    // 模拟 DO/账号映射丢失：同一身份在共享同一 R2 桶的新数据库中重建，生成新 accountId。
    const directory = mkdtempSync(join(tmpdir(), "hako-backup-remap-"));
    const sharedBucket = t.bucket;
    const savedT = t;
    const remapped = createTestAccount(join(directory, "account.sqlite"), { now: () => now, bucket: sharedBucket });
    t = remapped;
    try {
      await setupAccount();
      expect(accountId).not.toBe(originalAccountId);
      const fresh = doc();
      writeRecord(fresh, "one", syntheticRecord, true);
      lastMerged = await sync(fresh.export({ mode: "snapshot" }));
      now += windowMs;
      await fireAlarm();
      // 新序列启用检查覆盖同环境全部账号前缀：旧账号对本 DO 未知 → 阻断，
      // 不静默另起新序列、遗弃旧账号的已有备份。
      expect(cursorRow().blocked_error).toBe("ownership_conflict");
      expect(sharedBucket.counters.put).toBe(2);
      expect(sharedBucket.storedKeys()).toHaveLength(2);
      expect(taskRow()).toBeDefined();
    } finally {
      t = savedT;
      remapped.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("LIST 分页严格处理：31 份标记跨页全部计入保留集合", async () => {
    // 重新以分页桶构建（页大小 4）。
    const directory = mkdtempSync(join(tmpdir(), "hako-backup-paged-"));
    const { FakeBackupBucket } = await import("./helpers/fake-backup-bucket");
    const paged = createTestAccount(join(directory, "account.sqlite"), { now: () => now, bucket: new FakeBackupBucket(4) });
    const saved = t;
    t = paged;
    try {
      await setupAccount();
      const working = doc();
      writeRecord(working, "seed", syntheticRecord, true);
      lastMerged = await sync(working.export({ mode: "snapshot" }));
      now += windowMs;
      await fireAlarm();
      expect(completions()).toEqual([{ revision: 1 }]);
      for (let index = 2; index <= 31; index++) {
        await publishBackup((instance, i) => {
          writeRecord(instance, `record-${i}`, { ...syntheticRecord, odometerTenths: 30000 + i }, true);
        }, index);
      }
      expect(t.bucket.counters.listPages).toBeGreaterThan(0);
      expect(completions()).toHaveLength(30);
      expect(markerKeys()).toHaveLength(30);
      expect(completions()[0].revision).toBe(2);
    } finally {
      t = saved;
      paged.database.close();
      rmSync(directory, { recursive: true });
    }
  });
});

describe("同步事务与 alarm 的联合原子性", () => {
  it("主分块写失败：同步失败且不留下待备责任或唤醒", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const before = cursorRow();
    t.database.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON refueling_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic chunk failure'); END");
    now += 1000;
    writeRecord(working, "two", syntheticRecord, true);
    await expect(sync(working.export({ mode: "snapshot" }))).rejects.toThrow("synthetic chunk failure");
    expect(cursorRow()).toEqual(before);
    expect(t.storage.alarmTime()).toBe(before.window_due_at);
    t.database.exec("DROP TRIGGER fail_chunk");
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow().current_revision).toBe(2);
  });

  it("启用基线冻结分块写失败：整个启用回滚，R2 与 alarm 不受影响", async () => {
    const working = doc();
    writeRecord(working, "legacy", syntheticRecord, true);
    const preEnablement = await sync(working.export({ mode: "snapshot" }));
    t.database.exec("DELETE FROM backup_cursor; DELETE FROM backup_completions;");
    await t.storage.deleteAlarm();
    t.database.exec("CREATE TRIGGER fail_frozen BEFORE INSERT ON backup_frozen_task_chunks BEGIN SELECT RAISE(ABORT, 'synthetic frozen failure'); END");
    now += 1000;
    writeRecord(working, "legacy", { stationName: "启用后修改" }, false);
    await expect(sync(working.export({ mode: "snapshot" }))).rejects.toThrow("synthetic frozen failure");
    // 启用整体回滚：无 stream、无任务、无 alarm；主快照保持启用前内容。
    expect(t.database.prepare("SELECT count(*) AS count FROM backup_cursor").get()).toEqual({ count: 0 });
    expect(taskRow()).toBeUndefined();
    expect(t.storage.alarmTime()).toBeNull();
    t.database.exec("DROP TRIGGER fail_frozen");
    // 触发器删除后重新同步同一修改：启用并冻结启用前基线，revision 推进到 2。
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow().current_revision).toBe(2);
    expect(taskRow()!.revision).toBe(1);
    expect(frozenTaskBytes()).toEqual(preEnablement);
  });

  it("游标写失败或 setAlarm 失败：同步失败且窗口与责任不落库", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const before = cursorRow();
    t.database.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON backup_cursor BEGIN SELECT RAISE(ABORT, 'synthetic cursor failure'); END");
    now += 1000;
    writeRecord(working, "two", syntheticRecord, true);
    await expect(sync(working.export({ mode: "snapshot" }))).rejects.toThrow("synthetic cursor failure");
    expect(cursorRow()).toEqual(before);
    t.database.exec("DROP TRIGGER fail_cursor");

    // setAlarm 抛错：同步事务整体回滚（含主快照与责任），alarm 恢复先前值。
    const originalSetAlarm = t.storage.setAlarm.bind(t.storage);
    let failSetAlarm = true;
    t.storage.setAlarm = async (time: number) => {
      if (failSetAlarm) {
        failSetAlarm = false;
        throw new Error("synthetic alarm failure");
      }
      await originalSetAlarm(time);
    };
    await expect(sync(working.export({ mode: "snapshot" }))).rejects.toThrow("synthetic alarm failure");
    expect(cursorRow()).toEqual(before);
    expect(t.storage.alarmTime()).toBe(before.window_due_at);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow().current_revision).toBe(2);
  });

  it("确认事务持久失败不产生假完成；重启（重开 SQLite）后状态与 alarm 一致并继续收尾", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" }, skip: 1 });
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(retentionRow()).toEqual({ pending_revision: 1 });
    const alarmBefore = t.storage.alarmTime();

    // 模拟进程重启：同一文件重新打开账号状态与引擎。
    // node 适配器不持久模拟 alarm（真实 alarm 的持久性由 workerd 集成验收覆盖）；
    // 这里直接以重启后的时间驱动 alarm 处理器。
    const path = databasePath();
    const persistentBucket = t.bucket;
    t.database.close();
    // R2 是外部存储：同一桶实例跨“重启”保留内容。
    t = createTestAccount(path, { now: () => now, bucket: persistentBucket });
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(retentionRow()).toEqual({ pending_revision: 1 });
    // 重启后 alarm 触发：先收尾保留检查，不重新上传已完成版本。
    const putsBefore = t.bucket.counters.put;
    now = alarmBefore ?? now;
    await fireAlarm();
    expect(t.bucket.counters.put).toBe(putsBefore);
    expect(retentionRow()).toBeUndefined();
    expect(markerKeys()).toHaveLength(1);
    expect(t.storage.alarmTime()).toBeNull();
  });
});

describe("只读状态接口与账号隔离", () => {
  it("状态覆盖各阶段：未初始化、pending、uploading、retrying、cleanup_pending、blocked、current_backed_up", async () => {
    // 未建立映射：不创建映射、不触发 R2。
    const thirdHash = await hashSecret("synthetic-third-token");
    const before = t.database.prepare("SELECT count(*) AS count FROM account_data_ids").get();
    const noMapping = await t.account.readBackupStatus({ sessionHash: thirdHash, identity, nowMs: now });
    expect(noMapping).toEqual({ ok: false, error: "unauthorized" });
    seedSession(thirdHash, "synthetic-third-owner");
    const uninitialized = await t.account.readBackupStatus({ sessionHash: thirdHash, identity: { issuer: identity.issuer, subject: "synthetic-third-owner" }, nowMs: now });
    expect(uninitialized.ok).toBe(true);
    if (uninitialized.ok) {
      expect(uninitialized.status.state).toBe("uninitialized");
      expect(uninitialized.status.initialized).toBe(false);
    }
    expect(t.database.prepare("SELECT count(*) AS count FROM account_data_ids").get()).toEqual(before);
    expect(t.bucket.counters.put).toBe(0);

    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    const pending = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(pending.ok && pending.status.state === "pending" && pending.status.currentBackedUp === false).toBe(true);

    now += windowMs;
    await fireAlarm();
    const backedUp = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(backedUp.ok && backedUp.status.state === "current_backed_up" && backedUp.status.currentBackedUp).toBe(true);
    expect(backedUp.ok ? backedUp.status.latestCompletedRevision : null).toBe(1);

    // uploading：捕获后第一次尝试进行中／单次失败后的等待都属本任务生命周期。
    writeRecord(working, "two", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", count: 2, plan: { put: "throw" } });
    await fireAlarm();
    const uploading = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(uploading.ok && uploading.status.state === "uploading").toBe(true);
    // 第二次失败后进入 retrying。
    now += retryDelays[0];
    await fireAlarm();
    const retrying = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(retrying.ok && retrying.status.state === "retrying").toBe(true);
    t.bucket.clearFaults();

    // cleanup_pending：确认后保留检查 LIST 失败（序列检查 LIST 放行一次）。
    t.bucket.addFault({ match: "prefix:hako-backup/", count: 1, skip: 1, plan: { list: "throw" } });
    now += retryDelays[1];
    await fireAlarm();
    const cleanup = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(cleanup.ok && cleanup.status.state === "cleanup_pending").toBe(true);
    t.bucket.clearFaults();
    now += retryDelays[0];
    await fireAlarm();

    // blocked：写入已生效但响应丢失，且同 key 内容被外部篡改 → 校验冲突。
    writeRecord(working, "three", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", count: 1, plan: { put: "throw_after_write" } });
    await fireAlarm();
    const conflictedKey = bundleKeys().find((key) => key.includes("/objects/00000000000000000003-"))!;
    t.bucket.corruptObject(conflictedKey, (bytes) => {
      const corrupted = new Uint8Array(bytes);
      corrupted[0] ^= 0xff;
      return corrupted;
    });
    now += retryDelays[0];
    await fireAlarm();
    const blocked = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(blocked.ok && blocked.status.state === "blocked" && blocked.status.blockedError === "content_conflict").toBe(true);
  });

  it("覆盖缺口只报告不持久：主文档被旧代码修改后不误报已备份", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    // 模拟回退到不认识备份的旧代码修改了主库（游标未推进）。
    const rogue = doc();
    writeRecord(rogue, "rogue", syntheticRecord, true);
    t.database.exec("DELETE FROM refueling_snapshots");
    const rogueSnapshot = rogue.export({ mode: "snapshot" });
    for (let offset = 0; offset < rogueSnapshot.byteLength; offset += 512 * 1024) {
      t.storage.sql.exec(
        "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, ?, ?, ?)",
        accountId,
        Math.floor(offset / (512 * 1024)),
        rogueSnapshot.slice(offset, offset + 512 * 1024).buffer,
        // 模拟旧代码写入：不带代次标签（legacy NULL），与升级前生产状态一致。
        null,
      );
    }
    const status = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(status.ok && status.status.currentBackedUp === false).toBe(true);
    expect(status.ok ? status.status.blockedError : null).toBe("coverage_mismatch");
    expect(status.ok ? status.status.state : null).toBe("blocked");
    // 只是观察结果：持久 blocked_error 不因此设置。
    expect(cursorRow().blocked_error).toBeNull();
  });

  it("A/B 账号与备份序列隔离；不同账号互不可见", async () => {
    const secondAccountId = await t.account.readAccountId({
      sessionHash: secondSessionHash, identity: secondIdentity, nowMs: now,
    });
    const a = doc();
    writeRecord(a, "a-only", syntheticRecord, true);
    lastMerged = await sync(a.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toHaveLength(1);

    const b = doc();
    writeRecord(b, "b-only", syntheticRecord, true);
    await syncB(b.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    // B 的备份在 B 的前缀下，互不干扰。
    const bCursor = t.database.prepare("SELECT * FROM backup_cursor WHERE account_id = ?").get(secondAccountId) as Record<string, unknown>;
    expect(bCursor.pending_revision).toBeNull();
    expect(bCursor.latest_completed_revision).toBe(1);
    const prefixA = `hako-backup/layout-v1/${BACKUP_ENVIRONMENT}/accounts/${accountId}/`;
    const prefixB = `hako-backup/layout-v1/${BACKUP_ENVIRONMENT}/accounts/${secondAccountId}/`;
    expect(t.bucket.storedKeys().every((key) => key.startsWith(prefixA) || key.startsWith(prefixB))).toBe(true);
    expect(t.bucket.storedKeys().filter((key) => key.startsWith(prefixA))).toHaveLength(2);
    expect(t.bucket.storedKeys().filter((key) => key.startsWith(prefixB))).toHaveLength(2);
    // A 的完成缓存不含 B 的版本。
    expect(completions()).toEqual([{ revision: 1 }]);
  });
});

function commitMarkerKeyOf(revision: number): string {
  const streamId = (cursorRow().stream_id as string);
  return `hako-backup/layout-v1/${BACKUP_ENVIRONMENT}/accounts/${accountId}/refueling/${streamId}/commits/${String(revision).padStart(20, "0")}.json`;
}

function bundleKeyOf(revision: number): string {
  return t.bucket.storedKeys().find((key) => key.includes(`/objects/${String(revision).padStart(20, "0")}-`))!;
}

describe("代次兼容基础：捕获固定代次、覆盖判断与恢复基线消费", () => {
  it("新捕获在冻结时固定源代次/格式/来源；完成缓存保存对应信息与快照哈希", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    // 先注入一次 R2 故障：捕获后的任务保留在冻结表，验证捕获时固定字段。
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { put: "throw" } });
    await fireAlarm();
    const head = t.storage.sql.exec(`SELECT * FROM refueling_document_heads WHERE account_id = ?`, accountId).toArray()[0] as { current_generation: string; legacy_generation: string };
    expect(taskRow()).toMatchObject({
      source_generation: head.current_generation,
      format_version: 2,
      generation_origin: JSON.stringify({ kind: "initial" }),
    });
    const frozenCapturedAt = taskRow()?.captured_at;
    const frozenSnapshotSha = taskRow()?.snapshot_sha256;
    t.bucket.clearFaults();
    now += retryDelays[0];
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    const completion = t.database.prepare(
      "SELECT * FROM backup_completions WHERE account_id = ? AND revision = 1",
    ).get(accountId) as Record<string, unknown>;
    expect(completion).toMatchObject({
      source_generation: head.current_generation,
      format_version: 2,
      generation_origin: JSON.stringify({ kind: "initial" }),
      reason: "baseline",
      captured_at: frozenCapturedAt,
      snapshot_sha256: frozenSnapshotSha,
    });
    expect(cursorRow()).toMatchObject({
      latest_completed_generation: head.current_generation,
    });
  });

  it("不同代次即使历史摘要相同也不能互相确认覆盖：合成切换后状态报告覆盖缺口", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    const head = t.storage.sql.exec(`SELECT * FROM refueling_document_heads WHERE account_id = ?`, accountId).toArray()[0] as { current_generation: string; legacy_generation: string };
    // 合成 B 切换：同一份历史内容换新代次（摘要不变），不推进 revision 的游标完成状态。
    const newGeneration = crypto.randomUUID();
    t.storage.transactionSync(() => {
      t.storage.sql.exec(
        `INSERT OR REPLACE INTO refueling_document_heads
           (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
         VALUES (?, ?, ?, 'restore', ?, ?)`,
        accountId, newGeneration, head.current_generation,
        JSON.stringify({
          kind: "restore", requestId: crypto.randomUUID(), previousGeneration: head.current_generation,
          targetBackup: { backupStreamId: cursorRow().stream_id, revision: 1, bundleSha256: "a".repeat(64) },
          protectionBackup: { backupStreamId: cursorRow().stream_id, revision: 1, bundleSha256: "b".repeat(64) },
        }),
        now,
      );
      t.storage.sql.exec("UPDATE refueling_snapshots SET document_generation = ? WHERE account_id = ?", newGeneration, accountId);
    });
    // 历史摘要与最新完成一致，但代次不同：不算已备份（报告 coverage_mismatch）。
    const status = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(status.ok && status.status.currentBackedUp).toBe(false);
    expect(status.ok ? status.status.blockedError : null).toBe("coverage_mismatch");
    expect(status.ok ? status.status.currentGeneration : null).toBe(newGeneration);
    // 空闲同步（同一历史）按未覆盖登记新 revision 并开启窗口，恢复覆盖责任。
    now += 1000;
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    expect(cursorRow()).toMatchObject({ current_revision: 2, pending_revision: 2 });
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    const afterSwitch = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(afterSwitch.ok && afterSwitch.ok && afterSwitch.status.currentBackedUp).toBe(true);
  });

  it("捕获前核对分块来源：标签与 head 不一致时不发新对象并进入 blocked", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    // 破坏分块来源：标签与 head 当前代次不一致（可能来自带外/残缺状态）。
    t.database.prepare("UPDATE refueling_snapshots SET document_generation = ? WHERE account_id = ?")
      .run(crypto.randomUUID(), accountId);
    await fireAlarm();
    // 不发出新包与标记；责任保留并进入 blocked。
    expect(t.bucket.storedKeys()).toHaveLength(0);
    expect((await t.backups.readStatusSnapshot(accountId)).state).toBe("blocked");
    expect((await t.backups.readStatusSnapshot(accountId)).blockedError).toBe("generation_state_unavailable");
    expect(cursorRow().pending_revision).not.toBeNull();
    // 只读覆盖结论同样不报告已备份（来源不可证明）。
    const statusView = await t.account.readBackupStatus({ sessionHash, identity, nowMs: now });
    expect(statusView.ok && statusView.status.currentBackedUp).toBe(false);
  });

  it("恢复代次下的全 NULL 分块在捕获时不可解释：不发新对象并进入 blocked", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    const head = t.storage.sql.exec(`SELECT * FROM refueling_document_heads WHERE account_id = ?`, accountId).toArray()[0] as { current_generation: string; legacy_generation: string };
    // 合成 B 切换到新代次，同时把分块标签置 NULL：不能解释为恢复代次的当前文档。
    const newGeneration = crypto.randomUUID();
    t.storage.transactionSync(() => {
      t.storage.sql.exec(
        `INSERT OR REPLACE INTO refueling_document_heads
           (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
         VALUES (?, ?, ?, 'restore', ?, ?)`,
        accountId, newGeneration, head.legacy_generation,
        JSON.stringify({
          kind: "restore", requestId: crypto.randomUUID(), previousGeneration: head.current_generation,
          targetBackup: { backupStreamId: cursorRow().stream_id, revision: 1, bundleSha256: "a".repeat(64) },
          protectionBackup: { backupStreamId: cursorRow().stream_id, revision: 1, bundleSha256: "b".repeat(64) },
        }),
        now,
      );
      t.storage.sql.exec("UPDATE refueling_snapshots SET document_generation = NULL WHERE account_id = ?", accountId);
      t.storage.sql.exec(
        "UPDATE backup_cursor SET current_revision = 2, last_commit_at = ?, pending_revision = 2, pending_first_revision = 2, pending_first_at = ?, window_due_at = ? WHERE account_id = ?",
        now, now, now - 1000, accountId,
      );
    });
    await fireAlarm();
    // 捕获拒绝：不发出新对象，blocked 保留责任。
    expect(completions()).toEqual([{ revision: 1 }]);
    expect(t.bucket.storedKeys().filter((key) => key.includes("/objects/"))).toHaveLength(1);
    expect((await t.backups.readStatusSnapshot(accountId)).blockedError).toBe("generation_state_unavailable");
  });

  it("v2 任务的代次来源损坏不降级为 v1 发布：blocked 且零新对象", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    t.bucket.addFault({ match: "prefix:hako-backup/", plan: { list: "throw" } });
    await fireAlarm();
    // 任务已捕获（v2 字段固定）但尚未准备。
    const task = taskRow();
    expect(task).toMatchObject({ format_version: 2, source_generation: expect.any(String) });
    // 损坏 v2 任务的代次来源：不能当作 legacy v1 任务发布。
    t.storage.sql.exec(
      "UPDATE backup_frozen_task SET generation_origin = ?, manifest_json = NULL WHERE account_id = ?",
      "corrupt-json", accountId,
    );
    t.bucket.clearFaults();
    now += retryDelays[0];
    await fireAlarm();
    expect(completions()).toEqual([]);
    expect(t.bucket.storedKeys()).toHaveLength(0);
    expect((await t.backups.readStatusSnapshot(accountId)).blockedError).toBe("format_conflict");
  });

  it("A 消费合成 B 冻结的恢复基线任务：restore-baseline 以 v2 发布并携带 restore 来源", async () => {
    const working = doc();
    writeRecord(working, "one", syntheticRecord, true);
    lastMerged = await sync(working.export({ mode: "snapshot" }));
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }]);
    const head = t.storage.sql.exec(`SELECT * FROM refueling_document_heads WHERE account_id = ?`, accountId).toArray()[0] as { current_generation: string; legacy_generation: string };
    const streamId = cursorRow().stream_id as string;
    const newGeneration = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const origin = {
      kind: "restore" as const, requestId, previousGeneration: head.current_generation as string,
      targetBackup: { backupStreamId: streamId, revision: 1, bundleSha256: "a".repeat(64) },
      protectionBackup: { backupStreamId: streamId, revision: 1, bundleSha256: "b".repeat(64) },
    };
    const restored = doc();
    writeRecord(restored, "restored", { ...syntheticRecord, stationName: "恢复后" }, true);
    const restoredSnapshot = restored.export({ mode: "snapshot" });
    t.storage.transactionSync(() => {
      t.storage.sql.exec(
        `INSERT OR REPLACE INTO refueling_document_heads
           (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
         VALUES (?, ?, ?, 'restore', ?, ?)`,
        accountId, newGeneration, head.current_generation, JSON.stringify(origin), now,
      );
      t.storage.sql.exec("DELETE FROM refueling_snapshots WHERE account_id = ?", accountId);
      for (let offset = 0; offset < restoredSnapshot.byteLength; offset += 512 * 1024) {
        t.storage.sql.exec(
          "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, ?, ?, ?)",
          accountId, Math.floor(offset / (512 * 1024)),
          restoredSnapshot.slice(offset, offset + 512 * 1024).buffer, newGeneration,
        );
      }
      t.storage.sql.exec(
        "UPDATE backup_cursor SET current_revision = 2, last_commit_at = ?, pending_revision = NULL, pending_first_revision = NULL, pending_first_at = NULL, window_due_at = NULL WHERE account_id = ?",
        now, accountId,
      );
      t.storage.sql.exec(
        `INSERT INTO backup_frozen_task (account_id, stream_id, revision, reason, captured_at, source_committed_at,
           previous_completed_revision, first_pending_revision, source_generation, format_version, generation_origin,
           manifest_json, bundle_sha256, snapshot_sha256, snapshot_bytes, history_sha256, record_count,
           bundle_key, marker_key, attempt_count, next_attempt_at)
         VALUES (?, ?, 2, 'restore-baseline', ?, ?, 1, NULL, ?, 2, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`,
        accountId, streamId, now, now, newGeneration, JSON.stringify(origin),
      );
      t.storage.sql.exec(
        "INSERT INTO backup_frozen_task_chunks (account_id, chunk_index, chunk) SELECT ?, chunk_index, snapshot FROM refueling_snapshots WHERE account_id = ?",
        accountId, accountId,
      );
    });
    now += windowMs;
    await fireAlarm();
    expect(completions()).toEqual([{ revision: 1 }, { revision: 2 }]);
    const parsed = parseBundle(t.bucket.storedBytes(bundleKeys().at(-1)!)!);
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.manifest.formatVersion).toBe(2);
    expect(parsed.manifest.reason).toBe("restore-baseline");
    expect(parsed.manifest.sourceGeneration).toEqual({ kind: "document-generation-v1", id: newGeneration });
    if (parsed.manifest.formatVersion !== 2) throw new Error("restore baseline must be v2");
    expect(parsed.manifest.generationOrigin).toEqual(origin);
    expect(cursorRow()).toMatchObject({ latest_completed_generation: newGeneration, current_revision: 2 });
  });
});

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
