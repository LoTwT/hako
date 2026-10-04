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
import type { BackupStatusSnapshot } from "../backup/backup-engine";
import type { GenerationOrigin } from "../../shared/document-generation";
import type { RestoreReceipt } from "../../shared/restore-protocol";

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

export interface SyncRefuelingInput extends ReadHakoSessionInput {
  expectedAccountId: string;
  /** 客户端上传绑定的文档代次；必须与 DO 当前代次一致才进入合并。 */
  documentGeneration: string;
  snapshot: Uint8Array;
}

export type SyncRefuelingResult =
  | {
    ok: false;
    error: "unauthorized" | "account_changed" | "invalid_document" | "document_too_large"
      | "generation_state_unavailable" | "document_generation_changed";
    /** document_generation_changed 时的当前代次元数据；不附业务快照。 */
    currentGeneration?: string;
    legacyGeneration?: string;
    revision?: number;
  }
  | { ok: true; accountId: string; documentGeneration: string; revision: number; snapshot: Uint8Array };

/** 幂等初始化/读取代次；不接受业务快照，不执行恢复。 */
export interface BootstrapRefuelingInput extends ReadHakoSessionInput {
  expectedAccountId: string;
}

export type BootstrapRefuelingResult =
  | { ok: false; error: "unauthorized" | "account_changed" | "generation_state_unavailable" }
  | {
    ok: true;
    accountId: string;
    documentGeneration: string;
    legacyGeneration: string;
    origin: GenerationOrigin;
    snapshotAvailable: boolean;
    /** 当前应用版本是否提供恢复切换：A 恒为 false；客户端仍以实际请求结果为准。 */
    restoreWritesAvailable: boolean;
  };

/** 只读当前完整快照；不创建映射、不续期、不初始化。 */
export interface ReadRefuelingSnapshotInput extends ReadHakoSessionInput {
  expectedAccountId: string;
}

export type ReadRefuelingSnapshotResult =
  | { ok: false; error: "unauthorized" | "account_changed" | "generation_state_unavailable" }
  | { ok: true; accountId: string; documentGeneration: string; revision: number; snapshot: Uint8Array | null };

/** A 的恢复提交只做鉴权、请求查重与回执读回；无回执返回 unknown，不执行切换。 */
export interface SubmitRestoreInput extends ReadHakoSessionInput {
  expectedAccountId: string;
  requestId: string;
  requestFingerprint: string;
}

export type SubmitRestoreResult =
  | { ok: false; error: "unauthorized" | "account_changed" }
  | { ok: true; outcome: "committed"; receipt: RestoreReceipt }
  | { ok: true; outcome: "request_id_conflict" }
  | { ok: true; outcome: "unknown" };

/** 只读查询已提交回执；不存在返回 receipt=null（HTTP 404），不代表请求未提交。 */
export interface ReadRestoreReceiptInput extends ReadHakoSessionInput {
  expectedAccountId: string;
  requestId: string;
}

export type ReadRestoreReceiptResult =
  | { ok: false; error: "unauthorized" | "account_changed" }
  | { ok: true; receipt: RestoreReceipt | null };

/** 只读备份状态：会话在 DO 内重验；无有效会话返回 unauthorized。 */
export type ReadBackupStatusResult =
  | { ok: false; error: "unauthorized" }
  | { ok: true; status: BackupStatusSnapshot };

export interface HakoAccountStub {
  createLoginTransaction(input: LoginTransactionInput): Promise<void>;
  consumeLoginTransaction(
    input: ConsumeLoginTransactionInput,
  ): Promise<ConsumedLoginTransaction | null>;
  finalizeLoginTransaction(input: FinalizeLoginTransactionInput): Promise<boolean>;
  revokeEnvironmentTransactions(environmentId: string): Promise<void>;
  readSession(input: ReadHakoSessionInput): Promise<HakoSessionRecord | null>;
  readAccountId(input: ReadHakoSessionInput): Promise<string | null>;
  bootstrapRefueling(input: BootstrapRefuelingInput): Promise<BootstrapRefuelingResult>;
  readRefuelingSnapshot(input: ReadRefuelingSnapshotInput): Promise<ReadRefuelingSnapshotResult>;
  syncRefueling(input: SyncRefuelingInput): Promise<SyncRefuelingResult>;
  submitRestore(input: SubmitRestoreInput): Promise<SubmitRestoreResult>;
  readRestoreReceipt(input: ReadRestoreReceiptInput): Promise<ReadRestoreReceiptResult>;
  readBackupStatus(input: ReadHakoSessionInput): Promise<ReadBackupStatusResult>;
  renewSessionIfDue(input: RenewHakoSessionInput): Promise<RenewedHakoSession | null>;
  revokeSession(input: RevokeHakoSessionInput): Promise<void>;
}

/** 账号级状态只有一个实例：本人账号对应一个 SQLite Durable Object。 */
export interface HakoAccountBinding {
  getByName(name: string): HakoAccountStub;
}

export const HAKO_ACCOUNT_OBJECT_NAME = "owner-account";
