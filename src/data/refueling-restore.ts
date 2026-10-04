// 恢复协议的客户端（A 版本）：本机待确认/终态结构与回执查询/只查重提交。
// 规则（恢复设计 §7.5/§7.6）：
// - 待确认 requestId 与固定正文持久保存在账号控制库；所有标签页复用同一记录，
//   旧请求的迟到响应不能覆盖后来请求的终态。
// - 结果三分类只有 committed / not_committed 是终态；网络错误、无 outcome、
//   查询 404 与不能绑定到原请求的响应一律保留待确认（unknown），不自动换 ID。
// - 客户端核对账号、requestId 与固定正文指纹后才落盘任何结果。
// A 不发起恢复切换；这些结构由 B 的确认界面写入，A 负责保留、读取与查询。

import {
  computeRestoreRequestFingerprint,
  parseRestoreRequestBody,
  type RestoreRequestBody,
} from "../shared/restore-protocol";
import { SYNC_PROTOCOL } from "../shared/sync-protocol";

/** 待确认的恢复请求：requestId 与固定正文一旦写入，同账号所有标签页复用。 */
export interface PendingRestoreRequest {
  requestId: string;
  body: RestoreRequestBody;
  requestFingerprint: string;
  createdAtMs: number;
}

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

export type RestoreSubmitResult =
  | { status: "committed"; receipt: RestoreCommittedReceipt }
  | { status: "request_id_conflict" }
  | { status: "unknown" };

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
 */
export async function submitRestoreDedup(options: RestoreClientOptions, body: RestoreRequestBody): Promise<RestoreSubmitResult> {
  const response = await sendRestoreRequest(options, "/api/restores/refueling", "POST", JSON.stringify(body));
  if (response === null) return { status: "unknown" };
  try {
    if (response.status === 409) {
      const body_ = await response.json() as { error?: unknown };
      if (body_?.error === "request_id_conflict") return { status: "request_id_conflict" };
      return { status: "unknown" };
    }
    if (response.status !== 200) return { status: "unknown" };
    if (response.headers.get("X-Hako-Account") !== options.accountId) return { status: "unknown" };
    const parsed = await response.json() as Record<string, unknown>;
    const receipt = parseCommittedReceipt(parsed);
    const expectedFingerprint = await computeRestoreRequestFingerprint(body);
    if (receipt === null || receipt.requestId !== body.requestId
      || receipt.requestFingerprint !== expectedFingerprint) {
      return { status: "unknown" };
    }
    return { status: "committed", receipt };
  } catch {
    return { status: "unknown" };
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

async function sendRestoreRequest(
  options: RestoreClientOptions,
  path: string,
  method: "GET" | "POST",
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
