// workerd 集成验收专用的测试 Worker 入口（不参与生产构建）。
// 复用生产的 HakoAccountDurableObject 与 /api 路由，另提供最小测试控制面：
// - /test/session：按登录事务合同创建合成会话并返回账号标识；
// - /test/fault、/test/storage-fault、/test/schedule：配置 R2/存储故障与测试节奏；
// - /test/debug/*：只读检查 alarm 与备份状态表。
// R2 故障代理与存储代理只存在于本入口；生产 DO 类不包含任何测试钩子。

import { HakoAccountDurableObject } from "../../src/worker/account-durable-object";
import type { BackupSchedulePolicy } from "../../src/worker/backup/backup-schedule";
import { PRODUCTION_BACKUP_SCHEDULE } from "../../src/worker/backup/backup-schedule";
import { handleApiRequest } from "../../src/worker/api";
import { hashSecret } from "../../src/worker/auth/secrets";
import { HAKO_ACCOUNT_OBJECT_NAME } from "../../src/worker/auth/account-rpc";

// ---------------------------------------------------------------------------
// 测试节奏与故障配置（模块级；fetch 处理器与 DO 同一 isolate 共享）。
// ---------------------------------------------------------------------------

export const fastTestSchedule: BackupSchedulePolicy = {
  windowMs: 300,
  retryDelaysMs: [300, 1_000, 5_000, 10_000],
  hourlyRetryMs: 30_000,
  retentionCount: 30,
};

let scheduleOverride: BackupSchedulePolicy | null = null;

export interface R2FaultConfiguration {
  op: "put" | "get" | "list" | "delete";
  mode: "throw" | "hang" | "throw-after-write";
  once: boolean;
  skip: number;
}

let r2Fault: R2FaultConfiguration | null = null;

/** worker 侧 R2 调用计数：验证实际 A/B/DELETE 次数（DELETE 在 R2 计费中免费）。 */
const r2Counters = { put: 0, get: 0, list: 0, delete: 0 };

// ---------------------------------------------------------------------------
// SQL 计量（仅本测试入口）：包装 ctx.storage.sql，累计 workerd cursor 的
// rowsRead/rowsWritten；alarm 覆盖记录每个备份生命周期的精确用量。
// 生产 DO 类不含任何计量钩子；包装失败（对象不可配置）时 active=false。
// ---------------------------------------------------------------------------

export interface SqlMeterSnapshot {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
}

const sqlMeter: SqlMeterSnapshot & { active: boolean; incomplete: boolean } = {
  rowsRead: 0, rowsWritten: 0, statements: 0, active: false, incomplete: false,
};

/**
 * 调试/控制 SQL 单列计数器：debugExecSql（触发器注入、计量校准等显式测试 SQL）
 * 与业务计量来源隔离——同一业务的 alarm 差值不随调试/轮询频率或穿插的显式
 * 测试 SQL 变化；校准断言改以本计数器证明包装层计数机制（完整消费、每语句一次）。
 */
const debugSqlMeter: SqlMeterSnapshot & { incomplete: boolean } = {
  rowsRead: 0, rowsWritten: 0, statements: 0, incomplete: false,
};

let debugSqlMetering = false;

function withDebugSqlMetering<T>(closure: () => T): T {
  debugSqlMetering = true;
  try {
    return closure();
  } finally {
    debugSqlMetering = false;
  }
}

/**
 * 观测读取抑制：/test/debug 的轮询读取（alarm 与备份表 SELECT）不计入计量，
 * 使交错在 alarm 外部 I/O 期间的观测请求不改变生产流程的计量值。
 * 只抑制只读观测；debugExecSql（触发器/校准等显式测试 SQL）经
 * withDebugSqlMetering 单列到 debugSqlMeter，不进入业务计量。
 */
let observationMeteringSuppressed = false;

function withObservationMeteringSuppressed<T>(closure: () => T): T {
  observationMeteringSuppressed = true;
  try {
    return closure();
  } finally {
    observationMeteringSuppressed = false;
  }
}

/** 最近一次 alarm（即一个备份生命周期：捕获→发布→确认→保留收尾→重排）的用量。 */
let lastAlarmSqlUsage: SqlMeterSnapshot | null = null;

function installSqlMeter(state: DurableObjectState): void {
  const storage = state.storage as unknown as { sql: unknown };
  const originalSql = storage.sql;
  if (typeof originalSql !== "object" || originalSql === null) return;
  const meteredSql = new Proxy(originalSql, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "exec" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const cursor = value.apply(target, args) as {
          rowsRead?: number;
          rowsWritten?: number;
          toArray?: (...toArrayArgs: unknown[]) => unknown[];
        };
        if (observationMeteringSuppressed) return cursor;
        // 目标计数器在执行时确定（accumulate 在微任务里运行，标志可能已复位）。
        const meterTarget = debugSqlMetering ? debugSqlMeter : sqlMeter;
        // rowsRead 随游标消费逐步累计（官方 SQL API）：在游标被完整消费后取全量值。
        // 每个语句只累计一次：同步消费（toArray）完成即取；未消费的语句（写入类）
        // 在当前同步任务结束的微任务里取执行时值。累计异常显式标记计量不完整。
        let accumulated = false;
        const accumulate = (): void => {
          if (accumulated) return;
          accumulated = true;
          try {
            meterTarget.rowsRead += Number(cursor.rowsRead ?? 0);
            meterTarget.rowsWritten += Number(cursor.rowsWritten ?? 0);
            meterTarget.statements += 1;
          } catch {
            meterTarget.incomplete = true;
          }
        };
        queueMicrotask(accumulate);
        return new Proxy(cursor, {
          get(cursorTarget, cursorProperty) {
            const cursorValue = Reflect.get(cursorTarget, cursorProperty, cursorTarget);
            if (cursorProperty === "toArray" && typeof cursorValue === "function") {
              return (...toArrayArgs: unknown[]) => {
                const rows = cursorValue.apply(cursorTarget, toArrayArgs);
                accumulate();
                return rows;
              };
            }
            return cursorValue;
          },
        });
      };
    },
  });
  try {
    Object.defineProperty(storage, "sql", { configurable: true, get: () => meteredSql });
    sqlMeter.active = true;
  } catch {
    // workerd 存储对象不可配置：跳过计量，测试会因 active=false 显式失败。
  }
}


// ---------------------------------------------------------------------------
// 存储与 R2 代理：为真实 workerd 事务提供故障注入点。
// ---------------------------------------------------------------------------


function wrapR2Bucket(bucket: R2Bucket): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        if (property === "put" || property === "get" || property === "list" || property === "delete") {
          r2Counters[property] += 1;
        }
        if (r2Fault !== null && r2Fault.op === property) {
          if (r2Fault.skip > 0) {
            r2Fault.skip -= 1;
          } else {
            const mode = r2Fault.mode;
            if (r2Fault.once) r2Fault = null;
            if (mode === "throw") throw new Error(`injected r2 failure: ${property}`);
            if (mode === "hang") return new Promise(() => undefined);
            if (mode === "throw-after-write") {
              void Promise.resolve(value.apply(target, args)).catch(() => undefined);
              throw new Error(`injected r2 lost response: ${property}`);
            }
          }
        }
        return value.apply(target, args);
      };
    },
  });
}

// ---------------------------------------------------------------------------
// 测试 DO：覆盖节奏并加只读 debug 方法；生产类的持久语义不变。
// ---------------------------------------------------------------------------

class TestHakoAccountDurableObject extends HakoAccountDurableObject {
  constructor(state: DurableObjectState, env: Env) {
    // 计量包装必须在 super() 之前：生产构造即执行幂等建表 SQL。
    installSqlMeter(state);
    super(state, {
      ...env,
      HAKO_BACKUPS: wrapR2Bucket(env.HAKO_BACKUPS),
    } as Env);
  }

  protected resolveBackupSchedule(): BackupSchedulePolicy {
    return scheduleOverride ?? PRODUCTION_BACKUP_SCHEDULE;
  }

  /** 记录本次 alarm（一个备份生命周期）的 SQL 用量，供 /test/sql-meter 读取。 */
  async alarm(): Promise<void> {
    const before: SqlMeterSnapshot = {
      rowsRead: sqlMeter.rowsRead,
      rowsWritten: sqlMeter.rowsWritten,
      statements: sqlMeter.statements,
    };
    try {
      await super.alarm();
    } finally {
      // 冲刷未消费游标的计量微任务后再取差值，避免漏计最后一批语句。
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      lastAlarmSqlUsage = {
        rowsRead: sqlMeter.rowsRead - before.rowsRead,
        rowsWritten: sqlMeter.rowsWritten - before.rowsWritten,
        statements: sqlMeter.statements - before.statements,
      };
    }
  }

  async debugReadAlarm(): Promise<number | null> {
    return await this.ctx.storage.getAlarm();
  }

  async debugReadBackupRows(): Promise<Record<string, unknown>> {
    // 观测读取不计入计量（见 withObservationMeteringSuppressed）。
    const read = (query: string): unknown[] =>
      withObservationMeteringSuppressed(() => this.ctx.storage.sql.exec(query).toArray());
    return {
      cursor: read("SELECT * FROM backup_cursor"),
      task: read("SELECT * FROM backup_frozen_task"),
      completions: read("SELECT revision FROM backup_completions ORDER BY revision"),
      plan: read("SELECT revision, marker_deleted FROM backup_prune_plan ORDER BY revision"),
      retention: read("SELECT pending_revision FROM backup_retention_check"),
    };
  }

  /**
   * 测试专用 SQL 执行：安装/删除触发器注入存储故障、模拟元数据回退等。
   * 存储故障用真实 SQLite 触发器注入；事务回滚与持久性由真实 workerd 保证。
   */
  async debugExecSql(query: string): Promise<unknown[]> {
    return withDebugSqlMetering(() => this.ctx.storage.sql.exec(query).toArray());
  }
}

export { TestHakoAccountDurableObject as HakoAccountDurableObject };

// ---------------------------------------------------------------------------
// 测试控制面与生产 /api 路由挂载。
// ---------------------------------------------------------------------------

const issuer = "https://auth.eruoo.me";

interface CreatedSession {
  token: string;
  accountId: string;
}

function isAccountIdFormat(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** 测试 DO 的 debug 方法面；生产类不包含这些方法。 */
interface DebugAccountStub {
  debugReadAlarm(): Promise<number | null>;
  debugReadBackupRows(): Promise<Record<string, unknown>>;
  debugExecSql(query: string): Promise<unknown[]>;
}

function debugStub(env: Env): DebugAccountStub {
  return env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME) as unknown as DebugAccountStub;
}

async function createSession(subject: string, env: Env): Promise<CreatedSession> {
  const stub = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
  const now = Date.now();
  const environmentId = `test-env-${subject}`;
  const state = `state-${crypto.randomUUID()}`;
  const completion = `completion-${crypto.randomUUID()}`;
  const token = `session-${crypto.randomUUID()}`;
  const sessionHash = await hashSecret(token);
  const identity = { issuer, subject };
  await stub.createLoginTransaction({
    environmentId,
    stateHash: await hashSecret(state),
    completionSecretHash: await hashSecret(completion),
    nonce: `nonce-${crypto.randomUUID()}`,
    codeVerifier: `verifier-${crypto.randomUUID()}`,
    createdAtMs: now,
    expiresAtMs: now + 600_000,
  });
  const consumed = await stub.consumeLoginTransaction({
    stateHash: await hashSecret(state),
    environmentId,
    completionSecretHash: await hashSecret(completion),
    nowMs: now,
  });
  if (consumed === null) throw new Error("test session transaction failed");
  const finalized = await stub.finalizeLoginTransaction({
    stateHash: await hashSecret(state),
    environmentId,
    nowMs: now,
    session: {
      sessionHash,
      issuer: identity.issuer,
      subject: identity.subject,
      createdAtMs: now,
      expiresAtMs: now + 180 * 86_400_000,
      absoluteExpiresAtMs: now + 365 * 86_400_000,
    },
  });
  if (!finalized) throw new Error("test session finalize failed");
  const accountId = await stub.readAccountId({ sessionHash, identity, nowMs: now });
  if (accountId === null) throw new Error("test session account id missing");
  return { token, accountId };
}

async function handleTestRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/test/session": {
      const subject = new URL(request.url).searchParams.get("subject") ?? "synthetic-owner";
      const session = await createSession(subject, env);
      return Response.json(session);
    }
    case "/test/schedule": {
      scheduleOverride = (await request.json()) as BackupSchedulePolicy | null;
      return Response.json({ ok: true });
    }
    case "/test/fault": {
      const body = await request.json() as R2FaultConfiguration | null;
      r2Fault = body;
      return Response.json({ ok: true });
    }
    case "/test/debug/sql": {
      const { query } = await request.json() as { query: string };
      return Response.json({ rows: await debugStub(env).debugExecSql(query) });
    }
    case "/test/bootstrap-direct": {
      // 直连 DO bootstrap：隔离测试的第二合成身份绕过固定 owner 路由。
      const url = new URL(request.url);
      const subject = url.searchParams.get("subject") ?? "";
      const token = url.searchParams.get("token") ?? "";
      const expectedAccountId = url.searchParams.get("account") ?? "";
      if (subject === "" || token === "" || !isAccountIdFormat(expectedAccountId)) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const stub = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
      const result = await stub.bootstrapRefueling({
        sessionHash: await hashSecret(token),
        identity: { issuer, subject },
        nowMs: Date.now(),
        expectedAccountId,
      });
      if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 409 });
      return Response.json({
        documentGeneration: result.documentGeneration,
        legacyGeneration: result.legacyGeneration,
      });
    }
    case "/test/sync-direct": {
      // 绕过路由层固定 owner 校验直连 DO：隔离测试需要第二合成身份。
      // 认证边界本身由生产路由与既有回归测试覆盖。
      const url = new URL(request.url);
      const subject = url.searchParams.get("subject") ?? "";
      const token = url.searchParams.get("token") ?? "";
      const expectedAccountId = url.searchParams.get("account") ?? "";
      const generation = url.searchParams.get("generation") ?? "";
      if (subject === "" || token === "" || !isAccountIdFormat(expectedAccountId)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation)) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const stub = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
      const snapshot = new Uint8Array(await request.arrayBuffer());
      const result = await stub.syncRefueling({
        sessionHash: await hashSecret(token),
        identity: { issuer, subject },
        nowMs: Date.now(),
        expectedAccountId,
        documentGeneration: generation,
        snapshot,
      });
      if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 409 });
      return new Response(new Uint8Array(result.snapshot), {
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Hako-Document-Generation": result.documentGeneration,
          "X-Hako-Revision": String(result.revision),
        },
      });
    }
    case "/test/debug/r2-counters": {
      return Response.json(r2Counters);
    }
    case "/test/sql-meter": {
      // 只读返回累计计量与最近一次备份生命周期（alarm）的用量；
      // incomplete=true 表示出现过累计异常，计量结果不可作为准确值采纳。
      return Response.json({
        active: sqlMeter.active,
        incomplete: sqlMeter.incomplete,
        totals: { rowsRead: sqlMeter.rowsRead, rowsWritten: sqlMeter.rowsWritten, statements: sqlMeter.statements },
        lastAlarm: lastAlarmSqlUsage,
        debugIncomplete: debugSqlMeter.incomplete,
        debugTotals: { rowsRead: debugSqlMeter.rowsRead, rowsWritten: debugSqlMeter.rowsWritten, statements: debugSqlMeter.statements },
      });
    }
    case "/test/debug/state": {
      const stub = debugStub(env);
      return Response.json({
        alarm: await stub.debugReadAlarm(),
        rows: await stub.debugReadBackupRows(),
      });
    }
    default:
      return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return await handleApiRequest(request, env);
    }
    if (pathname.startsWith("/test/")) {
      return await handleTestRequest(request, env);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
