import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt/web";
import { createTestAccount, type TestAccount } from "./helpers/account-state-sqlite";
import { initializeTestLoro, syntheticRecord } from "./helpers/sync-fixtures";
import { handleApiRequest } from "../src/worker/api";
import { hashSecret } from "../src/worker/auth/secrets";
import { writeRecord } from "../src/data/refueling-document";

const origin = "https://hako.eruoo.me";
const identity = { issuer: "https://auth.eruoo.me", subject: "synthetic-backup-route-owner" };
const token = "synthetic-backup-route-token";
const start = Date.parse("2026-10-04T00:00:00Z");
let now: number;
let t: TestAccount;
let sessionHash: string;
let accountId: string;
let directory: string;

function environment(): Parameters<typeof handleApiRequest>[1] {
  return {
    HAKO_LOGIN: { origin, issuer: identity.issuer, clientId: "hako-web", resource: "https://auth.eruoo.me/api" },
    HAKO_OWNER_SUBJECT: identity.subject,
    HAKO_ACCOUNT: { getByName: () => t.account },
  };
}

function request(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`${origin}/api/backups/refueling/status`, { method, headers: { Cookie: `__Host-hako_session=${token}`, ...headers } });
}

beforeAll(initializeTestLoro);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hako-backup-route-"));
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

describe("只读备份状态接口", () => {
  it("方法、鉴权与配置边界；GET 不要求 Origin 头", async () => {
    expect((await handleApiRequest(request({}, "POST"), environment(), { now: () => now })).status).toBe(405);
    expect((await handleApiRequest(new Request(`${origin}/api/backups/refueling/status`), environment(), { now: () => now })).status).toBe(401);
    expect((await handleApiRequest(request({ Cookie: "" }), environment(), { now: () => now })).status).toBe(401);
    expect((await handleApiRequest(request({ Origin: "https://other.example" }), environment(), { now: () => now })).status).toBe(200);
    expect((await handleApiRequest(new Request(`${origin}/api/backups/unknown`, { headers: { Cookie: `__Host-hako_session=${token}` } }), environment(), { now: () => now })).status).toBe(404);
  });

  it("有效会话无映射：返回未初始化且不创建映射、不产生任何 R2/调度副作用", async () => {
    const revoked = await handleApiRequest(request(), { ...environment(), HAKO_OWNER_SUBJECT: "other-owner" }, { now: () => now });
    expect(revoked.status).toBe(401);
    const response = await handleApiRequest(request(), environment(), { now: () => now });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = await response.json() as { initialized: boolean; state: string };
    expect(body.initialized).toBe(false);
    expect(body.state).toBe("uninitialized");
    expect(t.database.prepare("SELECT count(*) AS count FROM account_data_ids").get()).toEqual({ count: 1 });
    expect(t.bucket.counters.put).toBe(0);
    expect(t.bucket.counters.list).toBe(0);
    expect(t.storage.alarmTime()).toBeNull();
    // 状态读取不续期。
    expect(t.state.readSession({ sessionHash, identity, nowMs: now })?.renewedAtMs).toBe(start);
  });

  it("有映射与备份状态时返回元数据；不触发上传，响应不缓存", async () => {
    const doc = new LoroDoc();
    writeRecord(doc, "one", syntheticRecord, true);
    const result = await t.account.syncRefueling({
      sessionHash, identity, nowMs: now, expectedAccountId: accountId, snapshot: doc.export({ mode: "snapshot" }),
    });
    expect(result.ok).toBe(true);
    const response = await handleApiRequest(request(), environment(), { now: () => now });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      initialized: boolean; state: string; currentRevision: number;
      pendingFromRevision: number | null; windowDueAtMs: number | null; currentBackedUp: boolean;
    };
    expect(body).toMatchObject({
      initialized: true, state: "pending", currentRevision: 1,
      pendingFromRevision: 1, currentBackedUp: false,
    });
    expect(body.windowDueAtMs).toBe(now + 30_000);
    expect(t.bucket.counters.put).toBe(0);
    doc.free();
  });

  it("DO 读取失败返回固定错误码，不泄露异常细节", async () => {
    const failing = { ...environment(), HAKO_ACCOUNT: { getByName: () => { throw new Error("synthetic storage failure"); } } };
    const response = await handleApiRequest(request(), failing, { now: () => now });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "backup_status_unavailable" });
  });
});
