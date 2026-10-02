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
import { MAX_SYNC_BYTES, SYNC_CONTENT_TYPE, SYNC_PROTOCOL } from "../src/shared/sync-protocol";

const origin = "https://hako.eruoo.me";
const identity = { issuer: "https://auth.eruoo.me", subject: "synthetic-sync-owner" };
const token = "synthetic-session-token-for-local-tests";
const start = Date.parse("2026-10-02T00:00:00Z");
let now: number;
let testAccount: TestAccount;
let directory: string;
let sessionHash: string;
let accountId: string;
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
function request(snapshot: Uint8Array, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/sync/refueling`, { method: "POST", headers: {
    Origin: origin, Cookie: `__Host-hako_session=${token}`, "X-Hako-Account": accountId,
    "X-Hako-Sync-Protocol": SYNC_PROTOCOL, "Content-Type": SYNC_CONTENT_TYPE, ...headers,
  }, body: new Uint8Array(snapshot) });
}
async function send(snapshot: Uint8Array, headers: Record<string, string> = {}) {
  return handleApiRequest(request(snapshot, headers), environment(), { now: () => now });
}
async function merged(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Hako-Account")).toBe(accountId);
  return new Uint8Array(await response.arrayBuffer());
}
beforeAll(initializeTestLoro);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hako-sync-"));
  testAccount = createTestAccount(join(directory, "account.sqlite"));
  now = start;
  sessionHash = await hashSecret(token);
  seedSession({ ...identity, sessionHash, createdAtMs: now, expiresAtMs: now + 180 * 86400000, absoluteExpiresAtMs: now + 365 * 86400000 });
  accountId = (await testAccount.account.readAccountId({ sessionHash, identity, nowMs: now }))!;
});
afterEach(() => {
  for (const doc of docs.splice(0)) doc.free();
  testAccount.database.close();
  rmSync(directory, { recursive: true });
  vi.restoreAllMocks();
});

describe("账号文档与持久同步协议", () => {
  it("非法容器和特殊键不进入权威快照、不续期，SQLite 重开保留原有字节", async () => {
    const healthy = document(); writeRecord(healthy, "one", syntheticRecord, true);
    const snapshot = await merged(await send(healthy.export({ mode: "snapshot" })));
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
    expect(readRecords(document(await merged(await send(document().export({ mode: "snapshot" })))))).toEqual(readRecords(healthy));
  });

  it("多分块完整历史原子切换；后续分块写失败保留此前完整副本", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const initial = await merged(await send(a.export({ mode: "snapshot" })));
    for (let index = 0; index < 6500; index++) {
      writeRecord(a, "one", { orderNumber: randomBytes(96).toString("base64") }, false);
    }
    const snapshot = a.export({ mode: "snapshot" });
    expect(snapshot.byteLength).toBeGreaterThan(512 * 1024);
    testAccount.database.exec("CREATE TRIGGER fail_second_chunk BEFORE INSERT ON refueling_snapshots WHEN NEW.chunk_index = 1 BEGIN SELECT RAISE(ABORT, 'synthetic chunk failure'); END");
    expect((await send(snapshot)).status).toBe(503);
    const retained = document(await merged(await send(document().export({ mode: "snapshot" }))));
    expect(readRecords(retained)).toEqual(readRecords(document(initial)));
    testAccount.database.exec("DROP TRIGGER fail_second_chunk");
    expect(readRecords(document(await merged(await send(snapshot))))).toEqual(readRecords(a));
    expect(Number(testAccount.database.prepare("SELECT count(*) AS count FROM refueling_snapshots").get()?.count)).toBeGreaterThan(1);
  });

  it("独立创建、并发字段、同字段竞争、重复/过时重试收敛，重启保留完整历史", async () => {
    const a = document(); writeRecord(a, "first", syntheticRecord, true);
    const initial = await merged(await send(a.export({ mode: "snapshot" })));
    const past = a.frontiers();
    const b = document(initial);
    writeRecord(a, "first", { stationName: "A", orderNumber: "A-1" }, false);
    writeRecord(b, "first", { stationName: "B", fuelGrade: "95" }, false);
    writeRecord(b, "second", { ...syntheticRecord, odometerTenths: 11000 }, true);
    const oldA = a.export({ mode: "snapshot" });
    await merged(await send(oldA));
    const mergedB = await merged(await send(b.export({ mode: "snapshot" })));
    const retried = await merged(await send(oldA));
    a.import(retried); b.import(mergedB);
    expect(readRecords(a)).toEqual(readRecords(b));
    expect(readRecords(a)).toHaveLength(2);
    expect(readRecords(a).find((record) => record.id === "first")).toMatchObject({ fuelGrade: "95", orderNumber: "A-1" });
    testAccount.database.close();
    testAccount = createTestAccount(join(directory, "account.sqlite"));
    const recovered = document(await merged(await send(document().export({ mode: "snapshot" }))));
    expect(readRecords(recovered)).toEqual(readRecords(a));
    recovered.checkout(past);
    expect(readRecords(recovered)[0].stationName).toBe(syntheticRecord.stationName);
  });

  it("身份由会话解析，账号 ID 不能代替授权；更换 owner 不认领旧文档", async () => {
    const a = document(); writeRecord(a, "private-a", syntheticRecord, true);
    const bytes = a.export({ mode: "snapshot" });
    await merged(await send(bytes));
    expect((await send(bytes, { Cookie: "" })).status).toBe(401);
    expect((await send(bytes, { "X-Hako-Account": crypto.randomUUID() })).status).toBe(409);
    expect((await handleApiRequest(request(bytes), environment("synthetic-owner-b"), { now: () => now })).status).toBe(401);
    const secondIdentity = { ...identity, subject: "synthetic-owner-b" };
    const secondHash = await hashSecret("synthetic-second-session");
    seedSession({ ...secondIdentity, sessionHash: secondHash, createdAtMs: now, expiresAtMs: now + 100000, absoluteExpiresAtMs: now + 200000 });
    const secondId = await testAccount.account.readAccountId({ sessionHash: secondHash, identity: secondIdentity, nowMs: now });
    expect(secondId).not.toBe(accountId);
    const response = await handleApiRequest(request(document().export({ mode: "snapshot" }), { Cookie: "__Host-hako_session=synthetic-second-session", "X-Hako-Account": secondId! }), environment(secondIdentity.subject), { now: () => now });
    expect(response.status).toBe(200);
    expect(readRecords(document(new Uint8Array(await response.arrayBuffer())))).toEqual([]);
  });

  it("Origin、协议、大小、损坏/浅快照与非法字段拒绝且不污染文档、不续期", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const snapshot = a.export({ mode: "snapshot" });
    await merged(await send(snapshot)); now += 2 * 86400000;
    expect((await send(snapshot, { Origin: "https://other.example" })).status).toBe(403);
    expect((await send(snapshot, { "X-Hako-Sync-Protocol": "2" })).status).toBe(400);
    expect((await send(new Uint8Array(MAX_SYNC_BYTES + 1))).status).toBe(413);
    expect((await send(new Uint8Array([1, 2, 3]))).status).toBe(422);
    const invalid = document(snapshot); invalid.getMap("credentials").set("token", "synthetic-forbidden"); invalid.commit();
    expect((await send(invalid.export({ mode: "snapshot" }))).status).toBe(422);
    expect((await send(a.export({ mode: "shallow-snapshot", frontiers: a.frontiers() }))).status).toBe(422);
    expect(testAccount.state.readSession({ identity, sessionHash, nowMs: now })?.renewedAtMs).toBe(start);
    expect(readRecords(document(await merged(await send(document().export({ mode: "snapshot" })))))).toEqual(readRecords(a));
  });

  it("合并关系异常仍同步并保留核对提示；有效同步续期，撤销后拒绝", async () => {
    const a = document(); writeRecord(a, "one", syntheticRecord, true);
    const b = document(await merged(await send(a.export({ mode: "snapshot" }))));
    writeRecord(a, "one", { amountPaidCents: 15000 }, false);
    writeRecord(b, "one", { couponDiscountCents: 2000 }, false);
    await merged(await send(a.export({ mode: "snapshot" })));
    now += 2 * 86400000;
    const response = await send(b.export({ mode: "snapshot" }));
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(testAccount.state.readSession({ identity, sessionHash, nowMs: now })?.renewedAtMs).toBe(now);
    expect(readRecords(document(await merged(response)))[0]).toMatchObject({ amountPaidCents: 15000, couponDiscountCents: 2000 });
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
    expect(readRecords(document(await merged(await send(bytes))))).toHaveLength(1);
  });
});
