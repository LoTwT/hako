// 账号隔离与保护流程可达性测试（父审第一轮修复 UI-R03/UI-R07 的回归）：真实编译
// App.vue 与 RefuelingWorkspace.vue，useAuthSession/useLocalRefueling 以受控桩替代
// （A/B 两账号各一份 local），工作区子组件以最小桩替代（BackupRestore 挂载计数可
// 观察）。覆盖：会话门禁与账号切换隐藏旧账号私有内容（对照）；隐藏的旧账号
// 工作区不得改写当前账号路由或全局地址（UI-R03 两条复现路径的修正行为）；保护态
// 「查看恢复结果」挂载本机原请求面板且不自动派发（UI-R07）；有限哈希与活动导航
// 保留原请求身份（对照）。不冒充真实浏览器。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextTick, shallowRef, type VNode } from "vue";
import App from "../../src/App.vue";
import { syntheticRecord } from "../helpers/sync-fixtures";
import { parseAppRoute } from "../../src/ui/app-route";
import { createMinimalHostRenderer, createMinimalHostRoot, type MinimalHostNode } from "../helpers/minimal-host";

const observed = vi.hoisted(() => ({
  auth: null as unknown as { value: { accountId: string | null; status: string; message: string; loggingIn: boolean; loggingOut: boolean } },
  locals: new Map<string, unknown>(),
  backupMounts: 0,
  backupUnmounts: 0,
  flushOk: true,
  flushCalls: 0,
  pendingClearAfterSave: null as Promise<{ ok: boolean; message: string }> | null,
  pendingDiscard: null as Promise<"cleared" | "held" | "failed"> | null,
}));

vi.mock("virtual:pwa-register/vue", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useRegisterSW: () => ({ offlineReady: sr(false), needRefresh: sr(false) }) };
});
vi.mock("../../src/ui/appearance", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useAppearance: () => ({ appearance: sr("system"), systemDark: sr(false), setAppearance() {}, dispose() {} }) };
});
vi.mock("../../src/composables/useAuthSession", () => ({
  useAuthSession: () => ({ auth: observed.auth, refresh: async () => undefined, login: vi.fn(), logout: vi.fn(), recheckRejectedSession: vi.fn() }),
}));
vi.mock("../../src/composables/useLocalRefueling", () => ({
  useLocalRefueling: ({ accountId }: { accountId: string }) => observed.locals.get(accountId),
}));
vi.mock("../../src/composables/useRefuelingDrafts", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useRefuelingDrafts: () => ({
    drafts: sr({ status: "ready", recovery: { status: "ready", candidates: [], notice: "" }, writeError: "", orphanedEditCount: 0, unsupportedCount: 0 }),
    initialize: async () => undefined,
    attachForm() {}, updateDraft() {}, adoptedDraft: () => null, currentDraftId: () => null,
    flush: async () => {
      observed.flushCalls += 1;
      return observed.flushOk;
    },
    // 保存清理/放弃是异步出口（UI-R03 二轮）：受控可阻塞，观察迟到完成的路由副作用。
    clearAfterSave: async () => {
      if (observed.pendingClearAfterSave !== null) return await observed.pendingClearAfterSave;
      return { ok: true, message: "" };
    },
    discard: async () => {
      if (observed.pendingDiscard !== null) return await observed.pendingDiscard;
      return "cleared";
    },
  }) };
});
vi.mock("../../src/components/refueling/RefuelingForm.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ props: ["initial", "initialDraft", "busy", "locked", "available", "records", "editingRecordId"], setup: () => () => h("div", "synthetic-form") }) };
});
vi.mock("../../src/components/refueling/RecordsRoot.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ props: ["records"], setup: (props) => () => h("div", (props.records as unknown[]).map((r) => (r as { stationName: string }).stationName).join(" ")) }) };
});
vi.mock("../../src/components/refueling/RecordDetailPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/StatisticsPage.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/DataPage.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/BackupRestore.vue", async () => {
  const { defineComponent, h, onMounted, onUnmounted } = await import("vue");
  return { default: defineComponent({ setup() { onMounted(() => { observed.backupMounts += 1; }); onUnmounted(() => { observed.backupUnmounts += 1; }); return () => h("div", "synthetic-original-request-panel"); } }) };
});
vi.mock("../../src/components/refueling/LegacyImport.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/RetainedRefuelingCopy.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/DraftSelectionLayer.vue", () => ({ default: { render: () => null } }));

const renderer = createMinimalHostRenderer();

function allNodes(node: MinimalHostNode): MinimalHostNode[] {
  const nodes: MinimalHostNode[] = [node];
  for (const child of node.children) nodes.push(...allNodes(child));
  return nodes;
}
function visibleText(node: MinimalHostNode): string {
  return allNodes(node)
    .map((entry) => (entry.style.display === "none" || entry.kind === "comment" ? "" : entry.text ?? ""))
    .join(" ");
}
function componentStates(vnode: VNode, name: string): unknown[] {
  const states: unknown[] = [];
  if (vnode.component) {
    if ((vnode.type as { __name?: string }).__name === name) states.push((vnode.component as unknown as { setupState: unknown }).setupState);
    states.push(...componentStates(vnode.component.subTree, name));
  }
  if (Array.isArray(vnode.children)) {
    for (const child of vnode.children) if (child !== null && typeof child === "object" && "type" in (child as VNode)) states.push(...componentStates(child as VNode, name));
  }
  return states;
}

const G0 = "00000000-0000-4000-8000-0000000000d1";
const G1 = "00000000-0000-4000-8000-0000000000d2";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";

function localFor(account: string) {
  return {
    records: shallowRef([{ ...syntheticRecord, id: account === A ? "record-a" : "record-b", stationName: account === A ? "PRIVATE_A_SYNTHETIC" : "PRIVATE_B_SYNTHETIC" }]),
    ready: shallowRef(true), saving: shallowRef(false), error: shallowRef(""), notice: shallowRef(""), persistent: shallowRef(false), importedLegacyIds: shallowRef([]),
    pendingSync: shallowRef(false), confirmed: shallowRef(true), syncStatus: shallowRef({ phase: "paused", message: "" }),
    pendingRestore: shallowRef(null), importConflicts: shallowRef({}), migrationPending: shallowRef(null), restoreWritesAvailable: shallowRef(true),
    generationFlow: shallowRef({ phase: "active", generation: G0, serverConfirmed: true }), workspaceGeneration: shallowRef(G0),
    save: vi.fn(async () => true), initialize: vi.fn(), requestPersistence: vi.fn(), importLegacy: vi.fn(), retrySync: vi.fn(),
    openCurrentGeneration: vi.fn(), recheckRestoreReceipt: vi.fn(), listRetainedGenerations: vi.fn(), readRetainedGeneration: vi.fn(), retryOpen: vi.fn(), recheckMigration: vi.fn(),
    refresh: vi.fn(), beginRestoreRequest: vi.fn(), submitPendingRestore: vi.fn(),
  };
}

const closes: Array<() => void> = [];
const loc = { hash: "#refueling", assign: vi.fn() };
const history = { replaceState: vi.fn(), pushState: vi.fn(), back: vi.fn() };

function auth(accountId: string | null, status = accountId !== null ? "authenticated" : "unavailable") {
  observed.auth.value = { accountId, status, message: "", loggingIn: false, loggingOut: false };
}
async function settle() { for (let i = 0; i < 6; i++) { await nextTick(); await Promise.resolve(); } }

function mount() {
  const root = createMinimalHostRoot();
  const app = renderer.createApp(App);
  const vm = app.mount(root) as unknown as { $: { setupState: Record<string, (...args: unknown[]) => unknown>; subTree: VNode } };
  closes.push(() => app.unmount());
  return { root, state: vm.$.setupState, workspaceStates: () => componentStates(vm.$.subTree, "RefuelingWorkspace") as Array<Record<string, unknown>> };
}

beforeEach(() => {
  observed.auth = shallowRef({ accountId: A, status: "authenticated", message: "", loggingIn: false, loggingOut: false });
  observed.locals.clear(); observed.locals.set(A, localFor(A)); observed.locals.set(B, localFor(B));
  observed.backupMounts = 0; observed.backupUnmounts = 0; observed.flushOk = true; observed.flushCalls = 0;
  observed.pendingClearAfterSave = null; observed.pendingDiscard = null;
  loc.hash = "#refueling"; history.replaceState.mockClear(); history.pushState.mockClear(); history.back.mockClear();
  vi.stubGlobal("window", { location: loc, history, scrollTo() {}, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("document", { title: "", visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { closes.splice(0).forEach((close) => close()); vi.unstubAllGlobals(); });

it("对照：会话门禁与账号切换隐藏旧账号私有内容，两个工作区实例都保留", async () => {
  const mounted = mount(); await settle();
  expect(mounted.workspaceStates().length).toBe(1);
  auth(null); await settle();
  auth(B); await settle();
  expect(mounted.workspaceStates().length).toBe(2);
});

it("UI-R03 隐藏的 A 不得改写 B 的记录详情地址（修正行为：路由与全局地址都保持 B 的目标）", async () => {
  const mounted = mount(); await settle();
  auth(B); await settle();
  await (mounted.state.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "record-detail", recordId: "record-b" } });
  await settle();
  // B 的详情地址落位；隐藏的 A 工作区没有以「没有找到这条记录」改写路由。
  expect(mounted.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-detail", recordId: "record-b" } });
  const hiddenA = mounted.workspaceStates().find((entry) => (entry as { localNotice?: string }).localNotice !== undefined);
  expect(hiddenA).toBeDefined();
  expect((hiddenA as { localNotice: string }).localNotice).toBe("");
});

it("UI-R03 A 的挂起编辑不得经 B 的导航泄露到全局地址（修正行为：不替换为 A 的编辑地址）", async () => {
  const mounted = mount(); await settle();
  const localA = observed.locals.get(A) as { records: { value: Array<{ id: string }> } };
  (mounted.workspaceStates()[0] as { startEdit: (record: unknown) => void }).startEdit(localA.records.value[0]!);
  await settle();
  await (mounted.state.navigate as (route: unknown) => Promise<void>)({ name: "home" });
  await settle();
  auth(B); await settle();
  history.replaceState.mockClear(); history.pushState.mockClear();
  await (mounted.state.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "record-new" } });
  await settle();
  expect(mounted.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-new" } });
  expect(history.replaceState).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "/#refueling/records/record-a/edit");
});

it("UI-R07 保护态「查看恢复结果」挂载原请求面板，pending 保留且不自动派发", async () => {
  const mounted = mount(); await settle();
  const local = observed.locals.get(A) as { pendingRestore: { value: unknown }, generationFlow: { value: unknown }, submitPendingRestore: ReturnType<typeof vi.fn> };
  await (mounted.state.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "data-backups" } });
  await settle();
  expect(observed.backupMounts).toBe(1);
  local.pendingRestore.value = { requestId: "original-request", requestFingerprint: "fixed-original" };
  local.generationFlow.value = { phase: "protected", localGeneration: G0, serverGeneration: G1, legacyGeneration: G0, receipt: "unknown", message: "synthetic protected" };
  await settle();
  // D2（backups 列表分区）出现「查看恢复结果」入口，本人点击推进到 D3。
  const entry = allNodes(mounted.root).find((node) => node.kind === "element" && node.tag === "button" && visibleText(node).trim() === "查看恢复结果");
  expect(entry).toBeDefined();
  (entry!.props.onClick as (event: unknown) => void)({ button: 0 });
  await settle();
  // 修正行为：D3 挂载本机原请求面板（不再只有地址变化），pending 保留，未自动派发。
  expect(mounted.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "data-restore-result" } });
  expect(observed.backupMounts).toBe(2);
  expect(observed.backupUnmounts).toBe(0);
  expect(visibleText(mounted.root)).toContain("synthetic-original-request-panel");
  expect(local.pendingRestore.value).toMatchObject({ requestId: "original-request" });
  expect(local.submitPendingRestore).not.toHaveBeenCalled();
});

it("对照：有限哈希不能提供恢复请求或不安全的记录 ID", () => {
  for (const hash of ["#refueling/data/restore/request-id", "#refueling/data/restore?requestId=attacker", "#refueling/data/backups/preview/attacker"]) {
    expect(parseAppRoute(hash)).toEqual({ name: "refueling", refueling: { name: "data" } });
  }
  for (const hash of ["#refueling/records/<script>", "#refueling/records/%2e%2e/edit", `#refueling/records/${"a".repeat(65)}`]) {
    expect(parseAppRoute(hash)).toEqual({ name: "refueling", refueling: { name: "records" } });
  }
});

it("对照：活动账号导航保留待确认请求身份，不自动提交", async () => {
  const mounted = mount(); await settle();
  const local = observed.locals.get(A) as { pendingRestore: { value: unknown }, submitPendingRestore: ReturnType<typeof vi.fn>, beginRestoreRequest: ReturnType<typeof vi.fn> };
  const original = { requestId: "original-request", requestFingerprint: "fixed-original", body: { previewId: "original-preview" } };
  local.pendingRestore.value = original;
  for (const name of ["data-restore-result", "data", "records", "data-restore-result"]) {
    await (mounted.state.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name } });
    await settle();
    expect(local.pendingRestore.value).toBe(original);
  }
  expect(local.submitPendingRestore).not.toHaveBeenCalled();
  expect(local.beginRestoreRequest).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// UI-R03 二轮：隐藏旧账号的保存/放弃迟到完成不得夺走当前账号路由
// ---------------------------------------------------------------------------

it("UI-R03 二轮：A 保存成功但 clearAfterSave 阻塞期间切到 B——A 的迟到返回不改变 B 的路由", async () => {
  const mounted = mount(); await settle();
  const localA = observed.locals.get(A) as { records: { value: Array<{ id: string }> } };
  const workspaceA = mounted.workspaceStates()[0] as unknown as {
    startEdit: (record: unknown) => void;
    submit: (record: unknown) => Promise<void>;
  };
  workspaceA.startEdit(localA.records.value[0]!);
  await settle();
  // 保存已成功、草稿清理在途（真实组合层里清理在独立异步链上）：清理结果在
  // 会话切换之后才返回。
  let releaseClearAfterSave!: (value: { ok: boolean; message: string }) => void;
  observed.pendingClearAfterSave = new Promise((resolve) => { releaseClearAfterSave = resolve; });
  const submitDone = workspaceA.submit({ ...syntheticRecord, id: "record-a" });
  await settle();
  // 期间会话切到 B，B 导航到统计页。
  auth(B); await settle();
  await (mounted.state.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await settle();
  expect(mounted.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "statistics" } });
  history.replaceState.mockClear(); history.pushState.mockClear();
  releaseClearAfterSave({ ok: true, message: "" });
  await submitDone;
  await settle();
  // A 的迟到返回不写全局地址、不改变 B 的目标（编辑器随保活实例保留）。
  expect(mounted.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "statistics" } });
  expect(history.replaceState).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "/#refueling/records/record-a/edit");
  expect(history.pushState).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "/#refueling/records/record-a/edit");
});

it("UI-R03 二轮对照：当前账号自身的保存完成仍正常返回来源", async () => {
  const mounted = mount(); await settle();
  const localA = observed.locals.get(A) as { records: { value: Array<{ id: string }> } };
  const workspaceA = mounted.workspaceStates()[0] as unknown as {
    startEdit: (record: unknown) => void;
    submit: (record: unknown) => Promise<void>;
  };
  workspaceA.startEdit(localA.records.value[0]!);
  await settle();
  history.back.mockClear();
  await workspaceA.submit({ ...syntheticRecord, id: "record-a" });
  await settle();
  // 未切换账号：保存结束经历史返回来源（本 harness 的 history 桩不派发 popstate，
  // 路由落位由导航归属套件单独覆盖）。
  expect(history.back).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// 父审第三轮修复（UI-R03.1 同账号较新导航 / R03.2 隐藏账号的编辑结束）
// ---------------------------------------------------------------------------

it("UI-R03.1：保存清理在途时同账号已去统计——迟到完成不把页面拉回旧详情", async () => {
  const mounted = mount(); await settle();
  const localA = observed.locals.get(A) as { records: { value: Array<{ id: string }> } };
  const workspaceA = mounted.workspaceStates()[0] as unknown as {
    startEdit: (record: unknown) => void;
    submit: (record: unknown) => Promise<void>;
  };
  workspaceA.startEdit(localA.records.value[0]!);
  await settle();
  let releaseClearAfterSave!: (value: { ok: boolean; message: string }) => void;
  observed.pendingClearAfterSave = new Promise((resolve) => { releaseClearAfterSave = resolve; });
  const submitDone = workspaceA.submit({ ...syntheticRecord, id: "record-a" });
  await settle();
  // 同账号较新的导航：用户去统计（保存忙状态已解除，导航可达）。
  await (mounted.state.navigate as (route: unknown) => Promise<void>)({ name: "refueling", refueling: { name: "statistics" } });
  await settle();
  expect(mounted.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "statistics" } });
  history.replaceState.mockClear(); history.pushState.mockClear();
  releaseClearAfterSave({ ok: true, message: "" });
  await submitDone;
  await settle();
  // 迟到完成只结束编辑，不抢回旧详情：路由保持统计，不写旧编辑地址。
  expect(mounted.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "statistics" } });
  expect(history.replaceState).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining("record-a"));
  expect(history.pushState).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining("record-a"));
});

it("UI-R03.2：隐藏账号的已保存编辑在清理完成时结束（切回不再继续旧编辑）", async () => {
  const mounted = mount(); await settle();
  const localA = observed.locals.get(A) as { records: { value: Array<{ id: string }> } };
  const workspaceA = mounted.workspaceStates()[0] as unknown as {
    startEdit: (record: unknown) => void;
    submit: (record: unknown) => Promise<void>;
    pendingEditor: unknown;
    dirty: boolean;
  };
  workspaceA.startEdit(localA.records.value[0]!);
  await settle();
  let releaseClearAfterSave!: (value: { ok: boolean; message: string }) => void;
  observed.pendingClearAfterSave = new Promise((resolve) => { releaseClearAfterSave = resolve; });
  const submitDone = workspaceA.submit({ ...syntheticRecord, id: "record-a" });
  await settle();
  // 清理在途时切到 B（A 隐藏）：A 自身的编辑收尾仍应完成。
  auth(B); await settle();
  releaseClearAfterSave({ ok: true, message: "" });
  await submitDone;
  await settle();
  // 本机结束：挂起编辑与输入标记已清（确属本次操作的已保存编辑不留「可继续」状态）。
  expect(workspaceA.pendingEditor).toBeNull();
  expect(workspaceA.dirty).toBe(false);
  // 切回 A：没有旧编辑实例可继续。
  auth(A); await settle();
  expect(workspaceA.pendingEditor).toBeNull();
});
