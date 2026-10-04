// 恢复 HTTP 接口（A 版本）：
// - POST /api/restores/refueling：固定正文 + 请求指纹，只做鉴权与 requestId 查重。
//   已有同指纹回执返回 committed（原结果回放），冲突返回 409 request_id_conflict，
//   无回执返回 503 restore_unavailable + outcome unknown；不执行切换、不删除预览。
// - GET /api/restores/refueling/requests/{requestId}：只读查询已提交回执；
//   不存在返回 404 restore_request_not_found（不证明请求未提交）。
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
  RESTORE_REQUEST_PATH_PREFIX,
  type RestoreReceipt,
  type RestoreRequestBody,
} from "../../shared/restore-protocol";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  return jsonResponse({ error: "not_found" }, 404);
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
    });
    if (!result.ok) {
      const status = result.error === "unauthorized" ? 401 : 409;
      return jsonResponse({ error: result.error }, status, { "X-Hako-Account": expectedAccountId });
    }
    if (result.outcome === "request_id_conflict") {
      return jsonResponse({ error: "request_id_conflict" }, 409, { "X-Hako-Account": expectedAccountId });
    }
    if (result.outcome === "unknown") {
      // A 不执行切换：无回执只表示暂不可判定，客户端保留原 requestId 待确认。
      return jsonResponse({
        error: "restore_unavailable",
        outcome: "unknown",
        requestId: body.requestId,
        requestFingerprint,
      }, 503, { "X-Hako-Account": expectedAccountId });
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
