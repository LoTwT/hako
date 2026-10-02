// HakoAccountDurableObject 的 RPC 合同：路由层只依赖这份接口，
// 因此协议与失败路径测试可以用真实 SQLite 逻辑替换 DO 运行时接线。
// 类型与 account-state.ts 中的状态层保持结构一致。

import type {
  ConsumedLoginTransaction,
  ConsumeLoginTransactionInput,
  FinalizeLoginTransactionInput,
  HakoIdentity,
  HakoSessionRecord,
  LoginTransactionInput,
  RenewedHakoSession,
} from "./account-state";

export interface ReadHakoSessionInput {
  sessionHash: string;
  identity: HakoIdentity;
  nowMs: number;
}

export interface RevokeHakoSessionInput {
  sessionHash: string;
  nowMs: number;
}

/** 续期调用提供会话、固定身份与当前时间；期限规则由 DO 内的策略常量决定。 */
export interface RenewHakoSessionInput {
  sessionHash: string;
  identity: HakoIdentity;
  nowMs: number;
}

export interface HakoAccountStub {
  createLoginTransaction(input: LoginTransactionInput): Promise<void>;
  consumeLoginTransaction(
    input: ConsumeLoginTransactionInput,
  ): Promise<ConsumedLoginTransaction | null>;
  finalizeLoginTransaction(input: FinalizeLoginTransactionInput): Promise<boolean>;
  revokeEnvironmentTransactions(environmentId: string): Promise<void>;
  readSession(input: ReadHakoSessionInput): Promise<HakoSessionRecord | null>;
  renewSessionIfDue(input: RenewHakoSessionInput): Promise<RenewedHakoSession | null>;
  revokeSession(input: RevokeHakoSessionInput): Promise<void>;
}

/** 账号级状态只有一个实例：本人账号对应一个 SQLite Durable Object。 */
export interface HakoAccountBinding {
  getByName(name: string): HakoAccountStub;
}

export const HAKO_ACCOUNT_OBJECT_NAME = "owner-account";
