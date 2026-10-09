// 本地测试账号的合成会话：走既有认证 DO 的正式登录事务合同
// （createLoginTransaction → consumeLoginTransaction → finalizeLoginTransaction），
// 与 tests/integration/worker-entry.ts 的 createSession 使用同一最小能力；
// 这里只保留建立会话所需的三步与账号读取，不包含测试入口的 SQL、debug 或故障注入接口。
//
// 会话凭据为随机值，服务端只保存哈希；期限沿用 src/worker/auth/session-policy.ts
// 的既有参数，登录、读取、刷新与退出都命中同一份 DO 会话记录。

import type { HakoAccountStub } from "../auth/account-rpc";
import type { HakoIdentity } from "../auth/account-state";
import { LOGIN_TRANSACTION_TTL_MS, resolveSessionExpiry } from "../auth/session-policy";
import { generateEnvironmentId, generateSecretToken, hashSecret } from "../auth/secrets";

export type LocalDevelopmentSessionResult =
  | { ok: true; token: string; accountId: string }
  | { ok: false; reason: "login_transaction_unavailable" | "account_unavailable" };

/**
 * 建立一条本地测试账号会话并返回其随机凭据与账号标识。
 * 失败时返回可读原因，调用方不得据此建立任何登录状态。
 */
export async function createLocalDevelopmentSession(
  account: HakoAccountStub,
  identity: HakoIdentity,
  nowMs: number,
): Promise<LocalDevelopmentSessionResult> {
  const environmentId = generateEnvironmentId();
  const state = generateSecretToken();
  const completionSecret = generateSecretToken();
  const sessionToken = generateSecretToken();

  await account.createLoginTransaction({
    environmentId,
    stateHash: await hashSecret(state),
    completionSecretHash: await hashSecret(completionSecret),
    nonce: generateSecretToken(),
    codeVerifier: generateSecretToken(48),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + LOGIN_TRANSACTION_TTL_MS,
  });
  const consumed = await account.consumeLoginTransaction({
    stateHash: await hashSecret(state),
    environmentId,
    completionSecretHash: await hashSecret(completionSecret),
    nowMs,
  });
  if (consumed === null) return { ok: false, reason: "login_transaction_unavailable" };

  const sessionHash = await hashSecret(sessionToken);
  const { expiresAtMs, absoluteExpiresAtMs } = resolveSessionExpiry(nowMs);
  const finalized = await account.finalizeLoginTransaction({
    stateHash: await hashSecret(state),
    environmentId,
    nowMs,
    session: {
      sessionHash,
      issuer: identity.issuer,
      subject: identity.subject,
      createdAtMs: nowMs,
      expiresAtMs,
      absoluteExpiresAtMs,
    },
  });
  if (!finalized) return { ok: false, reason: "login_transaction_unavailable" };

  const accountId = await account.readAccountId({ sessionHash, identity, nowMs });
  if (accountId === null) return { ok: false, reason: "account_unavailable" };
  return { ok: true, token: sessionToken, accountId };
}
