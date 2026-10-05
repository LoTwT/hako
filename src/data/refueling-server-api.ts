// 账号文档的服务端读取客户端：bootstrap（幂等初始化/读取代次）与只读当前快照。
// 纯逻辑 + 可注入 fetch，便于测试；会话授权始终由服务端决定。

import { BOOTSTRAP_PATH, isDocumentGeneration, readSyncBody, SYNC_PATH, SYNC_PROTOCOL } from "../shared/sync-protocol";
import type { GenerationOrigin } from "../shared/document-generation";
import { parseGenerationOrigin } from "../shared/document-generation";

export interface BootstrapInfo {
  accountId: string;
  documentGeneration: string;
  legacyGeneration: string;
  generationOrigin: GenerationOrigin;
  snapshotAvailable: boolean;
  restoreWritesAvailable: boolean;
}

export type BootstrapFailure = "unauthorized" | "account_changed" | "generation_state_unavailable" | "unavailable";

export type BootstrapResult =
  | { ok: true; info: BootstrapInfo }
  | { ok: false; error: BootstrapFailure };

export interface ServerSnapshot {
  documentGeneration: string;
  revision: number;
  /** null 表示服务端尚无主文档（HTTP 204）；在已知代次下创建合法空文档。 */
  snapshot: Uint8Array | null;
}

export type SnapshotResult =
  | { ok: true; snapshot: ServerSnapshot }
  | { ok: false; error: "unauthorized" | "account_changed" | "generation_state_unavailable" | "unavailable" };

export interface RefuelingServerApiOptions {
  accountId: string;
  fetch?: typeof fetch;
}

/** POST bootstrap：空 JSON 对象；返回当前代次与只读状态，不携带业务快照。 */
export async function bootstrapRefueling(options: RefuelingServerApiOptions): Promise<BootstrapResult> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(BOOTSTRAP_PATH, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "X-Hako-Account": options.accountId, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (response.status === 401) return { ok: false, error: "unauthorized" };
  if (response.status === 409) return { ok: false, error: "account_changed" };
  if (response.status === 503) return { ok: false, error: "generation_state_unavailable" };
  if (response.status !== 200) return { ok: false, error: "unavailable" };
  try {
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { ok: false, error: "account_changed" };
    const body = await response.json() as Record<string, unknown>;
    if (!isDocumentGeneration(body.documentGeneration) || !isDocumentGeneration(body.legacyGeneration)) {
      return { ok: false, error: "unavailable" };
    }
    const origin = parseGenerationOrigin(body.generationOrigin);
    if (origin === null) return { ok: false, error: "unavailable" };
    if (typeof body.snapshotAvailable !== "boolean" || typeof body.restoreWritesAvailable !== "boolean") {
      return { ok: false, error: "unavailable" };
    }
    return {
      ok: true,
      info: {
        accountId: options.accountId,
        documentGeneration: body.documentGeneration,
        legacyGeneration: body.legacyGeneration,
        generationOrigin: origin,
        snapshotAvailable: body.snapshotAvailable,
        restoreWritesAvailable: body.restoreWritesAvailable,
      },
    };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** GET 只读当前完整快照；204 返回 snapshot=null，bootstrap 的代次信息仍有效。 */
export async function fetchRefuelingSnapshot(options: RefuelingServerApiOptions): Promise<SnapshotResult> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(SYNC_PATH, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "X-Hako-Account": options.accountId, "X-Hako-Sync-Protocol": SYNC_PROTOCOL },
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (response.status === 401) return { ok: false, error: "unauthorized" };
  if (response.status === 409) return { ok: false, error: "account_changed" };
  if (response.status === 503) return { ok: false, error: "generation_state_unavailable" };
  if (response.status === 426) return { ok: false, error: "unavailable" };
  if (response.status !== 200 && response.status !== 204) return { ok: false, error: "unavailable" };
  try {
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { ok: false, error: "account_changed" };
    const generation = response.headers.get("X-Hako-Document-Generation");
    if (!isDocumentGeneration(generation)) return { ok: false, error: "unavailable" };
    const revision = Number.parseInt(response.headers.get("X-Hako-Revision") ?? "", 10);
    if (!Number.isSafeInteger(revision) || revision < 0) return { ok: false, error: "unavailable" };
    if (response.status === 204) return { ok: true, snapshot: { documentGeneration: generation, revision, snapshot: null } };
    const snapshot = await readSyncBody(response.body);
    return { ok: true, snapshot: { documentGeneration: generation, revision, snapshot } };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** 与 src/worker/backup/routes.ts 的 BACKUP_STATUS_PATH 保持一致（只读元数据，不加载完整快照）。 */
const BACKUP_STATUS_PATH = "/api/backups/refueling/status";

/** 备份状态只读元数据（面板轮询用；执行授权仍由最终 POST 完整验证）。 */
export interface RefuelingBackupStatus {
  initialized: boolean;
  state: string;
  currentRevision: number | null;
  currentGeneration: string | null;
  frozenTaskRevision: number | null;
  latestCompletedRevision: number | null;
  latestCompletedGeneration: string | null;
  pendingFromRevision: number | null;
  pendingToRevision: number | null;
  windowDueAtMs: number | null;
  nextAttemptAtMs: number | null;
  /** 责任优先级 + 持久失败下限后的有效可行动时间；blocked/无责任为 null（展示用真值）。 */
  nextActionAtMs: number | null;
  blockedError: string | null;
  cleanupPendingCount: number;
  currentBackedUp: boolean;
}

export type BackupStatusResult =
  | { ok: true; status: RefuelingBackupStatus }
  | { ok: false; error: "unauthorized" | "account_changed" | "unavailable" };

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

/** GET 只读备份状态元数据：不下载完整快照、不初始化、不写任何状态。 */
export async function fetchBackupStatus(options: RefuelingServerApiOptions): Promise<BackupStatusResult> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(BACKUP_STATUS_PATH, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "X-Hako-Account": options.accountId },
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (response.status === 401) return { ok: false, error: "unauthorized" };
  if (response.status !== 200) return { ok: false, error: "unavailable" };
  try {
    if (response.headers.get("X-Hako-Account") !== null && response.headers.get("X-Hako-Account") !== options.accountId) {
      return { ok: false, error: "account_changed" };
    }
    const body = await response.json() as Record<string, unknown>;
    const currentRevision = numberOrNull(body.currentRevision);
    const currentGeneration = stringOrNull(body.currentGeneration);
    const frozenTaskRevision = numberOrNull(body.frozenTaskRevision);
    const latestCompletedRevision = numberOrNull(body.latestCompletedRevision);
    const latestCompletedGeneration = stringOrNull(body.latestCompletedGeneration);
    const pendingFromRevision = numberOrNull(body.pendingFromRevision);
    const pendingToRevision = numberOrNull(body.pendingToRevision);
    const windowDueAtMs = numberOrNull(body.windowDueAtMs);
    const nextAttemptAtMs = numberOrNull(body.nextAttemptAtMs);
    const nextActionAtMs = numberOrNull(body.nextActionAtMs);
    const blockedError = stringOrNull(body.blockedError);
    if (typeof body.initialized !== "boolean" || typeof body.state !== "string"
      || typeof body.cleanupPendingCount !== "number" || !Number.isSafeInteger(body.cleanupPendingCount)
      || typeof body.currentBackedUp !== "boolean"
      || currentRevision === undefined || currentGeneration === undefined || frozenTaskRevision === undefined
      || latestCompletedRevision === undefined || latestCompletedGeneration === undefined
      || pendingFromRevision === undefined || pendingToRevision === undefined
      || windowDueAtMs === undefined || nextAttemptAtMs === undefined || nextActionAtMs === undefined
      || blockedError === undefined) {
      return { ok: false, error: "unavailable" };
    }
    return {
      ok: true,
      status: {
        initialized: body.initialized,
        state: body.state,
        currentRevision,
        currentGeneration,
        frozenTaskRevision,
        latestCompletedRevision,
        latestCompletedGeneration,
        pendingFromRevision,
        pendingToRevision,
        windowDueAtMs,
        nextAttemptAtMs,
        nextActionAtMs,
        blockedError,
        cleanupPendingCount: body.cleanupPendingCount,
        currentBackedUp: body.currentBackedUp,
      },
    };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
