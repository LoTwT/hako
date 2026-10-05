// 恢复协议的共享合同：固定请求正文、请求指纹、三个结果分类与固定错误码。
// A 版本交付回执表读取、只查重的恢复 POST 与结果查询；恢复切换由 B 实现，
// 两侧共用同一份请求/指纹定义，避免 B 引入 A 无法读取的结构。

import type { BackupCaptureReason } from "../worker/backup/backup-format";
import type { GenerationOrigin } from "./document-generation";

export const RESTORE_PATH = "/api/restores/refueling";
export const RESTORE_REQUEST_PATH_PREFIX = "/api/restores/refueling/requests/";
export const RESTORE_PREVIEW_PATH = "/api/restores/refueling/previews";
export const RESTORE_PREVIEW_PATH_PREFIX = "/api/restores/refueling/previews/";
export const BACKUP_LIST_PATH = "/api/backups/refueling";
export const MAX_RESTORE_JSON_BYTES = 16 * 1024;

/** 一份预览的有效期：固定 15 分钟，不随轮询续期、不新增配置项。 */
export const RESTORE_PREVIEW_TTL_MS = 15 * 60 * 1000;

/** 确认恢复的固定请求正文；字段顺序即指纹顺序，未知字段拒绝。 */
export interface RestoreRequestBody {
  requestId: string;
  previewId: string;
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
  expectedGeneration: string;
  expectedRevision: number;
  expectedSnapshotSha256: string;
}

export const RESTORE_REQUEST_FIELD_ORDER = [
  "requestId", "previewId", "backupStreamId", "revision", "bundleSha256",
  "expectedGeneration", "expectedRevision", "expectedSnapshotSha256",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 严格解析固定正文；任何未知字段、缺字段或非法值都返回 null。 */
export function parseRestoreRequestBody(value: unknown): RestoreRequestBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const present = Object.keys(body);
  if (present.length !== RESTORE_REQUEST_FIELD_ORDER.length
    || !RESTORE_REQUEST_FIELD_ORDER.every((field) => field in body)) return null;
  for (const field of ["requestId", "previewId", "backupStreamId", "expectedGeneration"] as const) {
    if (typeof body[field] !== "string" || !UUID_PATTERN.test(body[field] as string)) return null;
  }
  for (const field of ["bundleSha256", "expectedSnapshotSha256"] as const) {
    if (typeof body[field] !== "string" || !SHA256_PATTERN.test(body[field] as string)) return null;
  }
  for (const field of ["revision", "expectedRevision"] as const) {
    if (typeof body[field] !== "number" || !Number.isSafeInteger(body[field]) || (body[field] as number) < 0) return null;
  }
  return {
    requestId: body.requestId as string,
    previewId: body.previewId as string,
    backupStreamId: body.backupStreamId as string,
    revision: body.revision as number,
    bundleSha256: body.bundleSha256 as string,
    expectedGeneration: body.expectedGeneration as string,
    expectedRevision: body.expectedRevision as number,
    expectedSnapshotSha256: body.expectedSnapshotSha256 as string,
  };
}

/** 请求指纹：按固定字段顺序、无空白 JSON 的 SHA-256；同 requestId 不能换 preview 或目标。 */
export async function computeRestoreRequestFingerprint(body: RestoreRequestBody): Promise<string> {
  const json = JSON.stringify({
    requestId: body.requestId,
    previewId: body.previewId,
    backupStreamId: body.backupStreamId,
    revision: body.revision,
    bundleSha256: body.bundleSha256,
    expectedGeneration: body.expectedGeneration,
    expectedRevision: body.expectedRevision,
    expectedSnapshotSha256: body.expectedSnapshotSha256,
  });
  return await sha256Hex(new TextEncoder().encode(json));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 请求结果三分类；HTTP 状态或错误码本身不能决定终态。 */
export type RestoreOutcome = "committed" | "not_committed" | "unknown";

/** 已持久保存的成功回执（提交当时的固定结果；由恢复切换事务写入，A 只读取）。 */
export interface RestoreReceipt {
  requestId: string;
  requestFingerprint: string;
  previousGeneration: string;
  newGeneration: string;
  previousRevision: number;
  newRevision: number;
  sourceBackup: BackupReferenceLike;
  protectionBackup: BackupReferenceLike;
  /** 提交时新代次的恢复基线备份是否尚未完成。 */
  baselinePending: boolean;
  committedAtMs: number;
}

export interface BackupReferenceLike {
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
}

export const RESTORE_ERROR_CODES = [
  "unauthorized", "origin_not_allowed", "invalid_request",
  "backup_not_found", "restore_request_not_found", "preview_not_found",
  "account_changed", "source_changed", "preview_replaced", "request_id_conflict",
  "backup_not_ready", "backup_blocked", "preview_expired", "body_too_large",
  "backup_invalid", "no_restore_change",
  "restore_unavailable", "generation_state_unavailable",
] as const;
export type RestoreErrorCode = typeof RESTORE_ERROR_CODES[number];

/** not_committed 的固定裁决原因；随响应绑定 requestId 与正文指纹。 */
export type NotCommittedReason = "source_changed" | "preview_replaced" | "preview_expired";

/** 列表展示的完成版本摘要；全部来自完成缓存与 R2 标记清单核对，不含业务字段。 */
export interface BackupVersionSummary {
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
  /** 完成确认时间（完成缓存）；与捕获时间区分展示。 */
  completedAtMs: number;
  /** 任务捕获时间；旧缓存行缺失时为 null，展示端保持未知。 */
  capturedAtMs: number | null;
  recordCount: number;
  /** 包格式版本；旧缓存行缺失时为 null。 */
  formatVersion: number | null;
  /** 有效源代次（v1 完成按固定 legacy 绑定解释，读取侧合成）。 */
  effectiveSourceGeneration: string;
  /** 代次来源；旧缓存行缺失时为 null。 */
  generationOrigin: GenerationOrigin | null;
  reason: BackupCaptureReason | null;
  /** 是否为恢复基线（reason === restore-baseline）。 */
  restoreBaseline: boolean;
  snapshotSha256: string | null;
  /** 清理中的版本不可作为新的可选目标。 */
  selectable: boolean;
}

export interface RestorePreviewDescriptor {
  previewId: string;
  /** 预览过期时刻；不随轮询续期。 */
  expiresAtMs: number;
  createdAtMs: number;
  target: {
    backupStreamId: string;
    revision: number;
    bundleSha256: string;
    snapshotSha256: string;
    historySha256: string;
    recordCount: number;
    capturedAtMs: number | null;
  };
  /** 预览创建时的当前服务端版本；最终确认必须精确匹配。 */
  expected: {
    generation: string;
    revision: number;
    snapshotSha256: string;
    historySha256: string;
  };
  /** 保护等待原因：当前版本是否已有精确覆盖的完成备份，及等待说明。 */
  protection: {
    covered: boolean;
    waitingReason: string | null;
    nextAttemptAtMs: number | null;
    /** 服务端当前最新完成版本（界面展示的保护版本；执行时仍完整重新验证）。 */
    protectionRevision: number | null;
  };
}
