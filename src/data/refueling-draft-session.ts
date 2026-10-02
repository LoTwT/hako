// 草稿会话：把表单变更合并写入独立草稿库，并在登录跳转前强制等待
// 最新版本落盘。合并写保证“最后被持久化的草稿与实际离页输入一致”：
// 同一份草稿的写入按 id 合并为最新版本，写入串行执行；失败时保留
// 最新待写版本（更新的输入不会被较旧的失败版本覆盖），flush() 只有
// 在待写队列清空且无写入错误时才报告成功。
// 待写/在途写入与页面占用同生命周期：只要本页还可能补写某份草稿，就继续
// 持有它的占用；写完最后一份内容后才释放，因此其他页面不会在旧页面仍有
// 补写机会时接管，也不存在“释放占用后又写回”的路径。

import type { RefuelingDraft, SavedRefuelingRecord } from "../domain/refueling/form";
import {
  draftFromContext,
  planDraftRecovery,
  type DraftFormContext,
  type StoredRefuelingDraft,
} from "../domain/refueling/draft-recovery";
import { refuelingDraftFormatVersion, type RefuelingDraftStore } from "./refueling-draft-store";
import type { DraftLocatorStorage, DraftPageClaim } from "./draft-environment";

const locatorKey = "hako-refueling-draft-locator";

/** 放弃草稿的结果：被其他活跃页面持有时不删除。 */
export type DraftDiscardResult = "discarded" | "held" | "failed";

export type DraftRecoveryStatus =
  | { status: "loading" }
  | { status: "ready"; candidates: StoredRefuelingDraft[]; notice: string }
  | { status: "error"; message: string };

export interface RefuelingDraftSessionOptions {
  store: RefuelingDraftStore;
  locator: DraftLocatorStorage;
  claim: DraftPageClaim;
  /** 当前业务库中的已知记录，用于识别已保存草稿、找不到记录的编辑草稿与内容一致的草稿。 */
  knownRecords(): ReadonlyMap<string, SavedRefuelingRecord>;
  now?: () => number;
  createId?: () => string;
  /** 状态变化通知（写入成功/失败、恢复状态变化），供界面刷新。 */
  onChange?: () => void;
}

export class RefuelingDraftSession {
  recovery: DraftRecoveryStatus = { status: "loading" };
  /** 最近一次草稿写入失败的可读提示；成功写入后清空。 */
  writeError = "";
  /** 保留但因找不到对应记录而未恢复的编辑草稿数量。 */
  orphanedEditCount = 0;
  /** 草稿库中格式版本不受支持的条目数量。 */
  unsupportedCount = 0;
  /** 最近一次通过 adopt() 恢复的草稿；页面据此填充表单。 */
  adoptedDraft: StoredRefuelingDraft | null = null;

  private context: DraftFormContext | null = null;
  private currentDraftId: string | null = null;
  private createdAt = 0;
  /** 待写草稿：按 id 合并为最新版本；不同草稿各自保留，互不覆盖。 */
  private pendingWrites = new Map<string, StoredRefuelingDraft>();
  /** 正在写入的草稿 id：写事务已创建、结果未知。 */
  private writingDraftId: string | null = null;
  private writeChain: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: RefuelingDraftSessionOptions) {}

  private notify(): void {
    this.options.onChange?.();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private createId(): string {
    return (this.options.createId ?? (() => crypto.randomUUID()))();
  }

  /** 启动时加载草稿、清理已保存草稿并按线索或选择决定恢复方式。 */
  async initialize(): Promise<void> {
    try {
      const { drafts, unsupportedCount } = await this.options.store.list();
      this.unsupportedCount = unsupportedCount;
      const claimedDraftIds = new Set<string>();
      for (const draft of drafts) {
        if (await this.options.claim.isHeldByAnotherPage(draft.id)) claimedDraftIds.add(draft.id);
      }
      const decision = planDraftRecovery({
        drafts,
        hintDraftId: this.options.locator.get(locatorKey),
        claimedDraftIds,
        knownRecords: this.options.knownRecords(),
      });
      this.orphanedEditCount = decision.orphanedEditCount;
      for (const draftId of decision.cleanupDraftIds) {
        // 清理也要在操作时确认占用：列表生成后其他页面可能已经接管这份草稿
        if (!(await this.options.claim.tryClaim(draftId))) continue;
        try {
          await this.options.store.remove(draftId);
        } catch {
          continue;
        } finally {
          this.options.claim.release(draftId);
        }
        this.pendingWrites.delete(draftId);
        if (this.options.locator.get(locatorKey) === draftId) this.options.locator.remove(locatorKey);
      }
      if (decision.plan.kind === "restore") {
        const adopted = await this.adopt(decision.plan.draft.id);
        if (adopted) return;
        this.recovery = {
          status: "ready",
          candidates: [],
          notice: "上次的草稿正被其他窗口使用，本窗口从空白表单开始。",
        };
        this.notify();
        return;
      }
      if (decision.plan.kind === "choose") {
        this.recovery = {
          status: "ready",
          candidates: decision.plan.drafts,
          notice: "发现未保存的草稿，请选择恢复或放弃。",
        };
        this.notify();
        return;
      }
      this.recovery = { status: "ready", candidates: [], notice: "" };
      this.notify();
    } catch (error) {
      this.recovery = {
        status: "error",
        message: `草稿库不可用：${describeDraftError(error)} 仍可继续编辑，但登录跳转会被阻止。`,
      };
      this.notify();
    }
  }

  currentDraft(): string | null {
    return this.currentDraftId;
  }

  currentFormContext(): DraftFormContext | null {
    return this.context;
  }

  /**
   * 表单实例切换（新建/编辑/恢复）：绑定当前草稿上下文。
   * keepLocator 用于页面首次挂载：此时定位线索还没被 initialize() 读取，不能提前清除。
   */
  attachForm(context: DraftFormContext, options: { keepLocator?: boolean } = {}): void {
    const previous = this.currentDraftId;
    this.adoptedDraft = null;
    this.context = context;
    this.currentDraftId = null;
    this.createdAt = 0;
    if (previous !== null && !this.hasUnwrittenContent(previous)) {
      // 还有待写或在途写入时继续持有占用，写完后再由 releaseSettledClaim 释放：
      // 否则其他页面可能接管，而本页稍后补写会把新内容覆盖回旧版本。
      this.options.claim.release(previous);
    }
    if (options.keepLocator !== true) this.options.locator.remove(locatorKey);
  }

  /** 表单编辑：合并写入（同一时刻最多一个写事务，后续变更覆盖待写内容）。 */
  updateDraft(draft: RefuelingDraft): void {
    if (this.closed || this.context === null) return;
    const timestamp = this.now();
    const draftId = this.currentDraftId ?? this.createId();
    if (this.currentDraftId === null) {
      this.currentDraftId = draftId;
      this.createdAt = timestamp;
      this.options.locator.set(locatorKey, draftId);
      // 新草稿的 id 是新生成的，占用必然成功；先占住是为了让其他页面
      // （例如复制出的标签页带着同一线索）无法抢占这份正在编辑的草稿。
      void this.options.claim.tryClaim(draftId);
    }
    const stored = draftFromContext(
      this.context,
      draft,
      { id: draftId, createdAt: this.createdAt, updatedAt: timestamp },
      refuelingDraftFormatVersion,
    );
    // 同一份草稿只保留最新版本；切换表单不会挤掉另一份尚未落盘的草稿
    this.pendingWrites.delete(draftId);
    this.pendingWrites.set(draftId, stored);
    this.startWriteChain();
    this.notify();
  }

  /**
   * 等待待写草稿写入完成；失败时保留待写内容，本次调用重试一次。
   * 只有待写队列清空且没有写入错误时才算成功：调用方据此判断
   * “当前表单版本确已落盘”。
   */
  async flush(): Promise<boolean> {
    while (this.writeChain !== null) await this.writeChain;
    if (this.pendingWrites.size === 0) return this.writeError === "";
    // 上一次写失败或仍有更新：本次 flush 重新尝试一次，避免无限重试
    this.startWriteChain();
    while (this.writeChain !== null) await this.writeChain;
    return this.pendingWrites.size === 0 && this.writeError === "";
  }

  /** 用户选择恢复：原子占用草稿并返回内容；失败表示被其他活跃页面占用。 */
  async adopt(draftId: string): Promise<StoredRefuelingDraft | null> {
    const draft = await this.options.store.get(draftId);
    if (draft === null) return null;
    if (!(await this.options.claim.tryClaim(draftId))) return null;
    this.context = { mode: draft.mode, recordId: draft.recordId, base: draft.base };
    this.currentDraftId = draftId;
    this.createdAt = draft.createdAt;
    this.pendingWrites.delete(draftId);
    this.options.locator.set(locatorKey, draftId);
    this.adoptedDraft = draft;
    this.recovery = { status: "ready", candidates: [], notice: "" };
    this.notify();
    return draft;
  }

  /**
   * 用户明确放弃草稿：先原子占用再删除，避免删掉其他活跃页面正在编辑
   * 的草稿（恢复列表只是快照，占用可能在列表生成后发生变化）。
   */
  async discard(draftId: string): Promise<DraftDiscardResult> {
    if (!(await this.options.claim.tryClaim(draftId))) return "held";
    this.pendingWrites.delete(draftId);
    try {
      await this.options.store.remove(draftId);
    } catch (error) {
      this.options.claim.release(draftId);
      this.writeError = `未能删除草稿：${describeDraftError(error)}`;
      this.notify();
      return "failed";
    }
    this.options.claim.release(draftId);
    if (this.currentDraftId === draftId) this.currentDraftId = null;
    if (this.options.locator.get(locatorKey) === draftId) this.options.locator.remove(locatorKey);
    this.recovery = { status: "ready", candidates: [], notice: "" };
    this.notify();
    return "discarded";
  }

  /**
   * 业务保存成功后清除当前草稿。清理分两步：先写入“已保存”标记，再删除。
   * 这样即使删除失败，下次启动也能凭标记识别这份已经保存过的草稿；标记
   * 本身写不进去时不承诺自动清理，只给出可读提示。
   */
  async clearAfterSave(): Promise<{ ok: boolean; message: string }> {
    const draftId = this.currentDraftId;
    const savedAt = this.now();
    this.context = null;
    this.currentDraftId = null;
    this.adoptedDraft = null;
    this.createdAt = 0;
    this.options.locator.remove(locatorKey);
    if (draftId === null) {
      this.notify();
      return { ok: true, message: "" };
    }
    // 业务保存已成功：这份草稿不再补写，避免删除后又被队列写回来
    this.pendingWrites.delete(draftId);
    const stored = await this.options.store.get(draftId).catch(() => null);
    if (stored === null) {
      // 没写进去，或条目已不可识别（后者按既有策略保留，不在这里删除）
      this.options.claim.release(draftId);
      this.notify();
      return { ok: true, message: "" };
    }
    try {
      await this.options.store.put({ ...stored, savedAt });
    } catch (error) {
      this.options.claim.release(draftId);
      this.notify();
      return {
        ok: false,
        message: `记录已保存，但草稿未能标记或删除：${describeDraftError(error)} 下次打开会核对内容，一致时自动清理，否则列出供你确认。`,
      };
    }
    try {
      await this.options.store.remove(draftId);
    } catch (error) {
      this.options.claim.release(draftId);
      this.notify();
      return {
        ok: false,
        message: `记录已保存，但草稿未能删除：${describeDraftError(error)} 草稿已标记为已保存，下次打开会自动清理。`,
      };
    }
    this.options.claim.release(draftId);
    this.notify();
    return { ok: true, message: "" };
  }

  close(): void {
    this.closed = true;
    this.options.claim.releaseAll();
  }

  private startWriteChain(): void {
    if (this.writeChain !== null) return;
    this.writeChain = this.drainWrites().finally(() => {
      this.writeChain = null;
    });
  }

  /** 该草稿是否还有未落盘的内容（待写版本或正在写入）。 */
  private hasUnwrittenContent(draftId: string): boolean {
    return this.pendingWrites.has(draftId) || this.writingDraftId === draftId;
  }

  /** 最后一份内容写完后释放占用：不再是当前草稿且没有待写/在途内容。 */
  private releaseSettledClaim(draftId: string): void {
    if (this.currentDraftId === draftId) return;
    if (this.hasUnwrittenContent(draftId)) return;
    this.options.claim.release(draftId);
  }

  private async drainWrites(): Promise<void> {
    while (this.pendingWrites.size > 0 && !this.closed) {
      const [draftId, draft] = [...this.pendingWrites.entries()][0];
      this.pendingWrites.delete(draftId);
      this.writingDraftId = draftId;
      try {
        await this.options.store.put(draft);
        this.writeError = "";
        this.writingDraftId = null;
        this.notify();
        this.releaseSettledClaim(draftId);
      } catch (error) {
        // 写入期间可能有同一草稿的更新版本：补回旧版本会覆盖更新的输入
        if (!this.pendingWrites.has(draftId)) {
          this.pendingWrites.delete(draftId);
          this.pendingWrites.set(draftId, draft);
        }
        this.writeError = `草稿未保存：${describeDraftError(error)}`;
        this.writingDraftId = null;
        this.notify();
        return;
      }
    }
  }
}

export function describeDraftError(value: unknown): string {
  if (value instanceof DOMException && value.name === "QuotaExceededError") {
    return "本机存储空间不足。";
  }
  return value instanceof Error ? `${value.message}。` : "本机存储不可用。";
}
