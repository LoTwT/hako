// 草稿恢复决策（纯逻辑）：决定页面启动时如何处理既有草稿。
// 规则来自 docs/specs/eruoo-login-integration.md 第 6.3 节的草稿方案：
// 草稿库独立于业务文档；只有唯一定位且未被其他活跃页面占用才自动恢复；
// 无法唯一定位时提供明确的恢复/放弃选择；业务保存已完成的草稿只做清理。
// “已保存”只用正面证据判断：本地写入的已保存标记，或草稿内容与当前记录
// 完全一致；仅凭“记录存在”不删除编辑草稿，未保存的编辑内容必须保留。

import { validateDraft, type RefuelingDraft, type SavedRefuelingRecord } from "./form";

/** 独立草稿库中的一份草稿；保存完整原始输入，不从有效记录反推。 */
export interface StoredRefuelingDraft {
  id: string;
  mode: "create" | "edit";
  /** 稳定业务记录 id：新建模式为预留 id，编辑模式为既有记录 id。 */
  recordId: string;
  /** 编辑基线（含稳定 id）与新建模式下的空基线；用于 changedFields 语义。 */
  base: SavedRefuelingRecord | null;
  values: RefuelingDraft["values"];
  sources: RefuelingDraft["sources"];
  createdAt: number;
  updatedAt: number;
  formatVersion: number;
  /**
   * 业务保存成功时写入的标记（毫秒时间戳）：用于在清理失败后仍能识别
   * “这份草稿已经保存过”，避免重开时把它当成未保存草稿再次恢复。
   */
  savedAt: number | null;
}

export interface DraftRecoveryInput {
  drafts: readonly StoredRefuelingDraft[];
  /** sessionStorage 中的定位线索；仅作线索，不能作为唯一载体。 */
  hintDraftId: string | null;
  /** 已被其他活跃页面占用的草稿 id。 */
  claimedDraftIds: ReadonlySet<string>;
  /** 当前业务库中的已知记录；用于判断草稿是否已经保存过。 */
  knownRecords: ReadonlyMap<string, SavedRefuelingRecord>;
}

export type DraftRecoveryPlan =
  | { kind: "none" }
  | { kind: "restore"; draft: StoredRefuelingDraft }
  | { kind: "choose"; drafts: StoredRefuelingDraft[] };

export interface DraftRecoveryDecision {
  plan: DraftRecoveryPlan;
  /** 可以静默删除的已保存草稿（业务记录已经存在）。 */
  cleanupDraftIds: string[];
  /** 保留但不提供恢复的编辑草稿数量（找不到对应记录）。 */
  orphanedEditCount: number;
}

export function planDraftRecovery(input: DraftRecoveryInput): DraftRecoveryDecision {
  const cleanupDraftIds: string[] = [];
  const recoverable: StoredRefuelingDraft[] = [];
  let orphanedEditCount = 0;
  for (const draft of input.drafts) {
    if (draft.mode === "create") {
      if (input.knownRecords.has(draft.recordId)) {
        // 新建草稿对应的记录已经保存成功：清理，避免幽灵恢复或重复新增
        cleanupDraftIds.push(draft.id);
        continue;
      }
    } else {
      const record = input.knownRecords.get(draft.recordId);
      if (record === undefined) {
        // 找不到对应记录的编辑草稿：保留数据，但不恢复成新建记录
        orphanedEditCount += 1;
        continue;
      }
      if (draftAlreadySaved(draft, record)) {
        cleanupDraftIds.push(draft.id);
        continue;
      }
    }
    if (input.claimedDraftIds.has(draft.id)) continue;
    recoverable.push(draft);
  }

  const hinted =
    input.hintDraftId === null
      ? undefined
      : recoverable.find((draft) => draft.id === input.hintDraftId);
  if (hinted !== undefined) {
    return { plan: { kind: "restore", draft: hinted }, cleanupDraftIds, orphanedEditCount };
  }
  if (recoverable.length === 0) {
    return { plan: { kind: "none" }, cleanupDraftIds, orphanedEditCount };
  }
  return {
    plan: {
      kind: "choose",
      drafts: [...recoverable].sort((a, b) => b.updatedAt - a.updatedAt),
    },
    cleanupDraftIds,
    orphanedEditCount,
  };
}

/**
 * 编辑草稿是否已经保存过（只看正面证据）：
 * 1. 带本地“已保存”标记（保存成功但清理没走完）；
 * 2. 草稿里的每一处改动都已经体现在当前记录里——草稿没动过的字段可以
 *    被其他窗口改过，草稿动过的字段必须与记录一致才说明保存已经生效
 *    （覆盖“保存事务完成但页面在清理前结束”和“保存成功后别的窗口又改了
 *    其他字段”两种情况）。
 * 无法确认时返回 false：宁可让用户看到一份可能多余的草稿，也不静默删除
 * 真正尚未保存的编辑内容。
 */
function draftAlreadySaved(draft: StoredRefuelingDraft, record: SavedRefuelingRecord): boolean {
  if (typeof draft.savedAt === "number") return true;
  const base = draft.base;
  if (base === null) return false;
  const projection = validateDraft({ values: draft.values, sources: draft.sources }).record;
  if (projection === null) return false;
  const fields = Object.keys(projection) as (keyof typeof projection)[];
  return fields.every(
    (field) => projection[field] === base[field] || projection[field] === record[field],
  );
}

/** 当前表单对应的草稿上下文；随表单实例（新建/编辑/恢复）切换。 */
export interface DraftFormContext {
  mode: "create" | "edit";
  recordId: string;
  base: SavedRefuelingRecord | null;
}

export function draftFromContext(
  context: DraftFormContext,
  draft: RefuelingDraft,
  identity: { id: string; createdAt: number; updatedAt: number },
  formatVersion: number,
): StoredRefuelingDraft {
  return {
    id: identity.id,
    mode: context.mode,
    recordId: context.recordId,
    base: context.base,
    values: draft.values,
    sources: draft.sources,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    formatVersion,
    savedAt: null,
  };
}
