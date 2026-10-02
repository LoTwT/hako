import { afterEach, describe, expect, it, vi } from "vitest";
import { RefuelingSyncClient, type SyncStatus } from "../src/data/refueling-sync";
import { accountA } from "./helpers/sync-fixtures";
import { SYNC_CONTENT_TYPE, SYNC_PROTOCOL } from "../src/shared/sync-protocol";

function response(status = 200, account = accountA) {
  return new Response(new Uint8Array([1]), { status, headers: {
    "Content-Type": SYNC_CONTENT_TYPE, "X-Hako-Account": account, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
  } });
}
function setup(fetch: typeof globalThis.fetch) {
  const statuses: SyncStatus[] = [];
  const acceptSync = vi.fn(async (_snapshot: Uint8Array, _version: Uint8Array, applies: () => boolean) => {
    if (!applies()) return null;
    return { records: [], pendingSync: false, confirmed: true, importedLegacyIds: [] };
  });
  const onPersisted = vi.fn(); const onSessionRejected = vi.fn();
  const client = new RefuelingSyncClient({ accountId: accountA, fetch,
    repository: { load: vi.fn(), save: vi.fn(), importLegacy: vi.fn(), close: vi.fn(), acceptSync,
      prepareSync: async () => ({ snapshot: new Uint8Array([1]), version: new Uint8Array([1]) }) },
    onStatus: (status) => statuses.push(status), onPersisted, onSessionRejected });
  return { client, statuses, acceptSync, onPersisted, onSessionRejected };
}
async function settle() { await vi.advanceTimersByTimeAsync(1); }
afterEach(() => vi.useRealTimers());

describe("前台同步调度与响应边界", () => {
  it("响应丢失进入退避，重复提交只在本机确认落盘后报告完成", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("lost response")).mockResolvedValue(response());
    const test = setup(fetch);
    test.client.setEnabled(true); await settle();
    expect(test.statuses.at(-1)?.phase).toBe("failed");
    expect(test.onPersisted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(test.onPersisted).toHaveBeenCalledTimes(1);
    test.client.setEnabled(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("退出/账号切换后的迟到响应丢弃；恢复前台立即续传且没有并行请求", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; })).mockResolvedValue(response());
    const test = setup(fetch); test.client.setEnabled(true); await settle();
    test.client.request(); test.client.request();
    expect(fetch).toHaveBeenCalledTimes(1);
    test.client.setEnabled(false); test.client.setEnabled(true);
    release(response()); await settle();
    expect(test.acceptSync).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(test.onPersisted).toHaveBeenCalledTimes(1);
    test.client.setEnabled(false);
  });

  it.each([401, 409])("%s 立即暂停并要求重新检查 session，不循环重试或确认", async (status) => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(status));
    const test = setup(fetch); test.client.setEnabled(true); await settle();
    expect(test.onSessionRejected).toHaveBeenCalledOnce();
    expect(test.acceptSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("错误账号响应、客户端落盘失败都不确认成功", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(200, "wrong-account")).mockResolvedValue(response());
    const test = setup(fetch); test.client.setEnabled(true); await settle();
    expect(test.acceptSync).not.toHaveBeenCalled();
    expect(test.statuses.at(-1)?.phase).toBe("failed");
    test.acceptSync.mockRejectedValueOnce(new Error("storage failure"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.onPersisted).not.toHaveBeenCalled();
    expect(test.statuses.at(-1)?.phase).toBe("failed");
    test.client.setEnabled(false);
  });
});
