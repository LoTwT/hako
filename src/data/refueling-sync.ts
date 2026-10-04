import type { LocalRefuelingV2Repository } from "./local-refueling-v2";
import {
  MAX_SYNC_BYTES,
  readSyncBody,
  SYNC_CONTENT_TYPE,
  SYNC_PATH,
  SYNC_PROTOCOL,
} from "../shared/sync-protocol";

export interface SyncStatus {
  phase: "paused" | "syncing" | "waiting" | "failed";
  message: string;
}

/** 409 document_generation_changed 附带的当前代次元数据（不含业务快照）。 */
export interface GenerationChangedMetadata {
  currentGeneration: string;
  legacyGeneration: string | null;
  revision: number | null;
}

interface SyncOptions {
  accountId: string;
  repository: LocalRefuelingV2Repository;
  /** 调用实例绑定的代次（工作区代次）；每次交换在仓库事务内复核持久 activeGeneration。 */
  generation: () => string | null;
  fetch?: typeof fetch;
  onStatus: (status: SyncStatus) => void;
  onPersisted: () => void;
  onSessionRejected: () => void;
  /** 代次变化：进入副本保护流程，不触发登录循环。 */
  onGenerationChanged: (metadata: GenerationChangedMetadata) => void;
  /** 426：本版客户端已过旧，等待应用更新；本机数据保留。 */
  onProtocolOutdated: () => void;
}

class SyncFailure extends Error {}

/**
 * 单实例串行交换（协议 v2）；停用立即换世代并取消网络，任何迟到结果均不可应用。
 * 一次交换绑定账号、文档代次与请求 epoch：响应必须回传同一代次，代次不匹配按
 * document_generation_changed 进入副本保护流程；已失活代次的迟到响应不能写入
 * 新代次或更新其确认游标（由仓库在同一事务内复核 activeGeneration）。
 */
export class RefuelingSyncClient {
  private enabled = false;
  private epoch = 0;
  private running = false;
  private requested = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly options: SyncOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.epoch += 1;
    clearTimeout(this.timer);
    if (!enabled) {
      this.controller?.abort();
      this.options.onStatus({ phase: "paused", message: "同步已暂停，本机修改保留。" });
    } else this.request();
  }

  request(): void {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    if (this.running) { this.requested = true; return; }
    void this.exchange();
  }

  private async exchange(): Promise<void> {
    this.running = true;
    this.requested = false;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    const applies = () => this.enabled && this.epoch === epoch && !controller.signal.aborted;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    this.options.onStatus({ phase: "syncing", message: "正在同步…" });
    try {
      // 实例代次绑定：交换从调用实例绑定的代次出发；仓库在事务内复核持久
      // activeGeneration，已失活代次不提供快照（返回 null，等待重新接收）。
      const generation = this.options.generation();
      if (generation === null) {
        this.options.onStatus({ phase: "waiting", message: "" });
        return;
      }
      const outgoing = await this.options.repository.prepareSync(generation);
      if (!applies()) return;
      if (outgoing === null) {
        // 绑定代次已失活（其他窗口已接收新代次）：不再替旧实例发送。
        this.options.onStatus({ phase: "waiting", message: "" });
        return;
      }
      if (outgoing.snapshot.byteLength > MAX_SYNC_BYTES) throw new SyncFailure("文档超过本版同步容量，本机记录已保留。");
      const response = await (this.options.fetch ?? fetch)(SYNC_PATH, {
        method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
        headers: {
          "Content-Type": SYNC_CONTENT_TYPE,
          "X-Hako-Account": this.options.accountId,
          "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
          "X-Hako-Document-Generation": outgoing.generation,
        },
        body: new Uint8Array(outgoing.snapshot),
      });
      if (!applies()) return;
      if (response.status === 426) {
        this.setEnabled(false);
        this.options.onProtocolOutdated();
        return;
      }
      if (response.status === 409) {
        // 正文读取是 await 出口：停用/换代可能发生在读取期间。读完必须复核
        // 实例/请求资格——迟到的完整正文不能再触发代次保护，中止（AbortError
        // → 解析为 null）也不能触发会话拒绝；只有当前有效的 409 才走回调。
        const metadata = await readGenerationChangeMetadata(response);
        if (!applies()) return;
        if (metadata !== null) {
          this.setEnabled(false);
          this.options.onGenerationChanged(metadata);
          return;
        }
        this.setEnabled(false);
        this.options.onSessionRejected();
        return;
      }
      if (response.status === 401) {
        this.setEnabled(false);
        this.options.onSessionRejected();
        return;
      }
      if (response.status === 413) throw new SyncFailure("文档超过本版同步容量，本机记录已保留。");
      if (!response.ok) throw new SyncFailure("同步未完成，本机修改保留，将自动重试。");
      if (response.headers.get("X-Hako-Account") !== this.options.accountId
        || response.headers.get("X-Hako-Sync-Protocol") !== SYNC_PROTOCOL
        || response.headers.get("Content-Type") !== SYNC_CONTENT_TYPE
        || response.headers.get("X-Hako-Document-Generation") !== outgoing.generation) {
        throw new SyncFailure("同步响应不匹配，未确认已同步，将自动重试。");
      }
      const snapshot = await readSyncBody(response.body);
      if (!applies()) return;
      const accepted = await this.options.repository.acceptSync(outgoing.generation, snapshot, outgoing.version, applies);
      if (!applies() || accepted === null) return;
      this.failures = 0;
      this.options.onPersisted();
      this.options.onStatus({ phase: "waiting", message: "" });
      if (accepted.pendingSync) this.requested = true;
    } catch (error) {
      // timeout 与网络失败保留待传状态；主动取消/切换世代不改写新状态。
      if (!this.enabled || this.epoch !== epoch) return;
      this.failures += 1;
      this.options.onStatus({ phase: "failed", message: error instanceof SyncFailure
        ? error.message : "同步中断或未能保存确认，本机修改保留，将自动重试。" });
    } finally {
      clearTimeout(timeout);
      this.running = false;
      if (this.enabled) {
        const delay = this.failures ? [2000, 5000, 15000, 30000][Math.min(this.failures - 1, 3)] : 30000;
        this.timer = setTimeout(() => this.request(), this.requested && !this.failures ? 0 : delay);
      }
    }
  }
}

/** 解析 409 响应：只有 document_generation_changed 是代次变化，其余按会话问题处理。 */
async function readGenerationChangeMetadata(response: Response): Promise<GenerationChangedMetadata | null> {
  try {
    const body = await response.json() as Record<string, unknown>;
    if (body.error !== "document_generation_changed" || typeof body.currentGeneration !== "string") return null;
    return {
      currentGeneration: body.currentGeneration,
      legacyGeneration: typeof body.legacyGeneration === "string" ? body.legacyGeneration : null,
      revision: typeof body.revision === "number" && Number.isSafeInteger(body.revision) ? body.revision : null,
    };
  } catch {
    return null;
  }
}
