import { onMounted, onUnmounted, readonly, shallowRef } from "vue";
import { changeChannelName, openLocalRefueling } from "../data/local-refueling";
import type {
  RefuelingRecord,
  SavedRefuelingRecord,
} from "../domain/refueling/form";

export function useLocalRefueling() {
  const records = shallowRef<SavedRefuelingRecord[]>([]);
  const ready = shallowRef(false);
  const saving = shallowRef(false);
  const error = shallowRef("");
  const notice = shallowRef("正在打开本机记录…");
  const persistent = shallowRef<boolean | null>(null);
  let repository: Awaited<ReturnType<typeof openLocalRefueling>> | undefined;
  let channel: BroadcastChannel | undefined;
  let disposed = false;
  let loadSequence = 0;

  function describeError(value: unknown): string {
    if (value instanceof DOMException && value.name === "QuotaExceededError")
      return "本机存储空间不足，未保存成功。表单仍保留，请释放空间后重试。";
    return value instanceof Error
      ? `未完成本机操作：${value.message}。请保留表单后重试。`
      : "本机存储不可用，请保留表单后重试。";
  }

  async function refresh() {
    if (!repository || saving.value) return;
    const sequence = ++loadSequence;
    try {
      const loaded = await repository.load();
      if (!disposed && sequence === loadSequence) records.value = loaded;
    } catch (failure) {
      if (!disposed) error.value = describeError(failure);
    }
  }

  async function initialize() {
    if (saving.value) return;
    ready.value = false;
    error.value = "";
    try {
      repository?.close();
      repository = await openLocalRefueling();
      if (disposed) {
        repository.close();
        return;
      }
      records.value = await repository.load();
      ready.value = true;
      notice.value = "记录保存在此浏览器，云端同步尚未接入。";
      persistent.value = (await navigator.storage?.persisted?.()) ?? null;
    } catch (failure) {
      error.value = describeError(failure);
    }
  }

  async function save(
    id: string,
    patch: Partial<RefuelingRecord>,
    creating: boolean,
  ): Promise<boolean> {
    if (!repository || !ready.value || saving.value) return false;
    saving.value = true;
    ++loadSequence;
    error.value = "";
    notice.value = "正在保存到本机…";
    try {
      records.value = await repository.save(id, patch, creating);
      notice.value = "已保存到本机 · 尚未上传云端";
      try {
        channel?.postMessage("saved");
      } catch {
        /* Peers also refresh on focus. */
      }
      return true;
    } catch (failure) {
      error.value = describeError(failure);
      notice.value = "保存失败，输入仍保留。";
      return false;
    } finally {
      saving.value = false;
      void refresh();
    }
  }

  async function requestPersistence() {
    try {
      persistent.value = (await navigator.storage?.persist?.()) ?? false;
    } catch {
      persistent.value = false;
    }
  }

  const onVisible = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  onMounted(() => {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(changeChannelName);
      channel.onmessage = () => {
        void refresh();
      };
    }
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    void initialize();
  });
  onUnmounted(() => {
    disposed = true;
    channel?.close();
    repository?.close();
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  });
  return {
    records: readonly(records),
    ready: readonly(ready),
    saving: readonly(saving),
    error: readonly(error),
    notice: readonly(notice),
    persistent: readonly(persistent),
    save,
    initialize,
    refresh,
    requestPersistence,
  };
}
