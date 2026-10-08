// 数据页（D0）接线测试：本机 / 账号同步 / 独立备份 / 保留内容 / 旧验证导入
// 分区事实呈现；备份等待只用服务端 nextActionAtMs（未知不编时间）；blocked
// 显示需要排查；待确认恢复请求给出条件入口。备份状态与保留内容读取以受控
// mock 注入；自定义 renderer + 文本断言，不冒充真实浏览器。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRenderer, nextTick, shallowRef, type VNode } from "vue";
import DataPage from "../../src/components/refueling/DataPage.vue";
import { accountA } from "../helpers/sync-fixtures";
import type { RefuelingBackupStatus } from "../../src/data/refueling-server-api";

const backupStatusMock = vi.fn();
vi.mock("../../src/data/refueling-server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/refueling-server-api")>();
  return {
    ...actual,
    fetchBackupStatus: (options: { accountId: string }) => backupStatusMock(options),
  };
});
vi.mock("../../src/data/retained-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/retained-content")>();
  return {
    ...actual,
    listRetainedDraftSources: vi.fn(async () => []),
  };
});

const renderer = createRenderer({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({ style: {} }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const closes: Array<() => void> = [];

function statusOf(overrides: Partial<RefuelingBackupStatus>): RefuelingBackupStatus {
  return {
    initialized: true,
    state: "current_backed_up",
    currentRevision: 2,
    currentGeneration: "00000000-0000-4000-8000-0000000000a1",
    frozenTaskRevision: null,
    latestCompletedRevision: 2,
    latestCompletedGeneration: "00000000-0000-4000-8000-0000000000a1",
    pendingFromRevision: null,
    pendingToRevision: null,
    windowDueAtMs: null,
    nextAttemptAtMs: null,
    nextActionAtMs: null,
    blockedError: null,
    cleanupPendingCount: 0,
    currentBackedUp: true,
    ...overrides,
  };
}

function mountDataPage(localOverrides: Record<string, unknown> = {}) {
  const local = {
    ready: shallowRef(true), error: shallowRef(""), notice: shallowRef(""), persistent: shallowRef(true),
    pendingSync: shallowRef(false), confirmed: shallowRef(true),
    syncStatus: shallowRef({ phase: "paused", message: "" }),
    pendingRestore: shallowRef(null), restoreWritesAvailable: shallowRef(true),
    generationFlow: shallowRef({ phase: "active", generation: "00000000-0000-4000-8000-0000000000a1", serverConfirmed: true }),
    listRetainedGenerations: vi.fn(async () => [{ generation: "00000000-0000-4000-8000-0000000000a2", legacyGeneration: false, retainedAtMs: 1, pendingSync: false, recordCount: 3, importedLegacyIds: [] }]),
    retrySync: vi.fn(),
    ...localOverrides,
  };
  const app = renderer.createApp(DataPage, { accountId: accountA, local, busy: false });
  const instance = app.mount({ style: {} }) as unknown as { $: { subTree: VNode } };
  closes.push(() => app.unmount());
  return { root: instance.$, local };
}

async function flushRounds(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}

function collectText(vnode: VNode | null | undefined): string {
  if (vnode === null || vnode === undefined) return "";
  const parts: string[] = [];
  if (vnode.component?.subTree !== undefined && vnode.component?.subTree !== null) parts.push(collectText(vnode.component.subTree));
  const children = vnode.children;
  if (typeof children === "string") parts.push(children);
  else if (Array.isArray(children)) {
    for (const child of children) {
      if (child !== null && child !== undefined && typeof child === "object" && "children" in (child as VNode)) parts.push(collectText(child as VNode));
    }
  }
  return parts.join("");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
});
afterEach(() => { closes.splice(0).forEach((close) => close()); vi.unstubAllGlobals(); });

it("分区事实：本机/账号同步/独立备份/保留内容/旧验证导入与互斥说明", async () => {
  backupStatusMock.mockResolvedValue({ ok: true, status: statusOf({}) });
  const { root } = mountDataPage();
  await flushRounds();
  const text = collectText(root.subTree);
  expect(text).toContain("本机");
  expect(text).toContain("记录与草稿保存在此浏览器");
  expect(text).toContain("浏览器已授予持久存储");
  expect(text).toContain("账号同步");
  expect(text).toContain("此设备文档的已保存版本已由服务端持久保存");
  expect(text).toContain("独立备份");
  expect(text).toContain("最近完成版本 2");
  expect(text).toContain("备份版本与恢复");
  expect(text).toContain("保留内容");
  expect(text).toContain("有恢复前副本（1 份）");
  expect(text).toContain("从旧验证记录导入");
  expect(text).toContain("打开时读取，不自动关联账号");
  expect(text).toContain("同步完成不代表所有设备的修改都已备份");
  // 没有待确认请求：不显示条件入口。
  expect(text).not.toContain("查看恢复结果");
});

it("备份等待：等待原因与时间只用服务端 nextActionAtMs；未知明确未知", async () => {
  backupStatusMock.mockResolvedValue({ ok: true, status: statusOf({ currentBackedUp: false, nextActionAtMs: Date.parse("2026-10-08T10:21:00+08:00") }) });
  const { root } = mountDataPage();
  await flushRounds();
  const text = collectText(root.subTree);
  expect(text).toContain("有变化等待备份");
  expect(text).toContain("10/8");
  expect(text).toContain("后再次尝试");

  backupStatusMock.mockResolvedValue({ ok: true, status: statusOf({ currentBackedUp: false, nextActionAtMs: null }) });
  const { root: unknownRoot } = mountDataPage();
  await flushRounds();
  expect(collectText(unknownRoot.subTree)).toContain("下一次尝试时间未知");
});

it("备份 blocked：显示需要排查，不提供自动解锁时间", async () => {
  backupStatusMock.mockResolvedValue({ ok: true, status: statusOf({ currentBackedUp: false, blockedError: "r2_unavailable", nextActionAtMs: null }) });
  const { root } = mountDataPage();
  await flushRounds();
  const text = collectText(root.subTree);
  expect(text).toContain("自动备份已暂停，需要排查");
  expect(text).not.toContain("预计");
});

it("待确认恢复请求：数据页给出条件入口", async () => {
  backupStatusMock.mockResolvedValue({ ok: true, status: statusOf({}) });
  const { root } = mountDataPage({
    pendingRestore: shallowRef({ requestId: "00000000-0000-4000-8000-0000000000d1" }),
  });
  await flushRounds();
  const text = collectText(root.subTree);
  expect(text).toContain("有一笔恢复请求结果待确认");
  expect(text).toContain("查看恢复结果");
});

it("保留内容读取失败：明确读取失败与重试，不写成无内容", async () => {
  backupStatusMock.mockResolvedValue({ ok: true, status: statusOf({}) });
  const { root } = mountDataPage({
    listRetainedGenerations: vi.fn(async () => { throw new Error("boom"); }),
  });
  await flushRounds();
  const text = collectText(root.subTree);
  expect(text).toContain("暂时无法读取 · 重试");
  expect(text).not.toContain("没有保留内容");
});
