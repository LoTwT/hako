// 账号级 SQLite Durable Object：持久保存登录事务与本应用会话。
// SQL 与规则在 auth/account-state.ts，实现与测试共用同一份逻辑；
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
} from "./auth/account-rpc";
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_TTL_MS } from "./auth/session-policy";

export class HakoAccountDurableObject extends DurableObject<Env> {
  private readonly accountState: HakoAccountState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 幂等建表与补列；SQLite 写入由 DO 输出门确认后才返回响应。
    this.accountState = new HakoAccountState(ctx.storage);
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
