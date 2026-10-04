// 账号级服务端状态的逻辑层：登录事务与本应用会话都持久保存在 SQLite Durable Object 中，
// 由 HakoAccountDurableObject 暴露为 RPC 方法。把 SQL 与规则放在这里，便于用
// 受控时钟和真实 SQLite 语义做验证；DO 类只负责运行时接线。
//
// 状态变更都在 storage.transactionSync 内完成：过期、单次消费、完成、续期、撤销是原子的，
// 并发续期不会缩短已保存的有效期，撤销后不会被在途续期重新创建。
//
// 登录事务的两阶段语义：
// 1. consumeLoginTransaction 在回调到达时原子标记 consumed_at 并取出 nonce/verifier；
//    OIDC 网络兑换发生在这一步之后。
// 2. finalizeLoginTransaction 在身份验证成功后，把“事务删除 + 会话插入”放在同一事务里；
//    退出或同环境重新发起会删除该事务，因此在途登录无法再建立会话。

export type AccountStateSqlValue = ArrayBuffer | string | number | null;
export type AccountStateRow = Record<string, AccountStateSqlValue>;
export type AccountStateBinding = ArrayBuffer | string | number | null;

export interface AccountStateSqlCursor<T extends AccountStateRow> {
  toArray(): T[];
}

/** 本模块使用的 SQL 存储子集；Durable Object 的 ctx.storage.sql 结构兼容。 */
export interface AccountStateSqlStorage {
  exec<T extends AccountStateRow = AccountStateRow>(
    query: string,
    ...bindings: AccountStateBinding[]
  ): AccountStateSqlCursor<T>;
}

/** 本模块使用的 Durable Object 存储子集；Durable Object 的 ctx.storage 结构兼容。 */
export interface AccountStateStorage {
  readonly sql: AccountStateSqlStorage;
  transactionSync<T>(closure: () => T): T;
}

/**
 * Durable Object 运行时存储子集：在 `transaction()`（异步事务）内执行的 SQL 语句、
 * `transactionSync` 嵌套以及 alarm 安排会共同提交或一起回滚（已由本地 workerd 探针验证）。
 * 同步路径（登录事务、会话续期）继续只依赖 `AccountStateStorage`。
 */
export interface AccountDurableStorage extends AccountStateStorage {
  /** 闭包必须为异步函数；事务内只允许 storage 操作，不等待 R2 等外部 I/O。 */
  transaction<T>(closure: () => Promise<T>): Promise<T>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/** 会话绑定的固定身份键（规格第 4.2 节：固定 issuer 与稳定 sub 的组合）。 */
export interface HakoIdentity {
  issuer: string;
  subject: string;
}

export interface LoginTransactionInput {
  /** 发起登录的浏览器环境标识；同一环境重新发起会使其旧事务失效。 */
  environmentId: string;
  /** 授权响应 state 的哈希；state 只用于定位和校验 OAuth 事务。 */
  stateHash: string;
  /** 事务 Cookie 凭据的哈希；领取 Hako 会话必须同时匹配它和 state。 */
  completionSecretHash: string;
  /** ID token 必须包含的 nonce。 */
  nonce: string;
  /** PKCE code_verifier，兑换授权码时使用。 */
  codeVerifier: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** 单次消费成功后返回的兑换输入；此时事务已标记消费，不能再次开始兑换。 */
export interface ConsumedLoginTransaction {
  nonce: string;
  codeVerifier: string;
}

export interface ConsumeLoginTransactionInput {
  stateHash: string;
  environmentId: string;
  completionSecretHash: string;
  nowMs: number;
}

export interface HakoSessionRecord {
  sessionHash: string;
  issuer: string;
  subject: string;
  createdAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
  absoluteExpiresAtMs: number;
}

export interface CreateHakoSessionInput {
  sessionHash: string;
  issuer: string;
  subject: string;
  createdAtMs: number;
  expiresAtMs: number;
  absoluteExpiresAtMs: number;
}

/** 完成登录：删除事务并插入会话，两步在同一个 SQLite 事务内。 */
export interface FinalizeLoginTransactionInput {
  stateHash: string;
  environmentId: string;
  nowMs: number;
  session: CreateHakoSessionInput;
}

export interface RenewHakoSessionInput {
  sessionHash: string;
  identity: HakoIdentity;
  nowMs: number;
  sessionTtlMs: number;
  renewalIntervalMs: number;
}

export interface RenewedHakoSession {
  session: HakoSessionRecord;
  /** 本次调用是否实际延长了有效期（未到续期间隔或已到绝对上限时为 false）。 */
  renewed: boolean;
}

interface LoginTransactionRow extends AccountStateRow {
  nonce: string;
  code_verifier: string;
  expires_at: number;
  consumed_at: number | null;
}

interface SessionRow extends AccountStateRow {
  session_hash: string;
  issuer: string;
  subject: string;
  created_at: number;
  renewed_at: number;
  expires_at: number;
  absolute_expires_at: number;
}

/**
 * SQLite 幂等建表；Durable Object 首次实例化和测试都走同一份 schema。
 * 表已存在但缺少后续新增列时补列（列有默认值，旧行不会匹配现配置身份或被消费）。
 */
export function migrateAccountState(storage: AccountStateStorage): void {
  const { sql } = storage;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS login_transactions (
       state_hash TEXT PRIMARY KEY,
       environment_id TEXT NOT NULL,
       completion_secret_hash TEXT NOT NULL,
       nonce TEXT NOT NULL,
       code_verifier TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       consumed_at INTEGER
     )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS login_transactions_by_environment
       ON login_transactions (environment_id)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS sessions (
       session_hash TEXT PRIMARY KEY,
       issuer TEXT NOT NULL DEFAULT '',
       subject TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       renewed_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       absolute_expires_at INTEGER NOT NULL,
       revoked_at INTEGER
     )`,
  );
  ensureColumn(storage, "login_transactions", "consumed_at", "INTEGER");
  ensureColumn(storage, "sessions", "issuer", "TEXT NOT NULL DEFAULT ''");
}

function ensureColumn(
  storage: AccountStateStorage,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = storage.sql.exec<AccountStateRow & { name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (columns.some((entry) => entry.name === column)) return;
  storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export class HakoAccountState {
  constructor(private readonly storage: AccountStateStorage) {
    migrateAccountState(storage);
  }

  /**
   * 创建登录事务；同一环境的未完成或在途事务先失效（重新发起登录），
   * 并清理已过期的事务行。
   */
  createLoginTransaction(input: LoginTransactionInput): void {
    this.storage.transactionSync(() => {
      const { sql } = this.storage;
      sql.exec("DELETE FROM login_transactions WHERE expires_at <= ?", input.createdAtMs);
      sql.exec("DELETE FROM login_transactions WHERE environment_id = ?", input.environmentId);
      sql.exec(
        `INSERT INTO login_transactions
           (state_hash, environment_id, completion_secret_hash, nonce, code_verifier, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        input.stateHash,
        input.environmentId,
        input.completionSecretHash,
        input.nonce,
        input.codeVerifier,
        input.createdAtMs,
        input.expiresAtMs,
      );
    });
  }

  /**
   * 原子消费登录事务：state、发起环境凭据哈希、有效期必须同时匹配且尚未消费；
   * 消费成功后事务保留到 finalize 或过期，迟到/重复回调无法再次兑换授权码。
   */
  consumeLoginTransaction(input: ConsumeLoginTransactionInput): ConsumedLoginTransaction | null {
    return this.storage.transactionSync(() => {
      const { sql } = this.storage;
      const rows = sql
        .exec<LoginTransactionRow>(
          `SELECT * FROM login_transactions
            WHERE state_hash = ? AND environment_id = ? AND completion_secret_hash = ?`,
          input.stateHash,
          input.environmentId,
          input.completionSecretHash,
        )
        .toArray();
      const row = rows[0];
      if (row === undefined) return null;
      if (row.consumed_at !== null) return null;
      if (row.expires_at <= input.nowMs) return null;
      sql.exec(
        "UPDATE login_transactions SET consumed_at = ? WHERE state_hash = ?",
        input.nowMs,
        input.stateHash,
      );
      return {
        nonce: row.nonce,
        codeVerifier: row.code_verifier,
      };
    });
  }

  /**
   * 完成登录：只有在事务仍处于“已消费未完成”且未过期时，才在同一事务里删除它并
   * 插入会话。退出或同环境重新发起已删除的事务返回 false，不建立会话。
   */
  finalizeLoginTransaction(input: FinalizeLoginTransactionInput): boolean {
    return this.storage.transactionSync(() => {
      const { sql } = this.storage;
      const rows = sql
        .exec<AccountStateRow>(
          `SELECT state_hash FROM login_transactions
            WHERE state_hash = ? AND environment_id = ? AND consumed_at IS NOT NULL AND expires_at > ?`,
          input.stateHash,
          input.environmentId,
          input.nowMs,
        )
        .toArray();
      if (rows[0] === undefined) return false;
      sql.exec("DELETE FROM login_transactions WHERE state_hash = ?", input.stateHash);
      sql.exec(
        `INSERT INTO sessions
           (session_hash, issuer, subject, created_at, renewed_at, expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        input.session.sessionHash,
        input.session.issuer,
        input.session.subject,
        input.session.createdAtMs,
        input.session.createdAtMs,
        input.session.expiresAtMs,
        input.session.absoluteExpiresAtMs,
      );
      return true;
    });
  }

  /** 取消指定环境的未完成与在途事务（退出登录时使用）。 */
  revokeEnvironmentTransactions(environmentId: string): void {
    this.storage.sql.exec(
      "DELETE FROM login_transactions WHERE environment_id = ?",
      environmentId,
    );
  }

  /** 读取仍然有效的会话；必须同时匹配固定 issuer 与 sub，过期、退出或撤销的都返回 null。 */
  readSession(input: {
    sessionHash: string;
    identity: HakoIdentity;
    nowMs: number;
  }): HakoSessionRecord | null {
    return this.selectActiveSession(input.sessionHash, input.identity, input.nowMs);
  }

  /**
   * 续期能力（供未来已授权的前台同步请求复用，本 PR 不提供独立保活端点）：
   * 身份必须匹配；只有有效会话、距上次成功续期达到间隔、且未到绝对上限时才会延长；
   * 取“当前时间加 180 天”与“创建时间加 365 天”中较早者，绝不缩短已保存的有效期。
   */
  renewSessionIfDue(input: RenewHakoSessionInput): RenewedHakoSession | null {
    return this.storage.transactionSync(() => {
      const session = this.selectActiveSession(input.sessionHash, input.identity, input.nowMs);
      if (session === null) return null;
      const due = session.renewedAtMs + input.renewalIntervalMs <= input.nowMs;
      if (!due) return { session, renewed: false };
      const proposedExpiresAtMs = Math.min(
        input.nowMs + input.sessionTtlMs,
        session.absoluteExpiresAtMs,
      );
      if (proposedExpiresAtMs <= session.expiresAtMs) return { session, renewed: false };
      this.storage.sql.exec(
        "UPDATE sessions SET expires_at = ?, renewed_at = ? WHERE session_hash = ?",
        proposedExpiresAtMs,
        input.nowMs,
        input.sessionHash,
      );
      return {
        session: { ...session, expiresAtMs: proposedExpiresAtMs, renewedAtMs: input.nowMs },
        renewed: true,
      };
    });
  }

  /** 撤销当前会话；已撤销或过期的会话保持失效，不会被重新创建。 */
  revokeSession(input: { sessionHash: string; nowMs: number }): void {
    this.storage.sql.exec(
      "UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
      input.nowMs,
      input.sessionHash,
    );
  }

  private selectActiveSession(
    sessionHash: string,
    identity: HakoIdentity,
    nowMs: number,
  ): HakoSessionRecord | null {
    const rows = this.storage.sql
      .exec<SessionRow>(
        `SELECT * FROM sessions
          WHERE session_hash = ? AND issuer = ? AND subject = ?
            AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?`,
        sessionHash,
        identity.issuer,
        identity.subject,
        nowMs,
        nowMs,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      sessionHash: row.session_hash,
      issuer: row.issuer,
      subject: row.subject,
      createdAtMs: row.created_at,
      renewedAtMs: row.renewed_at,
      expiresAtMs: row.expires_at,
      absoluteExpiresAtMs: row.absolute_expires_at,
    };
  }
}
