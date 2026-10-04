import { afterEach, describe, expect, it, vi } from "vitest";
import { RefuelingSyncClient, type GenerationChangedMetadata, type SyncStatus } from "../src/data/refueling-sync";
import type { LocalRefuelingV2Repository } from "../src/data/local-refueling-v2";
import { accountA } from "./helpers/sync-fixtures";
import { SYNC_CONTENT_TYPE, SYNC_PROTOCOL } from "../src/shared/sync-protocol";

const generation = "00000000-0000-4000-8000-0000000000d1";
function response(status = 200, extraHeaders: Record<string, string> = {}, body: Uint8Array | unknown = new Uint8Array([1])) {
  const headers = {
    "Content-Type": SYNC_CONTENT_TYPE, "X-Hako-Account": accountA, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
    "X-Hako-Document-Generation": generation, ...extraHeaders,
  };
  if (typeof body === "string") return new Response(body, { status, headers: { ...headers, "Content-Type": "application/json" } });
  const bytes = body instanceof Uint8Array ? body : new Uint8Array([1]);
  return new Response(bytes as unknown as BodyInit, { status, headers });
}
function setup(fetch: typeof globalThis.fetch, boundGeneration: string | null = generation) {
  const statuses: SyncStatus[] = [];
  const acceptSync = vi.fn(async (_generation: string, _snapshot: Uint8Array, _version: Uint8Array, applies: () => boolean) => {
    if (!applies()) return null;
    return { generation, records: [], pendingSync: false, confirmed: true, importedLegacyIds: [] };
  });
  const onPersisted = vi.fn(); const onSessionRejected = vi.fn();
  const onGenerationChanged = vi.fn<(metadata: GenerationChangedMetadata) => void>();
  const onProtocolOutdated = vi.fn();
  const client = new RefuelingSyncClient({ accountId: accountA, fetch,
    generation: () => boundGeneration,
    repository: {
      load: vi.fn(), save: vi.fn(), importLegacy: vi.fn(), close: vi.fn(), acceptSync,
      prepareSync: async (requested: string) => requested === generation
        ? { snapshot: new Uint8Array([1]), version: new Uint8Array([1]), generation }
        : null,
    } as unknown as LocalRefuelingV2Repository,
    onStatus: (status) => statuses.push(status), onPersisted, onSessionRejected,
    onGenerationChanged, onProtocolOutdated });
  return { client, statuses, acceptSync, onPersisted, onSessionRejected, onGenerationChanged, onProtocolOutdated };
}
async function settle() { await vi.advanceTimersByTimeAsync(1); }
afterEach(() => vi.useRealTimers());

describe("前台同步调度与响应边界（协议 v2）", () => {
  it("v2 请求携带代次头；响应必须回传同一代次，响应丢失进入退避", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue(response());
    const test = setup(fetch);
    test.client.setEnabled(true); await settle();
    expect(test.statuses.at(-1)?.phase).toBe("failed");
    expect(test.onPersisted).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
      "X-Hako-Document-Generation": generation,
      "X-Hako-Account": accountA,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(test.onPersisted).toHaveBeenCalledTimes(1);
    test.client.setEnabled(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("409 document_generation_changed 进入副本保护流程，不触发登录循环", async () => {
    vi.useFakeTimers();
    const metadata = {
      error: "document_generation_changed", currentGeneration: "00000000-0000-4000-8000-0000000000d2",
      legacyGeneration: generation, revision: 3,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(409, {}, JSON.stringify(metadata)));
    const test = setup(fetch);
    test.client.setEnabled(true); await settle();
    expect(test.onGenerationChanged).toHaveBeenCalledTimes(1);
    expect(test.onGenerationChanged.mock.calls[0][0]).toMatchObject({
      currentGeneration: metadata.currentGeneration, legacyGeneration: generation, revision: 3,
    });
    expect(test.onSessionRejected).not.toHaveBeenCalled();
    expect(test.acceptSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    // 保护流程中不再自动重试，不自动上传旧代次。
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("409 account_changed 与 401 仍重查会话；426 停止同步并提示更新", async () => {
    vi.useFakeTimers();
    const accountChanged = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(409, {}, JSON.stringify({ error: "account_changed" })));
    const testAccount = setup(accountChanged);
    testAccount.client.setEnabled(true); await settle();
    expect(testAccount.onSessionRejected).toHaveBeenCalledOnce();
    expect(testAccount.onGenerationChanged).not.toHaveBeenCalled();
    testAccount.client.setEnabled(false);

    const unauthorized = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(401));
    const testUnauthorized = setup(unauthorized);
    testUnauthorized.client.setEnabled(true); await settle();
    expect(testUnauthorized.onSessionRejected).toHaveBeenCalledOnce();
    testUnauthorized.client.setEnabled(false);

    const outdated = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(426, {}, JSON.stringify({ error: "protocol_upgrade_required" })));
    const testOutdated = setup(outdated);
    testOutdated.client.setEnabled(true); await settle();
    expect(testOutdated.onProtocolOutdated).toHaveBeenCalledTimes(1);
    expect(testOutdated.acceptSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(outdated).toHaveBeenCalledTimes(1);
  });

  it("无活动代次时不发起交换；错误账号/代次响应与客户端落盘失败都不确认成功", async () => {
    vi.useFakeTimers();
    const idle = setup(vi.fn<typeof globalThis.fetch>(), null);
    idle.client.setEnabled(true); await settle();
    expect(idle.statuses.at(-1)?.phase).toBe("waiting");
    idle.client.setEnabled(false);

    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(200, { "X-Hako-Account": "wrong-account" }))
      .mockResolvedValueOnce(response(200, { "X-Hako-Document-Generation": "00000000-0000-4000-8000-0000000000d3" }))
      .mockResolvedValue(response());
    const test = setup(fetch);
    test.client.setEnabled(true); await settle();
    expect(test.acceptSync).not.toHaveBeenCalled();
    expect(test.statuses.at(-1)?.phase).toBe("failed");
    test.acceptSync.mockRejectedValueOnce(new Error("storage failure"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.onPersisted).not.toHaveBeenCalled();
    expect(test.statuses.at(-1)?.phase).toBe("failed");
    test.client.setEnabled(false);
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
});

describe("409 正文在途停用（R11 四轮）", () => {
  it.each(["complete", "abort"])("停用后迟到的 409 正文（%s）不触发任何回调", async (mode) => {
    vi.useFakeTimers();
    // 受控正文流：先给 409 的部分 JSON，停用客户端后再完成或中止正文。
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      body = controller;
      controller.enqueue(new TextEncoder().encode('{"error":"document_generation_changed",'));
    } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream as unknown as BodyInit, { status: 409 }));
    const test = setup(fetch);
    try {
      test.client.setEnabled(true); await settle();
      expect(fetch).toHaveBeenCalledOnce();
      test.client.setEnabled(false);
      if (mode === "complete") {
        body.enqueue(new TextEncoder().encode('"currentGeneration":"00000000-0000-4000-8000-0000000000d2"}'));
        body.close();
      } else {
        body.error(new DOMException("body aborted after sync detach", "AbortError"));
      }
      await settle();
      // 正文读完/中止都只是迟到结果：不进入代次保护流程，不触发会话拒绝。
      expect(test.onGenerationChanged).not.toHaveBeenCalled();
      expect(test.onSessionRejected).not.toHaveBeenCalled();
    } finally {
      test.client.setEnabled(false);
    }
  });

  it("当前有效的 409 正文照常进入代次保护流程", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(409, {}, '{"error":"document_generation_changed","currentGeneration":"00000000-0000-4000-8000-0000000000d2"}'));
    const test = setup(fetch);
    try {
      test.client.setEnabled(true); await settle();
      expect(test.onGenerationChanged).toHaveBeenCalledTimes(1);
      expect(test.onGenerationChanged).toHaveBeenCalledWith({
        currentGeneration: "00000000-0000-4000-8000-0000000000d2",
        legacyGeneration: null,
        revision: null,
      });
      expect(test.onSessionRejected).not.toHaveBeenCalled();
    } finally {
      test.client.setEnabled(false);
    }
  });
});
