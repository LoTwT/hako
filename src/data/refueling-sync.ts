import type { LocalRefuelingRepository } from "./local-refueling";
import { MAX_SYNC_BYTES, readSyncBody, SYNC_CONTENT_TYPE, SYNC_PATH, SYNC_PROTOCOL } from "../shared/sync-protocol";

export interface SyncStatus {
  phase: "paused" | "syncing" | "waiting" | "failed";
  message: string;
}
interface SyncOptions {
  accountId: string;
  repository: LocalRefuelingRepository;
  fetch?: typeof fetch;
  onStatus: (status: SyncStatus) => void;
  onPersisted: () => void;
  onSessionRejected: () => void;
}

class SyncFailure extends Error {}

/** 单实例串行交换；停用立即换世代并取消网络，任何迟到结果均不可应用。 */
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
      const outgoing = await this.options.repository.prepareSync();
      if (!applies()) return;
      if (outgoing.snapshot.byteLength > MAX_SYNC_BYTES) throw new SyncFailure("文档超过本版同步容量，本机记录已保留。");
      const response = await (this.options.fetch ?? fetch)(SYNC_PATH, {
        method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
        headers: { "Content-Type": SYNC_CONTENT_TYPE, "X-Hako-Account": this.options.accountId, "X-Hako-Sync-Protocol": SYNC_PROTOCOL },
        body: new Uint8Array(outgoing.snapshot),
      });
      if (!applies()) return;
      if (response.status === 401 || response.status === 409) {
        this.setEnabled(false);
        this.options.onSessionRejected();
        return;
      }
      if (response.status === 413) throw new SyncFailure("文档超过本版同步容量，本机记录已保留。");
      if (!response.ok) throw new SyncFailure("同步未完成，本机修改保留，将自动重试。");
      if (response.headers.get("X-Hako-Account") !== this.options.accountId
        || response.headers.get("X-Hako-Sync-Protocol") !== SYNC_PROTOCOL
        || response.headers.get("Content-Type") !== SYNC_CONTENT_TYPE) throw new SyncFailure("同步响应不匹配，未确认已同步，将自动重试。");
      const snapshot = await readSyncBody(response.body);
      if (!applies()) return;
      const accepted = await this.options.repository.acceptSync(snapshot, outgoing.version, applies);
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
