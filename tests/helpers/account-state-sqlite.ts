// 测试用账号状态实现：真实 SQLite（node:sqlite）承载与 Durable Object 相同的
// auth/account-state.ts 逻辑，按 RPC 合同暴露给路由层。
// 生产持久化仍由 workerd 中的 SQLite Durable Object 验证（见本地验证记录）。

import { DatabaseSync } from "node:sqlite";
import { HakoAccountState } from "../../src/worker/auth/account-state";
import type {
  AccountStateBinding,
  AccountStateRow,
  AccountStateSqlCursor,
  AccountStateSqlStorage,
  AccountStateStorage,
} from "../../src/worker/auth/account-state";
import type {
  HakoAccountStub,
  ReadHakoSessionInput,
  RevokeHakoSessionInput,
} from "../../src/worker/auth/account-rpc";
import type {
  ConsumedLoginTransaction,
  ConsumeLoginTransactionInput,
  FinalizeLoginTransactionInput,
  HakoSessionRecord,
  LoginTransactionInput,
  RenewedHakoSession,
  RenewHakoSessionInput,
} from "../../src/worker/auth/account-state";
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_TTL_MS } from "../../src/worker/auth/session-policy";

class NodeSqliteCursor<T extends AccountStateRow> implements AccountStateSqlCursor<T> {
  constructor(private readonly rows: T[]) {}

  toArray(): T[] {
    return this.rows;
  }
}

class NodeSqliteSqlStorage implements AccountStateSqlStorage {
  constructor(private readonly database: DatabaseSync) {}

  exec<T extends AccountStateRow = AccountStateRow>(
    query: string,
    ...bindings: AccountStateBinding[]
  ): AccountStateSqlCursor<T> {
    const statement = this.database.prepare(query);
    const rows = statement.all(...(bindings as Array<string | number | null | Uint8Array>)) as T[];
    return new NodeSqliteCursor(rows);
  }
}

export class NodeSqliteAccountStorage implements AccountStateStorage {
  readonly sql: AccountStateSqlStorage;

  constructor(readonly database: DatabaseSync) {
    this.sql = new NodeSqliteSqlStorage(database);
  }

  transactionSync<T>(closure: () => T): T {
    this.database.exec("BEGIN");
    try {
      const result = closure();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

/** 打开内存或文件 SQLite 上的账号状态。 */
export interface TestAccount {
  account: TestHakoAccount;
  state: HakoAccountState;
  database: DatabaseSync;
}

/** 打开 SQLite 上的账号状态，并保留数据库句柄用于直接检查存储内容或模拟重启。 */
export function createTestAccount(path = ":memory:"): TestAccount {
  const database = new DatabaseSync(path);
  const state = new HakoAccountState(new NodeSqliteAccountStorage(database));
  return { account: new TestHakoAccount(state), state, database };
}

/** 按 HakoAccountStub 合同包装真实状态逻辑；路由测试通过它访问 SQLite。 */
export class TestHakoAccount implements HakoAccountStub {
  constructor(readonly state: HakoAccountState) {}

  async createLoginTransaction(input: LoginTransactionInput): Promise<void> {
    this.state.createLoginTransaction(input);
  }

  async consumeLoginTransaction(
    input: ConsumeLoginTransactionInput,
  ): Promise<ConsumedLoginTransaction | null> {
    return this.state.consumeLoginTransaction(input);
  }

  async finalizeLoginTransaction(input: FinalizeLoginTransactionInput): Promise<boolean> {
    return this.state.finalizeLoginTransaction(input);
  }

  async revokeEnvironmentTransactions(environmentId: string): Promise<void> {
    this.state.revokeEnvironmentTransactions(environmentId);
  }

  async readSession(input: ReadHakoSessionInput): Promise<HakoSessionRecord | null> {
    return this.state.readSession(input);
  }

  async renewSessionIfDue(input: RenewHakoSessionInput): Promise<RenewedHakoSession | null> {
    return this.state.renewSessionIfDue({
      ...input,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
  }

  async revokeSession(input: RevokeHakoSessionInput): Promise<void> {
    this.state.revokeSession(input);
  }
}
