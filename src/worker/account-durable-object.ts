// 账号级 SQLite Durable Object：持久保存登录事务、会话及账号文档。
// SQL 与规则在 auth/account-state.ts 和 sync/，实现与测试共用同一份逻辑；
// 本类只负责把逻辑接到 Durable Object 运行时并按 RPC 合同暴露。

import { DurableObject } from "cloudflare:workers";
import { HakoAccountState } from "./auth/account-state";
import type {
  ConsumedLoginTransaction,
  ConsumeLoginTransactionInput,
  FinalizeLoginTransactionInput,
  HakoSessionRecord,
  LoginTransactionInput,
  RenewedHakoSession,
} from "./auth/account-state";
import type {
  ReadHakoSessionInput,
  RenewHakoSessionInput,
  RevokeHakoSessionInput,
  SyncRefuelingInput,
  SyncRefuelingResult,
} from "./auth/account-rpc";
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_TTL_MS } from "./auth/session-policy";
import { AccountSync } from "./sync/account-sync";
import { initializeWorkerLoro } from "./sync/loro-runtime";

export class HakoAccountDurableObject extends DurableObject<Env> {
  private readonly accountState: HakoAccountState;
  private readonly accountSync: AccountSync;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 幂等建表与补列；SQLite 写入由 DO 输出门确认后才返回响应。
    this.accountState = new HakoAccountState(ctx.storage);
    this.accountSync = new AccountSync(ctx.storage, this.accountState);
  }

  async createLoginTransaction(input: LoginTransactionInput): Promise<void> {
    this.accountState.createLoginTransaction(input);
  }

  async consumeLoginTransaction(
    input: ConsumeLoginTransactionInput,
  ): Promise<ConsumedLoginTransaction | null> {
    return this.accountState.consumeLoginTransaction(input);
  }

  async finalizeLoginTransaction(input: FinalizeLoginTransactionInput): Promise<boolean> {
    return this.accountState.finalizeLoginTransaction(input);
  }

  async revokeEnvironmentTransactions(environmentId: string): Promise<void> {
    this.accountState.revokeEnvironmentTransactions(environmentId);
  }

  async readSession(input: ReadHakoSessionInput): Promise<HakoSessionRecord | null> {
    return this.accountState.readSession(input);
  }

  async readAccountId(input: ReadHakoSessionInput): Promise<string | null> {
    const accountId = this.accountSync.readAccountId({ ...input, nowMs: Date.now() });
    await this.ctx.storage.sync();
    return accountId;
  }

  async syncRefueling(input: SyncRefuelingInput): Promise<SyncRefuelingResult> {
    // RPC 到达时重验会话。授权、合并与续期之间没有 await，退出不能穿插进来。
    initializeWorkerLoro();
    const result = this.accountSync.exchange({ ...input, nowMs: Date.now() });
    await this.ctx.storage.sync();
    return result;
  }

  async renewSessionIfDue(input: RenewHakoSessionInput): Promise<RenewedHakoSession | null> {
    // 期限规则集中在 auth/session-policy.ts；调用方只提供会话、身份与当前时间。
    return this.accountState.renewSessionIfDue({
      sessionHash: input.sessionHash,
      identity: input.identity,
      nowMs: input.nowMs,
      sessionTtlMs: SESSION_TTL_MS,
      renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
  }

  async revokeSession(input: RevokeHakoSessionInput): Promise<void> {
    this.accountState.revokeSession(input);
  }
}
