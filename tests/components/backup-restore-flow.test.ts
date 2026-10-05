// 面板与本机仓储的接线证明（真实 IndexedDB + 真实组合层 + 真实编译 SFC）：
// 重开面板读取持久 pending、本人以原 ID 重试、终态先落盘才解除，以及旧 POST
// 迟到结果不覆盖后来请求的持久状态。不冒充真实浏览器（无 DOM 依赖包），
// 但本机存储与网络合同都用真实实现（fetch 为受控 mock）。
import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB } from "idb";
import { createRenderer, defineComponent, h, nextTick, type VNode } from "vue";
import BackupRestore from "../../src/components/refueling/BackupRestore.vue";
import { accountA, initializeTestLoro, syntheticRecord } from "../helpers/sync-fixtures";
import { openLocalRefuelingV2 } from "../../src/data/local-refueling-v2";
import { useLocalRefueling } from "../../src/composables/useLocalRefueling";
import { writeRecord } from "../../src/data/refueling-document";
import { LoroDoc } from "loro-crdt/web";
import {
  BOOTSTRAP_PATH,
  SYNC_PATH,
  SYNC_CONTENT_TYPE,
  SYNC_PROTOCOL,
} from "../../src/shared/sync-protocol";
import { computeRestoreRequestFingerprint, RESTORE_PATH, type RestoreRequestBody } from "../../src/shared/restore-protocol";

vi.mock("../../src/data/loro-runtime", () => ({ initializeLoro: async () => undefined }));

/** 终态落盘注入：failResolve 计数抛配额错误。 */
const restoreOutcomeHook = vi.hoisted(() => ({ failResolve: 0 }));
vi.mock("../../src/data/local-refueling-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/local-refueling-v2")>();
  return {
    ...actual,
    openLocalRefuelingV2: async (options: import("../../src/data/local-refueling-v2").OpenLocalRefuelingV2Options) => {
      const repository = await actual.openLocalRefuelingV2(options);
      return {
        ...repository,
        resolveRestoreOutcome: async (outcome: import("../../src/data/refueling-restore").RestoreOutcomeRecord) => {
          if (restoreOutcomeHook.failResolve > 0) {
            restoreOutcomeHook.failResolve -= 1;
            throw new DOMException("quota", "QuotaExceededError");
          }
          return repository.resolveRestoreOutcome(outcome);
        },
      };
    },
  };
});

const G0 = "00000000-0000-4000-8000-0000000000a1";
const G1 = "00000000-0000-4000-8000-0000000000a2";

// 忠实的最小宿主（与 backust-restore 组件测试同构）：Vue 卸载 fragment 依赖
// nextSibling 沿兄弟链收敛，no-op 宿主会死循环。
interface HostNode {
  kind: "root" | "element" | "text" | "comment";
  tag: string | null;
  text: string | null;
  children: HostNode[];
  parent: HostNode | null;
}
function hostChildListOf(node: HostNode): HostNode[] {
  if (!Array.isArray(node.children)) node.children = [];
  return node.children;
}
function createHostContainer(): HostNode {
  return { kind: "root", tag: null, text: null, children: [], parent: null };
}
function detachHostNode(node: HostNode): void {
  const parent = node.parent;
  if (parent === null) return;
  const siblings = hostChildListOf(parent);
  const index = siblings.indexOf(node);
  if (index >= 0) siblings.splice(index, 1);
  node.parent = null;
}
const renderer = createRenderer<HostNode, HostNode>({
  patchProp() {},
  insert(child, parent, anchor = null) {
    detachHostNode(child);
    const siblings = hostChildListOf(parent);
    const index = anchor === null ? -1 : siblings.indexOf(anchor);
    siblings.splice(index < 0 ? siblings.length : index, 0, child);
    child.parent = parent;
  },
  remove(child) { detachHostNode(child); },
  createElement(tag) { return { kind: "element", tag, text: null, children: [], parent: null }; },
  createText(text) { return { kind: "text", tag: null, text, children: [], parent: null }; },
  createComment(text) { return { kind: "comment", tag: null, text, children: [], parent: null }; },
  setText(node, text) { node.text = text; },
  setElementText(node, text) { for (const child of hostChildListOf(node)) child.parent = null; node.children = []; node.text = text; },
  parentNode(node) { return node.parent; },
  nextSibling(node) {
    const parent = node.parent;
    if (parent === null) return null;
    const siblings = hostChildListOf(parent);
    const index = siblings.indexOf(node);
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1]! : null;
  },
});

async function flushPanel(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}

function collectText(vnode: VNode | null | undefined, visited: Set<VNode> = new Set()): string {
  if (vnode === null || vnode === undefined || visited.has(vnode)) return "";
  visited.add(vnode);
  const parts: string[] = [];
  if (vnode.component?.subTree !== undefined && vnode.component?.subTree !== null) parts.push(collectText(vnode.component.subTree, visited));
  const children = vnode.children;
  if (typeof children === "string") parts.push(children);
  else if (Array.isArray(children)) {
    for (const child of children) {
      if (child !== null && typeof child === "object" && "children" in (child as VNode)) parts.push(collectText(child as VNode, visited));
    }
  }
  return parts.join("");
}

function buttonsByText(root: VNode, text: string): { text: string; onClick?: unknown; props?: Record<string, unknown> }[] {
  const buttons: { text: string; onClick?: unknown; props?: Record<string, unknown> }[] = [];
  const walk = (vnode: VNode | null | undefined, visited: Set<VNode>): void => {
    if (vnode === null || vnode === undefined || visited.has(vnode)) return;
    visited.add(vnode);
    if (vnode.component?.subTree !== undefined && vnode.component.subTree !== null) walk(vnode.component.subTree, visited);
    if (vnode.type === "button") {
      buttons.push({ text: collectText(vnode, new Set()), onClick: (vnode.props as Record<string, unknown> | undefined)?.onClick, props: vnode.props as Record<string, unknown> | undefined });
    }
    const children = vnode.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child !== null && typeof child === "object" && "children" in (child as VNode)) walk(child as VNode, visited);
      }
    }
  };
  walk(root, new Set());
  return buttons.filter((button) => button.text.includes(text));
}

interface MountedFlow {
  local: ReturnType<typeof useLocalRefueling>;
  readonly root: VNode;
  unmount: () => void;
}

function snapshotWith(mutate?: (doc: LoroDoc) => void): Uint8Array {
  const doc = new LoroDoc();
  try {
    writeRecord(doc, "one", syntheticRecord, true);
    mutate?.(doc);
    return doc.export({ mode: "snapshot" });
  } finally { doc.free(); }
}

function restoreBody(requestId: string): RestoreRequestBody {
  return {
    requestId,
    previewId: "00000000-0000-4000-8000-0000000000e2",
    backupStreamId: "00000000-0000-4000-8000-0000000000e3",
    revision: 1,
    bundleSha256: "b".repeat(64),
    expectedGeneration: G0,
    expectedRevision: 2,
    expectedSnapshotSha256: "c".repeat(64),
  };
}

function mountFlow(fetchMock: typeof fetch): MountedFlow {
  let local!: ReturnType<typeof useLocalRefueling>;
  const Host = defineComponent({
    setup() {
      local = useLocalRefueling({ accountId: accountA, active: () => true, onSessionRejected() {} });
      return () => h(BackupRestore, {
        accountId: accountA,
        local,
        flushDraft: async () => ({ ok: true, message: "" }),
        onClose: () => undefined,
      });
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  const app = renderer.createApp(Host);
  const instance = app.mount(createHostContainer()) as unknown as { $: { subTree: VNode } };
  return {
    local,
    get root() { return instance.$.subTree; },
    unmount: () => app.unmount(),
  };
}

beforeAll(initializeTestLoro);
beforeEach(() => {
  restoreOutcomeHook.failResolve = 0;
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    onLine: true,
    locks: {
      request: async (name: string, fn: () => Promise<unknown>) => {
        const promise = (locks.get(name) ?? Promise.resolve()).then(fn);
        locks.set(name, promise.catch(() => undefined));
        return promise;
      },
    },
  });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
});
afterEach(async () => {
  unmounts.splice(0).forEach((unmount) => unmount());
  vi.unstubAllGlobals();
  for (const db of await indexedDB.databases()) if (db.name) await deleteDB(db.name);
});
const unmounts: Array<() => void> = [];

describe("面板×真实本机仓储接线（B-R3/B-R4）", () => {
  it("重开后持久 pending 可达「以原请求重试」，重试成功先落盘终态再解除", async () => {
    const requestId = "00000000-0000-4000-8000-0000000000d1";
    const body = restoreBody(requestId);
    const fingerprint = await computeRestoreRequestFingerprint(body);
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    await repo.setPendingRestore({ requestId, body, requestFingerprint: fingerprint, createdAtMs: 1 });
    repo.close();

    let submissions = 0;
    let reopenBootstraps = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === RESTORE_PATH) {
        submissions += 1;
        return new Response(JSON.stringify({
          outcome: "committed", requestId, requestFingerprint: fingerprint,
          previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
          baselinePending: true, committedAt: "2026-10-05T00:00:00.000Z",
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      if (path.includes("/requests/")) {
        return new Response(JSON.stringify({ error: "restore_request_not_found" }), { status: 404 });
      }
      if (path === BOOTSTRAP_PATH) {
        if (submissions > 0) {
          reopenBootstraps += 1;
          throw new TypeError("offline");
        }
        return new Response(JSON.stringify({
          accountId: accountA, documentGeneration: G0, legacyGeneration: G0,
          generationOrigin: { kind: "initial" }, snapshotAvailable: true, restoreWritesAvailable: true,
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      // 终态收尾会读回备份列表（§7.3 结束后给出可执行下一步）。
      if (path === "/api/backups/refueling") {
        return new Response(JSON.stringify({ initialized: true, currentGeneration: G1, currentRevision: 3, versions: [] }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      if (path === SYNC_PATH && init?.method === "GET") {
        return new Response(snapshotWith() as unknown as BodyInit, {
          status: 200,
          headers: {
            "X-Hako-Account": accountA, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
            "X-Hako-Document-Generation": G0, "X-Hako-Revision": "2", "Content-Type": SYNC_CONTENT_TYPE,
          },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const flow = mountFlow(fetchMock);
    unmounts.push(flow.unmount);
    await flow.local.initialize();
    await flushPanel();
    // 重开即显示原请求入口；此时不生成新预览。
    expect(buttonsByText(flow.root, "以原请求重试")).toHaveLength(1);
    expect(buttonsByText(flow.root, "查询恢复结果")).toHaveLength(1);
    // 本人以原 ID 重试成功：终态先落盘（resolveRestoreOutcome），随后解除待确认。
    await (buttonsByText(flow.root, "以原请求重试")[0]!.onClick as () => Promise<void>)();
    await flushPanel();
    const probe = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    const control = await probe.readControl();
    probe.close();
    expect(control.pendingRestore).toBeNull();
    expect(control.restoreOutcomes[requestId]?.outcome).toBe("committed");
    expect(collectText(flow.root)).toContain("恢复已提交到服务端");
    expect(buttonsByText(flow.root, "以原请求重试")).toHaveLength(0);
    await vi.waitFor(() => expect(reopenBootstraps).toBeGreaterThan(0));
  });

  it("committed 但本机终态落盘失败：面板保留原请求入口，重试落盘成功后解除", async () => {
    const requestId = "00000000-0000-4000-8000-0000000000d2";
    const body = restoreBody(requestId);
    const fingerprint = await computeRestoreRequestFingerprint(body);
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    await repo.setPendingRestore({ requestId, body, requestFingerprint: fingerprint, createdAtMs: 1 });
    repo.close();

    let submissions = 0;
    let reopenBootstraps = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === RESTORE_PATH) {
        submissions += 1;
        return new Response(JSON.stringify({
          outcome: "committed", requestId, requestFingerprint: fingerprint,
          previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
          baselinePending: true, committedAt: "2026-10-05T00:00:00.000Z",
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      if (path.includes("/requests/")) return new Response(JSON.stringify({ error: "restore_request_not_found" }), { status: 404 });
      if (path === BOOTSTRAP_PATH) {
        if (submissions > 0) {
          reopenBootstraps += 1;
          throw new TypeError("offline");
        }
        return new Response(JSON.stringify({
          accountId: accountA, documentGeneration: G0, legacyGeneration: G0,
          generationOrigin: { kind: "initial" }, snapshotAvailable: true, restoreWritesAvailable: true,
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      // 终态收尾会读回备份列表（§7.3 结束后给出可执行下一步）。
      if (path === "/api/backups/refueling") {
        return new Response(JSON.stringify({ initialized: true, currentGeneration: G1, currentRevision: 3, versions: [] }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      if (path === SYNC_PATH && init?.method === "GET") {
        return new Response(snapshotWith() as unknown as BodyInit, {
          status: 200,
          headers: {
            "X-Hako-Account": accountA, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
            "X-Hako-Document-Generation": G0, "X-Hako-Revision": "2", "Content-Type": SYNC_CONTENT_TYPE,
          },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    restoreOutcomeHook.failResolve = 1;
    const flow = mountFlow(fetchMock);
    unmounts.push(flow.unmount);
    await flow.local.initialize();
    await flushPanel();
    await (buttonsByText(flow.root, "以原请求重试")[0]!.onClick as () => Promise<void>)();
    await flushPanel();
    // 落盘失败：不虚报已提交，原请求仍保留并给出可重试错误。
    expect(collectText(flow.root)).toContain("本机保存结果失败");
    expect(buttonsByText(flow.root, "以原请求重试")).toHaveLength(1);
    const blocked = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    expect((await blocked.readControl()).pendingRestore?.requestId).toBe(requestId);
    expect((await blocked.readControl()).restoreOutcomes[requestId]).toBeUndefined();
    // 释放空间后再次重试：终态落盘并解除。
    await (buttonsByText(flow.root, "以原请求重试")[0]!.onClick as () => Promise<void>)();
    await flushPanel();
    const resolved = await blocked.readControl();
    expect(resolved.pendingRestore).toBeNull();
    expect(resolved.restoreOutcomes[requestId]?.outcome).toBe("committed");
    blocked.close();
    await vi.waitFor(() => expect(reopenBootstraps).toBeGreaterThan(0));
  });

  it("同一请求两笔在途 POST：先 committed 落盘，迟到 unknown 不降级终态也不复活待确认", async () => {
    const requestIdOne = "00000000-0000-4000-8000-0000000000d3";
    const requestIdTwo = "00000000-0000-4000-8000-0000000000d4";
    const bodyOne = restoreBody(requestIdOne);
    const bodyTwo = restoreBody(requestIdTwo);
    const fingerprintOne = await computeRestoreRequestFingerprint(bodyOne);
    const repo = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    await repo.receiveGeneration(G0, snapshotWith(), null);
    await repo.setPendingRestore({ requestId: requestIdOne, body: bodyOne, requestFingerprint: fingerprintOne, createdAtMs: 1 });
    repo.close();

    const releases: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === RESTORE_PATH) {
        return await new Promise<Response>((resolve) => { releases.push(resolve); });
      }
      if (path.includes("/requests/")) return new Response(JSON.stringify({ error: "restore_request_not_found" }), { status: 404 });
      if (path === BOOTSTRAP_PATH) {
        // 提交完成后的自动 reopen：模拟离线，立即返回，不悬挂本机 I/O。
        if (releases.length > 0) throw new TypeError("offline");
        return new Response(JSON.stringify({
          accountId: accountA, documentGeneration: G0, legacyGeneration: G0,
          generationOrigin: { kind: "initial" }, snapshotAvailable: true, restoreWritesAvailable: true,
        }), { status: 200, headers: { "X-Hako-Account": accountA } });
      }
      if (path === SYNC_PATH && init?.method === "GET") {
        return new Response(snapshotWith() as unknown as BodyInit, {
          status: 200,
          headers: {
            "X-Hako-Account": accountA, "X-Hako-Sync-Protocol": SYNC_PROTOCOL,
            "X-Hako-Document-Generation": G0, "X-Hako-Revision": "2", "Content-Type": SYNC_CONTENT_TYPE,
          },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const flow = mountFlow(fetchMock);
    unmounts.push(flow.unmount);
    await flow.local.initialize();
    await flushPanel();
    // 两个窗口（或双击）同时以同一固定正文重试：两笔 POST 都在途。
    const first = flow.local.submitPendingRestore();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = flow.local.submitPendingRestore();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    // 第一笔提交成功：终态先落盘并解除待确认。
    releases[0]!(new Response(JSON.stringify({
      outcome: "committed", requestId: requestIdOne, requestFingerprint: fingerprintOne,
      previousGeneration: G0, newGeneration: G1, previousRevision: 2, newRevision: 3,
      baselinePending: true, committedAt: "2026-10-05T00:00:00.000Z",
    }), { status: 200, headers: { "X-Hako-Account": accountA } }));
    await first;
    await flushPanel();
    const probe = await openLocalRefuelingV2({ accountId: accountA, legacyGeneration: G0 });
    expect((await probe.readControl()).pendingRestore).toBeNull();
    expect((await probe.readControl()).restoreOutcomes[requestIdOne]?.outcome).toBe("committed");
    // 另一窗口此时合法地持久第二笔请求（无覆盖）。
    await probe.setPendingRestore({ requestId: requestIdTwo, body: bodyTwo, requestFingerprint: await computeRestoreRequestFingerprint(bodyTwo), createdAtMs: 2 });
    // 第一笔的迟到 unknown 到达：不得把已记录终态降级、不得清除第二笔。
    releases[1]!(new Response(JSON.stringify({ error: "restore_unavailable", outcome: "unknown", requestId: requestIdOne, requestFingerprint: fingerprintOne }), { status: 503, headers: { "X-Hako-Account": accountA } }));
    await second;
    await flushPanel();
    const control = await probe.readControl();
    expect(control.restoreOutcomes[requestIdOne]?.outcome).toBe("committed");
    expect(control.pendingRestore?.requestId).toBe(requestIdTwo);
    probe.close();
  });
});
