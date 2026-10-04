// 恢复协议的共享合同：固定请求正文、请求指纹、三个结果分类与固定错误码。
// A 版本交付回执表读取、只查重的恢复 POST 与结果查询；恢复切换由 B 实现，
// 两侧共用同一份请求/指纹定义，避免 B 引入 A 无法读取的结构。

export const RESTORE_PATH = "/api/restores/refueling";
export const RESTORE_REQUEST_PATH_PREFIX = "/api/restores/refueling/requests/";
export const MAX_RESTORE_JSON_BYTES = 16 * 1024;

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
  "backup_not_found", "restore_request_not_found",
  "account_changed", "source_changed", "preview_replaced", "request_id_conflict",
  "backup_not_ready", "backup_blocked", "preview_expired", "body_too_large",
  "backup_invalid", "no_restore_change",
  "restore_unavailable", "generation_state_unavailable",
] as const;
export type RestoreErrorCode = typeof RESTORE_ERROR_CODES[number];
