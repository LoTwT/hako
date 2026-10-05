// 恢复协议的客户端（B 版本）：本机待确认/终态结构、回执查询、备份列表、固定预览
// 与恢复提交。规则（恢复设计 §7.5/§7.6/§7.4）：
// - 待确认 requestId 与固定正文持久保存在账号控制库；所有标签页复用同一记录，
//   旧请求的迟到响应不能覆盖后来请求的终态。
// - 结果三分类只有 committed / not_committed 是终态；网络错误、无 outcome、
//   查询 404 与不能绑定到原请求（requestId + 固定正文指纹 + 账号）的响应一律
//   保留待确认（unknown），不自动换 ID。
// - not_committed 只接受 409 source_changed / preview_replaced 与 410 preview_expired
//   且必须绑定本请求指纹；committed 回执同样先核对账号与指纹再落盘。

import {
  computeRestoreRequestFingerprint,
  parseRestoreRequestBody,
  type RestoreRequestBody,
} from "../shared/restore-protocol";

export type { RestoreRequestBody } from "../shared/restore-protocol";
import { SYNC_PROTOCOL } from "../shared/sync-protocol";

/** 待确认的恢复请求：requestId 与固定正文一旦写入，同账号所有标签页复用。 */
export interface PendingRestoreRequest {
  requestId: string;
  body: RestoreRequestBody;
  requestFingerprint: string;
  createdAtMs: number;
  /**
   * 首次派发事实（§7.2）：在账号控制锁内随资格判定一次性落盘；从未派发为
   * null/缺失。已派发过的请求允许本人重试（可能已有结果，requestId 幂等），
   * 未派发且本机存在未同步保存时不得首次发送。
   */
  dispatchedAtMs?: number | null;
}

/** 列表展示的完成版本（服务端固定合同解析；不含业务字段）。 */
export interface RefuelingBackupVersion {
  backupStreamId: string;
  revision: number;
  bundleSha256: string;
  completedAtMs: number;
  capturedAtMs: number | null;
  recordCount: number;
  formatVersion: number | null;
  effectiveSourceGeneration: string;
  restoreBaseline: boolean;
  selectable: boolean;
}

export interface RefuelingBackupList {
  initialized: boolean;
  currentGeneration: string | null;
  currentRevision: number | null;
  versions: RefuelingBackupVersion[];
}

export type BackupListResult =
  | { ok: true; list: RefuelingBackupList }
  | { ok: false; error: string };

/** 固定预览（服务端验证并暂存目标后返回；15 分钟不续期）。 */
export interface RestorePreview {
  previewId: string;
  expiresAtMs: number;
  target: {
    backupStreamId: string;
    revision: number;
    bundleSha256: string;
    snapshotSha256: string;
    historySha256: string;
    recordCount: number;
    capturedAtMs: number | null;
  };
  expected: {
    generation: string;
    revision: number;
    snapshotSha256: string;
    historySha256: string;
  };
  protection: {
    covered: boolean;
    waitingReason: string | null;
    nextAttemptAtMs: number | null;
    /** 服务端当前最新完成版本（展示用；执行时仍由服务端完整重新验证保护包）。 */
    protectionRevision: number | null;
  };
}

export type CreatePreviewResult =
  | { ok: true; preview: RestorePreview }
  | { ok: false; error: string };

export type PreviewSnapshotResult =
  | { ok: true; snapshot: Uint8Array; snapshotSha256: string }
  | { ok: false; error: string };

/** 已判定的终态：先在严格 IndexedDB 事务内落盘，才解除待确认状态。 */
export interface RestoreOutcomeRecord {
  requestId: string;
  requestFingerprint: string;
  outcome: "committed" | "not_committed";
  decidedAtMs: number;
  /** committed：提交时的新代次与 revision（供接收流程参考）。 */
  newGeneration: string | null;
  newRevision: number | null;
  /** not_committed：裁决给出的固定原因（preview_expired / source_changed / preview_replaced）。 */
  notCommittedReason: string | null;
}

/** 服务端回执的客户端投影；字段由固定响应合同解析。 */
export interface RestoreCommittedReceipt {
  requestId: string;
  requestFingerprint: string;
  previousGeneration: string;
  newGeneration: string;
  previousRevision: number;
  newRevision: number;
  baselinePending: boolean;
  committedAtMs: number;
}

export type RestoreQueryResult =
  | { status: "committed"; receipt: RestoreCommittedReceipt }
  | { status: "unknown" };

export type RestoreSubmitOutcome =
  | { status: "committed"; receipt: RestoreCommittedReceipt }
  | { status: "request_id_conflict" }
  | { status: "not_committed"; reason: "source_changed" | "preview_replaced" | "preview_expired" }
  | { status: "unknown"; errorCode: string | null };

export interface RestoreClientOptions {
  accountId: string;
  fetch?: typeof fetch;
}

/** 依据固定正文计算请求指纹；写入待确认记录时使用。 */
export async function fingerprintRestoreRequest(body: RestoreRequestBody): Promise<string> {
  return await computeRestoreRequestFingerprint(body);
}

/** 只读查询已提交回执；404、网络错误或不可绑定的响应一律按 unknown 处理。 */
export async function queryRestoreReceipt(options: RestoreClientOptions, requestId: string): Promise<RestoreQueryResult> {
  const response = await sendRestoreRequest(options, `/api/restores/refueling/requests/${requestId}`, "GET");
  if (response === null) return { status: "unknown" };
  try {
    if (response.status === 404) return { status: "unknown" };
    if (response.status !== 200) return { status: "unknown" };
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { status: "unknown" };
    const body = await response.json() as Record<string, unknown>;
    const receipt = parseCommittedReceipt(body);
    if (receipt === null || receipt.requestId !== requestId) return { status: "unknown" };
    return { status: "committed", receipt };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * A 的恢复提交：只做鉴权与 requestId 查重的 POST。已有同指纹回执返回
 * committed（回放固定结果）；冲突返回 request_id_conflict（停止重发并核对）；
 * 无回执返回 unknown（保留原 ID 待确认，不自动换 ID，不执行切换）。
 * B 的提交按同一响应合同解析：not_committed（409 source_changed/preview_replaced、
 * 410 preview_expired）必须绑定 requestId 与正文指纹才可落盘为终态；其余已鉴权
 * 失败携带 outcome unknown，不可绑定的一律保留待确认。
 */
export async function submitRestoreRequest(options: RestoreClientOptions, body: RestoreRequestBody): Promise<RestoreSubmitOutcome> {
  const response = await sendRestoreRequest(options, "/api/restores/refueling", "POST", JSON.stringify(body));
  const expectedFingerprint = await computeRestoreRequestFingerprint(body);
  const boundOutcome = (parsed: Record<string, unknown>): RestoreSubmitOutcome | null => {
    // 响应必须携带本请求的 requestId 与固定正文指纹才可绑定结果。
    if (parsed.requestId !== body.requestId || parsed.requestFingerprint !== expectedFingerprint) return null;
    if (parsed.outcome === "not_committed") {
      if (parsed.error !== "source_changed" && parsed.error !== "preview_replaced" && parsed.error !== "preview_expired") return null;
      return { status: "not_committed", reason: parsed.error };
    }
    if (parsed.outcome === "unknown") {
      return { status: "unknown", errorCode: typeof parsed.error === "string" ? parsed.error : null };
    }
    return null;
  };
  if (response === null) return { status: "unknown", errorCode: null };
  try {
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { status: "unknown", errorCode: null };
    if (response.status === 200) {
      const parsed = await response.json() as Record<string, unknown>;
      const receipt = parseCommittedReceipt(parsed);
      if (receipt === null || receipt.requestId !== body.requestId
        || receipt.requestFingerprint !== expectedFingerprint) {
        return { status: "unknown", errorCode: null };
      }
      return { status: "committed", receipt };
    }
    if (response.status === 409) {
      const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (parsed === null) return { status: "unknown", errorCode: null };
      if (parsed.error === "request_id_conflict") return { status: "request_id_conflict" };
      const bound = boundOutcome(parsed);
      return bound ?? { status: "unknown", errorCode: null };
    }
    if (response.status === 410) {
      const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (parsed === null) return { status: "unknown", errorCode: null };
      const bound = boundOutcome(parsed);
      return bound ?? { status: "unknown", errorCode: null };
    }
    // 其余已鉴权失败：可绑定时保留原错误码与 unknown；不可绑定一律 unknown。
    const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (parsed === null) return { status: "unknown", errorCode: null };
    const bound = boundOutcome(parsed);
    return bound ?? { status: "unknown", errorCode: null };
  } catch {
    return { status: "unknown", errorCode: null };
  }
}


/** 解析 committed 回执；outcome 不是 committed 或字段不完整时返回 null（不可绑定）。 */
export function parseCommittedReceipt(value: unknown): RestoreCommittedReceipt | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.outcome !== "committed") return null;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const committedAt = typeof body.committedAt === "string" ? Date.parse(body.committedAt) : Number.NaN;
  for (const field of ["requestId", "previousGeneration", "newGeneration"] as const) {
    if (typeof body[field] !== "string" || !UUID.test(body[field] as string)) return null;
  }
  if (typeof body.requestFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(body.requestFingerprint)) return null;
  for (const field of ["previousRevision", "newRevision"] as const) {
    if (typeof body[field] !== "number" || !Number.isSafeInteger(body[field] as number)) return null;
  }
  if (typeof body.baselinePending !== "boolean") return null;
  if (!Number.isFinite(committedAt)) return null;
  return {
    requestId: body.requestId as string,
    requestFingerprint: body.requestFingerprint as string,
    previousGeneration: body.previousGeneration as string,
    newGeneration: body.newGeneration as string,
    previousRevision: body.previousRevision as number,
    newRevision: body.newRevision as number,
    baselinePending: body.baselinePending as boolean,
    committedAtMs: committedAt,
  };
}

/** 从任意响应正文构造终态记录（committed/not_committed）；不可绑定返回 null。 */
export function outcomeFromCommittedReceipt(pending: PendingRestoreRequest, receipt: RestoreCommittedReceipt): RestoreOutcomeRecord {
  return {
    requestId: pending.requestId,
    requestFingerprint: pending.requestFingerprint,
    outcome: "committed",
    decidedAtMs: Date.now(),
    newGeneration: receipt.newGeneration,
    newRevision: receipt.newRevision,
    notCommittedReason: null,
  };
}

export function notCommittedOutcome(pending: PendingRestoreRequest, reason: string): RestoreOutcomeRecord {
  return {
    requestId: pending.requestId,
    requestFingerprint: pending.requestFingerprint,
    outcome: "not_committed",
    decidedAtMs: Date.now(),
    newGeneration: null,
    newRevision: null,
    notCommittedReason: reason,
  };
}

/** 严格校验固定正文；B 的确认界面写入待确认记录前使用。 */
export function validateRestoreRequestBody(value: unknown): RestoreRequestBody | null {
  return parseRestoreRequestBody(value);
}

/** 已核对的备份列表（只读）；解析失败或不可绑定一律按错误返回。 */
export async function listRefuelingBackups(options: RestoreClientOptions): Promise<BackupListResult> {
  const response = await sendRestoreRequest(options, "/api/backups/refueling", "GET");
  if (response === null) return { ok: false, error: "unavailable" };
  try {
    if (response.status === 401) return { ok: false, error: "unauthorized" };
    if (response.status === 409) return { ok: false, error: "account_changed" };
    if (response.status !== 200) return { ok: false, error: "unavailable" };
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { ok: false, error: "account_changed" };
    const parsed = await response.json() as Record<string, unknown>;
    if (typeof parsed.initialized !== "boolean") return { ok: false, error: "unavailable" };
    if (!Array.isArray(parsed.versions)) return { ok: false, error: "unavailable" };
    const versions: RefuelingBackupVersion[] = [];
    for (const entry of parsed.versions as Record<string, unknown>[]) {
      const completedAt = typeof entry.completedAt === "string" ? Date.parse(entry.completedAt) : Number.NaN;
      const capturedAt = entry.capturedAt === null ? null
        : typeof entry.capturedAt === "string" ? Date.parse(entry.capturedAt) : Number.NaN;
      if (typeof entry.backupStreamId !== "string" || typeof entry.bundleSha256 !== "string"
        || typeof entry.effectiveSourceGeneration !== "string"
        || typeof entry.revision !== "number" || !Number.isSafeInteger(entry.revision)
        || typeof entry.recordCount !== "number" || typeof entry.restoreBaseline !== "boolean"
        || typeof entry.selectable !== "boolean" || !Number.isFinite(completedAt)
        || (entry.capturedAt !== null && !Number.isFinite(capturedAt as number))) {
        return { ok: false, error: "unavailable" };
      }
      versions.push({
        backupStreamId: entry.backupStreamId,
        revision: entry.revision,
        bundleSha256: entry.bundleSha256,
        completedAtMs: completedAt,
        capturedAtMs: capturedAt as number | null,
        recordCount: entry.recordCount,
        formatVersion: typeof entry.formatVersion === "number" ? entry.formatVersion : null,
        effectiveSourceGeneration: entry.effectiveSourceGeneration,
        restoreBaseline: entry.restoreBaseline,
        selectable: entry.selectable,
      });
    }
    return {
      ok: true,
      list: {
        initialized: parsed.initialized,
        currentGeneration: typeof parsed.currentGeneration === "string" ? parsed.currentGeneration : null,
        currentRevision: typeof parsed.currentRevision === "number" ? parsed.currentRevision : null,
        versions,
      },
    };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** 创建固定预览：输入精确备份引用；错误按固定错误码返回。 */
export async function createRestorePreview(
  options: RestoreClientOptions,
  reference: { backupStreamId: string; revision: number; bundleSha256: string },
): Promise<CreatePreviewResult> {
  // 发送边界显式构造三字段正文（恢复设计 §7.4：服务端严格拒绝未知字段）。
  // 调用方可能把列表展示用的完整版本行直接传进来，窄参数类型不会删除运行时
  // 额外字段，因此这里按精确引用重新组装，而不是原样序列化入参。
  const requestBody = {
    backupStreamId: reference.backupStreamId,
    revision: reference.revision,
    bundleSha256: reference.bundleSha256,
  };
  const response = await sendRestoreRequest(options, "/api/restores/refueling/previews", "POST", JSON.stringify(requestBody));
  if (response === null) return { ok: false, error: "unavailable" };
  try {
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { ok: false, error: "account_changed" };
    const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.status !== 200) {
      const code = parsed !== null && typeof parsed.error === "string" ? parsed.error : "unavailable";
      return { ok: false, error: code };
    }
    if (parsed === null) return { ok: false, error: "unavailable" };
    const preview = parsePreview(parsed);
    if (preview === null) return { ok: false, error: "unavailable" };
    return { ok: true, preview };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** 只读读取固定目标 snapshot；仅用于比较视图，不能交给普通同步合并入口。 */
export async function fetchRestorePreviewSnapshot(options: RestoreClientOptions, previewId: string): Promise<PreviewSnapshotResult> {
  const response = await sendRestoreRequest(options, `/api/restores/refueling/previews/${previewId}/snapshot`, "GET");
  if (response === null) return { ok: false, error: "unavailable" };
  try {
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { ok: false, error: "account_changed" };
    if (response.status !== 200) {
      const parsed = await response.json().catch(() => null) as { error?: unknown } | null;
      return { ok: false, error: parsed !== null && typeof parsed.error === "string" ? parsed.error : "unavailable" };
    }
    const snapshotSha256 = response.headers.get("X-Hako-Snapshot-Sha256");
    if (snapshotSha256 === null || !/^[0-9a-f]{64}$/.test(snapshotSha256)) return { ok: false, error: "unavailable" };
    const snapshot = await readPreviewSnapshotBody(response.body);
    if (snapshot === null || snapshot.byteLength === 0) return { ok: false, error: "unavailable" };
    return { ok: true, snapshot, snapshotSha256 };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** 取消预览：只删除仍匹配且未消费的预览；不存在/已替换按 not_found 返回。 */
export async function cancelRestorePreview(options: RestoreClientOptions, previewId: string): Promise<{ cancelled: boolean; error: string | null }> {
  const response = await sendRestoreRequest(options, `/api/restores/refueling/previews/${previewId}`, "DELETE");
  if (response === null) return { cancelled: false, error: "unavailable" };
  try {
    if (response.status === 200) return { cancelled: true, error: null };
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { cancelled: false, error: "account_changed" };
    const parsed = await response.json().catch(() => null) as { error?: unknown } | null;
    return { cancelled: false, error: parsed !== null && typeof parsed.error === "string" ? parsed.error : "unavailable" };
  } catch {
    return { cancelled: false, error: "unavailable" };
  }
}

function parsePreview(value: Record<string, unknown>): RestorePreview | null {
  const previewId = value.previewId;
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  if (typeof previewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(previewId)
    || !Number.isFinite(expiresAt)) return null;
  const target = value.target as Record<string, unknown> | undefined;
  const expected = value.expected as Record<string, unknown> | undefined;
  const protection = value.protection as Record<string, unknown> | undefined;
  if (target === undefined || expected === undefined || protection === undefined) return null;
  if (typeof target.backupStreamId !== "string" || typeof target.bundleSha256 !== "string"
    || typeof target.snapshotSha256 !== "string" || typeof target.historySha256 !== "string"
    || typeof target.revision !== "number" || !Number.isSafeInteger(target.revision)
    || typeof target.recordCount !== "number"
    || typeof expected.generation !== "string" || typeof expected.snapshotSha256 !== "string"
    || typeof expected.historySha256 !== "string"
    || typeof expected.revision !== "number" || !Number.isSafeInteger(expected.revision)
    || typeof protection.covered !== "boolean") return null;
  const capturedAt = target.capturedAt === null ? null
    : typeof target.capturedAt === "string" ? Date.parse(target.capturedAt) : Number.NaN;
  if (target.capturedAt !== null && !Number.isFinite(capturedAt as number)) return null;
  const nextAttemptAt = protection.nextAttemptAt === null || protection.nextAttemptAt === undefined ? null
    : typeof protection.nextAttemptAt === "string" ? Date.parse(protection.nextAttemptAt) : Number.NaN;
  if (protection.nextAttemptAt != null && !Number.isFinite(nextAttemptAt as number)) return null;
  const protectionRevision = protection.protectionRevision === null || protection.protectionRevision === undefined ? null
    : typeof protection.protectionRevision === "number" && Number.isSafeInteger(protection.protectionRevision) && protection.protectionRevision >= 0
      ? protection.protectionRevision
      : Number.NaN;
  if (Number.isNaN(protectionRevision as number)) return null;
  return {
    previewId,
    expiresAtMs: expiresAt,
    target: {
      backupStreamId: target.backupStreamId,
      revision: target.revision,
      bundleSha256: target.bundleSha256,
      snapshotSha256: target.snapshotSha256,
      historySha256: target.historySha256,
      recordCount: target.recordCount,
      capturedAtMs: capturedAt as number | null,
    },
    expected: {
      generation: expected.generation,
      revision: expected.revision,
      snapshotSha256: expected.snapshotSha256,
      historySha256: expected.historySha256,
    },
    protection: {
      covered: protection.covered,
      waitingReason: typeof protection.waitingReason === "string" ? protection.waitingReason : null,
      nextAttemptAtMs: nextAttemptAt as number | null,
      protectionRevision: protectionRevision as number | null,
    },
  };
}

/** 预览快照正文：有界流式读取（上限与同步合同一致，不信任 Content-Length）。 */
async function readPreviewSnapshotBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return null;
  const limit = 4 * 1024 * 1024;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) return null;
      chunks.push(next.value);
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function sendRestoreRequest(
  options: RestoreClientOptions,
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: string,
): Promise<Response | null> {
  try {
    return await (options.fetch ?? fetch)(path, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "X-Hako-Account": options.accountId,
        "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return null;
  }
}
