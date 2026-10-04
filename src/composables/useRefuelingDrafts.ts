import { onUnmounted, readonly, shallowRef } from "vue";
import {
  createSessionLocatorStorage,
  createWebLocksPageClaim,
  createUnclaimedPageClaim,
} from "../data/draft-environment";
import { openRefuelingDraftStore } from "../data/refueling-draft-store";
import {
  RefuelingDraftSession,
  type DraftDiscardResult,
  type DraftRecoveryStatus,
} from "../data/refueling-draft-session";
import type { DraftFormContext } from "../domain/refueling/draft-recovery";
import type { RefuelingDraft, SavedRefuelingRecord } from "../domain/refueling/form";
import { accountStorageNamesV2 } from "../data/account-storage";

export interface RefuelingDraftSnapshot {
  status: "loading" | "ready";
  recovery: DraftRecoveryStatus;
  writeError: string;
  orphanedEditCount: number;
  unsupportedCount: number;
}

/**
 * 草稿接线（v2，按账号+代次隔离）：独立 IndexedDB 草稿库 + 页面占用 + 合并写。
 * 工作区按代次挂载（AccountWorkspace 以活动代次为 key），因此每个实例的
 * generation 在生命周期内固定；代次切换后旧实例的待写内容在 flush 完成后才
 * 卸载，旧代次草稿库原样保留、只读查看。
 * knownRecords 由业务记录列表提供，用于识别已保存草稿、找不到记录的编辑草稿
 * 与内容已经一致的草稿。
 */
export function useRefuelingDrafts(options: { accountId: string; generation: string | null; knownRecords: () => ReadonlyMap<string, SavedRefuelingRecord> }) {
  const snapshot = shallowRef<RefuelingDraftSnapshot>({
    status: "loading",
    recovery: { status: "loading" },
    writeError: "",
    orphanedEditCount: 0,
    unsupportedCount: 0,
  });
  let session: RefuelingDraftSession | null = null;
  // 页面可能在草稿库就绪前就绑定了表单上下文，先记下来在会话建立时应用
  let pendingContext: DraftFormContext | null = null;
  let pendingContextOptions: { keepLocator?: boolean } | undefined;
  // 草稿库打开完成前的输入先留在内存里，等会话就绪后补写一次，不静默丢弃
  let deferredDraft: RefuelingDraft | null = null;

  function sync() {
    if (session === null) return;
    snapshot.value = {
      status: "ready",
      recovery: session.recovery,
      writeError: session.writeError,
      orphanedEditCount: session.orphanedEditCount,
      unsupportedCount: session.unsupportedCount,
    };
  }

  async function initialize() {
    if (session !== null || options.generation === null) {
      // 没有活动代次（保护流程/全新打开）：草稿按各自代次保留，本实例无可恢复内容。
      snapshot.value = {
        status: "ready",
        recovery: { status: "ready", candidates: [], notice: "" },
        writeError: "",
        orphanedEditCount: 0,
        unsupportedCount: 0,
      };
      return;
    }
    const names = accountStorageNamesV2(options.accountId);
    const claim =
      typeof navigator !== "undefined" && "locks" in navigator
        ? createWebLocksPageClaim(navigator.locks, names.draftScopeFor(options.generation))
        : createUnclaimedPageClaim();
    try {
      const store = await openRefuelingDraftStore(names.draftsFor(options.generation));
      session = new RefuelingDraftSession({
        store,
        locator: createSessionLocatorStorage(names.draftScopeFor(options.generation)),
        claim,
        knownRecords: options.knownRecords,
        onChange: sync,
      });
      if (pendingContext !== null) session.attachForm(pendingContext, pendingContextOptions ?? {});
      await session.initialize();
      // initialize() 决定是否恢复既有草稿；没有恢复时才补写挂载早期的输入，
      // 避免与自动恢复抢同一份草稿留下多余条目。
      const buffered = deferredDraft;
      deferredDraft = null;
      if (
        buffered !== null &&
        session.currentDraft() === null &&
        session.currentFormContext() !== null
      ) {
        session.updateDraft(buffered);
      }
    } catch {
      // 草稿库不可用：仍可编辑，但登录跳转会被阻止（flush 返回 false）
      snapshot.value = {
        status: "ready",
        recovery: {
          status: "error",
          message: "草稿库不可用，仍可继续编辑，但登录跳转会被阻止。",
        },
        writeError: "",
        orphanedEditCount: 0,
        unsupportedCount: 0,
      };
    }
    sync();
  }

  onUnmounted(() => {
    session?.close();
    session = null;
  });

  return {
    drafts: readonly(snapshot),
    initialize,
    attachForm: (context: DraftFormContext, attachOptions?: { keepLocator?: boolean }) => {
      pendingContext = context;
      pendingContextOptions = attachOptions;
      session?.attachForm(context, attachOptions);
    },
    updateDraft: (draft: RefuelingDraft) => {
      if (session === null) {
        deferredDraft = draft;
        return;
      }
      session.updateDraft(draft);
    },
    currentDraftId: () => session?.currentDraft() ?? null,
    adoptedDraft: () => session?.adoptedDraft ?? null,
    flush: async () => {
      // 草稿库未就绪或挂载早期输入还没补写：不放行登录跳转
      if (session === null) return deferredDraft === null && options.generation === null;
      const flushed = await session.flush();
      if (!flushed) return false;
      return deferredDraft === null;
    },
    adopt: async (draftId: string) => {
      const draft = (await session?.adopt(draftId)) ?? null;
      sync();
      return draft;
    },
    discard: async (draftId: string) => {
      const result: DraftDiscardResult = (await session?.discard(draftId)) ?? "failed";
      sync();
      return result;
    },
    clearAfterSave: async () => {
      const result = (await session?.clearAfterSave()) ?? { ok: false, message: "草稿库不可用。" };
      sync();
      return result;
    },
  };
}
