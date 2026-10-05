import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LoroDoc } from "loro-crdt/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createTestAccount, type TestAccount } from "./helpers/account-state-sqlite";
import { initializeTestLoro, syntheticRecord, unsupportedDocumentCases } from "./helpers/sync-fixtures";
import { readRecords, writeRecord } from "../src/data/refueling-document";
import { handleApiRequest } from "../src/worker/api";
import { hashSecret } from "../src/worker/auth/secrets";
import {
  BOOTSTRAP_PATH,
  MAX_SYNC_BYTES,
  SYNC_CONTENT_TYPE,
  SYNC_PATH,
  SYNC_PROTOCOL,
} from "../src/shared/sync-protocol";

const origin = "https://hako.eruoo.me";
const identity = { issuer: "https://auth.eruoo.me", subject: "synthetic-sync-owner" };
const token = "synthetic-session-token-for-local-tests";
const start = Date.parse("2026-10-02T00:00:00Z");
let now: number;
let testAccount: TestAccount;
let directory: string;
let sessionHash: string;
let accountId: string;
let generation: string;
const docs: LoroDoc[] = [];
function document(snapshot?: Uint8Array) {
  const doc = new LoroDoc(); docs.push(doc);
  if (snapshot) doc.import(snapshot);
  return doc;
}
function seedSession(session: { issuer: string; subject: string; sessionHash: string; createdAtMs: number; expiresAtMs: number; absoluteExpiresAtMs: number }) {
  testAccount.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(session.sessionHash, session.issuer, session.subject, session.createdAtMs, session.createdAtMs, session.expiresAtMs, session.absoluteExpiresAtMs);
}
function environment(subject = identity.subject) {
  return {
    HAKO_LOGIN: { origin, issuer: identity.issuer, clientId: "hako-web", resource: "https://auth.eruoo.me/api" },
    HAKO_OWNER_SUBJECT: subject, HAKO_ACCOUNT: { getByName: () => testAccount.account },
  };
}
/** null 值表示省略该头（模拟缺代次/缺协议的旧客户端请求）。 */
function uploadRequest(snapshot: Uint8Array, headers: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
    "X-Hako-Sync-Protocol": SYNC_PROTOCOL, "X-Hako-Document-Generation": generation,
    "Content-Type": SYNC_CONTENT_TYPE,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  return new Request(`${origin}${SYNC_PATH}`, { method: "POST", headers: base, body: new Uint8Array(snapshot) });
}
function getRequest(headers: Record<string, string> = {}) {
  return new Request(`${origin}${SYNC_PATH}`, { method: "GET", headers: {
    Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
    "X-Hako-Sync-Protocol": SYNC_PROTOCOL, ...headers,
  } });
}
function bootstrapRequest(headers: Record<string, string> = {}) {
  return new Request(`${origin}${BOOTSTRAP_PATH}`, { method: "POST", headers: {
    Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
    "Content-Type": "application/json", ...headers,
  }, body: "{}" });
}
async function send(snapshot: Uint8Array, headers: Record<string, string | null> = {}) {
  return handleApiRequest(uploadRequest(snapshot, headers), environment(), { now: () => now });
}
async function snapshotOf(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Hako-Account")).toBe(accountId);
  expect(response.headers.get("X-Hako-Sync-Protocol")).toBe(SYNC_PROTOCOL);
  expect(response.headers.get("X-Hako-Document-Generation")).toBe(generation);
  expect(response.headers.get("X-Hako-Revision")).not.toBeNull();
  return new Uint8Array(await response.arrayBuffer());
}
/** 幂等 bootstrap：读取/固定当前代次（测试在需要时复核代次未漂移）。 */
async function bootstrap(extraHeaders: Record<string, string> = {}) {
  const response = await handleApiRequest(bootstrapRequest(extraHeaders), environment(), { now: () => now });
  expect(response.status).toBe(200);
  return await response.json() as {
    accountId: string; documentGeneration: string; legacyGeneration: string;
    generationOrigin: unknown; snapshotAvailable: boolean; restoreWritesAvailable: boolean;
  };
}
beforeAll(initializeTestLoro);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hako-sync-"));
  testAccount = createTestAccount(join(directory, "account.sqlite"));
  now = start;
  sessionHash = await hashSecret(token);
  seedSession({ ...identity, sessionHash, createdAtMs: now, expiresAtMs: now + 180 * 86400000, absoluteExpiresAtMs: now + 365 * 86400000 });
  accountId = (await testAccount.account.readAccountId({ sessionHash, identity, nowMs: now }))!;
  generation = (await bootstrap()).documentGeneration;
});
afterEach(() => {
  for (const doc of docs.splice(0)) doc.free();
  testAccount.database.close();
  rmSync(directory, { recursive: true });
  vi.restoreAllMocks();
});

describe("bootstrap 与受控代次初始化", () => {
  it("幂等 bootstrap：重复调用返回同一 G0；空账号无主文档，restoreWritesAvailable=true（B 起提供恢复切换）", async () => {
    const first = await bootstrap();
    expect(first).toMatchObject({
      accountId, snapshotAvailable: false, restoreWritesAvailable: true, generationOrigin: { kind: "initial" },
    });
    expect(first.documentGeneration).toBe(first.legacyGeneration);
    for (let index = 0; index < 3; index += 1) {
      expect(await bootstrap()).toEqual(first);
    }
    const rows = testAccount.database.prepare("SELECT count(*) AS count FROM refueling_document_heads").get();
    expect(rows).toEqual({ count: 1 });
  });

  it("bootstrap 正文只接受空 JSON 对象；Origin、会话与方法边界", async () => {
    for (const body of ["", "[]", '{"extra":1}', "null"]) {
      const request = new Request(`${origin}${BOOTSTRAP_PATH}`, { method: "POST", headers: {
        Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId, "Content-Type": "application/json",
      }, body });
      expect((await handleApiRequest(request, environment(), { now: () => now })).status, body).toBe(400);
    }
    const wrongOrigin = await handleApiRequest(bootstrapRequest({ Origin: "https://other.example" }), environment(), { now: () => now });
    expect(wrongOrigin.status).toBe(403);
    const anonymous = await handleApiRequest(bootstrapRequest({ Cookie: "" }), environment(), { now: () => now });
    expect(anonymous.status).toBe(401);
    const accountMismatch = await handleApiRequest(bootstrapRequest({ "X-Hako-Account": crypto.randomUUID() }), environment(), { now: () => now });
    expect(accountMismatch.status).toBe(409);
    expect((await handleApiRequest(new Request(`${origin}${BOOTSTRAP_PATH}`, { method: "GET", headers: { Cookie: `__Host-hako_session=${token}` } }), environment(), { now: () => now })).status).toBe(405);
  });

  it("既有 legacy 文档升级：bootstrap 与 head 同事务绑定 G0；原字节与 revision 不变", async () => {
    // 模拟升级前（协议 1 时代）的既有主文档：先移除 beforeEach 建立的空 head，
    // 再以 legacy 分块（无代次标签）恢复升级前状态。
    testAccount.storage.sql.exec("DELETE FROM refueling_document_heads WHERE account_id = ?", accountId);
    const legacy = document();
    writeRecord(legacy, "pre-upgrade", syntheticRecord, true);
    const legacySnapshot = legacy.export({ mode: "snapshot" });
    testAccount.storage.transactionSync(() => {
      for (let offset = 0; offset < legacySnapshot.byteLength; offset += 512 * 1024) {
        testAccount.storage.sql.exec(
          "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, ?, ?, NULL)",
          accountId, Math.floor(offset / (512 * 1024)), legacySnapshot.slice(offset, offset + 512 * 1024).buffer,
        );
      }
    });
    const before = testAccount.database.prepare("SELECT snapshot FROM refueling_snapshots ORDER BY chunk_index").all();
    const result = await bootstrap();
    generation = result.documentGeneration;
    expect(result.snapshotAvailable).toBe(true);
    expect(result.documentGeneration).toBe(result.legacyGeneration);
    // 绑定只补标签，不改快照字节；revision 不因初始化推进。
    expect(testAccount.database.prepare("SELECT snapshot FROM refueling_snapshots ORDER BY chunk_index").all()).toEqual(before);
    expect(testAccount.database.prepare("SELECT document_generation FROM refueling_snapshots").all())
      .toEqual(before.map(() => ({ document_generation: result.documentGeneration })));
    const uploaded = await snapshotOf(await send(document().export({ mode: "snapshot" })));
    expect(readRecords(document(uploaded))).toHaveLength(1);
    expect(Number(testAccount.database.prepare("SELECT current_revision FROM backup_cursor").get()?.current_revision)).toBe(1);
  });

  it("head 缺失但分块/冻结任务/完成缓存已带现代代次时不补建 G0（generation_state_unavailable）", async () => {
    // 先移除 beforeEach 建立的 head，再注入带现代代次标签的分块：不可解释状态。
    testAccount.storage.sql.exec("DELETE FROM refueling_document_heads WHERE account_id = ?", accountId);
    const foreign = crypto.randomUUID();
    testAccount.storage.sql.exec(
      "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, 0, ?, ?)",
      accountId, new Uint8Array(8).buffer, foreign,
    );
    const bootstrapResponse = await handleApiRequest(bootstrapRequest(), environment(), { now: () => now });
    expect(bootstrapResponse.status).toBe(503);
    expect(await bootstrapResponse.json()).toEqual({ error: "generation_state_unavailable" });
    expect(testAccount.database.prepare("SELECT count(*) AS count FROM refueling_document_heads").get()).toEqual({ count: 0 });
    // 同一状态下同步上传与只读快照同样拒绝，不产生任何写入。
    expect((await send(document().export({ mode: "snapshot" }))).status).toBe(503);
    expect((await handleApiRequest(getRequest(), environment(), { now: () => now })).status).toBe(503);
  });
});

describe("只读当前快照 GET", () => {
  it("无主文档返回 204；有主文档返回完整快照与 revision 头；不创建映射、不续期", async () => {
    const empty = await handleApiRequest(getRequest(), environment(), { now: () => now });
    expect(empty.status).toBe(204);
    expect(empty.headers.get("X-Hako-Account")).toBe(accountId);
    expect(empty.headers.get("X-Hako-Document-Generation")).toBe(generation);
    expect(empty.headers.get("X-Hako-Revision")).toBe("0");

    const doc = document();
    writeRecord(doc, "one", syntheticRecord, true);
    await snapshotOf(await send(doc.export({ mode: "snapshot" })));
    now += 2 * 86400000;
    const response = await handleApiRequest(getRequest(), environment(), { now: () => now });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(SYNC_CONTENT_TYPE);
    expect(response.headers.get("X-Hako-Revision")).toBe("1");
    expect(readRecords(document(new Uint8Array(await response.arrayBuffer())))).toHaveLength(1);
    // GET 不续期、不写 Cookie。
    expect(testAccount.state.readSession({ identity, sessionHash, nowMs: now })?.renewedAtMs).toBe(start);
    expect(response.headers.getSetCookie()).toEqual([]);
    // GET 要求协议 2；无映射账号返回 account_changed。
    expect((await handleApiRequest(getRequest({ "X-Hako-Sync-Protocol": "1" }), environment(), { now: () => now })).status).toBe(426);
    expect((await handleApiRequest(getRequest({ "X-Hako-Account": crypto.randomUUID() }), environment(), { now: () => now })).status).toBe(409);
    expect((await handleApiRequest(getRequest({ Cookie: "" }), environment(), { now: () => now })).status).toBe(401);
    expect((await handleApiRequest(new Request(`${origin}${SYNC_PATH}`, { method: "PUT", headers: { Cookie: `__Host-hako_session=${token}` } }), environment(), { now: () => now })).status).toBe(405);
  });
});

describe("账号文档与持久同步协议 v2", () => {
  it("非法容器和特殊键不进入权威快照、不续期，SQLite 重开保留原有字节", async () => {
    const healthy = document(); writeRecord(healthy, "one", syntheticRecord, true);
    const snapshot = await snapshotOf(await send(healthy.export({ mode: "snapshot" })));
    const stored = () => testAccount.database.prepare("SELECT * FROM refueling_snapshots ORDER BY account_id, chunk_index").all();
    const before = stored(); now += 2 * 86400000;
    for (const [name, mutate] of unsupportedDocumentCases) {
      const invalid = document(snapshot); mutate(invalid); invalid.commit();
      expect((await send(invalid.export({ mode: "snapshot" }))).status, name).toBe(422);
      expect(stored(), name).toEqual(before);
      expect(testAccount.state.readSession({ identity, sessionHash, nowMs: now })?.renewedAtMs, name).toBe(start);
    }
    testAccount.database.close(); testAccount = createTestAccount(join(directory, "account.sqlite"));
    expect(stored()).toEqual(before);
    expect(readRecords(document(await snapshotOf(await send(document().export({ mode: "snapshot" })))))).toEqual(readRecords(healthy));
  });

  it("多分块完整历史原子切换；后续分块写失败保留此前完整副本", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const initial = await snapshotOf(await send(a.export({ mode: "snapshot" })));
    for (let index = 0; index < 6500; index++) {
      writeRecord(a, "one", { orderNumber: randomBytes(96).toString("base64") }, false);
    }
    const snapshot = a.export({ mode: "snapshot" });
    expect(snapshot.byteLength).toBeGreaterThan(512 * 1024);
    testAccount.database.exec("CREATE TRIGGER fail_second_chunk BEFORE INSERT ON refueling_snapshots WHEN NEW.chunk_index = 1 BEGIN SELECT RAISE(ABORT, 'synthetic chunk failure'); END");
    expect((await send(snapshot)).status).toBe(503);
    const retained = document(await snapshotOf(await send(document().export({ mode: "snapshot" }))));
    expect(readRecords(retained)).toEqual(readRecords(document(initial)));
    testAccount.database.exec("DROP TRIGGER fail_second_chunk");
    expect(readRecords(document(await snapshotOf(await send(snapshot))))).toEqual(readRecords(a));
    expect(Number(testAccount.database.prepare("SELECT count(*) AS count FROM refueling_snapshots").get()?.count)).toBeGreaterThan(1);
  });

  it("独立创建、并发字段、同字段竞争、重复/过时重试收敛，重启保留完整历史", async () => {
    const a = document(); writeRecord(a, "first", syntheticRecord, true);
    const initial = await snapshotOf(await send(a.export({ mode: "snapshot" })));
    const past = a.frontiers();
    const b = document(initial);
    writeRecord(a, "first", { stationName: "A", orderNumber: "A-1" }, false);
    writeRecord(b, "first", { stationName: "B", fuelGrade: "95" }, false);
    writeRecord(b, "second", { ...syntheticRecord, odometerTenths: 11000 }, true);
    const oldA = a.export({ mode: "snapshot" });
    await snapshotOf(await send(oldA));
    const mergedB = await snapshotOf(await send(b.export({ mode: "snapshot" })));
    const retried = await snapshotOf(await send(oldA));
    a.import(retried); b.import(mergedB);
    expect(readRecords(a)).toEqual(readRecords(b));
    expect(readRecords(a)).toHaveLength(2);
    expect(readRecords(a).find((record) => record.id === "first")).toMatchObject({ fuelGrade: "95", orderNumber: "A-1" });
    testAccount.database.close();
    testAccount = createTestAccount(join(directory, "account.sqlite"));
    const recovered = document(await snapshotOf(await send(document().export({ mode: "snapshot" }))));
    expect(readRecords(recovered)).toEqual(readRecords(a));
    recovered.checkout(past);
    expect(readRecords(recovered)[0].stationName).toBe(syntheticRecord.stationName);
  });

  it("身份由会话解析，账号 ID 不能代替授权；更换 owner 不认领旧文档", async () => {
    const a = document(); writeRecord(a, "private-a", syntheticRecord, true);
    const bytes = a.export({ mode: "snapshot" });
    await snapshotOf(await send(bytes));
    expect((await send(bytes, { Cookie: "" })).status).toBe(401);
    expect((await send(bytes, { "X-Hako-Account": crypto.randomUUID() })).status).toBe(409);
    expect((await handleApiRequest(uploadRequest(bytes), environment("synthetic-owner-b"), { now: () => now })).status).toBe(401);
    const secondIdentity = { ...identity, subject: "synthetic-owner-b" };
    const secondHash = await hashSecret("synthetic-second-session");
    seedSession({ ...secondIdentity, sessionHash: secondHash, createdAtMs: now, expiresAtMs: now + 100000, absoluteExpiresAtMs: now + 200000 });
    const secondId = await testAccount.account.readAccountId({ sessionHash: secondHash, identity: secondIdentity, nowMs: now });
    expect(secondId).not.toBe(accountId);
    // v2 客户端先 bootstrap 取得自己账号的代次，再正常交换空快照。
    const secondBootstrap = await testAccount.account.bootstrapRefueling({
      sessionHash: secondHash, identity: secondIdentity, nowMs: now, expectedAccountId: secondId!,
    });
    expect(secondBootstrap.ok).toBe(true);
    const response = await handleApiRequest(new Request(`${origin}${SYNC_PATH}`, { method: "POST", headers: {
      Origin: origin, Cookie: "__Host-hako_session=synthetic-second-session", "X-Hako-Account": secondId!,
      "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
      "X-Hako-Document-Generation": secondBootstrap.ok ? secondBootstrap.documentGeneration : "",
      "Content-Type": SYNC_CONTENT_TYPE,
    }, body: new Uint8Array(document().export({ mode: "snapshot" })) }), environment(secondIdentity.subject), { now: () => now });
    expect(response.status).toBe(200);
    expect(readRecords(document(new Uint8Array(await response.arrayBuffer())))).toEqual([]);
  });

  it("协议 1/缺代次/坏 Content-Type 与大小、损坏快照、非法代次格式的拒绝语义", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const snapshot = a.export({ mode: "snapshot" });
    await snapshotOf(await send(snapshot)); now += 2 * 86400000;
    // 协议 1 与缺代次：426 protocol_upgrade_required（不进入合并，不产生状态变化）。
    expect((await send(snapshot, { "X-Hako-Sync-Protocol": "1", "X-Hako-Document-Generation": null })).status).toBe(426);
    expect((await send(snapshot, { "X-Hako-Document-Generation": null })).status).toBe(426);
    expect((await send(snapshot, { "X-Hako-Sync-Protocol": "3" })).status).toBe(426);
    expect((await send(snapshot, { "X-Hako-Document-Generation": "" })).status).toBe(400);
    // 格式错误代次：400；Content-Type 错误：400。
    expect((await send(snapshot, { "X-Hako-Document-Generation": "not-a-uuid" })).status).toBe(400);
    expect((await send(snapshot, { "Content-Type": "application/json" })).status).toBe(400);
    expect((await send(new Uint8Array(MAX_SYNC_BYTES + 1))).status).toBe(413);
    expect((await send(new Uint8Array([1, 2, 3]))).status).toBe(422);
    const invalid = document(snapshot); invalid.getMap("credentials").set("token", "synthetic-forbidden"); invalid.commit();
    expect((await send(invalid.export({ mode: "snapshot" }))).status).toBe(422);
    expect((await send(a.export({ mode: "shallow-snapshot", frontiers: a.frontiers() }))).status).toBe(422);
    expect((await send(snapshot, { Origin: "https://other.example" })).status).toBe(403);
    expect(testAccount.state.readSession({ identity, sessionHash, nowMs: now })?.renewedAtMs).toBe(start);
    expect(readRecords(document(await snapshotOf(await send(document().export({ mode: "snapshot" })))))).toEqual(readRecords(a));
  });

  it("正文读取中途暂停期间会话被撤销：续读完成后在合并前拒绝且零写入", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const snapshot = a.export({ mode: "snapshot" });
    // 受控正文流：发出第一块后在事务外暂停，撤销会话后再发出剩余。
    let releaseRest!: () => void;
    const paused = new Promise<void>((resolve) => { releaseRest = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(snapshot.slice(0, 64));
        await paused;
        controller.enqueue(snapshot.slice(64));
        controller.close();
      },
    });
    const handled = handleApiRequest(new Request(`${origin}${SYNC_PATH}`, {
      method: "POST",
      headers: {
        Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
        "X-Hako-Sync-Protocol": SYNC_PROTOCOL, "X-Hako-Document-Generation": generation,
        "Content-Type": SYNC_CONTENT_TYPE,
      },
      body,
      duplex: "half",
    } as unknown as RequestInit), environment(), { now: () => now });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 正文只读了一半：此刻撤销会话，随后正文续读完成。
    await testAccount.account.revokeSession({ sessionHash, nowMs: now });
    releaseRest();
    const response = await handled;
    expect(response.status).toBe(401);
    expect(Number(testAccount.database.prepare("SELECT count(*) AS count FROM refueling_snapshots").get()?.count)).toBe(0);
    // 会话恢复后同一正文重试成功（前一次未留下任何状态）。
    testAccount.database.prepare("UPDATE sessions SET revoked_at = NULL").run();
    expect(readRecords(document(await snapshotOf(await send(snapshot))))).toHaveLength(1);
  });

  it("正文读取中途流被取消：返回 400 且零写入，不进入合并", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const snapshot = a.export({ mode: "snapshot" });
    let failRest!: () => void;
    const paused = new Promise<void>((resolve) => { failRest = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(snapshot.slice(0, 64));
        await paused;
        controller.error(new Error("client aborted upload"));
      },
    });
    const handled = handleApiRequest(new Request(`${origin}${SYNC_PATH}`, {
      method: "POST",
      headers: {
        Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
        "X-Hako-Sync-Protocol": SYNC_PROTOCOL, "X-Hako-Document-Generation": generation,
        "Content-Type": SYNC_CONTENT_TYPE,
      },
      body,
      duplex: "half",
    } as unknown as RequestInit), environment(), { now: () => now });
    await new Promise((resolve) => setTimeout(resolve, 20));
    failRest();
    const response = await handled;
    expect(response.status).toBe(400);
    expect(Number(testAccount.database.prepare("SELECT count(*) AS count FROM refueling_snapshots").get()?.count)).toBe(0);
  });

  it("合法但非当前代次：409 document_generation_changed 附代次元数据、不附业务快照，与 account_changed 分开", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    await snapshotOf(await send(a.export({ mode: "snapshot" })));
    const staleGeneration = generation;
    const nextGeneration = crypto.randomUUID();
    // 模拟 B 的恢复切换事务：替换主分块（绑定新代次）+ 换 head + 登记 restore 来源。
    const switchedSnapshot = a.export({ mode: "snapshot" });
    testAccount.storage.transactionSync(() => {
      testAccount.storage.sql.exec("DELETE FROM refueling_snapshots WHERE account_id = ?", accountId);
      for (let offset = 0; offset < switchedSnapshot.byteLength; offset += 512 * 1024) {
        testAccount.storage.sql.exec(
          "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, ?, ?, ?)",
          accountId, Math.floor(offset / (512 * 1024)),
          switchedSnapshot.slice(offset, offset + 512 * 1024).buffer, nextGeneration,
        );
      }
      testAccount.storage.sql.exec(
        `INSERT OR REPLACE INTO refueling_document_heads
           (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
         VALUES (?, ?, ?, 'restore', ?, ?)`,
        accountId, nextGeneration, staleGeneration,
        JSON.stringify({
          kind: "restore", requestId: crypto.randomUUID(), previousGeneration: staleGeneration,
          targetBackup: { backupStreamId: crypto.randomUUID(), revision: 3, bundleSha256: "a".repeat(64) },
          protectionBackup: { backupStreamId: crypto.randomUUID(), revision: 4, bundleSha256: "b".repeat(64) },
        }),
        now,
      );
    });
    const response = await send(a.export({ mode: "snapshot" }), { "X-Hako-Document-Generation": staleGeneration });
    expect(response.status).toBe(409);
    const text = await response.text();
    const body = JSON.parse(text) as { error: string; currentGeneration: string; legacyGeneration: string; revision: number };
    expect(body).toMatchObject({ error: "document_generation_changed", legacyGeneration: staleGeneration, revision: 1 });
    expect(body.currentGeneration).toBe(nextGeneration);
    // 不附业务快照：响应体只是固定错误 JSON。
    expect(text).not.toContain("snapshot");
    // 主文档保持切换后的字节（无合并写入）；账号不匹配仍为 account_changed。
    expect(Number(testAccount.database.prepare("SELECT count(*) AS count FROM refueling_snapshots").get()?.count)).toBe(1);
    expect((await send(a.export({ mode: "snapshot" }), { "X-Hako-Account": crypto.randomUUID() })).status).toBe(409);
    // 新代次上传正常收敛；GET 快照同样按新代次读取。
    generation = nextGeneration;
    expect(readRecords(document(await snapshotOf(await send(a.export({ mode: "snapshot" })))))).toHaveLength(1);
    const current = await handleApiRequest(getRequest(), environment(), { now: () => now });
    expect(current.headers.get("X-Hako-Document-Generation")).toBe(nextGeneration);
  });

  it("恢复代次下的全 NULL 分块不可解释：同步与只读快照拒绝，不重新贴现代标签", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    await snapshotOf(await send(a.export({ mode: "snapshot" })));
    const legacyGeneration = generation;
    const newGeneration = crypto.randomUUID();
    // 合成 B 切换：head 换新代次，但把分块标签置 NULL（可能来自旧代码/带外操作）。
    testAccount.storage.transactionSync(() => {
      testAccount.storage.sql.exec(
        `INSERT OR REPLACE INTO refueling_document_heads
           (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
         VALUES (?, ?, ?, 'restore', ?, ?)`,
        accountId, newGeneration, legacyGeneration,
        JSON.stringify({
          kind: "restore", requestId: crypto.randomUUID(), previousGeneration: legacyGeneration,
          targetBackup: { backupStreamId: crypto.randomUUID(), revision: 1, bundleSha256: "a".repeat(64) },
          protectionBackup: { backupStreamId: crypto.randomUUID(), revision: 1, bundleSha256: "b".repeat(64) },
        }),
        now,
      );
      testAccount.storage.sql.exec("UPDATE refueling_snapshots SET document_generation = NULL WHERE account_id = ?", accountId);
    });
    // 全 NULL 只在 legacy G0 边界内可解释：恢复代次下同步上传与只读快照都拒绝。
    generation = newGeneration;
    expect((await send(a.export({ mode: "snapshot" }))).status).toBe(503);
    const snapshotResponse = await handleApiRequest(getRequest(), environment(), { now: () => now });
    expect(snapshotResponse.status).toBe(503);
    // 回到 legacy G0 边界（部署回退窗口语义）时同一 NULL 分块可解释。
    testAccount.storage.sql.exec(
      "UPDATE refueling_document_heads SET current_generation = ? WHERE account_id = ?",
      legacyGeneration, accountId,
    );
    generation = legacyGeneration;
    expect(readRecords(document(await snapshotOf(await send(a.export({ mode: "snapshot" })))))).toHaveLength(1);
  });

  it("合并关系异常仍同步并保留核对提示；有效同步续期，撤销后拒绝", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const b = document(await snapshotOf(await send(a.export({ mode: "snapshot" }))));
    writeRecord(a, "one", { amountPaidCents: 15000 }, false);
    writeRecord(b, "one", { couponDiscountCents: 2000 }, false);
    await snapshotOf(await send(a.export({ mode: "snapshot" })));
    now += 2 * 86400000;
    const response = await send(b.export({ mode: "snapshot" }));
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(testAccount.state.readSession({ identity, sessionHash, nowMs: now })?.renewedAtMs).toBe(now);
    expect(readRecords(document(await snapshotOf(response)))[0]).toMatchObject({ amountPaidCents: 15000, couponDiscountCents: 2000 });
    await testAccount.account.revokeSession({ sessionHash, nowMs: now });
    expect((await send(a.export({ mode: "snapshot" }))).status).toBe(401);
  });

  it("续期响应迟到、丢失与重试均不回写旧 Cookie，旧会话仍可被撤销", async () => {
    const snapshot = document().export({ mode: "snapshot" });
    now = start + 180 * 86400000 - 3600000;
    const delayed = await send(snapshot);
    expect(delayed.status).toBe(200);
    const extended = testAccount.state.readSession({ identity, sessionHash, nowMs: now })!;
    expect(extended.expiresAtMs).toBe(now + 180 * 86400000);
    now += 2000;
    const retry = await send(snapshot);
    expect(retry.status).toBe(200);
    expect(testAccount.state.readSession({ identity, sessionHash, nowMs: now })?.expiresAtMs).toBe(extended.expiresAtMs);
    await testAccount.account.revokeSession({ sessionHash, nowMs: now });
    // 后续登录将签发新 Cookie；任意顺序交付旧响应都不能改写它。
    expect(delayed.headers.getSetCookie()).toEqual([]);
    expect(retry.headers.getSetCookie()).toEqual([]);
    expect((await send(snapshot)).status).toBe(401);
  });

  it("读取会话之后撤销仍在合并点拒绝；SQLite 写失败不报成功且可恢复重试", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const bytes = a.export({ mode: "snapshot" });
    const original = testAccount.account.syncRefueling.bind(testAccount.account);
    vi.spyOn(testAccount.account, "syncRefueling").mockImplementationOnce(async (input) => {
      await testAccount.account.revokeSession({ sessionHash, nowMs: now });
      return original(input);
    });
    expect((await send(bytes)).status).toBe(401);
    testAccount.database.prepare("UPDATE sessions SET revoked_at = NULL").run();
    testAccount.database.exec("CREATE TRIGGER fail_write BEFORE INSERT ON refueling_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
    expect((await send(bytes)).status).toBe(503);
    expect(testAccount.database.prepare("SELECT count(*) AS count FROM refueling_snapshots").get()?.count).toBe(0);
    testAccount.database.exec("DROP TRIGGER fail_write");
    expect(readRecords(document(await snapshotOf(await send(bytes))))).toHaveLength(1);
  });
});
