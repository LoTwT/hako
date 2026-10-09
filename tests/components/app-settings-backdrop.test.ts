// 设置层背景路由回归（S-1，2026-10-09）：真实编译 App.vue 与 RefuelingWorkspace.vue，
// useAuthSession/useLocalRefueling/useRefuelingDrafts 以受控桩替代，工作区子视图以
// 可观测桩替代（DataPage/StatisticsPage/BackupRestore 挂载计数可观察）。覆盖：
// 从数据/统计/备份预览打开设置时背景业务页面保持来源子路由与实例（不能退回
// 记录根页）；备份面板不因打开设置卸载（卸载会触发未提交预览的精确取消）；
// 编辑器打开设置保留编辑地址与表单实例，迟到的保存/放弃完成不夺走设置层路由；
// 直接打开/刷新 #settings 叠在首页的兜底与从首页打开设置的背景归属；Esc 与
// 浏览器返回按同一来源规则关闭。不冒充真实浏览器（边界见 docs/local-validation.md）。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextTick, shallowRef, type VNode } from "vue";
import App from "../../src/App.vue";
import { syntheticRecord } from "../helpers/sync-fixtures";
import { createMinimalHostRenderer, createMinimalHostRoot, type MinimalHostNode } from "../helpers/minimal-host";

const observed = vi.hoisted(() => ({
  auth: null as unknown as { value: { accountId: string | null; status: string; message: string; loggingIn: boolean; loggingOut: boolean } },
  local: null as unknown as Record<string, unknown>,
  backupMounts: 0,
  backupUnmounts: 0,
  dataPageMounts: 0,
  statisticsPageMounts: 0,
  formMounts: 0,
  formUnmounts: 0,
  flushOk: true,
  pendingClearAfterSave: null as Promise<{ ok: boolean; message: string }> | null,
  pendingDiscard: null as Promise<"cleared" | "held" | "failed"> | null,
  /** 面板桩的 emit 句柄：模拟背景面板异步完成时的 requestSection 出口。 */
  backupEmitters: [] as Array<(event: "close" | "requestSection" | "cancelUnconfirmedChange", ...args: unknown[]) => void>,
}));

vi.mock("virtual:pwa-register/vue", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useRegisterSW: () => ({ offlineReady: sr(false), needRefresh: sr(false) }) };
});
vi.mock("../../src/ui/appearance", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useAppearance: () => ({ appearance: sr("system"), systemDark: sr(false), setAppearance() {}, dispose() {} }) };
});
vi.mock("../../src/composables/useAuthSession", async () => {
  const { shallowRef: sr } = await import("vue");
  return {
    useAuthSession: () => ({
      auth: observed.auth,
      authenticatedAccountLabel: sr("已登录 · eruoo"),
      localDevelopment: false,
      refresh: async () => undefined,
      login: vi.fn(),
      logout: vi.fn(),
      recheckRejectedSession: vi.fn(),
    }),
  };
});
vi.mock("../../src/composables/useLocalRefueling", () => ({
  useLocalRefueling: () => observed.local,
}));
vi.mock("../../src/composables/useRefuelingDrafts", async () => {
  const { shallowRef: sr } = await import("vue");
  return { useRefuelingDrafts: () => ({
    drafts: sr({ status: "ready", recovery: { status: "ready", candidates: [], notice: "" }, writeError: "", orphanedEditCount: 0, unsupportedCount: 0 }),
    initialize: async () => undefined,
    attachForm() {}, updateDraft() {}, adoptedDraft: () => null, currentDraftId: () => null,
    flush: async () => observed.flushOk,
    // 保存清理/放弃是异步出口：受控可阻塞，观察迟到完成对设置层路由的影响。
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
  const { defineComponent, h, onMounted, onUnmounted } = await import("vue");
  return { default: defineComponent({
    props: ["initial", "initialDraft", "busy", "locked", "available", "records", "editingRecordId"],
    setup: () => {
      onMounted(() => { observed.formMounts += 1; });
      onUnmounted(() => { observed.formUnmounts += 1; });
      return () => h("div", "synthetic-form");
    },
  }) };
});
vi.mock("../../src/components/refueling/RecordsRoot.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ props: ["records"], setup: (props) => () => h("div", (props.records as unknown[]).map((r) => (r as { stationName: string }).stationName).join(" ")) }) };
});
vi.mock("../../src/components/refueling/RecordDetailPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/StatisticsPage.vue", async () => {
  const { defineComponent, h, onMounted } = await import("vue");
  return { default: defineComponent({ setup: () => { onMounted(() => { observed.statisticsPageMounts += 1; }); return () => h("div", "synthetic-statistics-page"); } }) };
});
vi.mock("../../src/components/refueling/DataPage.vue", async () => {
  const { defineComponent, h, onMounted } = await import("vue");
  return { default: defineComponent({ setup: () => { onMounted(() => { observed.dataPageMounts += 1; }); return () => h("div", "synthetic-data-page"); } }) };
});
vi.mock("../../src/components/refueling/BackupRestore.vue", async () => {
  const { defineComponent, h, onMounted, onUnmounted } = await import("vue");
  return { default: defineComponent({
    props: ["accountId", "local", "flushDraft", "visibleSection", "protectionMode", "onCancelUnconfirmedChange", "cancelDeliveryEpoch"],
    emits: ["close", "requestSection", "cancelUnconfirmedChange"],
    setup(_props, { emit }) {
      onMounted(() => { observed.backupMounts += 1; observed.backupEmitters.push(emit); });
      onUnmounted(() => { observed.backupUnmounts += 1; observed.backupEmitters = observed.backupEmitters.filter((entry) => entry !== emit); });
      return () => h("div", "synthetic-backup-restore-panel");
    },
  }) };
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
    .join(" ")
    .replace(/\s+/g, " ");
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

const A = "00000000-0000-4000-8000-0000000000a1";
const G0 = "00000000-0000-4000-8000-0000000000d1";

function localFor() {
  return {
    records: shallowRef([{ ...syntheticRecord, id: "record-a", stationName: "PRIVATE_A_SYNTHETIC" }]),
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
const history = { replaceState: vi.fn((_data: unknown, _unused: string, href: string) => { loc.hash = href.slice(href.indexOf("#")); }), pushState: vi.fn((_data: unknown, _unused: string, href: string) => { loc.hash = href.slice(href.indexOf("#")); }), back: vi.fn() };

type SetupState = Record<string, (...args: unknown[]) => unknown>;
let mounted: { root: MinimalHostNode; state: SetupState; workspaces: () => Array<Record<string, unknown>> } | null = null;

async function settle() { for (let i = 0; i < 6; i += 1) { await nextTick(); await Promise.resolve(); } }

function mountApp(): { root: MinimalHostNode; state: SetupState; workspaces: () => Array<Record<string, unknown>> } {
  const root = createMinimalHostRoot();
  const app = renderer.createApp(App);
  const vm = app.mount(root) as unknown as { $: { setupState: SetupState; subTree: VNode } };
  closes.push(() => app.unmount());
  const entry = { root, state: vm.$.setupState, workspaces: () => componentStates(vm.$.subTree, "RefuelingWorkspace") as Array<Record<string, unknown>> };
  mounted = entry;
  return entry;
}

/** 工作区当前的加油业务路由名（背景页面身份；setupState 经 proxyRefs 已解包）。 */
function workspaceRouteName(): string {
  const workspaces = mounted?.workspaces() ?? [];
  const routeName = workspaces[0]?.routeName as unknown as string | { value: string } | undefined;
  if (routeName === undefined) throw new Error("加油工作区尚未挂载");
  return typeof routeName === "string" ? routeName : routeName.value;
}

async function navigate(route: unknown): Promise<void> {
  await (mounted!.state.navigate as (route: unknown) => Promise<void>)(route);
  await settle();
}

async function openSettings(): Promise<void> {
  (mounted!.state.openSettings as () => void)();
  await settle();
}

/** 模拟浏览器历史导航（popstate 携带条目状态；hashchange 复用同一次捕获）。 */
async function browserHistoryTo(hash: string, entryState: unknown): Promise<void> {
  loc.hash = hash;
  const listener = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
    .find(([type]) => type === "popstate")?.[1] as (event: { state: unknown }) => void;
  if (listener === undefined) throw new Error("popstate 监听未注册");
  listener({ state: entryState });
  await settle();
}

beforeEach(() => {
  observed.auth = shallowRef({ accountId: A, status: "authenticated", message: "", loggingIn: false, loggingOut: false });
  observed.local = localFor();
  observed.backupMounts = 0; observed.backupUnmounts = 0; observed.dataPageMounts = 0; observed.statisticsPageMounts = 0;
  observed.formMounts = 0; observed.formUnmounts = 0; observed.flushOk = true;
  observed.pendingClearAfterSave = null; observed.pendingDiscard = null;
  observed.backupEmitters = [];
  loc.hash = "#refueling"; history.replaceState.mockClear(); history.pushState.mockClear(); history.back.mockClear();
  vi.stubGlobal("window", { location: loc, history, scrollTo: vi.fn(), sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener: vi.fn(), removeEventListener: vi.fn(), matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("document", { title: "", visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { closes.splice(0).forEach((close) => close()); mounted = null; vi.unstubAllGlobals(); });

it("S-1 从数据打开设置：背景保持数据页身份与实例，Esc 关闭回到数据", async () => {
  mountApp(); await settle();
  await navigate({ name: "refueling", refueling: { name: "data" } });
  expect(workspaceRouteName()).toBe("data");
  expect(visibleText(mounted!.root)).toContain("synthetic-data-page");
  expect(visibleText(mounted!.root)).toContain("加油 / 数据");

  await openSettings();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  // 背景业务页面仍是数据页：路由、页面实例与标题都不退回记录根页。
  expect(workspaceRouteName()).toBe("data");
  expect(visibleText(mounted!.root)).toContain("synthetic-data-page");
  expect(visibleText(mounted!.root)).toContain("加油 / 数据");
  expect(visibleText(mounted!.root)).toContain("账号与外观");
  expect(observed.dataPageMounts).toBe(1);

  // Esc 关闭：统一关闭动作走历史返回（邻项可信时 history.back），随后浏览器
  // 事件把地址落回数据页。
  (mounted!.state.closeSettings as () => void)();
  expect(history.back).toHaveBeenCalledTimes(1);
  loc.hash = "#refueling/data";
  await (mounted!.state.onLocationChanged as () => Promise<void>)();
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "data" } });
  expect(visibleText(mounted!.root)).not.toContain("账号与外观");
  expect(visibleText(mounted!.root)).toContain("synthetic-data-page");
  // 打开设置没有卸载/重建数据页实例。
  expect(observed.dataPageMounts).toBe(1);
});

it("S-1 从统计打开设置：背景保持统计页，浏览器返回与 Esc 同一来源规则", async () => {
  mountApp(); await settle();
  await navigate({ name: "refueling", refueling: { name: "statistics" } });
  expect(workspaceRouteName()).toBe("statistics");
  expect(observed.statisticsPageMounts).toBe(1);

  await openSettings();
  expect(workspaceRouteName()).toBe("statistics");
  expect(visibleText(mounted!.root)).toContain("synthetic-statistics-page");
  expect(visibleText(mounted!.root)).toContain("加油 / 加油统计");
  expect(visibleText(mounted!.root)).toContain("账号与外观");
  expect(observed.statisticsPageMounts).toBe(1);

  // 浏览器 Back：地址回到统计页，设置层关闭，背景页面身份一致。
  loc.hash = "#refueling/statistics";
  await (mounted!.state.onLocationChanged as () => Promise<void>)();
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "statistics" } });
  expect(visibleText(mounted!.root)).not.toContain("账号与外观");
  expect(workspaceRouteName()).toBe("statistics");
  expect(observed.statisticsPageMounts).toBe(1);
});

it("S-1 从恢复预览打开设置：备份面板不卸载（不触发未提交预览的卸载取消）", async () => {
  mountApp(); await settle();
  await navigate({ name: "refueling", refueling: { name: "data-backup-preview" } });
  expect(observed.backupMounts).toBe(1);
  expect(observed.backupUnmounts).toBe(0);

  await openSettings();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  // 打开设置不离开备份区：面板保持挂载，卸载路径（会对未提交预览发送精确
  // 取消）不得发生。
  expect(workspaceRouteName()).toBe("data-backup-preview");
  expect(observed.backupUnmounts).toBe(0);
  expect(observed.backupMounts).toBe(1);

  // 关闭设置回到预览页，面板实例不变。
  (mounted!.state.closeSettings as () => void)();
  loc.hash = "#refueling/data/backups/preview";
  await (mounted!.state.onLocationChanged as () => Promise<void>)();
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "data-backup-preview" } });
  expect(observed.backupMounts).toBe(1);
  expect(observed.backupUnmounts).toBe(0);
});

it("S-1 编辑器打开设置：保留编辑地址与表单实例；迟到的保存完成不夺走设置层", async () => {
  mountApp(); await settle();
  const workspace = mounted!.workspaces()[0]! as unknown as { startEdit: (record: unknown) => void; submit: (record: unknown) => Promise<void> };
  (workspace.startEdit as (record: unknown) => void)({ ...syntheticRecord, id: "record-a" });
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "record-edit", recordId: "record-a" } });
  // startEdit 建立新表单实例（formKey 递增）；以此时的实例为基线观察设置层
  // 开关是否保活同一实例。
  const formMountsAtEdit = observed.formMounts;
  const formUnmountsAtEdit = observed.formUnmounts;

  // 保存清理在途时打开设置：编辑地址与表单实例保持，不退回记录根页。
  let releaseSave!: (result: { ok: boolean; message: string }) => void;
  observed.pendingClearAfterSave = new Promise((resolve) => { releaseSave = resolve; });
  const submitting = (workspace.submit as (record: unknown) => Promise<void>)({ ...syntheticRecord, id: "record-a" });
  await settle();
  await openSettings();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  expect(workspaceRouteName()).toBe("record-edit");
  expect(visibleText(mounted!.root)).toContain("编辑记录");
  expect(observed.formUnmounts).toBe(formUnmountsAtEdit);
  expect(observed.formMounts).toBe(formMountsAtEdit);

  // 迟到的保存完成只结束编辑，不把页面从设置层拉走（较新的导航意图优先）。
  history.pushState.mockClear(); history.replaceState.mockClear(); history.back.mockClear();
  releaseSave({ ok: true, message: "" });
  await submitting;
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  expect(history.pushState).not.toHaveBeenCalled();
  expect(history.replaceState).not.toHaveBeenCalled();
  expect(history.back).not.toHaveBeenCalled();
});

it("S-1 直接打开/刷新 #settings：叠在首页（无来源工作区），关闭回首页", async () => {
  loc.hash = "#settings";
  mountApp(); await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  expect(visibleText(mounted!.root)).toContain("账号与外观");
  expect(visibleText(mounted!.root)).toContain("我的工具");
  // 无来源：加油工作区不挂载。
  expect(mounted!.workspaces()).toHaveLength(0);

  (mounted!.state.closeSettings as () => void)();
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "home" });
  expect(visibleText(mounted!.root)).toContain("我的工具");
  expect(visibleText(mounted!.root)).not.toContain("账号与外观");
  expect(history.replaceState).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/");
});

it("S-1 从首页打开设置：首页背景保留，Esc 关闭回到首页", async () => {
  loc.hash = "";
  mountApp(); await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "home" });

  await openSettings();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  // 首页在设置层下保持渲染（仅被覆盖），加油工作区仍未挂载。
  expect(visibleText(mounted!.root)).toContain("我的工具");
  expect(visibleText(mounted!.root)).toContain("账号与外观");
  expect(mounted!.workspaces()).toHaveLength(0);

  (mounted!.state.closeSettings as () => void)();
  expect(history.back).toHaveBeenCalledTimes(1);
  loc.hash = "";
  await (mounted!.state.onLocationChanged as () => Promise<void>)();
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "home" });
  expect(visibleText(mounted!.root)).not.toContain("账号与外观");
});

it("HS-R1 Forward 重新进入同一设置历史项：背景与关闭目标保持来源页（父审 R1）", async () => {
  mountApp(); await settle();
  await navigate({ name: "refueling", refueling: { name: "data" } });
  await openSettings();
  // 打开设置时，来源作为历史条目状态写入当前条目（同一设置历史项的可信来源）。
  expect(history.replaceState).toHaveBeenCalledWith({ hako: true, settingsSource: "/#refueling/data" }, expect.anything(), "/#settings");

  // Esc 关闭 → history.back 落回数据页。
  (mounted!.state.closeSettings as () => void)();
  expect(history.back).toHaveBeenCalledTimes(1);
  await browserHistoryTo("#refueling/data", { hako: true });
  expect(mounted!.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "data" } });
  expect(visibleText(mounted!.root)).not.toContain("账号与外观");

  // 浏览器 Forward 回到同一设置历史项：popstate 携带该条目状态，来源恢复——
  // 背景仍是数据页（不是首页），设置层打开。
  await browserHistoryTo("#settings", { hako: true, settingsSource: "/#refueling/data" });
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  expect(workspaceRouteName()).toBe("data");
  expect(visibleText(mounted!.root)).toContain("synthetic-data-page");
  expect(visibleText(mounted!.root)).toContain("加油 / 数据");
  expect(visibleText(mounted!.root)).toContain("账号与外观");
  expect(observed.dataPageMounts).toBe(1);

  // 再次 Esc：关闭回到数据页（不是首页）。
  (mounted!.state.closeSettings as () => void)();
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "data" } });
  expect(history.replaceState).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/#refueling/data");
  expect(visibleText(mounted!.root)).not.toContain("账号与外观");
  expect(visibleText(mounted!.root)).toContain("synthetic-data-page");
  expect(observed.dataPageMounts).toBe(1);

  // 无可信来源的设置条目（直接打开等）不恢复业务背景：仍按首页兜底。
  await browserHistoryTo("#refueling", { hako: true });
  await openSettings();
  await browserHistoryTo("#refueling", { hako: true });
  await browserHistoryTo("#settings", { hako: true });
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  expect(visibleText(mounted!.root)).toContain("我的工具");
  // 非应用写入（无 hako 标记）或非法来源的条目状态同样不恢复。
  await browserHistoryTo("#refueling", { hako: true });
  await browserHistoryTo("#settings", { hako: false, settingsSource: "/#refueling/records/one" });
  expect(visibleText(mounted!.root)).toContain("我的工具");
  await browserHistoryTo("#settings", { hako: true, settingsSource: "/#login" });
  expect(visibleText(mounted!.root)).toContain("我的工具");
});

it("HS-R2 设置层打开期间背景面板的迟到完成不关闭设置层：只推进背景身份（父审 R1）", async () => {
  mountApp(); await settle();
  await navigate({ name: "refueling", refueling: { name: "data-backups" } });
  expect(observed.backupMounts).toBe(1);
  await openSettings();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  expect(workspaceRouteName()).toBe("data-backups");
  const workspace = mounted!.workspaces()[0]! as unknown as { routeHeading: { focusCount: number } };
  const focusCountBefore = workspace.routeHeading.focusCount;
  const scrollTo = (window as unknown as { scrollTo: ReturnType<typeof vi.fn> }).scrollTo;
  scrollTo.mockClear();
  history.pushState.mockClear(); history.replaceState.mockClear();

  // 背景面板异步完成（预览创建后推进 D2）：requestSection 经工作区导航回调，
  // 只推进背景业务页面身份——设置层保持自己的地址/标题/焦点。
  observed.backupEmitters[0]!("requestSection", "preview");
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "settings" });
  expect(workspaceRouteName()).toBe("data-backup-preview");
  expect(visibleText(mounted!.root)).toContain("账号与外观");
  expect(visibleText(mounted!.root)).toContain("synthetic-backup-restore-panel");
  expect(observed.backupUnmounts).toBe(0);
  expect(observed.backupMounts).toBe(1);
  expect(history.pushState).not.toHaveBeenCalled();
  // 历史条目状态随最新背景页重写（Forward 再入一致），地址仍是 /#settings。
  expect(history.replaceState).toHaveBeenCalledWith({ hako: true, settingsSource: "/#refueling/data/backups/preview" }, expect.anything(), "/#settings");
  // 背景不抢焦点、不滚动（焦点/滚动归设置层所有）。
  expect(workspace.routeHeading.focusCount).toBe(focusCountBefore);
  expect(scrollTo).not.toHaveBeenCalled();

  // Esc 关闭：按最新背景页（D2 恢复预览）返回，面板实例不变、未触发卸载取消。
  (mounted!.state.closeSettings as () => void)();
  await settle();
  expect(mounted!.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "data-backup-preview" } });
  expect(workspaceRouteName()).toBe("data-backup-preview");
  expect(visibleText(mounted!.root)).toContain("synthetic-backup-restore-panel");
  expect(observed.backupMounts).toBe(1);
  expect(observed.backupUnmounts).toBe(0);
});
