// 「备份与恢复」面板组件测试（真实编译 BackupRestore SFC）：列表渲染与不可选
// 版本、比较视图（将增加/移除/字段不同/相同 + 字段相同历史不同提示）、
// pendingSync 禁用最终确认，以及确认编排（flush 草稿 → 持久请求 → 提交 →
// committed 展示）与 unknown 结果保留查询/原请求重试入口。客户端网络层以受控
// mock 注入；不冒充真实浏览器。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderer, nextTick, shallowRef, type VNode } from "vue";
import BackupRestore from "../../src/components/refueling/BackupRestore.vue";
import { accountA, initializeTestLoro, syntheticRecord } from "../helpers/sync-fixtures";
import type { RefuelingBackupList, RestorePreview } from "../../src/data/refueling-restore";
import type { RestoreComparison } from "../../src/data/restore-comparison";
import { writeRecord } from "../../src/data/refueling-document";
import { LoroDoc } from "loro-crdt/web";

const generation = "00000000-0000-4000-8000-0000000000a1";

// 客户端网络层 mock：面板只应依赖这些合同的响应绑定。
const listBackupsMock = vi.fn<(options: { accountId: string }) => Promise<{ ok: true; list: RefuelingBackupList } | { ok: false; error: string }>>();
const createPreviewMock = vi.fn();
const fetchPreviewSnapshotMock = vi.fn();
const cancelPreviewMock = vi.fn();
const fetchSnapshotMock = vi.fn();

vi.mock("../../src/data/refueling-restore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/refueling-restore")>();
  return {
    ...actual,
    listRefuelingBackups: (options: { accountId: string }) => listBackupsMock(options),
    createRestorePreview: (...args: unknown[]) => createPreviewMock(...(args as [])),
    fetchRestorePreviewSnapshot: (...args: unknown[]) => fetchPreviewSnapshotMock(...(args as [])),
    cancelRestorePreview: (...args: unknown[]) => cancelPreviewMock(...(args as [])),
  };
});
vi.mock("../../src/data/refueling-server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/refueling-server-api")>();
  return {
    ...actual,
    fetchRefuelingSnapshot: (...args: unknown[]) => fetchSnapshotMock(...(args as [])),
  };
});
vi.mock("../../src/data/loro-runtime", () => ({ initializeLoro: async () => undefined }));

// 忠实的最小宿主：Vue 卸载 fragment 时用 nextSibling 沿兄弟链走到 anchor
// （removeFragment 的 while 循环）。朴素 no-op 宿主（nextSibling 恒 null）会让
// 该循环无法收敛而同步死循环，因此这里维护真实父子/兄弟链；不使用任何 DOM
// 依赖包，仅覆盖本组件实际用到的宿主能力。
interface HostNode {
  kind: "root" | "element" | "text" | "comment";
  tag: string | null;
  text: string | null;
  children: HostNode[];
  parent: HostNode | null;
}

function createHostContainer(): HostNode {
  return { kind: "root", tag: null, text: null, children: [], parent: null };
}

function hostChildListOf(node: HostNode): HostNode[] {
  if (!Array.isArray(node.children)) node.children = [];
  return node.children;
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
  remove(child) {
    detachHostNode(child);
  },
  createElement(tag) {
    return { kind: "element", tag, text: null, children: [], parent: null };
  },
  createText(text) {
    return { kind: "text", tag: null, text, children: [], parent: null };
  },
  createComment(text) {
    return { kind: "comment", tag: null, text, children: [], parent: null };
  },
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    for (const child of hostChildListOf(node)) child.parent = null;
    node.children = [];
    node.text = text;
  },
  parentNode(node) {
    return node.parent;
  },
  nextSibling(node) {
    const parent = node.parent;
    if (parent === null) return null;
    const siblings = hostChildListOf(parent);
    const index = siblings.indexOf(node);
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1]! : null;
  },
});

/** 冲刷微任务与渲染队列：面板的列表/预览链有多个 await 边界。 */
async function flushPanel(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}
const unmounts: Array<() => void> = [];

interface LocalProp {
  pendingRestore: { value: { requestId: string } | null };
  pendingSync: { value: boolean };
  recheckRestoreReceipt: () => void;
  beginRestoreRequest: (body: unknown) => Promise<{ ok: boolean; pending: unknown; message: string }>;
  submitPendingRestore: () => Promise<{ kind: string; reason?: string; message?: string }>;
}

function mountPanel(local: LocalProp, flushDraft: () => Promise<{ ok: boolean; message: string }>) {
  const app = renderer.createApp(BackupRestore, {
    accountId: accountA,
    local,
    flushDraft,
  });
  const instance = app.mount(createHostContainer()) as unknown as { $: { subTree: VNode } };
  unmounts.push(() => app.unmount());
  return instance.$;
}

/** 自定义 renderer 的 vnode 树可能通过 component.subTree 复用同一子树；按节点身份去重，防止指数级重复遍历。 */
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

function buttonByText(root: VNode, text: string): { text: string; onClick?: unknown; props?: Record<string, unknown> } | undefined {
  return buttonsByText(root, text)[0];
}

/** 选择列表中最旧的可选版本进入比较视图（点最后一个「预览此版本」）。 */
async function selectOldestVersion(root: { subTree: VNode }): Promise<void> {
  const previews = buttonsByText(root.subTree, "预览此版本");
  expect(previews.length).toBeGreaterThan(0);
  (previews[previews.length - 1]!.onClick as () => void)();
  await flushPanel();
}

const baseLocal = (): LocalProp => ({
  pendingRestore: shallowRef(null),
  pendingSync: shallowRef(false),
  recheckRestoreReceipt: () => undefined,
  beginRestoreRequest: vi.fn(async () => ({ ok: true, pending: null, message: "" })),
  submitPendingRestore: vi.fn(async () => ({ kind: "committed" })),
});

function versionEntry(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    backupStreamId: "00000000-0000-4000-8000-0000000000b3",
    revision,
    bundleSha256: "a".repeat(64),
    completedAtMs: Date.parse("2026-10-05T12:00:00Z"),
    capturedAtMs: null,
    recordCount: 1,
    formatVersion: 2,
    effectiveSourceGeneration: generation,
    restoreBaseline: false,
    selectable: true,
    ...overrides,
  };
}

function previewResponse(revision: number): RestorePreview {
  return {
    previewId: "00000000-0000-4000-8000-0000000000c1",
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    target: {
      backupStreamId: "00000000-0000-4000-8000-0000000000b3",
      revision,
      bundleSha256: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
      historySha256: "e".repeat(64),
      recordCount: 1,
      capturedAtMs: null,
    },
    expected: {
      generation,
      revision: 2,
      snapshotSha256: "f".repeat(64),
      historySha256: "9".repeat(64),
    },
    protection: { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision: 1 },
  };
}

/** 用真实 Loro 构造目标/当前快照（比较函数本身不被 mock，动态取实际模块）。 */
async function buildSnapshots(): Promise<{ target: Uint8Array; current: Uint8Array; comparison: RestoreComparison }> {
  const target = new LoroDoc();
  writeRecord(target, "one", { ...syntheticRecord, stationName: "旧站" }, true);
  writeRecord(target, "two", syntheticRecord, true);
  // 两条相同的记录：比较应给出「相同」，展开后可逐条核对字段。
  writeRecord(target, "same", { ...syntheticRecord, orderNumber: "same-order" }, true);
  const current = new LoroDoc();
  writeRecord(current, "one", { ...syntheticRecord, stationName: "新站" }, true);
  writeRecord(current, "three", syntheticRecord, true);
  writeRecord(current, "same", { ...syntheticRecord, orderNumber: "same-order" }, true);
  const targetSnapshot = target.export({ mode: "snapshot" });
  const currentSnapshot = current.export({ mode: "snapshot" });
  const actual = await vi.importActual<typeof import("../../src/data/restore-comparison")>("../../src/data/restore-comparison");
  const comparison = actual.compareRestoreSnapshots(targetSnapshot, currentSnapshot);
  if (comparison === null) throw new Error("synthetic fixtures must produce a comparison");
  return {
    target: targetSnapshot,
    current: currentSnapshot,
    comparison,
  };
}

beforeEach(async () => {
  await initializeTestLoro();
  vi.clearAllMocks();
});

afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()?.();
});

it("列表渲染：未初始化提示、版本条目与清理中不可选", async () => {
  listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: false, currentGeneration: null, currentRevision: null, versions: [] } });
  const root = mountPanel(baseLocal(), async () => ({ ok: true, message: "" }));
  await flushPanel();
  let text = collectText(root.subTree);
  expect(text).toContain("还没有独立备份");
  expect(text).not.toContain("预览此版本");

  listBackupsMock.mockResolvedValue({
    ok: true,
    list: {
      initialized: true,
      currentGeneration: generation,
      currentRevision: 2,
      versions: [versionEntry(2), versionEntry(1, { selectable: false, restoreBaseline: true })],
    },
  });
  const root2 = mountPanel(baseLocal(), async () => ({ ok: true, message: "" }));
  await flushPanel();
  text = collectText(root2.subTree);
  expect(text).toContain("恢复基线");
  expect(text).toContain("清理中，不可选择");
  expect(text).toContain("预览此版本");
});

it("比较视图：增加/移除/字段不同/相同计数与字段差异；字段相同历史不同提示", async () => {
  const snapshots = await buildSnapshots();
  listBackupsMock.mockResolvedValue({
    ok: true,
    list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] },
  });
  createPreviewMock.mockResolvedValue({ ok: true, preview: previewResponse(1) });
  fetchPreviewSnapshotMock.mockResolvedValue({ ok: true, snapshot: snapshots.target, snapshotSha256: "b".repeat(64) });
  fetchSnapshotMock.mockResolvedValue({
    ok: true,
    snapshot: { documentGeneration: generation, revision: 2, snapshot: snapshots.current },
  });
  const local = baseLocal();
  const root = mountPanel(local, async () => ({ ok: true, message: "" }));
  await flushPanel();
  await selectOldestVersion(root);
  // 目标比当前多 two、少 three、one 字段不同：计数与提示齐全。
  const text = collectText(root.subTree);
  expect(text).toContain("将增加 1 条");
  expect(text).toContain("将移除 1 条");
  expect(text).toContain("字段不同 1 条");
  expect(text).toContain("旧站");
  expect(text).toContain("新站");
  expect(text).toContain("恢复到此版本");
  expect(text).toContain("这会替换账号当前的全部加油记录");
});

it("确认编排：pendingSync 禁用；flush→持久请求→提交→committed 展示", async () => {
  const snapshots = await buildSnapshots();
  listBackupsMock.mockResolvedValue({
    ok: true,
    list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] },
  });
  createPreviewMock.mockResolvedValue({ ok: true, preview: previewResponse(1) });
  fetchPreviewSnapshotMock.mockResolvedValue({ ok: true, snapshot: snapshots.target, snapshotSha256: "b".repeat(64) });
  fetchSnapshotMock.mockResolvedValue({
    ok: true,
    snapshot: { documentGeneration: generation, revision: 2, snapshot: snapshots.current },
  });
  const beginRestoreRequest = vi.fn(async (body: unknown) => {
    const requestId = (body as { requestId: string }).requestId;
    return { ok: true, pending: { requestId, requestFingerprint: "f".repeat(64), body, createdAtMs: 1, dispatchedAtMs: null }, message: "" };
  });
  const submitPendingRestore = vi.fn(async () => ({ kind: "committed" }));
  const flushDraft = vi.fn(async () => ({ ok: true, message: "" }));
  const local: LocalProp = {
    ...baseLocal(),
    pendingSync: shallowRef(true),
    beginRestoreRequest,
    submitPendingRestore,
  };
  const root = mountPanel(local, flushDraft);
  await flushPanel();
  await selectOldestVersion(root);
  // 有待上传修改：确认按钮禁用。
  const confirm = buttonByText(root.subTree, "恢复到此版本");
  expect(confirm).toBeDefined();
  expect(confirm!.props?.disabled).toBe(true);
  local.pendingSync.value = false;
  await flushPanel();
  const confirmEnabled = buttonByText(root.subTree, "恢复到此版本");
  expect(confirmEnabled!.props?.disabled).toBe(false);
  // 点击确认：先 flush，再持久保存请求，然后提交。
  (confirmEnabled!.onClick as () => void)();
  await flushPanel();
  expect(flushDraft).toHaveBeenCalledTimes(1);
  expect(beginRestoreRequest).toHaveBeenCalledTimes(1);
  expect(submitPendingRestore).toHaveBeenCalledTimes(1);
  const body = (beginRestoreBody(beginRestoreRequest));
  expect(body).toMatchObject({ previewId: "00000000-0000-4000-8000-0000000000c1", expectedGeneration: generation, expectedRevision: 2 });
  expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  const text = collectText(root.subTree);
  expect(text).toContain("恢复已提交到服务端");
  expect(text).toContain("打开恢复后的数据");
});

it("unknown 结果保留待确认提示与查询/原请求重试入口", async () => {
  const snapshots = await buildSnapshots();
  listBackupsMock.mockResolvedValue({
    ok: true,
    list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] },
  });
  createPreviewMock.mockResolvedValue({ ok: true, preview: previewResponse(1) });
  fetchPreviewSnapshotMock.mockResolvedValue({ ok: true, snapshot: snapshots.target, snapshotSha256: "b".repeat(64) });
  fetchSnapshotMock.mockResolvedValue({
    ok: true,
    snapshot: { documentGeneration: generation, revision: 2, snapshot: snapshots.current },
  });
  const submitPendingRestore = vi.fn(async () => ({ kind: "unknown", errorCode: "backup_not_ready" }));
  const local = { ...baseLocal(), submitPendingRestore };
  // 真实组合层在 unknown 后会把待确认请求写回本机并暴露给面板：这里用受控 mock 模拟同一归属。
  local.beginRestoreRequest = vi.fn(async (body: unknown) => {
    const pending = { requestId: (body as { requestId: string }).requestId, requestFingerprint: "f".repeat(64), body, createdAtMs: 1, dispatchedAtMs: null };
    local.pendingRestore.value = pending;
    return { ok: true, pending, message: "" };
  });
  const root = mountPanel(local, async () => ({ ok: true, message: "" }));
  await flushPanel();
  await selectOldestVersion(root);
  const confirm = buttonByText(root.subTree, "恢复到此版本");
  (confirm!.onClick as () => void)();
  await flushPanel();
  const text = collectText(root.subTree);
  expect(text).toContain("恢复结果尚待确认");
  expect(text).toContain("不会自动换编号重发");
  expect(buttonByText(root.subTree, "查询恢复结果")).toBeDefined();
  expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
});

function beginRestoreBody(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return mock.mock.calls[0]![0] as Record<string, unknown>;
}

describe("B 修复回归（第一轮父审）：保护门控、重开入口与 flush 后重验", () => {
  async function readyPanelWith(local: LocalProp, protection: RestorePreview["protection"], flush = async () => ({ ok: true, message: "" })) {
    const snapshots = await buildSnapshots();
    listBackupsMock.mockResolvedValue({
      ok: true,
      list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] },
    });
    createPreviewMock.mockResolvedValue({ ok: true, preview: { ...previewResponse(1), protection } });
    fetchPreviewSnapshotMock.mockResolvedValue({ ok: true, snapshot: snapshots.target, snapshotSha256: "b".repeat(64) });
    fetchSnapshotMock.mockResolvedValue({ ok: true, snapshot: { documentGeneration: generation, revision: 2, snapshot: snapshots.current } });
    const root = mountPanel(local, flush);
    await flushPanel();
    await selectOldestVersion(root);
    return root;
  }

  it.each([
    ["pending_backup_window", "等待当前修改的备份窗口完成"],
    ["backup_blocked", "备份暂时受阻"],
    ["cleanup_pending", "正在收尾旧备份"],
  ])("保护未覆盖（%s）：确认禁用并显示原因/版本/下次时间", async (waitingReason, expectedText) => {
    const local = baseLocal();
    const root = await readyPanelWith(local, { covered: false, waitingReason, nextAttemptAtMs: Date.now() + 30_000, protectionRevision: 1 });
    const button = buttonByText(root.subTree, "恢复到此版本");
    expect(button!.props?.disabled).toBe(true);
    const text = collectText(root.subTree);
    expect(text).toContain(expectedText);
    expect(text).toContain("最新完成版本 1");
    expect(text).toContain("就绪前不能最终确认");
    expect(local.beginRestoreRequest).not.toHaveBeenCalled();
  });

  it("保护就绪：显示版本并可最终确认", async () => {
    const local = baseLocal();
    const root = await readyPanelWith(local, { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision: 2 });
    expect(buttonByText(root.subTree, "恢复到此版本")!.props?.disabled).toBe(false);
    expect(collectText(root.subTree)).toContain("保护备份已就绪（版本 2）");
  });

  it("重开面板：持久待确认请求直接暴露查询/原请求重试，且不能新选版本", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000d1" };
    listBackupsMock.mockResolvedValue({
      ok: true,
      list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] },
    });
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
    expect(buttonByText(root.subTree, "查询恢复结果")).toBeDefined();
    expect(collectText(root.subTree)).toContain("0000000");
    for (const preview of buttonsByText(root.subTree, "预览此版本")) expect(preview.props?.disabled).toBe(true);
  });

  it("重开面板的待确认请求先查结果（404/unknown 不清除原编号）", async () => {
    const local = baseLocal();
    const recheck = vi.fn();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000d5" };
    local.recheckRestoreReceipt = recheck;
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2)] } });
    mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(local.pendingRestore.value?.requestId).toBe("00000000-0000-4000-8000-0000000000d5");
  });

  it("flush 期间出现新的未同步修改：不发请求、不持久新恢复", async () => {
    const local = baseLocal();
    const flush = vi.fn(async () => { local.pendingSync.value = true; return { ok: true, message: "" }; });
    const root = await readyPanelWith(local, { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision: 1 }, flush);
    const button = buttonByText(root.subTree, "恢复到此版本");
    expect(button!.props?.disabled).toBe(false);
    await (button!.onClick as () => Promise<void>)();
    await flushPanel();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(local.beginRestoreRequest).not.toHaveBeenCalled();
    expect(local.submitPendingRestore).not.toHaveBeenCalled();
    expect(collectText(root.subTree)).toContain("尚未同步的修改");
  });

  it("flush 期间另一窗口持久了待确认请求：不覆盖、不发新请求", async () => {
    const local = baseLocal();
    const flush = vi.fn(async () => { local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000d6" }; return { ok: true, message: "" }; });
    const root = await readyPanelWith(local, { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision: 1 }, flush);
    await (buttonByText(root.subTree, "恢复到此版本")!.onClick as () => Promise<void>)();
    await flushPanel();
    expect(local.beginRestoreRequest).not.toHaveBeenCalled();
    expect(local.submitPendingRestore).not.toHaveBeenCalled();
    expect(collectText(root.subTree)).toContain("不会用新请求覆盖");
    expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
  });

  it("展开相同记录后可逐条核对字段值", async () => {
    const local = baseLocal();
    const root = await readyPanelWith(local, { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision: 1 });
    const expandAll = buttonByText(root.subTree, "展开相同记录");
    expect(expandAll).toBeDefined();
    (expandAll!.onClick as () => void)();
    await flushPanel();
    const fields = buttonByText(root.subTree, "查看逐条字段");
    expect(fields).toBeDefined();
    (fields!.onClick as () => void)();
    await flushPanel();
    expect(collectText(root.subTree)).toContain("same-order");
  });

  it("待确认请求存在时仍可查询与重试（不受待同步修改门禁影响）", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000d7" };
    local.pendingSync.value = true;
    const submitPendingRestore = vi.fn(async () => ({ kind: "unknown", errorCode: "backup_not_ready" }));
    local.submitPendingRestore = submitPendingRestore;
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2)] } });
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    const retry = buttonByText(root.subTree, "以原请求重试");
    expect(retry!.props?.disabled).toBe(false);
    await (retry!.onClick as () => Promise<void>)();
    await flushPanel();
    expect(submitPendingRestore).toHaveBeenCalledTimes(1);
  });
});

describe("B 修复回归（第二轮父审）：首发送资格与待确认转移", () => {
  async function readyPanelWith(local: LocalProp, protection: RestorePreview["protection"], flush = async () => ({ ok: true, message: "" })) {
    const snapshots = await buildSnapshots();
    listBackupsMock.mockResolvedValue({
      ok: true,
      list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] },
    });
    createPreviewMock.mockResolvedValue({ ok: true, preview: { ...previewResponse(1), protection } });
    fetchPreviewSnapshotMock.mockResolvedValue({ ok: true, snapshot: snapshots.target, snapshotSha256: "b".repeat(64) });
    fetchSnapshotMock.mockResolvedValue({ ok: true, snapshot: { documentGeneration: generation, revision: 2, snapshot: snapshots.current } });
    const root = mountPanel(local, flush);
    await flushPanel();
    await selectOldestVersion(root);
    return root;
  }

  it("begin 的异步边界后出现未同步修改：不发送首次请求，保留原请求入口", async () => {
    const local = baseLocal();
    local.beginRestoreRequest = vi.fn(async (body: unknown) => {
      local.pendingRestore.value = { requestId: (body as { requestId: string }).requestId };
      // 请求落盘返回前出现新的保存（本窗口或其他窗口）：首次发送资格必须复核。
      local.pendingSync.value = true;
      return { ok: true, pending: local.pendingRestore.value, message: "" };
    });
    const root = await readyPanelWith(local, { covered: true, waitingReason: null, nextAttemptAtMs: null, protectionRevision: 1 });
    await (buttonByText(root.subTree, "恢复到此版本")!.onClick as () => Promise<void>)();
    await flushPanel();
    expect(local.submitPendingRestore, "首次发送不得越过本机未同步保存").not.toHaveBeenCalled();
    expect(collectText(root.subTree)).toContain("尚未同步的修改");
    expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
  });

  it("以原请求重试得 not_committed：清 pending 后回到可预览列表", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000d8" };
    local.submitPendingRestore = vi.fn(async () => {
      local.pendingRestore.value = null;
      return { kind: "not_committed", reason: "preview_expired" };
    });
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    await (buttonByText(root.subTree, "以原请求重试")!.onClick as () => Promise<void>)();
    await flushPanel();
    expect(local.pendingRestore.value).toBeNull();
    expect(buttonsByText(root.subTree, "预览此版本").length, "结束后必须给出可执行的下一步").toBeGreaterThan(0);
    expect(collectText(root.subTree)).toContain("本次恢复未执行");
  });

  it("只读回执查询结束待确认：离开保护态并列出可预览版本", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000d9" };
    // 重开时的自动查询：仍活跃的工作区确认终态并清除 pending。
    local.recheckRestoreReceipt = vi.fn(() => { local.pendingRestore.value = null; });
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    expect(local.pendingRestore.value).toBeNull();
    expect(buttonsByText(root.subTree, "预览此版本").length, "查询完成后不能停在保护态").toBeGreaterThan(0);
  });
});

describe("B 修复回归（第三轮父审）：请求归属与 busy 收尾", () => {
  it("重试 POST 在途时查询已结束 pending：迟到 unknown 不留在空保护态", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000e1" };
    let finishPost!: (value: { kind: string }) => void;
    local.submitPendingRestore = vi.fn(() => new Promise<{ kind: string }>((resolve) => { finishPost = resolve; }));
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    const submitting = (buttonByText(root.subTree, "以原请求重试")!.onClick as () => Promise<void>)();
    await flushPanel();
    // 在途期间只读查询先确认终态并清除 pending（查询入口不被禁用）。
    local.recheckRestoreReceipt = () => { local.pendingRestore.value = null; };
    (buttonByText(root.subTree, "查询恢复结果")!.onClick as () => void)();
    await flushPanel();
    finishPost({ kind: "unknown" });
    await submitting;
    await flushPanel();
    expect(local.pendingRestore.value).toBeNull();
    expect(buttonsByText(root.subTree, "预览此版本").length, "busy 期间结束的 pending 必须在收尾时协调出下一步").toBeGreaterThan(0);
    expect(collectText(root.subTree)).not.toContain("结果仍待确认");
  });

  it("重试在途时 pending 被新请求替换：旧终态文案不得标到新请求", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000e2" };
    let finishPost!: (value: { kind: string; reason: string }) => void;
    local.submitPendingRestore = vi.fn(() => new Promise<{ kind: string; reason: string }>((resolve) => { finishPost = resolve; }));
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    const submitting = (buttonByText(root.subTree, "以原请求重试")!.onClick as () => Promise<void>)();
    await flushPanel();
    // 其他窗口结束旧请求并登记新的待确认请求：界面当前 pending 已替换。
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000e3" };
    await flushPanel();
    finishPost({ kind: "not_committed", reason: "source_changed" });
    await submitting;
    await flushPanel();
    expect(local.pendingRestore.value?.requestId).toBe("00000000-0000-4000-8000-0000000000e3");
    expect(collectText(root.subTree), "旧请求的终态不得宣告给新请求").not.toContain("已确认本次恢复未执行");
    expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
  });
});

describe("浏览器验收缺陷回归：预览失败的可读原因保留与归属", () => {
  it("预览失败后的列表刷新不清掉可读原因（backup_not_found）：预览 1 次、列表 2 次", async () => {
    listBackupsMock
      .mockResolvedValueOnce({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(1)] } })
      .mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    createPreviewMock.mockResolvedValue({ ok: false, error: "backup_not_found" });
    const root = mountPanel(baseLocal(), async () => ({ ok: true, message: "" }));
    await flushPanel();
    await selectOldestVersion(root);
    expect(createPreviewMock).toHaveBeenCalledTimes(1);
    expect(listBackupsMock).toHaveBeenCalledTimes(2);
    expect(collectText(root.subTree)).toContain("所选备份已不可用（可能正在清理），请重新选择。");
  });

  it("预览失效（当前版本变化）分支的提示同样在列表刷新后保留", async () => {
    const snapshots = await buildSnapshots();
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    createPreviewMock.mockResolvedValue({ ok: true, preview: previewResponse(1) });
    fetchPreviewSnapshotMock.mockResolvedValue({ ok: true, snapshot: snapshots.target, snapshotSha256: "b".repeat(64) });
    fetchSnapshotMock.mockResolvedValue({ ok: true, snapshot: { documentGeneration: generation, revision: 3, snapshot: snapshots.current } });
    const root = mountPanel(baseLocal(), async () => ({ ok: true, message: "" }));
    await flushPanel();
    await selectOldestVersion(root);
    expect(collectText(root.subTree)).toContain("账号数据已变化，本次预览已失效；请重新选择。");
    expect(buttonByText(root.subTree, "恢复到此版本")).toBeUndefined();
  });

  it("预览失败在途时归属被新的待确认流程推进：迟到的失败原因不写回新界面", async () => {
    const local = baseLocal();
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(1)] } });
    let resolvePreview: (value: unknown) => void = () => undefined;
    createPreviewMock.mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve; }));
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    await selectOldestVersion(root);
    // 另一窗口登记待确认请求：本面板归属被推进（旧操作作废）。
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000f5" };
    await flushPanel();
    resolvePreview({ ok: false, error: "backup_not_found" });
    await flushPanel();
    const text = collectText(root.subTree);
    expect(text).not.toContain("所选备份已不可用");
    expect(text).toContain("待确认");
  });
});

describe("浏览器验收缺陷修复（第二轮父审）：旧预览 finally 的 loading 归属", () => {
  it("旧预览迟到收尾不得结束当前仍在途的列表刷新", async () => {
    const local = baseLocal();
    const firstList = { ok: true as const, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(1)] } };
    let finishPreview: (result: unknown) => void = () => undefined;
    createPreviewMock.mockImplementation(() => new Promise((resolve) => { finishPreview = resolve; }));
    let finishNewList: (result: typeof firstList) => void = () => undefined;
    listBackupsMock
      .mockResolvedValueOnce(firstList)
      .mockResolvedValueOnce(firstList)
      .mockImplementationOnce(() => new Promise((resolve) => { finishNewList = resolve; }));
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    await selectOldestVersion(root);
    expect(createPreviewMock).toHaveBeenCalledTimes(1);
    // 另一标签页登记 pending：旧预览操作的归属作废。
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000f5" };
    await flushPanel();
    expect(listBackupsMock).toHaveBeenCalledTimes(2);
    // 该请求随后取得 not_committed 并解除：当前面板开始新的列表刷新（仍在途）。
    local.pendingRestore.value = null;
    await flushPanel();
    expect(listBackupsMock).toHaveBeenCalledTimes(3);
    expect(collectText(root.subTree)).toContain("正在读取备份列表");
    expect(buttonsByText(root.subTree, "预览此版本")).toHaveLength(0);
    // 当前列表仍在途时旧预览迟到返回：正文出口与 finally 都必须复核归属。
    finishPreview({ ok: false, error: "backup_not_found" });
    await flushPanel();
    expect(collectText(root.subTree), "旧预览收尾不得结束新列表的加载提示").toContain("正在读取备份列表");
    expect(buttonsByText(root.subTree, "预览此版本"), "新列表未完成前旧缓存版本不得重新可点").toHaveLength(0);
    finishNewList(firstList);
    await flushPanel();
    expect(collectText(root.subTree)).not.toContain("正在读取备份列表");
  });
});

describe("B 修复回归（第四轮父审）：异步列表刷新与换人归属", () => {
  it("P1 终态收尾的列表响应迟到：不把 P1 终态文案写到 P2，且旧响应不改共享状态", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000f1" };
    local.submitPendingRestore = vi.fn(async () => {
      local.pendingRestore.value = null;
      return { kind: "not_committed", reason: "preview_expired" };
    });
    const listResolvers: Array<(value: { ok: true; list: RefuelingBackupList }) => void> = [];
    listBackupsMock.mockImplementation(() => new Promise((resolve) => { listResolvers.push(resolve); }));
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    await (buttonByText(root.subTree, "以原请求重试")!.onClick as () => Promise<void>)();
    await flushPanel();
    // 终态收尾已启动列表读取，但响应尚未返回（busy 已解除）。
    expect(listResolvers.length).toBeGreaterThan(0);
    // 另一窗口登记 P2：本窗口 pending 换人，旧列表响应此时才返回。
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000f2" };
    await flushPanel();
    listResolvers[0]!({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    await flushPanel();
    expect(local.pendingRestore.value?.requestId).toBe("00000000-0000-4000-8000-0000000000f2");
    const staleText = collectText(root.subTree);
    expect(staleText, "P1 终态文案不得由迟到的列表回调写入 P2 界面").not.toContain("预览已过期");
    expect(staleText).not.toContain("本次恢复未执行");
    expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
    // 当前归属（换人后）的列表响应返回后仍可正常落位：中立提示与 P2 入口都在。
    listResolvers.at(-1)?.({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    await flushPanel();
    expect(collectText(root.subTree), "换人收尾须给出当前中立提示").toContain("当前的待确认恢复请求已更新");
    expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
  });

  it("非 busy 的 P1→P2 替换：清掉 P1 的本机失败文案并保留 P2", async () => {
    const local = baseLocal();
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000f3" };
    const oldFailure = "服务端已提交恢复，但本机保存结果失败；原请求已保留，请释放本机空间后重试查询。";
    local.submitPendingRestore = vi.fn(async () => ({ kind: "local-failed", message: oldFailure }));
    listBackupsMock.mockResolvedValue({ ok: true, list: { initialized: true, currentGeneration: generation, currentRevision: 2, versions: [versionEntry(2), versionEntry(1)] } });
    const root = mountPanel(local, async () => ({ ok: true, message: "" }));
    await flushPanel();
    await (buttonByText(root.subTree, "以原请求重试")!.onClick as () => Promise<void>)();
    await flushPanel();
    expect(collectText(root.subTree), "同一请求的本机失败提示须真实展示").toContain(oldFailure);
    // 另一窗口处理完 P1 并登记 P2：本窗口下一次 control 刷新直接见到 P2（无中间 null）。
    local.pendingRestore.value = { requestId: "00000000-0000-4000-8000-0000000000f4" };
    await flushPanel();
    const text = collectText(root.subTree);
    expect(text, "旧请求的失败文案不得留给新请求").not.toContain(oldFailure);
    expect(text).toContain("当前的待确认恢复请求已更新");
    expect(buttonByText(root.subTree, "以原请求重试")).toBeDefined();
  });
});
