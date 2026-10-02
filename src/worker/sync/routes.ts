import type { AuthEnvironment, AuthHandlerDependencies } from "../auth/routes";
import { HAKO_ACCOUNT_OBJECT_NAME } from "../auth/account-rpc";
import { readSessionCookie } from "../auth/cookies";
import { hashSecret } from "../auth/secrets";
import { readLoginConfig } from "../login-config";
import { jsonResponse } from "../http";
import { isAccountId, readSyncBody, SYNC_CONTENT_TYPE, SYNC_PROTOCOL } from "../../shared/sync-protocol";

export async function handleSyncRequest(request: Request, env: AuthEnvironment, dependencies: AuthHandlerDependencies): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  if (request.headers.get("Origin") !== login.config.origin) return jsonResponse({ error: "origin_not_allowed" }, 403);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
  const session = {
    sessionHash: await hashSecret(token),
    identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
    nowMs: (dependencies.now ?? Date.now)(),
  };
  try {
    if (await account.readSession(session) === null) return jsonResponse({ error: "unauthorized" }, 401);
    const expectedAccountId = request.headers.get("X-Hako-Account");
    if (!isAccountId(expectedAccountId) || request.headers.get("X-Hako-Sync-Protocol") !== SYNC_PROTOCOL
      || request.headers.get("Content-Type") !== SYNC_CONTENT_TYPE) {
      return jsonResponse({ error: "unsupported_protocol" }, 400);
    }
    let snapshot: Uint8Array;
    try { snapshot = await readSyncBody(request.body); }
    catch (error) {
      return jsonResponse({ error: "invalid_body" }, error instanceof Error && error.message === "document_too_large" ? 413 : 400);
    }
    const result = await account.syncRefueling({ ...session, expectedAccountId, snapshot });
    if (!result.ok) {
      const status = { unauthorized: 401, account_changed: 409, invalid_document: 422, document_too_large: 413 }[result.error];
      return jsonResponse({ error: result.error }, status);
    }
    const headers = new Headers({
      "Cache-Control": "no-store", "Content-Type": SYNC_CONTENT_TYPE,
      "X-Hako-Account": result.accountId, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
    });
    // Cookie 在登录时固定到绝对上限。后台响应不重写它，避免覆盖其他窗口的新登录。
    return new Response(new Uint8Array(result.snapshot), { headers });
  } catch {
    // 不将解析内容、会话或 SQLite 异常写入响应/日志；失败不确认任何版本。
    return jsonResponse({ error: "sync_unavailable" }, 503);
  }
}
