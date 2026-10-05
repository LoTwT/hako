// 测试用账号状态实现：真实 SQLite（node:sqlite）承载与 Durable Object 相同的
// auth/account-state.ts 逻辑，按 RPC 合同暴露给路由层。
// 生产持久化仍由 workerd 中的 SQLite Durable Object 验证（见本地验证记录）。

import { DatabaseSync } from "node:sqlite";
import { HakoAccountState } from "../../src/worker/auth/account-state";
import type {
  AccountDurableStorage,
  AccountStateBinding,
  AccountStateRow,
  AccountStateSqlCursor,
  AccountStateSqlStorage,
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
import { AccountSync } from "../../src/worker/sync/account-sync";
import { AccountDocuments } from "../../src/worker/sync/account-documents";
import { BackupEngine, type BackupLogEvent } from "../../src/worker/backup/backup-engine";
import type {
  BootstrapRefuelingInput,
  BootstrapRefuelingResult,
  CancelRestorePreviewResult,
  CreateRestorePreviewInput,
  CreateRestorePreviewResult,
  ListRefuelingBackupsInput,
  ListRefuelingBackupsResult,
  ReadRefuelingSnapshotInput,
  ReadRefuelingSnapshotResult,
  ReadRestorePreviewInput,
  ReadRestorePreviewSnapshotResult,
  ReadRestoreReceiptInput,
  ReadRestoreReceiptResult,
  SubmitRestoreInput,
  SubmitRestoreResult,
  SyncRefuelingInput,
  SyncRefuelingResult,
  ReadBackupStatusResult,
} from "../../src/worker/auth/account-rpc";
import type { RestoreReceiptInput } from "../../src/worker/restore/restore-store";
import { R2BackupObjectStore } from "../../src/worker/backup/backup-object-store";
import { BackupStore } from "../../src/worker/backup/backup-store";
import { FakeBackupBucket } from "./fake-backup-bucket";
import { PRODUCTION_BACKUP_SCHEDULE, type BackupSchedulePolicy } from "../../src/worker/backup/backup-schedule";
import { RestoreService } from "../../src/worker/restore/restore-service";
import { RestoreStore } from "../../src/worker/restore/restore-store";
import { RestorePreviewStore } from "../../src/worker/restore/restore-preview-store";

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
    const rows = statement.all(...bindings.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value)) as T[];
    return new NodeSqliteCursor(rows);
  }
}

interface OpenTransactionLevel {
  /** 最外层为 BEGIN/COMMIT；嵌套层使用 SAVEPOINT，与 workerd 的嵌套 transactionSync 对齐。 */
  readonly savepoint: string | null;
  readonly alarmTimeMs: number | null;
}

export class NodeSqliteAccountStorage implements AccountDurableStorage {
  readonly sql: AccountStateSqlStorage;
  private readonly openTransactions: OpenTransactionLevel[] = [];
  private alarmTimeMs: number | null = null;
  private savepointCounter = 0;

  constructor(readonly database: DatabaseSync) {
    this.sql = new NodeSqliteSqlStorage(database);
  }

  transactionSync<T>(closure: () => T): T {
    const savepoint = this.openTransactions.length === 0
      ? null
      : `hako_sp_${this.openTransactions.length}_${this.savepointCounter++}`;
    if (savepoint === null) this.database.exec("BEGIN");
    else this.database.exec(`SAVEPOINT ${savepoint}`);
    this.openTransactions.push({ savepoint, alarmTimeMs: this.alarmTimeMs });
    try {
      const result = closure();
      this.commitLevel();
      return result;
    } catch (error) {
      this.rollbackLevel();
      throw error;
    }
  }

  async transaction<T>(closure: () => Promise<T>): Promise<T> {
    const savepoint = this.openTransactions.length === 0
      ? null
      : `hako_sp_${this.openTransactions.length}_${this.savepointCounter++}`;
    if (savepoint === null) this.database.exec("BEGIN");
    else this.database.exec(`SAVEPOINT ${savepoint}`);
    this.openTransactions.push({ savepoint, alarmTimeMs: this.alarmTimeMs });
    try {
      const result = await closure();
      this.commitLevel();
      return result;
    } catch (error) {
      this.rollbackLevel();
      throw error;
    }
  }

  private commitLevel(): void {
    const level = this.openTransactions.pop();
    if (level === undefined) throw new Error("test_adapter_transaction_underflow");
    if (level.savepoint === null) this.database.exec("COMMIT");
    else this.database.exec(`RELEASE ${level.savepoint}`);
  }

  private rollbackLevel(): void {
    const level = this.openTransactions.pop();
    if (level === undefined) throw new Error("test_adapter_transaction_underflow");
    if (level.savepoint === null) this.database.exec("ROLLBACK");
    else {
      this.database.exec(`ROLLBACK TO ${level.savepoint}`);
      this.database.exec(`RELEASE ${level.savepoint}`);
    }
    // SQL 与 alarm 在同一事务边界内回滚：恢复进入该层前的 alarm 安排。
    this.alarmTimeMs = level.alarmTimeMs;
  }

  async setAlarm(scheduledTimeMs: number): Promise<void> {
    this.alarmTimeMs = scheduledTimeMs;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTimeMs;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTimeMs = null;
  }

  /** 测试断言用：读取模拟 alarm 时间的当前值。 */
  alarmTime(): number | null {
    return this.alarmTimeMs;
  }
}

/** 打开内存或文件 SQLite 上的账号状态。 */
export interface TestAccount {
  account: TestHakoAccount;
  state: HakoAccountState;
  database: DatabaseSync;
  storage: NodeSqliteAccountStorage;
  backups: BackupEngine;
  bucket: FakeBackupBucket;
  restoreStore: RestoreStore;
  previewStore: RestorePreviewStore;
  restoreService: RestoreService;
}

export interface CreateTestAccountOptions {
  /** 备份引擎节奏与日志；默认使用生产节奏与静默日志。 */
  schedule?: BackupSchedulePolicy;
  log?: (event: BackupLogEvent) => void;
  /** 受控时钟：同步、备份与恢复均通过它取当前时间。 */
  now?: () => number;
  bucket?: FakeBackupBucket;
}

/** 打开 SQLite 上的账号状态，并保留数据库句柄用于直接检查存储内容或模拟重启。 */
export function createTestAccount(path = ":memory:", options: CreateTestAccountOptions = {}): TestAccount {
  const database = new DatabaseSync(path);
  const storage = new NodeSqliteAccountStorage(database);
  const state = new HakoAccountState(storage);
  const documents = new AccountDocuments(storage);
  const restoreStore = new RestoreStore(storage);
  const previewStore = new RestorePreviewStore(storage);
  const bucket = options.bucket ?? new FakeBackupBucket();
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? PRODUCTION_BACKUP_SCHEDULE;
  const objectStore = new R2BackupObjectStore(bucket);
  const backups = new BackupEngine({
    storage,
    objectStore,
    snapshotSource: documents,
    schedule,
    now,
    log: options.log ?? (() => undefined),
  });
  const sync = new AccountSync(storage, state, documents, backups);
  const restore = new RestoreService(
    storage, state, documents, restoreStore, previewStore,
    new BackupStore(storage), objectStore, backups, schedule, now,
  );
  return {
    account: new TestHakoAccount(state, sync, backups, restore, restoreStore, previewStore),
    state, database, storage, backups, bucket, restoreStore, previewStore, restoreService: restore,
  };
}

/** 按 HakoAccountStub 合同包装真实状态逻辑；路由测试通过它访问 SQLite。 */
export class TestHakoAccount implements HakoAccountStub {
  constructor(
    readonly state: HakoAccountState,
    readonly sync: AccountSync,
    private readonly backups: BackupEngine,
    private readonly restore: RestoreService,
    private readonly restoreStore: RestoreStore,
    private readonly previewStore: RestorePreviewStore,
  ) {}

  async readAccountId(input: ReadHakoSessionInput): Promise<string | null> {
    return this.sync.readAccountId(input);
  }

  async bootstrapRefueling(input: BootstrapRefuelingInput): Promise<BootstrapRefuelingResult> {
    return this.sync.bootstrap(input);
  }

  async readRefuelingSnapshot(input: ReadRefuelingSnapshotInput): Promise<ReadRefuelingSnapshotResult> {
    return this.sync.readSnapshot(input);
  }

  async syncRefueling(input: SyncRefuelingInput): Promise<SyncRefuelingResult> {
    return this.sync.exchange(input);
  }

  async listRefuelingBackups(input: ListRefuelingBackupsInput): Promise<ListRefuelingBackupsResult> {
    return this.restore.listBackups(input);
  }

  async createRestorePreview(input: CreateRestorePreviewInput): Promise<CreateRestorePreviewResult> {
    return this.restore.createPreview(input);
  }

  async readRestorePreviewSnapshot(input: ReadRestorePreviewInput): Promise<ReadRestorePreviewSnapshotResult> {
    return this.restore.readPreviewSnapshot(input);
  }

  async cancelRestorePreview(input: ReadRestorePreviewInput): Promise<CancelRestorePreviewResult> {
    return this.restore.cancelPreview(input);
  }

  async submitRestore(input: SubmitRestoreInput): Promise<SubmitRestoreResult> {
    return this.restore.submit(input);
  }

  async readRestoreReceipt(input: ReadRestoreReceiptInput): Promise<ReadRestoreReceiptResult> {
    return this.restore.read(input);
  }

  /** 测试注入合成 B 回执（生产路径只在恢复切换事务内写入）。 */
  async insertRestoreReceiptForTest(input: RestoreReceiptInput): Promise<void> {
    this.restoreStore.insertReceipt(input);
  }

  /** 测试直读当前预览（生产路径只经服务层访问）。 */
  readPreviewForTest(accountId: string) {
    return this.previewStore.get(accountId);
  }

  async readBackupStatus(input: ReadHakoSessionInput): Promise<ReadBackupStatusResult> {
    if (this.state.readSession(input) === null) return { ok: false, error: "unauthorized" };
    const accountId = this.sync.findExistingAccountId(input);
    return { ok: true, status: await this.backups.readStatusSnapshot(accountId) };
  }

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
