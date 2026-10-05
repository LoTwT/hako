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
import type {
  BackupVersionSummary,
  NotCommittedReason,
  RestorePreviewDescriptor,
  RestoreReceipt,
  RestoreRequestBody,
} from "../../shared/restore-protocol";

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

/**
 * 恢复提交（B 版本）：固定正文 + 请求指纹。入口先鉴权与 requestId 查回执
 * （同指纹回放 committed、不同指纹 request_id_conflict、早于代次变化检查）；
 * 再完整验证暂存目标与保护包，最终在同一事务内原子切换。失败出口按 §7.3
 * 短裁决重新鉴权与查回执：只有持久失去资格才返回 not_committed，否则 unknown。
 */
export interface SubmitRestoreInput extends ReadHakoSessionInput {
  expectedAccountId: string;
  requestId: string;
  requestFingerprint: string;
  body: RestoreRequestBody;
}

export type SubmitRestoreResult =
  | { ok: false; error: "unauthorized" | "account_changed" }
  | { ok: true; outcome: "committed"; receipt: RestoreReceipt }
  | { ok: true; outcome: "request_id_conflict" }
  | { ok: true; outcome: "not_committed"; reason: NotCommittedReason }
  | { ok: true; outcome: "unknown"; errorCode?: string };

/** 只读查询已提交回执；不存在返回 receipt=null（HTTP 404），不代表请求未提交。 */
export interface ReadRestoreReceiptInput extends ReadHakoSessionInput {
  expectedAccountId: string;
  requestId: string;
}

export type ReadRestoreReceiptResult =
  | { ok: false; error: "unauthorized" | "account_changed" }
  | { ok: true; receipt: RestoreReceipt | null };

/** 当前账号备份列表：只读核对 R2 标记清单与完成缓存；不初始化、不写删 R2。 */
export interface ListRefuelingBackupsInput extends ReadHakoSessionInput {
  expectedAccountId: string;
}

export type ListRefuelingBackupsResult =
  | {
    ok: false;
    error: "unauthorized" | "account_changed" | "generation_state_unavailable"
      | "backup_invalid" | "restore_unavailable";
  }
  | {
    ok: true;
    initialized: boolean;
    currentGeneration: string | null;
    legacyGeneration: string | null;
    currentRevision: number | null;
    versions: BackupVersionSummary[];
  };

/** 创建固定预览：输入精确备份引用；R2 验证在事务外，写入前重验会话与替换条件。 */
export interface CreateRestorePreviewInput extends ReadHakoSessionInput {
  expectedAccountId: string;
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
}

export type RestorePreviewErrorCode =
  | "unauthorized" | "account_changed" | "invalid_request" | "backup_not_found"
  | "backup_invalid" | "backup_not_ready" | "no_restore_change" | "source_changed"
  | "preview_replaced" | "restore_unavailable" | "generation_state_unavailable";

export type CreateRestorePreviewResult =
  | { ok: false; error: RestorePreviewErrorCode }
  | { ok: true; preview: RestorePreviewDescriptor };

/** 读取/取消预览：只匹配本账号且仍存在的 previewId；已消费/替换的 ID 返回 not_found。 */
export interface ReadRestorePreviewInput extends ReadHakoSessionInput {
  expectedAccountId: string;
  previewId: string;
}

export type ReadRestorePreviewSnapshotResult =
  | { ok: false; error: "unauthorized" | "account_changed" | "preview_not_found" | "restore_unavailable" }
  | { ok: true; snapshot: Uint8Array; preview: RestorePreviewDescriptor };

export type CancelRestorePreviewResult =
  | { ok: false; error: "unauthorized" | "account_changed" | "restore_unavailable" }
  | { ok: true; cancelled: boolean };

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
  listRefuelingBackups(input: ListRefuelingBackupsInput): Promise<ListRefuelingBackupsResult>;
  createRestorePreview(input: CreateRestorePreviewInput): Promise<CreateRestorePreviewResult>;
  readRestorePreviewSnapshot(input: ReadRestorePreviewInput): Promise<ReadRestorePreviewSnapshotResult>;
  cancelRestorePreview(input: ReadRestorePreviewInput): Promise<CancelRestorePreviewResult>;
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
