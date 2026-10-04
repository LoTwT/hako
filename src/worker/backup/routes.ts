// 只读备份状态接口：GET /api/backups/refueling/status。
// 使用既有本人会话校验，但只查已有映射取得账号：无映射时返回未初始化，
// 不调用会创建映射的 resolveAccountId；不续期、不写 Cookie、不初始化备份、不上传数据，
// 也不 LIST R2。响应 no-store（http.ts 统一处理）。

import type { AuthEnvironment, AuthHandlerDependencies } from "../auth/routes";
import { HAKO_ACCOUNT_OBJECT_NAME } from "../auth/account-rpc";
import { readSessionCookie } from "../auth/cookies";
import { hashSecret } from "../auth/secrets";
import { readLoginConfig } from "../login-config";
import { jsonResponse } from "../http";

export const BACKUP_STATUS_PATH = "/api/backups/refueling/status";

export async function handleBackupStatusRequest(
  request: Request,
  env: AuthEnvironment,
  dependencies: AuthHandlerDependencies,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  }
  const login = readLoginConfig(env);
  if (!login.ok) return jsonResponse({ error: "configuration_error" }, 503);
  const token = readSessionCookie(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  try {
    const account = env.HAKO_ACCOUNT.getByName(HAKO_ACCOUNT_OBJECT_NAME);
    const result = await account.readBackupStatus({
      sessionHash: await hashSecret(token),
      identity: { issuer: login.config.issuer, subject: login.config.ownerSubject },
      nowMs: (dependencies.now ?? Date.now)(),
    });
    if (!result.ok) return jsonResponse({ error: "unauthorized" }, 401);
    // 服务器元数据，不承诺覆盖设备离线修改；具体字段含义见备份合同。
    return jsonResponse(result.status, 200);
  } catch {
    // 不将解析内容、会话或 SQLite 异常写入响应；读取失败不产生任何状态变化。
    return jsonResponse({ error: "backup_status_unavailable" }, 503);
  }
}
