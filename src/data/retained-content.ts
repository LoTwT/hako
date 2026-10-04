// 保留内容装配：为保留副本视图列出旧 v1 草稿与各保留代次的 v2 草稿（只读）。
// 只枚举与读取，不创建数据库、不占用草稿锁、不做已保存清理——旧窗口继续落盘
// 不受影响；只有草稿而无正式记录的代次同样可被发现（升级前仅有草稿的账号）。

import { accountStorageNames } from "./account-storage";
import { listRefuelingDraftsReadOnly } from "./refueling-draft-store";
import type { StoredRefuelingDraft } from "../domain/refueling/draft-recovery";

export interface RetainedDraftSource {
  /** v1 为升级前旧草稿库；generation 为某个 v2 代次的草稿库。 */
  kind: "v1" | "generation";
  generation: string | null;
  drafts: StoredRefuelingDraft[];
  /** 格式版本不受支持的条目数量；这些条目被保留在原库中。 */
  unsupportedCount: number;
}

const DRAFTS_SUFFIX = ":drafts";

/**
 * 列出保留草稿来源：旧 v1 草稿库（如存在）+ 各保留代次的 v2 草稿库。
 * excludeGeneration 为当前活动代次（其草稿由当前草稿会话管理，不在此重复列出）；
 * 传 null 表示保护流程（本机旧活动副本即被保护对象，需全部列出）。
 */
export async function listRetainedDraftSources(accountId: string, excludeGeneration: string | null): Promise<RetainedDraftSource[]> {
  const sources: RetainedDraftSource[] = [];
  const legacy = await listRefuelingDraftsReadOnly(accountStorageNames(accountId).drafts).catch(() => null);
  if (legacy !== null && legacy.drafts.length + legacy.unsupportedCount > 0) {
    sources.push({ kind: "v1", generation: null, drafts: legacy.drafts, unsupportedCount: legacy.unsupportedCount });
  }
  const prefix = `hako-account-v2:${accountId}:`;
  const databases = await indexedDB.databases().catch(() => [] as { name?: string }[]);
  for (const entry of databases) {
    if (entry.name === undefined || !entry.name.startsWith(prefix) || !entry.name.endsWith(DRAFTS_SUFFIX)) continue;
    const generation = entry.name.slice(prefix.length, entry.name.length - DRAFTS_SUFFIX.length);
    if (generation.length === 0 || generation === excludeGeneration) continue;
    const list = await listRefuelingDraftsReadOnly(entry.name).catch(() => null);
    if (list === null || list.drafts.length + list.unsupportedCount === 0) continue;
    sources.push({ kind: "generation", generation, drafts: list.drafts, unsupportedCount: list.unsupportedCount });
  }
  return sources;
}
