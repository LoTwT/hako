// 恢复 HTTP 接口（B 版本，恢复设计 §7.4）：
// - GET /api/backups/refueling：已核对的完成版本元数据与当前代次；只读、有界分页，
//   不初始化、不续期、不进行 R2 写删。
// - POST /api/restores/refueling/previews：输入精确备份引用；返回 previewId、期限、
//   目标摘要、预期当前版本及保护等待原因。只接受现有账号/stream 的完成引用。
// - GET /api/restores/refueling/previews/{previewId}/snapshot：只读返回固定目标
//   snapshot 及其摘要；不能把此响应交给普通同步合并入口。
// - DELETE /api/restores/refueling/previews/{previewId}：只删除仍匹配且未消费的
//   本账号 preview 与暂存；迟到取消不能删除较新预览或已完成回执。
// - POST /api/restores/refueling：固定正文 + 请求指纹；成功 200 committed，
//   冲突 409 request_id_conflict，not_committed 随裁决证明返回 409 source_changed /
//   preview_replaced 或 410 preview_expired，其余已鉴权失败沿用原错误码并携带
//   outcome: unknown。HTTP 状态或错误码本身不能决定终态。
// - GET /api/restores/refueling/requests/{requestId}：只读查询已提交回执；
//   不存在返回 404（不证明请求未提交，客户端按 unknown 处理）。
// 使用既有本人会话与账号匹配；写请求严格校验 Origin；响应 no-store。

import type { AuthEnvironment, AuthHandlerDependencies } from "../auth/routes";
import { HAKO_ACCOUNT_OBJECT_NAME } from "../auth/account-rpc";
import { readSessionCookie } from "../auth/cookies";
import { hashSecret } from "../auth/secrets";
import { readLoginConfig } from "../login-config";
import { jsonResponse } from "../http";
import { isAccountId } from "../../shared/sync-protocol";
import {
  computeRestoreRequestFingerprint,
  parseRestoreRequestBody,
  RESTORE_PATH,
  RESTORE_PREVIEW_PATH,
  RESTORE_PREVIEW_PATH_PREFIX,
  RESTORE_REQUEST_PATH_PREFIX,
  type RestoreErrorCode,
  type RestoreReceipt,
  type RestoreRequestBody,
} from "../../shared/restore-protocol";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 固定错误码 → HTTP 状态；状态本身不能决定请求终态。 */
const RESTORE_ERROR_STATUS: Record<RestoreErrorCode, number> = {
  unauthorized: 401,
  origin_not_allowed: 403,
  invalid_request: 400,
  backup_not_found: 404,
  restore_request_not_found: 404,
  preview_not_found: 404,
  account_changed: 409,
  source_changed: 409,
  preview_replaced: 409,
  request_id_conflict: 409,
  backup_not_ready: 409,
  backup_blocked: 409,
  preview_expired: 410,
  body_too_large: 413,
  backup_invalid: 422,
  no_restore_change: 422,
  restore_unavailable: 503,
  generation_state_unavailable: 503,
};

export async function handleRestoreRequest(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === RESTORE_PATH) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    return await handleRestoreSubmit(request, env, dependencies);
  }
  if (pathname.startsWith(RESTORE_REQUEST_PATH_PREFIX)) {
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "GET" });
    return await handleRestoreReceiptQuery(request, env, dependencies, pathname.slice(RESTORE_REQUEST_PATH_PREFIX.length));
  }
  if (pathname === RESTORE_PREVIEW_PATH) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    return await handlePreviewCreate(request, env, dependencies);
  }
  if (pathname.startsWith(RESTORE_PREVIEW_PATH_PREFIX)) {
    const rest = pathname.slice(RESTORE_PREVIEW_PATH_PREFIX.length);
    const snapshotMatch = /^([0-9a-f-]{36})\/snapshot$/.exec(rest);
    if (snapshotMatch !== null) {
      if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "GET" });
      return await handlePreviewSnapshot(request, env, dependencies, snapshotMatch[1]!);
    }
    if (UUID_PATTERN.test(rest)) {
      if (request.method !== "DELETE") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "DELETE" });
      return await handlePreviewCancel(request, env, dependencies, rest);
    }
  }
  return jsonResponse({ error: "not_found" }, 404);
}

/** GET /api/backups/refueling：已核对的版本列表（在 api.ts 注册）。 */
export async function handleBackupListRequest(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get("X-Hako-Account");
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    const session = {
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    };
    const result = await account.listRefuelingBackups({ ...session, expectedAccountId });
    if (!result.ok) {
      return jsonResponse({ error: result.error }, RESTORE_ERROR_STATUS[result.error], { "X-Hako-Account": expectedAccountId });
    }
    return jsonResponse({
      initialized: result.initialized,
      currentGeneration: result.currentGeneration,
      legacyGeneration: result.legacyGeneration,
      currentRevision: result.currentRevision,
      versions: result.versions.map((version) => ({
        backupStreamId: version.backupStreamId,
        revision: version.revision,
        bundleSha256: version.bundleSha256,
        completedAt: new Date(version.completedAtMs).toISOString(),
        capturedAt: version.capturedAtMs === null ? null : new Date(version.capturedAtMs).toISOString(),
        recordCount: version.recordCount,
        formatVersion: version.formatVersion,
        effectiveSourceGeneration: version.effectiveSourceGeneration,
        generationOrigin: version.generationOrigin,
        reason: version.reason,
        restoreBaseline: version.restoreBaseline,
        snapshotSha256: version.snapshotSha256,
        selectable: version.selectable,
      })),
    }, 200, { "X-Hako-Account": expectedAccountId });
  } catch {
    // 不将解析内容、会话或 SQLite 异常写入响应；读取失败不产生任何状态变化。
    return jsonResponse({ error: "restore_unavailable" }, 503);
  }
}

async function handlePreviewCreate(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  if (request.headers.get("Origin") !== login.config.origin) return jsonResponse({ error: "origin_not_allowed" }, 403);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get("X-Hako-Account");
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  // 严格正文：仅精确备份引用三字段，未知字段拒绝。
  let reference: { backupStreamId: string; revision: number; bundleSha256: string };
  try {
    const text = await readBoundedJsonBody(request);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const present = Object.keys(parsed);
    if (present.length !== 3 || !(["backupStreamId", "revision", "bundleSha256"] as const).every((field) => field in parsed)) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    if (typeof parsed.backupStreamId !== "string" || !UUID_PATTERN.test(parsed.backupStreamId)
      || typeof parsed.bundleSha256 !== "string" || !SHA256_PATTERN.test(parsed.bundleSha256)
      || typeof parsed.revision !== "number" || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    reference = parsed as typeof reference;
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return jsonResponse({ error: "body_too_large" }, 413);
    }
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    const session = {
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    };
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const result = await account.createRestorePreview({ ...session, expectedAccountId, ...reference });
    if (!result.ok) {
      return jsonResponse({ error: result.error }, RESTORE_ERROR_STATUS[result.error], { "X-Hako-Account": expectedAccountId });
    }
    return jsonResponse(previewResponse(result.preview), 200, { "X-Hako-Account": expectedAccountId });
  } catch {
    return jsonResponse({ error: "restore_unavailable" }, 503);
  }
}

async function handlePreviewSnapshot(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthHandlerDependencies,
  previewId: string,
): Promise<Response> {
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get("X-Hako-Account");
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    const session = {
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    };
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const result = await account.readRestorePreviewSnapshot({ ...session, expectedAccountId, previewId });
    if (!result.ok) {
      return jsonResponse({ error: result.error }, RESTORE_ERROR_STATUS[result.error], { "X-Hako-Account": expectedAccountId });
    }
    // 只读返回固定目标 snapshot；摘要随头部提供，不能交给普通同步合并入口。
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "X-Hako-Account": expectedAccountId,
      "X-Hako-Snapshot-Sha256": result.preview.target.snapshotSha256,
    });
    return new Response(new Uint8Array(result.snapshot), { headers });
  } catch {
    return jsonResponse({ error: "restore_unavailable" }, 503);
  }
}

async function handlePreviewCancel(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthHandlerDependencies,
  previewId: string,
): Promise<Response> {
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  if (request.headers.get("Origin") !== login.config.origin) return jsonResponse({ error: "origin_not_allowed" }, 403);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get("X-Hako-Account");
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    const session = {
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    };
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const result = await account.cancelRestorePreview({ ...session, expectedAccountId, previewId });
    if (!result.ok) {
      const status = result.error === "unauthorized" ? 401 : 409;
      return jsonResponse({ error: result.error }, status, { "X-Hako-Account": expectedAccountId });
    }
    if (!result.cancelled) {
      // 预览不存在、已被替换或已消费：不做任何删除，不泄露其他预览状态。
      return jsonResponse({ error: "preview_not_found" }, 404, { "X-Hako-Account": expectedAccountId });
    }
    return jsonResponse({ cancelled: true }, 200, { "X-Hako-Account": expectedAccountId });
  } catch {
    return jsonResponse({ error: "restore_unavailable" }, 503);
  }
}

async function handleRestoreSubmit(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  if (request.headers.get("Origin") !== login.config.origin) return jsonResponse({ error: "origin_not_allowed" }, 403);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get("X-Hako-Account");
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  let body: RestoreRequestBody;
  try {
    const text = await readBoundedJsonBody(request);
    body = parseRestoreRequestBody(JSON.parse(text)) ?? failJson();
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return jsonResponse({ error: "body_too_large" }, 413);
    }
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const requestFingerprint = await computeRestoreRequestFingerprint(body);
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    // 先重验会话再进入查重；失败不泄露回执或正文内容。
    const session = {
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    };
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const result = await account.submitRestore({
      ...session,
      expectedAccountId,
      requestId: body.requestId,
      requestFingerprint,
      body,
    });
    if (!result.ok) {
      const status = result.error === "unauthorized" ? 401 : 409;
      return jsonResponse({ error: result.error }, status, { "X-Hako-Account": expectedAccountId });
    }
    if (result.outcome === "request_id_conflict") {
      return jsonResponse({ error: "request_id_conflict" }, 409, { "X-Hako-Account": expectedAccountId });
    }
    if (result.outcome === "not_committed") {
      return jsonResponse({
        error: result.reason,
        outcome: "not_committed",
        requestId: body.requestId,
        requestFingerprint,
      }, RESTORE_ERROR_STATUS[result.reason], { "X-Hako-Account": expectedAccountId });
    }
    if (result.outcome === "unknown") {
      const errorCode = (result.errorCode ?? "restore_unavailable") as RestoreErrorCode;
      return jsonResponse({
        error: errorCode,
        outcome: "unknown",
        requestId: body.requestId,
        requestFingerprint,
      }, RESTORE_ERROR_STATUS[errorCode] ?? 503, { "X-Hako-Account": expectedAccountId });
    }
    return jsonResponse(receiptResponse(result.receipt, requestFingerprint), 200, { "X-Hako-Account": expectedAccountId });
  } catch {
    // 不将解析内容、会话或 SQLite 异常写入响应；失败不改变任何状态。
    return jsonResponse({ error: "restore_unavailable" }, 503);
  }
}

async function handleRestoreReceiptQuery(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthHandlerDependencies,
  requestId: string,
): Promise<Response> {
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get("X-Hako-Account");
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  if (!UUID_PATTERN.test(requestId)) return jsonResponse({ error: "invalid_request" }, 400);
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    const session = {
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    };
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const result = await account.readRestoreReceipt({ ...session, expectedAccountId, requestId });
    if (!result.ok) {
      const status = result.error === "unauthorized" ? 401 : 409;
      return jsonResponse({ error: result.error }, status, { "X-Hako-Account": expectedAccountId });
    }
    if (result.receipt === null) {
      // 404 不证明另一个在途请求尚未或将不会提交；客户端按 unknown 处理。
      return jsonResponse({ error: "restore_request_not_found" }, 404, { "X-Hako-Account": expectedAccountId });
    }
    return jsonResponse(receiptResponse(result.receipt, result.receipt.requestFingerprint), 200, { "X-Hako-Account": expectedAccountId });
  } catch {
    return jsonResponse({ error: "restore_unavailable" }, 503);
  }
}

function previewResponse(preview: {
  previewId: string;
  expiresAtMs: number;
  createdAtMs: number;
  target: { backupStreamId: string; revision: number; bundleSha256: string; snapshotSha256: string; historySha256: string; recordCount: number; capturedAtMs: number | null };
  expected: { generation: string; revision: number; snapshotSha256: string; historySha256: string };
  protection: { covered: boolean; waitingReason: string | null; nextAttemptAtMs: number | null; protectionRevision: number | null };
}): Record<string, unknown> {
  return {
    previewId: preview.previewId,
    expiresAt: new Date(preview.expiresAtMs).toISOString(),
    createdAt: new Date(preview.createdAtMs).toISOString(),
    target: {
      backupStreamId: preview.target.backupStreamId,
      revision: preview.target.revision,
      bundleSha256: preview.target.bundleSha256,
      snapshotSha256: preview.target.snapshotSha256,
      historySha256: preview.target.historySha256,
      recordCount: preview.target.recordCount,
      capturedAt: preview.target.capturedAtMs === null ? null : new Date(preview.target.capturedAtMs).toISOString(),
    },
    expected: {
      generation: preview.expected.generation,
      revision: preview.expected.revision,
      snapshotSha256: preview.expected.snapshotSha256,
      historySha256: preview.expected.historySha256,
    },
    protection: {
      covered: preview.protection.covered,
      waitingReason: preview.protection.waitingReason,
      nextAttemptAt: preview.protection.nextAttemptAtMs === null ? null : new Date(preview.protection.nextAttemptAtMs).toISOString(),
      protectionRevision: preview.protection.protectionRevision,
    },
  };
}

function receiptResponse(receipt: RestoreReceipt, requestFingerprint: string): Record<string, unknown> {
  return {
    outcome: "committed",
    requestId: receipt.requestId,
    requestFingerprint,
    previousGeneration: receipt.previousGeneration,
    newGeneration: receipt.newGeneration,
    previousRevision: receipt.previousRevision,
    newRevision: receipt.newRevision,
    sourceBackup: receipt.sourceBackup,
    protectionBackup: receipt.protectionBackup,
    baselinePending: receipt.baselinePending,
    committedAt: new Date(receipt.committedAtMs).toISOString(),
  };
}

/** 有界读取 JSON 正文；超限抛 body_too_large，空正文或读取中断抛 invalid_request。 */
async function readBoundedJsonBody(request: Request): Promise<string> {
  const limit = 16 * 1024;
  if (request.headers.get("Content-Type") !== "application/json") throw new Error("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error("body_too_large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error("invalid_request");
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function failJson(): RestoreRequestBody {
  throw new Error("invalid_request");
}
