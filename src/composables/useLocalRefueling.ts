import { computed, onMounted, onUnmounted, readonly, shallowRef, watch } from "vue";
import { openLocalRefueling, type LocalRefuelingRepository, type LocalRefuelingState } from "../data/local-refueling";
import { accountStorageNames } from "../data/account-storage";
import { RefuelingSyncClient, type SyncStatus } from "../data/refueling-sync";
import type { RefuelingRecord, SavedRefuelingRecord } from "../domain/refueling/form";

export function useLocalRefueling(options: { accountId: string; active: () => boolean; onSessionRejected: () => void }) {
  const records = shallowRef<SavedRefuelingRecord[]>([]);
  const ready = shallowRef(false);
  const saving = shallowRef(false);
  const error = shallowRef("");
  const persistent = shallowRef<boolean | null>(null);
  const pendingSync = shallowRef(false);
  const confirmed = shallowRef(false);
  const importedLegacyIds = shallowRef<string[]>([]);
  const syncStatus = shallowRef<SyncStatus>({ phase: "paused", message: "" });
  const foregroundOnline = shallowRef(document.visibilityState === "visible" && navigator.onLine);
  const notice = computed(() => {
    if (!ready.value) return "正在打开账号的本机记录…";
    if (saving.value) return "正在保存到本机…";
    const local = pendingSync.value ? "已保存到本机 · 有待上传修改" : confirmed.value ? "本机版本已由服务端持久保存" : "本机副本尚未与服务端确认";
    return syncStatus.value.message ? `${local} · ${syncStatus.value.message}` : local;
  });
  let repository: LocalRefuelingRepository | undefined;
  let sync: RefuelingSyncClient | undefined;
  let channel: BroadcastChannel | undefined;
  let disposed = false;
  let loadSequence = 0;
  let initializing: Promise<void> | undefined;

  function describeError(value: unknown): string {
    if (value instanceof DOMException && value.name === "QuotaExceededError")
      return "本机存储空间不足，未保存成功。表单仍保留，请释放空间后重试。";
    return value instanceof Error ? `未完成本机操作：${value.message}。请保留表单后重试。` : "本机存储不可用，请保留表单后重试。";
  }
  function apply(state: LocalRefuelingState) {
    records.value = state.records;
    pendingSync.value = state.pendingSync;
    confirmed.value = state.confirmed;
    importedLegacyIds.value = state.importedLegacyIds;
  }
  function notify() {
    try { channel?.postMessage("changed"); } catch { /* Focus refresh is the fallback. */ }
  }
  async function refresh() {
    if (!repository || saving.value) return;
    const sequence = ++loadSequence;
    try {
      const loaded = await repository.load();
      if (!disposed && sequence === loadSequence) apply(loaded);
    } catch (failure) { if (!disposed) error.value = describeError(failure); }
  }
  function updateSyncEnabled() {
    sync?.setEnabled(!disposed && options.active() && foregroundOnline.value && ready.value);
  }
  async function open() {
    if (saving.value) return;
    ready.value = false;
    sync?.setEnabled(false);
    error.value = "";
    try {
      repository?.close();
      repository = await openLocalRefueling(options.accountId);
      if (disposed) { repository.close(); return; }
      apply(await repository.load());
      sync = new RefuelingSyncClient({
        accountId: options.accountId, repository,
        onStatus: (status) => { syncStatus.value = status; },
        onPersisted: () => { notify(); void refresh(); },
        onSessionRejected: options.onSessionRejected,
      });
      ready.value = true;
      updateSyncEnabled();
      persistent.value = (await navigator.storage?.persisted?.()) ?? null;
    } catch (failure) { error.value = describeError(failure); }
  }
  function initialize() {
    initializing ??= open().finally(() => { initializing = undefined; });
    return initializing;
  }
  async function mutate(operation: (repository: LocalRefuelingRepository) => Promise<LocalRefuelingState>): Promise<boolean> {
    if (!repository || !ready.value || saving.value || !options.active()) return false;
    saving.value = true;
    ++loadSequence;
    error.value = "";
    try {
      apply(await operation(repository));
      notify();
      sync?.request();
      return true;
    } catch (failure) {
      error.value = describeError(failure);
      return false;
    } finally { saving.value = false; void refresh(); }
  }
  async function requestPersistence() {
    try { persistent.value = (await navigator.storage?.persist?.()) ?? false; }
    catch { persistent.value = false; }
  }
  const onEnvironment = () => {
    foregroundOnline.value = document.visibilityState === "visible" && navigator.onLine;
    updateSyncEnabled();
    if (document.visibilityState === "visible") void refresh();
  };
  watch([options.active, foregroundOnline], updateSyncEnabled, { flush: "sync" });
  onMounted(() => {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(accountStorageNames(options.accountId).changes);
      channel.onmessage = () => { void refresh(); };
    }
    window.addEventListener("focus", onEnvironment);
    window.addEventListener("online", onEnvironment);
    window.addEventListener("offline", onEnvironment);
    document.addEventListener("visibilitychange", onEnvironment);
    void initialize();
  });
  onUnmounted(() => {
    disposed = true;
    sync?.setEnabled(false);
    channel?.close();
    repository?.close();
    window.removeEventListener("focus", onEnvironment);
    window.removeEventListener("online", onEnvironment);
    window.removeEventListener("offline", onEnvironment);
    document.removeEventListener("visibilitychange", onEnvironment);
  });
  return {
    records: readonly(records), ready: readonly(ready), saving: readonly(saving), error: readonly(error),
    notice, persistent: readonly(persistent), importedLegacyIds: readonly(importedLegacyIds),
    save: (id: string, patch: Partial<RefuelingRecord>, creating: boolean) => mutate((repo) => repo.save(id, patch, creating)),
    importLegacy: (selected: SavedRefuelingRecord[]) => mutate((repo) => repo.importLegacy(selected)),
    initialize, refresh, requestPersistence, retrySync: () => sync?.request(),
  };
}
