// 同步 HTTP 接口（协议 v2）：
// - POST /api/sync/refueling/bootstrap：空 JSON 对象；幂等初始化/读取 G0 与当前代次。
// - GET /api/sync/refueling：只读当前完整快照；头部含账号、协议、当前代次与 revision。
//   没有主文档时返回 204，bootstrap 的代次信息仍有效。
// - POST /api/sync/refueling：协议 2 + 必填 X-Hako-Document-Generation；代次与会话账号
//   及 DO 当前代次一起匹配后才合并。协议 1/缺代次上传一律 426 protocol_upgrade_required，
//   格式错误代次 400，合法但非当前代次 409 document_generation_changed（附代次元数据，
//   不附业务快照），账号不匹配仍为 409 account_changed。

import type { AuthEnvironment, AuthHandlerDependencies } from "../auth/routes";
import { HAKO_ACCOUNT_OBJECT_NAME } from "../auth/account-rpc";
import { readSessionCookie } from "../auth/cookies";
import { hashSecret } from "../auth/secrets";
import { readLoginConfig } from "../login-config";
import { jsonResponse } from "../http";
import {
  ACCOUNT_HEADER,
  BOOTSTRAP_PATH,
  DOCUMENT_GENERATION_HEADER,
  isAccountId,
  isDocumentGeneration,
  PROTOCOL_HEADER,
  readSyncBody,
  REVISION_HEADER,
  SYNC_CONTENT_TYPE,
  SYNC_PATH,
  SYNC_PROTOCOL,
} from "../../shared/sync-protocol";

export async function handleSyncRequest(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  return await handleSyncUpload(request, env, dependencies);
}

export async function handleSyncSnapshotRequest(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get(ACCOUNT_HEADER);
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  if (request.headers.get(PROTOCOL_HEADER) !== SYNC_PROTOCOL) {
    return jsonResponse({ error: "protocol_upgrade_required" }, 426);
  }
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    const session = {
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    };
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const result = await account.readRefuelingSnapshot({ ...session, expectedAccountId });
    if (!result.ok) {
      const status = { unauthorized: 401, account_changed: 409, generation_state_unavailable: 503 }[result.error];
      return jsonResponse({ error: result.error }, status);
    }
    const headers = new Headers({
      "Cache-Control": "no-store",
      [ACCOUNT_HEADER]: result.accountId,
      [PROTOCOL_HEADER]: SYNC_PROTOCOL,
      [DOCUMENT_GENERATION_HEADER]: result.documentGeneration,
      [REVISION_HEADER]: String(result.revision),
    });
    if (result.snapshot === null) return new Response(null, { status: 204, headers });
    headers.set("Content-Type", SYNC_CONTENT_TYPE);
    // GET 不创建映射、不续期、不上传；返回快照的 revision 即已持久确认范围。
    return new Response(new Uint8Array(result.snapshot), { headers });
  } catch {
    // 不将解析内容、会话或 SQLite 异常写入响应；读取失败不产生任何状态变化。
    return jsonResponse({ error: "sync_unavailable" }, 503);
  }
}

export async function handleBootstrapRequest(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  if (request.headers.get("Origin") !== login.config.origin) return jsonResponse({ error: "origin_not_allowed" }, 403);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get(ACCOUNT_HEADER);
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  if (request.headers.get("Content-Type") !== "application/json") return jsonResponse({ error: "invalid_request" }, 400);
  try {
    const text = await readBootstrapBody(request);
    const parsed: unknown = JSON.parse(text);
    // 只接受空 JSON 对象；数组、null 或任何未知字段都拒绝。
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed as Record<string, unknown>).length !== 0) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") return jsonResponse({ error: "body_too_large" }, 413);
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
    const result = await account.bootstrapRefueling({ ...session, expectedAccountId });
    if (!result.ok) {
      const status = { unauthorized: 401, account_changed: 409, generation_state_unavailable: 503 }[result.error];
      return jsonResponse({ error: result.error }, status, { [ACCOUNT_HEADER]: expectedAccountId });
    }
    // 全部 no-store；不从客户端上传内容推断代次，不返回身份字段；沿用账号匹配响应头。
    return jsonResponse({
      accountId: result.accountId,
      documentGeneration: result.documentGeneration,
      legacyGeneration: result.legacyGeneration,
      generationOrigin: result.origin,
      snapshotAvailable: result.snapshotAvailable,
      restoreWritesAvailable: result.restoreWritesAvailable,
    }, 200, { [ACCOUNT_HEADER]: result.accountId });
  } catch {
    return jsonResponse({ error: "sync_unavailable" }, 503);
  }
}

async function handleSyncUpload(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  if (request.headers.get("Origin") !== login.config.origin) return jsonResponse({ error: "origin_not_allowed" }, 403);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const expectedAccountId = request.headers.get(ACCOUNT_HEADER);
  if (!isAccountId(expectedAccountId)) return jsonResponse({ error: "invalid_request" }, 400);
  // 协议 1 与缺代次的业务上传一律 426：旧客户端保留本机数据并进入更新提示。
  if (request.headers.get(PROTOCOL_HEADER) !== SYNC_PROTOCOL) {
    return jsonResponse({ error: "protocol_upgrade_required" }, 426);
  }
  if (request.headers.get("Content-Type") !== SYNC_CONTENT_TYPE) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const documentGeneration = request.headers.get(DOCUMENT_GENERATION_HEADER);
  if (documentGeneration === null) {
    return jsonResponse({ error: "protocol_upgrade_required" }, 426);
  }
  if (!isDocumentGeneration(documentGeneration)) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  let snapshot: Uint8Array;
  try { snapshot = await readSyncBody(request.body); }
  catch (error) {
    return jsonResponse({ error: "invalid_body" }, error instanceof Error && error.message === "document_too_large" ? 413 : 400);
  }
  const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
  const session = {
    sessionHash: await hashSecret(token),
    identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
    nowMs: (dependencies.now ?? Date.now)(),
  };
  try {
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const result = await account.syncRefueling({ ...session, expectedAccountId, documentGeneration, snapshot });
    if (!result.ok) {
      if (result.error === "document_generation_changed") {
        // 合法但非当前代次：附当前代次元数据，不附业务快照。
        return jsonResponse({
          error: "document_generation_changed",
          currentGeneration: result.currentGeneration,
          legacyGeneration: result.legacyGeneration,
          revision: result.revision,
        }, 409);
      }
      const status = {
        unauthorized: 401, account_changed: 409, invalid_document: 422,
        document_too_large: 413, generation_state_unavailable: 503,
      }[result.error];
      return jsonResponse({ error: result.error }, status);
    }
    const headers = new Headers({
      "Cache-Control": "no-store", "Content-Type": SYNC_CONTENT_TYPE,
      [ACCOUNT_HEADER]: result.accountId, [PROTOCOL_HEADER]: SYNC_PROTOCOL,
      [DOCUMENT_GENERATION_HEADER]: result.documentGeneration,
      [REVISION_HEADER]: String(result.revision),
    });
    // Cookie 在登录时固定到绝对上限。后台响应不重写它，避免覆盖其他窗口的新登录。
    return new Response(new Uint8Array(result.snapshot), { headers });
  } catch {
    // 不将解析内容、会话或 SQLite 异常写入响应/日志；失败不确认任何版本。
    return jsonResponse({ error: "sync_unavailable" }, 503);
  }
}

/** bootstrap 正文只接受空 JSON 对象；有界读取防止无上限缓冲。 */
async function readBootstrapBody(request: Request): Promise<string> {
  const limit = 1024;
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

export const SYNC_ROUTE_PATHS = [SYNC_PATH, BOOTSTRAP_PATH] as const;
