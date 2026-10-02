// 账号状态（SQLite Durable Object 逻辑层）语义测试：使用真实 SQLite 与受控时钟，
// 覆盖登录事务的消费/完成/在途取消、会话期限（24 小时续期、180 天有效期、
// 365 天绝对上限）、固定身份绑定、撤销、并发续期不缩短有效期、schema 补列，
// 以及重开数据库后从持久化状态恢复。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestAccount, NodeSqliteAccountStorage } from "./helpers/account-state-sqlite";
import type { TestAccount } from "./helpers/account-state-sqlite";
import { HakoAccountState } from "../src/worker/auth/account-state";
import type { HakoSessionRecord } from "../src/worker/auth/account-state";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_RENEWAL_INTERVAL_MS,
  SESSION_TTL_MS,
} from "../src/worker/auth/session-policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-02T00:00:00.000Z");
const ISSUER = "https://auth.eruoo.me";
const OWNER = "owner-subject";
const IDENTITY = { issuer: ISSUER, subject: OWNER };

let openAccounts: TestAccount[] = [];
let tempDirectories: string[] = [];

function account(path = ":memory:"): TestAccount {
  const created = createTestAccount(path);
  openAccounts.push(created);
  return created;
}

afterEach(() => {
  for (const entry of openAccounts) {
    try {
      entry.database.close();
    } catch {
      // 已在测试中关闭
    }
  }
  openAccounts = [];
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories = [];
});

/** 通过真实的消费 + 完成路径建立会话，避免测试绕过会话身份的持久化入口。 */
function completeLogin(
  testAccount: TestAccount,
  options: {
    state?: string;
    environmentId?: string;
    sessionHash?: string;
    subject?: string;
    issuer?: string;
    createdAtMs?: number;
  } = {},
): boolean {
  const state = options.state ?? "state-hash";
  const environmentId = options.environmentId ?? "env-1";
  testAccount.state.createLoginTransaction({
    environmentId,
    stateHash: state,
    completionSecretHash: "secret-hash",
    nonce: "nonce-1",
    codeVerifier: "verifier-1",
    createdAtMs: T0,
    expiresAtMs: T0 + 600_000,
  });
  const consumed = testAccount.state.consumeLoginTransaction({
    stateHash: state,
    environmentId,
    completionSecretHash: "secret-hash",
    nowMs: T0,
  });
  if (consumed === null) throw new Error("测试事务未能消费");
  const createdAtMs = options.createdAtMs ?? T0;
  return testAccount.state.finalizeLoginTransaction({
    stateHash: state,
    environmentId,
    nowMs: createdAtMs,
    session: {
      sessionHash: options.sessionHash ?? "session-hash-1",
      issuer: options.issuer ?? ISSUER,
      subject: options.subject ?? OWNER,
      createdAtMs,
      expiresAtMs: createdAtMs + SESSION_TTL_MS,
      absoluteExpiresAtMs: createdAtMs + SESSION_ABSOLUTE_TTL_MS,
    },
  });
}

function readSession(
  testAccount: TestAccount,
  sessionHash = "session-hash-1",
  nowMs = T0 + DAY_MS,
  identity = IDENTITY,
): HakoSessionRecord | null {
  return testAccount.state.readSession({ sessionHash, identity, nowMs });
}

describe("登录事务", () => {
  it("按 state 与环境凭据消费一次，重复消费失败", () => {
    const { state } = account();
    state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-hash",
      completionSecretHash: "secret-hash",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });

    const consumed = state.consumeLoginTransaction({
      stateHash: "state-hash",
      environmentId: "env-1",
      completionSecretHash: "secret-hash",
      nowMs: T0 + 1000,
    });
    expect(consumed).toEqual({ nonce: "nonce-1", codeVerifier: "verifier-1" });

    // 已消费的事务不能被再次消费（重复回调不能重新兑换 code）
    expect(
      state.consumeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        completionSecretHash: "secret-hash",
        nowMs: T0 + 2000,
      }),
    ).toBeNull();
  });

  it("凭据哈希不符或环境不符都不消费，且不破坏原事务", () => {
    const { state } = account();
    state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-hash",
      completionSecretHash: "secret-hash",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    for (const input of [
      { environmentId: "env-1", completionSecretHash: "other-secret" },
      { environmentId: "env-other", completionSecretHash: "secret-hash" },
    ]) {
      expect(
        state.consumeLoginTransaction({
          stateHash: "state-hash",
          nowMs: T0 + 1000,
          ...input,
        }),
      ).toBeNull();
    }
    // 失败尝试不消耗事务，原环境仍可正常完成
    expect(
      state.consumeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        completionSecretHash: "secret-hash",
        nowMs: T0 + 2000,
      }),
    ).not.toBeNull();
  });

  it("过期事务不能被消费或完成", () => {
    const { state } = account();
    state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-hash",
      completionSecretHash: "secret-hash",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    expect(
      state.consumeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        completionSecretHash: "secret-hash",
        nowMs: T0 + 600_001,
      }),
    ).toBeNull();
    expect(
      state.finalizeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        nowMs: T0 + 600_001,
        session: {
          sessionHash: "session-hash-1",
          issuer: ISSUER,
          subject: OWNER,
          createdAtMs: T0,
          expiresAtMs: T0 + SESSION_TTL_MS,
          absoluteExpiresAtMs: T0 + SESSION_ABSOLUTE_TTL_MS,
        },
      }),
    ).toBe(false);
  });

  it("未消费的事务不能直接完成", () => {
    const { state } = account();
    state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-hash",
      completionSecretHash: "secret-hash",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    expect(
      state.finalizeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        nowMs: T0,
        session: {
          sessionHash: "session-hash-1",
          issuer: ISSUER,
          subject: OWNER,
          createdAtMs: T0,
          expiresAtMs: T0 + SESSION_TTL_MS,
          absoluteExpiresAtMs: T0 + SESSION_ABSOLUTE_TTL_MS,
        },
      }),
    ).toBe(false);
  });

  it("同一事务只能完成一次，重复完成返回 false 且不产生第二个会话", () => {
    const testAccount = account();
    expect(completeLogin(testAccount)).toBe(true);
    // 首次完成已删除该事务；重复完成使用新的会话凭据也不能再建立会话
    expect(
      testAccount.state.finalizeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        nowMs: T0 + 1000,
        session: {
          sessionHash: "session-hash-2",
          issuer: ISSUER,
          subject: OWNER,
          createdAtMs: T0 + 1000,
          expiresAtMs: T0 + 1000 + SESSION_TTL_MS,
          absoluteExpiresAtMs: T0 + 1000 + SESSION_ABSOLUTE_TTL_MS,
        },
      }),
    ).toBe(false);
    const count = testAccount.database
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .all() as Array<{ count: number }>;
    expect(count[0].count).toBe(1);
  });

  it("退出使在途（已消费未完成）登录无法建立会话", () => {
    const testAccount = account();
    const { state } = testAccount;
    state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-hash",
      completionSecretHash: "secret-hash",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    // 回调已消费事务，OIDC 兑换在途
    expect(
      state.consumeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        completionSecretHash: "secret-hash",
        nowMs: T0 + 1000,
      }),
    ).not.toBeNull();
    // 同一环境退出登录
    state.revokeEnvironmentTransactions("env-1");
    expect(
      state.finalizeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        nowMs: T0 + 2000,
        session: {
          sessionHash: "session-hash-1",
          issuer: ISSUER,
          subject: OWNER,
          createdAtMs: T0 + 2000,
          expiresAtMs: T0 + 2000 + SESSION_TTL_MS,
          absoluteExpiresAtMs: T0 + 2000 + SESSION_ABSOLUTE_TTL_MS,
        },
      }),
    ).toBe(false);
    const count = testAccount.database
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .all() as Array<{ count: number }>;
    expect(count[0].count).toBe(0);
  });

  it("同环境重新发起使在途事务失效", () => {
    const testAccount = account();
    const { state } = testAccount;
    state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-old",
      completionSecretHash: "secret-old",
      nonce: "nonce-old",
      codeVerifier: "verifier-old",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    expect(
      state.consumeLoginTransaction({
        stateHash: "state-old",
        environmentId: "env-1",
        completionSecretHash: "secret-old",
        nowMs: T0 + 1000,
      }),
    ).not.toBeNull();

    state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-new",
      completionSecretHash: "secret-new",
      nonce: "nonce-new",
      codeVerifier: "verifier-new",
      createdAtMs: T0 + 2000,
      expiresAtMs: T0 + 600_000,
    });
    expect(
      state.finalizeLoginTransaction({
        stateHash: "state-old",
        environmentId: "env-1",
        nowMs: T0 + 3000,
        session: {
          sessionHash: "session-hash-1",
          issuer: ISSUER,
          subject: OWNER,
          createdAtMs: T0 + 3000,
          expiresAtMs: T0 + 3000 + SESSION_TTL_MS,
          absoluteExpiresAtMs: T0 + 3000 + SESSION_ABSOLUTE_TTL_MS,
        },
      }),
    ).toBe(false);
    // 新事务仍可正常消费
    expect(
      state.consumeLoginTransaction({
        stateHash: "state-new",
        environmentId: "env-1",
        completionSecretHash: "secret-new",
        nowMs: T0 + 3000,
      }),
    ).not.toBeNull();
  });

  it("创建新事务时清理已过期事务", () => {
    const testAccount = account();
    const { state } = testAccount;
    state.createLoginTransaction({
      environmentId: "env-expired",
      stateHash: "state-expired",
      completionSecretHash: "secret-expired",
      nonce: "nonce",
      codeVerifier: "verifier",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    state.createLoginTransaction({
      environmentId: "env-2",
      stateHash: "state-2",
      completionSecretHash: "secret-2",
      nonce: "nonce",
      codeVerifier: "verifier",
      createdAtMs: T0 + 600_001,
      expiresAtMs: T0 + 1_200_000,
    });
    const rows = testAccount.database
      .prepare("SELECT state_hash FROM login_transactions")
      .all() as Array<{ state_hash: string }>;
    expect(rows.map((row) => row.state_hash)).toEqual(["state-2"]);
  });
});

describe("本应用会话", () => {
  it("180 天内有效，超过有效期或绝对上限不再有效", () => {
    const testAccount = account();
    expect(completeLogin(testAccount)).toBe(true);
    expect(readSession(testAccount)).not.toBeNull();
    expect(readSession(testAccount, "session-hash-1", T0 + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(readSession(testAccount, "session-hash-1", T0 + SESSION_TTL_MS)).toBeNull();
    expect(readSession(testAccount, "session-hash-1", T0 + SESSION_ABSOLUTE_TTL_MS)).toBeNull();
  });

  it("会话必须与固定 issuer 和 owner 主体匹配", () => {
    const testAccount = account();
    expect(completeLogin(testAccount)).toBe(true);
    expect(readSession(testAccount, "session-hash-1", T0 + DAY_MS, IDENTITY)).not.toBeNull();
    // 配置的 owner 主体或 issuer 变化后，旧会话不再被视为已登录
    expect(
      readSession(testAccount, "session-hash-1", T0 + DAY_MS, {
        issuer: ISSUER,
        subject: "another-owner",
      }),
    ).toBeNull();
    expect(
      readSession(testAccount, "session-hash-1", T0 + DAY_MS, {
        issuer: "https://staging.auth.example",
        subject: OWNER,
      }),
    ).toBeNull();
    expect(
      testAccount.state.renewSessionIfDue({
        sessionHash: "session-hash-1",
        identity: { issuer: ISSUER, subject: "another-owner" },
        nowMs: T0 + DAY_MS,
        sessionTtlMs: SESSION_TTL_MS,
        renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
      }),
    ).toBeNull();
  });

  it("续期需要距上次成功续期满 24 小时", () => {
    const testAccount = account();
    expect(completeLogin(testAccount)).toBe(true);
    const tooEarly = testAccount.state.renewSessionIfDue({
      sessionHash: "session-hash-1",
      identity: IDENTITY,
      nowMs: T0 + SESSION_RENEWAL_INTERVAL_MS - 1,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    expect(tooEarly?.renewed).toBe(false);
    expect(tooEarly?.session.expiresAtMs).toBe(T0 + SESSION_TTL_MS);

    const due = testAccount.state.renewSessionIfDue({
      sessionHash: "session-hash-1",
      identity: IDENTITY,
      nowMs: T0 + SESSION_RENEWAL_INTERVAL_MS,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    expect(due?.renewed).toBe(true);
    expect(due?.session.expiresAtMs).toBe(T0 + SESSION_TTL_MS + SESSION_RENEWAL_INTERVAL_MS);
    expect(due?.session.renewedAtMs).toBe(T0 + SESSION_RENEWAL_INTERVAL_MS);
  });

  it("续期绝不缩短已保存的有效期，也不越过 365 天绝对上限", () => {
    const testAccount = account();
    expect(completeLogin(testAccount)).toBe(true);
    const first = testAccount.state.renewSessionIfDue({
      sessionHash: "session-hash-1",
      identity: IDENTITY,
      nowMs: T0 + 179 * DAY_MS,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    expect(first?.session.expiresAtMs).toBe(T0 + 359 * DAY_MS);

    const second = testAccount.state.renewSessionIfDue({
      sessionHash: "session-hash-1",
      identity: IDENTITY,
      nowMs: T0 + 200 * DAY_MS,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    expect(second?.renewed).toBe(true);
    expect(second?.session.expiresAtMs).toBe(T0 + SESSION_ABSOLUTE_TTL_MS);

    const third = testAccount.state.renewSessionIfDue({
      sessionHash: "session-hash-1",
      identity: IDENTITY,
      nowMs: T0 + 240 * DAY_MS,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    expect(third?.renewed).toBe(false);
    expect(third?.session.expiresAtMs).toBe(T0 + SESSION_ABSOLUTE_TTL_MS);
  });

  it("被撤销或过期的会话不能续期", () => {
    const testAccount = account();
    expect(completeLogin(testAccount)).toBe(true);
    testAccount.state.revokeSession({ sessionHash: "session-hash-1", nowMs: T0 + 1000 });
    expect(
      testAccount.state.renewSessionIfDue({
        sessionHash: "session-hash-1",
        identity: IDENTITY,
        nowMs: T0 + SESSION_RENEWAL_INTERVAL_MS,
        sessionTtlMs: SESSION_TTL_MS,
        renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
      }),
    ).toBeNull();
    expect(readSession(testAccount, "session-hash-1", T0 + 1000)).toBeNull();

    const expired = account();
    expect(completeLogin(expired)).toBe(true);
    expect(
      expired.state.renewSessionIfDue({
        sessionHash: "session-hash-1",
        identity: IDENTITY,
        nowMs: T0 + SESSION_TTL_MS + DAY_MS,
        sessionTtlMs: SESSION_TTL_MS,
        renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
      }),
    ).toBeNull();
  });

  it("退出后到达的续期不会复活会话", () => {
    const testAccount = account();
    expect(completeLogin(testAccount)).toBe(true);
    // 在途请求先读到有效会话，随后退出完成，续期才落库
    const inFlight = readSession(testAccount, "session-hash-1", T0 + 1000);
    expect(inFlight).not.toBeNull();
    testAccount.state.revokeSession({ sessionHash: "session-hash-1", nowMs: T0 + 2000 });
    expect(
      testAccount.state.renewSessionIfDue({
        sessionHash: "session-hash-1",
        identity: IDENTITY,
        nowMs: T0 + 2000,
        sessionTtlMs: SESSION_TTL_MS,
        renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
      }),
    ).toBeNull();
    expect(readSession(testAccount, "session-hash-1", T0 + 3000)).toBeNull();
  });
});

describe("持久化、重启恢复与 schema 迁移", () => {
  it("重开同一 SQLite 文件后事务与会话仍可读取", () => {
    const directory = mkdtempSync(join(tmpdir(), "hako-account-state-"));
    tempDirectories.push(directory);
    const path = join(directory, "account.sqlite");

    const first = createTestAccount(path);
    expect(completeLogin(first)).toBe(true);
    first.state.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-hash",
      completionSecretHash: "secret-hash",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    first.database.close();

    const reopened = account(path);
    expect(readSession(reopened)).not.toBeNull();
    const consumed = reopened.state.consumeLoginTransaction({
      stateHash: "state-hash",
      environmentId: "env-1",
      completionSecretHash: "secret-hash",
      nowMs: T0 + 1000,
    });
    expect(consumed?.codeVerifier).toBe("verifier-1");
    // 重启不改变到期判断与身份匹配
    expect(readSession(reopened, "session-hash-1", T0 + SESSION_TTL_MS)).toBeNull();
    expect(
      readSession(reopened, "session-hash-1", T0 + DAY_MS, { issuer: ISSUER, subject: "other" }),
    ).toBeNull();
  });

  it("旧 schema（无 issuer / consumed_at）自动补列，旧会话按身份不匹配失效", () => {
    const directory = mkdtempSync(join(tmpdir(), "hako-account-state-old-"));
    tempDirectories.push(directory);
    const path = join(directory, "old.sqlite");

    // 模拟 PR2 早期版本创建的库：缺少 sessions.issuer 与 login_transactions.consumed_at
    const legacy = new DatabaseSync(path);
    legacy.exec(
      `CREATE TABLE sessions (
         session_hash TEXT PRIMARY KEY,
         subject TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         renewed_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         absolute_expires_at INTEGER NOT NULL,
         revoked_at INTEGER
       )`,
    );
    legacy.exec(
      `CREATE TABLE login_transactions (
         state_hash TEXT PRIMARY KEY,
         environment_id TEXT NOT NULL,
         completion_secret_hash TEXT NOT NULL,
         nonce TEXT NOT NULL,
         code_verifier TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
    legacy
      .prepare(
        `INSERT INTO sessions
           (session_hash, subject, created_at, renewed_at, expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run("legacy-session", OWNER, T0, T0, T0 + SESSION_TTL_MS, T0 + SESSION_ABSOLUTE_TTL_MS);
    legacy.close();

    const upgraded = new HakoAccountState(new NodeSqliteAccountStorage(new DatabaseSync(path)));
    // 旧会话没有 issuer，不再匹配固定身份
    expect(
      upgraded.readSession({ sessionHash: "legacy-session", identity: IDENTITY, nowMs: T0 + DAY_MS }),
    ).toBeNull();
    // 补列后新事务仍可正常消费与完成
    upgraded.createLoginTransaction({
      environmentId: "env-1",
      stateHash: "state-hash",
      completionSecretHash: "secret-hash",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      createdAtMs: T0,
      expiresAtMs: T0 + 600_000,
    });
    expect(
      upgraded.consumeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        completionSecretHash: "secret-hash",
        nowMs: T0 + 1000,
      }),
    ).not.toBeNull();
    expect(
      upgraded.finalizeLoginTransaction({
        stateHash: "state-hash",
        environmentId: "env-1",
        nowMs: T0 + 1000,
        session: {
          sessionHash: "session-hash-2",
          issuer: ISSUER,
          subject: OWNER,
          createdAtMs: T0 + 1000,
          expiresAtMs: T0 + 1000 + SESSION_TTL_MS,
          absoluteExpiresAtMs: T0 + 1000 + SESSION_ABSOLUTE_TTL_MS,
        },
      }),
    ).toBe(true);
  });
});
