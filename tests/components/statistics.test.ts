import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computed, defineComponent, h, nextTick, shallowRef, type VNode } from "vue";
import App from "../../src/App.vue";
import StatisticsPage from "../../src/components/refueling/StatisticsPage.vue";
import StatisticsTrend from "../../src/components/refueling/StatisticsTrend.vue";
import * as statistics from "../../src/domain/refueling/statistics";
import * as form from "../../src/domain/refueling/form";
import type { SavedRefuelingRecord } from "../../src/domain/refueling/form";
import type { StatisticsPeriod, StatisticsRecordsContext } from "../../src/domain/refueling/statistics";
import { createMinimalHostRenderer, createMinimalHostRoot, type MinimalHostNode } from "../helpers/minimal-host";

// App / AccountWorkspace / Workspace / F4 / 趋势 / 表单均为真实组件；只控制底层依赖。
const observed = vi.hoisted(() => ({ auth: null as any, locals: new Map<string, any>(), flushOk: true, flushCalls: 0 }));
vi.mock("virtual:pwa-register/vue", async () => {
  const { shallowRef } = await import("vue");
  return { useRegisterSW: () => ({ offlineReady: shallowRef(false), needRefresh: shallowRef(false) }) };
});
vi.mock("../../src/ui/appearance", async () => {
  const { shallowRef } = await import("vue");
  return { useAppearance: () => ({ appearance: shallowRef("system"), systemDark: shallowRef(false), setAppearance() {}, dispose() {} }) };
});
vi.mock("../../src/composables/useAuthSession", async () => {
  const { shallowRef } = await import("vue");
  return { useAuthSession: () => ({ auth: observed.auth, authenticatedAccountLabel: shallowRef("合成账号"),
    localDevelopment: false, refresh: vi.fn(), login: vi.fn(), logout: vi.fn(), recheckRejectedSession: vi.fn() }) };
});
vi.mock("../../src/composables/useLocalRefueling", () => ({ useLocalRefueling: ({ accountId }: { accountId: string }) => observed.locals.get(accountId) }));
vi.mock("../../src/composables/useRefuelingDrafts", async () => {
  const { shallowRef } = await import("vue");
  return { useRefuelingDrafts: () => ({
    drafts: shallowRef({ status: "ready", recovery: { status: "ready", candidates: [], notice: "" }, writeError: "", orphanedEditCount: 0, unsupportedCount: 0 }),
    initialize: vi.fn(), attachForm: vi.fn(), updateDraft: vi.fn(), adoptedDraft: () => null, currentDraftId: () => null,
    flush: async () => { observed.flushCalls++; return observed.flushOk; },
    clearAfterSave: async () => ({ ok: true, message: "" }), discard: async () => "cleared",
  }) };
});
vi.mock("../../src/domain/refueling/statistics", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/domain/refueling/statistics")>();
  return { ...original, calculateRefuelingHistory: vi.fn(original.calculateRefuelingHistory), projectRefuelingStatistics: vi.fn(original.projectRefuelingStatistics) };
});

// 原始输入摘自批准的 SYNTHETIC_RECORDS，断言值取自人工 CASES，不从页面生成。
function r(id: string, occurredAtLocal: string, odometerTenths: number, fuelVolumeMillilitres: number,
  unitPriceTenThousandths: number, amountPayableCents: number, couponDiscountCents: number,
  amountPaidCents: number, fullTank: boolean, lowFuelLight: boolean | null): SavedRefuelingRecord {
  return { id, occurredAtLocal, odometerTenths, fuelVolumeMillilitres, unitPriceTenThousandths, amountPayableCents,
    couponDiscountCents, amountPaidCents, fullTank, lowFuelLight, invoiceableAmountCents: null, stationName: "", fuelGrade: "", orderNumber: "" };
}
const cases: Record<string, SavedRefuelingRecord[]> = {
  C00_empty: [
  ],
  C01_single: [
    r("A", "2026-03-01T08:00:00", 10000, 20000, 60000, 12000, 2000, 10000, true, null),
  ],
  C03_partial: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
  ],
  C07_cross_year: [
    r("A", "2025-12-20T08:00:00", 10000, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2025-12-31T23:30:00", 13000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-01-01T00:30:00", 19000, 40000, 70000, 28000, 0, 28000, true, null),
  ],
  C08_short_history: [
    r("A", "2026-01-31T08:00:00", 10000, 5000, 50000, 2500, 0, 2500, true, null),
    r("B", "2026-02-01T08:00:00", 11000, 10000, 60000, 6000, 0, 6000, true, null),
    r("C", "2026-02-02T08:00:00", 12000, 5000, 70000, 3500, 0, 3500, true, null),
  ],
  C08_history_added: [
    r("P", "2026-01-30T08:00:00", 9000, 5000, 40000, 2000, 0, 2000, false, null),
    r("A", "2026-01-31T08:00:00", 10000, 5000, 50000, 2500, 0, 2500, true, null),
    r("B", "2026-02-01T08:00:00", 11000, 10000, 60000, 6000, 0, 6000, true, null),
    r("C", "2026-02-02T08:00:00", 12000, 5000, 70000, 3500, 0, 3500, true, null),
  ],
  C09_rollback: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 2500, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
    r("E", "2026-03-06T08:00:00", 11000, 10000, 90000, 9000, 0, 9000, true, null),
  ],
  C10_same_time: [
    r("z", "2026-04-01T08:00:00", 2000, 20000, 70000, 14000, 0, 14000, true, null),
    r("b", "2026-04-01T08:00", 1000, 10000, 60000, 6000, 0, 6000, true, null),
    r("a", "2026-04-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
  ],
  C11_amount_warning: [
    r("A", "2026-03-01T08:00:00", 0, 20000, 50000, 10000, 0, 0, true, null),
    r("B", "2026-03-02T08:00:00", 2000, 10000, 60000, 6000, 0, 6000, true, null),
  ],
  C12_max: [
    r("A", "2026-03-01T08:00:00", 0, 9007199254740991, 9007199254740991, 9007199254740991, 0, 9007199254740991, true, null),
    r("B", "2026-03-02T08:00:00", 9007199254740991, 9007199254740991, 9007199254740991, 9007199254740991, 0, 9007199254740991, true, null),
  ],
  C14_edit: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-03-05T08:00:00", 9000, 30000, 80000, 24000, 0, 24000, true, null),
  ],
  C14_delete_end: [
    r("A", "2026-03-01T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-03-02T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-03-03T08:00:00", 5000, 15000, 70000, 10500, 0, 10500, false, null),
  ],
  C15_external_anomaly: [
    r("A", "2026-01-30T08:00:00", 0, 50000, 50000, 25000, 0, 25000, true, null),
    r("B", "2026-01-31T08:00:00", 3000, 20000, 60000, 12000, 0, 12000, false, null),
    r("C", "2026-02-01T08:00:00", 2500, 15000, 70000, 10500, 0, 10500, false, null),
    r("D", "2026-02-28T08:00:00", 9000, 25000, 80000, 20000, 0, 20000, true, null),
    r("E", "2026-03-01T08:00:00", 11000, 10000, 90000, 9000, 0, 9000, true, null),
  ],
};

const renderer = createMinimalHostRenderer();
const closes: Array<() => void> = [];
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
const G = "00000000-0000-4000-8000-0000000000d1";
const G1 = "00000000-0000-4000-8000-0000000000d2";
const location = { hash: "#refueling/statistics", assign: vi.fn() };
const history = { replaceState: vi.fn(), pushState: vi.fn(), back: vi.fn() };
const march: StatisticsPeriod = { kind: "monthly", year: 2026, month: 3 };
const total: StatisticsPeriod = { kind: "total" };
function localFor(records: SavedRefuelingRecord[]) {
  return {
    records: shallowRef(records), ready: shallowRef(true), saving: shallowRef(false), error: shallowRef(""), notice: shallowRef(""), persistent: shallowRef(false), importedLegacyIds: shallowRef([]),
    pendingSync: shallowRef(false), confirmed: shallowRef(true), syncStatus: shallowRef({ phase: "paused", message: "" }),
    pendingRestore: shallowRef(null), importConflicts: shallowRef({}), migrationPending: shallowRef(null), restoreWritesAvailable: shallowRef(true),
    generationFlow: shallowRef<any>({ phase: "active", generation: G, serverConfirmed: true }), workspaceGeneration: shallowRef(G),
    save: vi.fn(async () => true), initialize: vi.fn(), requestPersistence: vi.fn(), importLegacy: vi.fn(), retrySync: vi.fn(),
    openCurrentGeneration: vi.fn(), recheckRestoreReceipt: vi.fn(), listRetainedGenerations: vi.fn(), readRetainedGeneration: vi.fn(), retryOpen: vi.fn(), recheckMigration: vi.fn(),
    refresh: vi.fn(), beginRestoreRequest: vi.fn(), submitPendingRestore: vi.fn(),
  };
}
function auth(accountId: string) { observed.auth.value = { accountId, status: "authenticated", message: "", loggingIn: false, loggingOut: false }; }
function nodes(node: MinimalHostNode): MinimalHostNode[] { return [node, ...node.children.flatMap(nodes)]; }
function text(node: MinimalHostNode): string {
  if (node.style.display === "none" || node.kind === "comment") return "";
  return [node.text ?? "", ...node.children.map(text)].join(" ");
}
function button(root: MinimalHostNode, label: string) {
  const found = nodes(root).find(node => node.tag === "button" && text(node).trim() === label);
  expect(found, label).toBeDefined(); return found!;
}
function click(node: MinimalHostNode) { (node.props.onClick as Function)({ button: 0 }); }
async function settle() { for (let i = 0; i < 8; i++) { await nextTick(); await Promise.resolve(); } }
function components(vnode: VNode, name: string): any[] {
  const list: any[] = [];
  if (vnode.component) {
    if ((vnode.type as { __name?: string }).__name === name) list.push(vnode.component);
    list.push(...components(vnode.component.subTree, name));
  }
  if (Array.isArray(vnode.children)) for (const child of vnode.children)
    if (child && typeof child === "object" && "type" in child) list.push(...components(child as VNode, name));
  return list;
}
function mountApp() {
  const root = createMinimalHostRoot();
  const app = renderer.createApp(App);
  const vm = app.mount(root) as any;
  closes.push(() => app.unmount());
  const instances = (name: string) => components(vm.$.subTree, name);
  const workspace = (account = A) => instances("RefuelingWorkspace").find(instance => instance.props.accountId === account);
  return { root, state: vm.$.setupState, instances, workspace,
    navigate: async (name: string) => { await vm.$.setupState.navigate({ name: "refueling", refueling: { name } }); await settle(); } };
}
function mountPage(records: SavedRefuelingRecord[], initialPeriod: StatisticsPeriod = total) {
  const snapshot = shallowRef(records);
  const period = shallowRef(initialPeriod);
  const ready = shallowRef(true);
  const error = shallowRef("");
  const root = createMinimalHostRoot();
  const viewRecords = vi.fn();
  const app = renderer.createApp(defineComponent({ setup() {
    const fullHistory = computed(() => statistics.calculateRefuelingHistory(snapshot.value));
    const result = computed(() => statistics.projectRefuelingStatistics(fullHistory.value, period.value));
    return () => h(StatisticsPage, { history: ready.value ? fullHistory.value : null, result: ready.value ? result.value : null,
      period: period.value, ready: ready.value, error: error.value, onUpdatePeriod: next => { period.value = next; }, onViewRecords: viewRecords });
  } }));
  const vm = app.mount(root) as any;
  closes.push(() => app.unmount());
  return { root, snapshot, period, ready, error, viewRecords, state: () => components(vm.$.subTree, "StatisticsPage")[0].setupState };
}
async function expand(root: MinimalHostNode) {
  const details = nodes(root).find(node => node.tag === "details")!;
  (details.props.onToggle as Function)({ target: { open: true } }); await settle();
}
function region(root: MinimalHostNode, label: string) { return nodes(root).find(node => node.props["aria-label"] === label)!; }

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-11T04:00:00Z"), toFake: ["Date"] });
  observed.auth = shallowRef(null); auth(A); observed.flushOk = true; observed.flushCalls = 0;
  observed.locals.clear(); observed.locals.set(A, localFor(cases.C03_partial));
  observed.locals.set(B, localFor(cases.C11_amount_warning.map(record => ({ ...record, id: `B-${record.id}`, occurredAtLocal: record.occurredAtLocal.replace("03-", "02-") }))));
  location.hash = "#refueling/statistics";
  vi.clearAllMocks();
  vi.stubGlobal("window", { location, history, scrollTo() {}, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("document", { title: "", visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { closes.splice(0).forEach(close => close()); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("C03/C14 同 ID 编辑更新指标、来源量和实付；展开来源不重算历史", async () => {
  const page = mountPage(cases.C03_partial, march); await settle();
  expect(text(region(page.root, "平均油耗"))).toContain("6.67");
  expect(text(region(page.root, "每公里油费"))).toContain("0.394");
  expect(text(region(page.root, "加油支出"))).toContain("675.00");
  await expand(page.root);
  expect(text(page.root)).toContain("60.000 L / 900.0 km");
  click(button(page.root, "历史实付分摊")); await settle();
  expect(text(region(page.root, "历史实付分摊"))).toContain("原始 50.000 L / 实付 ¥250.00；取 20.000 L，分摊 ¥100.00");
  expect(statistics.calculateRefuelingHistory).toHaveBeenCalledTimes(1);
  page.snapshot.value = cases.C14_edit; await settle();
  expect(text(region(page.root, "平均油耗"))).toContain("7.22");
  expect(text(region(page.root, "每公里油费"))).toContain("0.426");
  expect(text(page.root)).toContain("65.000 L / 900.0 km");
  expect(text(region(page.root, "加油支出"))).toContain("715.00");
  expect(statistics.calculateRefuelingHistory).toHaveBeenCalledTimes(2);
  page.snapshot.value = cases.C14_delete_end; await settle();
  expect(text(region(page.root, "平均油耗"))).toContain("待计算");
  expect(text(page.root)).not.toContain("65.000 L");
  expect(region(page.root, "历史实付分摊")).toBeUndefined();
});

it("C07 后续记录补算旧月，期间只投影，单条期内记录仍有有效行程", async () => {
  const page = mountPage(cases.C07_cross_year.slice(0, 2), { kind: "monthly", year: 2025, month: 12 }); await settle();
  expect(text(region(page.root, "平均油耗"))).toContain("待计算");
  page.snapshot.value = cases.C07_cross_year; await settle();
  expect(text(region(page.root, "每公里油费"))).toContain("0.333");
  expect(text(region(page.root, "平均油耗"))).toContain("300.0 km");
  click(nodes(page.root).find(node => node.props["aria-label"] === "下一月")!); await settle();
  expect(page.period.value).toEqual({ kind: "monthly", year: 2026, month: 1 });
  expect(text(region(page.root, "平均油耗"))).toContain("6.67");
  expect(text(region(page.root, "每公里油费"))).toContain("0.367");
  expect(text(region(page.root, "加油支出"))).toContain("280.00");
  expect(text(page.root)).toContain("记录不足");
  expect(statistics.calculateRefuelingHistory).toHaveBeenCalledTimes(2);
});

it("C08 油耗/油费/记录覆盖分别为 200/100/100 km，补历史只更新油费覆盖", async () => {
  const page = mountPage(cases.C08_short_history, { kind: "monthly", year: 2026, month: 2 }); await settle();
  expect(text(region(page.root, "平均油耗"))).toContain("7.50");
  expect(text(region(page.root, "平均油耗"))).toContain("覆盖 200.0 km");
  expect(text(region(page.root, "每公里油费"))).toContain("0.300");
  expect(text(region(page.root, "每公里油费"))).toContain("覆盖 100.0 km");
  expect(text(region(page.root, "待核对与依据"))).toContain("100.0 km");
  await expand(page.root);
  expect(text(page.root)).toContain("需要 10.000 L，已有 5.000 L，缺 5.000 L");
  page.snapshot.value = cases.C08_history_added; await settle();
  expect(text(region(page.root, "每公里油费"))).toContain("0.375");
  expect(text(region(page.root, "每公里油费"))).toContain("覆盖 200.0 km");
  expect(text(region(page.root, "加油支出"))).toContain("95.00");
});

it.each(["C00_empty", "C01_single"])("%s 空/首笔没有伪造前段或零油耗", async name => {
  const page = mountPage(cases[name]); await settle();
  expect(text(region(page.root, "平均油耗"))).toContain("本期结束 0 段");
  expect(nodes(page.root).some(node => node.tag === "svg" && node.props.role === "img")).toBe(false);
  expect(text(page.root)).toContain("记录不足");
});

it("C09 部分与待核对并存，C11 有效零与金额警告并存，C12 最后一分完整", async () => {
  const page = mountPage(cases.C09_rollback); await settle();
  expect(text(region(page.root, "平均油耗"))).toContain("5.00");
  expect(text(region(page.root, "平均油耗"))).toContain("部分区间");
  expect(text(region(page.root, "平均油耗"))).toContain("待核对 3 段");
  page.snapshot.value = cases.C11_amount_warning; await settle();
  expect(text(region(page.root, "每公里油费"))).toContain("0.000");
  expect(text(region(page.root, "每公里油费"))).toContain("覆盖 200.0 km");
  expect(text(page.root)).toContain("本期有 1 条记录待核对");
  page.snapshot.value = cases.C12_max; await settle();
  expect(text(region(page.root, "加油支出"))).toContain("180,143,985,094,819.82");
});

it("C15 期外异常来源带真实坏边两端、移除期间限制，独立记录覆盖有效", async () => {
  const page = mountPage(cases.C15_external_anomaly, { kind: "monthly", year: 2026, month: 1 }); await settle();
  expect(text(page.root)).toContain("本期交易记录没有待核对提示");
  expect(text(page.root)).toContain("包含期间外异常记录");
  expect(text(region(page.root, "平均油耗"))).toContain("待核对");
  expect(text(region(page.root, "待核对与依据"))).toContain("300.0 km");
  click(button(page.root, "查看异常依据（含期外）"));
  const context = page.viewRecords.mock.calls[0][0] as StatisticsRecordsContext;
  expect(context.period).toEqual(total); expect(context.pendingOnly).toBe(false);
  expect(new Set(context.related!.recordIds)).toEqual(new Set(["A", "B", "C", "D"]));
});

it("真实 App 的来源→记录→详情→编辑→统计保持期间，三个筛选可分别移除", async () => {
  const app = mountApp(); await settle(); const state = app.workspace().setupState;
  state.updateStatisticsPeriod(march); await settle();
  await expand(app.root); click(button(app.root, "查看来源记录")); await settle();
  expect(state.statsFilterContext.related.recordIds).toEqual(["A", "B", "C", "D"]);
  const records = app.instances("RecordsRoot")[0].setupState;
  records.toggleFilter("review"); await settle();
  await app.navigate("statistics"); await expand(app.root); click(button(app.root, "查看来源记录")); await settle();
  expect(records.filter).toBe("all");
  state.selectRecord("D", { push: true }); await settle();
  state.startEdit(cases.C03_partial[3]); await settle();
  expect(app.instances("RefuelingForm")).toHaveLength(1);
  await app.navigate("statistics");
  expect(state.statisticsPeriod).toEqual(march);
  observed.locals.get(A).records.value = cases.C14_edit; await settle();
  expect(text(region(app.root, "每公里油费"))).toContain("0.426");
  state.viewRecordsFromStatistics({ period: march, periodLabel: "2026 年 3 月", pendingOnly: true, related: { recordIds: ["D"], label: "合成条件" } }); await settle();
  state.removeStatsFilter("pending"); await settle();
  expect(state.statsFilterContext).toMatchObject({ period: march, pendingOnly: false, related: { recordIds: ["D"] } });
  records.toggleFilter("review"); await settle();
  state.removeStatsFilter("period"); await settle();
  expect(state.statsFilterContext).toMatchObject({ period: total, related: { recordIds: ["D"] } });
  expect(records.filter).toBe("review");
  observed.locals.get(A).records.value = []; await settle();
  expect(text(app.root)).toContain("相关记录已变化，可清除筛选");
  click(nodes(app.root).find(node => node.props["aria-label"] === "移除相关记录筛选")!); await settle();
  expect(state.statsFilterContext).toBeNull();
  expect(nodes(app.root).find(node => node.tag === "button" && text(node).trim() === "全部")!.focusCount).toBe(1);
});

it("L1 真实 App A→B→A 两账号保活；私有期间/context、隐藏动作拒绝、同 ID 新快照重算", async () => {
  const app = mountApp(); await settle(); const accountA = app.instances("AccountWorkspace")[0];
  const workspaceA = app.workspace(); const stateA = workspaceA.setupState;
  stateA.updateStatisticsPeriod(march); await settle(); await expand(app.root);
  expect(text(region(app.root, "平均油耗"))).toContain("6.67");
  expect(text(region(app.root, "每公里油费"))).toContain("0.394");
  expect(text(app.root)).toContain("60.000 L / 900.0 km");
  click(button(app.root, "查看来源记录")); await settle();
  const contextA = stateA.statsFilterContext;
  stateA.startEdit(cases.C03_partial[0]); await settle();
  const editorA = app.instances("RefuelingForm")[0];
  auth(B); await settle(); await app.navigate("statistics");
  expect(app.instances("AccountWorkspace")).toHaveLength(2);
  expect(app.instances("RefuelingWorkspace")).toHaveLength(2);
  expect(workspaceA.props.locked).toBe(true); expect(accountA.props.visible).toBe(false);
  expect(app.instances("RefuelingForm")).toContain(editorA); expect(editorA.isUnmounted).toBe(false);
  const stateB = app.workspace(B).setupState;
  stateB.updateStatisticsPeriod({ kind: "monthly", year: 2026, month: 2 }); await settle();
  expect(text(app.root)).toContain("0.000"); expect(text(app.root)).not.toContain("0.394");
  const contextB: StatisticsRecordsContext = { period: total, periodLabel: "累计", pendingOnly: false, related: { recordIds: ["B-A"], label: "B 来源" } };
  stateB.viewRecordsFromStatistics(contextB); await settle();
  const targetBefore = app.state.targetRoute; const pushesBefore = history.pushState.mock.calls.length;
  stateA.viewRecordsFromStatistics(contextB); stateA.updateStatisticsPeriod(total); stateA.removeStatsFilter("related"); await settle();
  expect(app.state.targetRoute).toEqual(targetBefore); expect(history.pushState).toHaveBeenCalledTimes(pushesBefore);
  expect(stateA.statisticsPeriod).toEqual(march); expect(stateA.statsFilterContext).toBe(contextA);
  expect(stateB.statsFilterContext).toEqual(contextB);
  auth(B); await settle(); await app.navigate("statistics");
  expect(app.workspace(B).setupState.statsFilterContext).toEqual(contextB);
  expect(text(app.root)).toContain("0.000"); expect(text(app.root)).not.toContain("0.426");
  observed.locals.get(A).records.value = cases.C14_edit; await settle();
  auth(A); await settle();
  expect(app.workspace()).toBe(workspaceA); expect(app.instances("AccountWorkspace")).toContain(accountA);
  expect(stateA.statsFilterContext).toBe(contextA); expect(workspaceA.props.locked).toBe(false);
  await app.navigate("statistics");
  expect(stateA.statisticsPeriod).toEqual(march);
  expect(text(region(app.root, "平均油耗"))).toContain("7.22"); expect(text(region(app.root, "每公里油费"))).toContain("0.426");
  await expand(app.root); expect(text(app.root)).toContain("65.000 L / 900.0 km");
  expect(text(app.root)).not.toContain("B-A");
  expect(stateB.statisticsPeriod).toEqual({ kind: "monthly", year: 2026, month: 2 });
  expect(stateB.statsFilterContext).toEqual(contextB);
});

it("L2 flush 失败不推进真实 key、不卸载编辑器；成功接收后内层 G→G1 重建复位", async () => {
  const app = mountApp(); await settle(); const account = app.instances("AccountWorkspace")[0];
  const oldWorkspace = app.workspace(); const state = oldWorkspace.setupState; const local = observed.locals.get(A);
  state.updateStatisticsPeriod(march); await settle(); await expand(app.root); click(button(app.root, "查看来源记录")); await settle();
  state.startEdit(cases.C03_partial[0]); await settle(); const editor = app.instances("RefuelingForm")[0];
  observed.flushOk = false;
  local.generationFlow.value = { phase: "protected", localGeneration: G, serverGeneration: G1, legacyGeneration: G, receipt: "committed", message: "合成代次保护" }; await settle();
  await state.openCurrentData(); await settle();
  expect(local.openCurrentGeneration).not.toHaveBeenCalled(); expect(local.workspaceGeneration.value).toBe(G);
  expect(app.workspace()).toBe(oldWorkspace); expect(editor.isUnmounted).toBe(false); expect(state.protectionStage).toBe("failed");
  expect(app.instances("StatisticsPage")).toHaveLength(0);
  observed.flushOk = true;
  local.openCurrentGeneration.mockImplementation(async () => {
    local.records.value = cases.C11_amount_warning.map(record => ({ ...record, id: `G1-${record.id}` }));
    local.workspaceGeneration.value = G1; local.generationFlow.value = { phase: "active", generation: G1, serverConfirmed: true };
    return { ok: true, message: "" };
  });
  await state.openCurrentData(); await settle();
  const newWorkspace = app.workspace();
  expect(local.openCurrentGeneration).toHaveBeenCalledTimes(1); expect(oldWorkspace.isUnmounted).toBe(true); expect(editor.isUnmounted).toBe(true);
  expect(newWorkspace).not.toBe(oldWorkspace); expect(app.instances("AccountWorkspace")[0]).toBe(account);
  expect(newWorkspace.setupState.statisticsPeriod).toEqual({ kind: "monthly", year: 2026, month: 10 });
  expect(newWorkspace.setupState.statsFilterContext).toBeNull();
  await app.navigate("statistics"); newWorkspace.setupState.updateStatisticsPeriod(march); await settle(); await expand(app.root);
  expect(text(region(app.root, "平均油耗"))).toContain("5.00"); expect(text(region(app.root, "每公里油费"))).toContain("0.000");
  expect(text(app.root)).toContain("G1-A"); expect(text(app.root)).not.toContain("60.000 L");
  state.viewRecordsFromStatistics({ period: total, periodLabel: "旧代次", pendingOnly: false }); await settle();
  expect(app.state.targetRoute).toEqual({ name: "refueling", refueling: { name: "statistics" } });
  expect(newWorkspace.setupState.statsFilterContext).toBeNull();
});

it("ready=false 加载/失败不闪零；同步失败保留本机指标；设置保持实例和期间且拒绝背景导航", async () => {
  const local = observed.locals.get(A); local.ready.value = false;
  const app = mountApp(); await settle();
  expect(text(app.root)).toContain("正在打开本机记录"); expect(text(app.root)).not.toContain("¥0.00");
  local.error.value = "合成加载失败"; await settle(); expect(text(app.root)).toContain("合成加载失败");
  local.ready.value = true; local.error.value = "合成同步失败"; await settle(); const state = app.workspace().setupState;
  state.updateStatisticsPeriod(march); await settle(); expect(text(app.root)).toContain("0.394");
  const page = app.instances("StatisticsPage")[0]; const historyCalls = vi.mocked(statistics.calculateRefuelingHistory).mock.calls.length;
  await app.state.openSettings(); await settle();
  expect(app.instances("StatisticsPage")[0]).toBe(page); expect(state.statisticsPeriod).toEqual(march);
  state.viewRecordsFromStatistics({ period: total, periodLabel: "累计", pendingOnly: false }); await settle();
  expect(app.state.targetRoute).toEqual({ name: "settings" });
  expect(state.statsFilterContext).toBeNull(); expect(statistics.calculateRefuelingHistory).toHaveBeenCalledTimes(historyCalls);
});

it("北京时间默认跨月与合法旧年份、未来期间均可达", async () => {
  vi.setSystemTime(new Date("2026-09-30T17:00:00Z"));
  const app = mountApp(); await settle(); expect(app.workspace().setupState.statisticsPeriod).toEqual({ kind: "monthly", year: 2026, month: 10 });
  const page = mountPage(cases.C01_single.map(record => ({ ...record, occurredAtLocal: "0099-12-01T08:00:00" })));
  page.period.value = { kind: "monthly", year: 99, month: 12 }; await settle();
  click(nodes(page.root).find(node => node.props["aria-label"] === "下一月")!); await settle(); expect(page.period.value).toEqual({ kind: "monthly", year: 100, month: 1 });
  page.snapshot.value = cases.C01_single.map(record => ({ ...record, occurredAtLocal: "2027-01-01T08:00:00" }));
  page.period.value = { kind: "monthly", year: 2026, month: 12 }; await settle();
  click(nodes(page.root).find(node => node.props["aria-label"] === "下一月")!); await settle(); expect(page.period.value).toEqual({ kind: "monthly", year: 2027, month: 1 });
});

it.each(["pending", "review"] as const)("SVG 中间 %s 真断开，后续连续单次仍连接", async state => {
  const valid = { state: "valid" as const, sourceId: "test", method: "full-tank" as const, kind: "single" as const,
    consumedMillilitres: { numerator: 1000n, denominator: 1n }, litresPer100Km: { numerator: 5n, denominator: 1n } };
  const points = [0, 1, 2, 3].map(i => ({ tripId: [`r${i}`, `r${i + 1}`] as const, edgeIndex: i, endAtLocal: `2026-03-0${i + 1}T08:00:00`, xTimestampMs: Date.parse(`2026-03-0${i + 1}T08:00:00+08:00`), consumption: i === 1
    ? { state, reason: "no-completed-source" as const, relatedRecordIds: [], blockedSourceIds: [] } : valid }));
  const root = createMinimalHostRoot(); const app = renderer.createApp(StatisticsTrend, { points, period: total, periodLabel: "累计" }); app.mount(root); closes.push(() => app.unmount()); await settle();
  const path = nodes(root).find(node => node.props.class === "single-lines")!.props.d as string;
  expect(path.match(/M/g)).toHaveLength(1); expect(path.match(/L/g)).toHaveLength(1);
  expect(path).not.toContain("M52,");
  expect(text(root)).toContain("3 个有效点");
});

it("SVG 阶段为空心虚线；单点、同时间多点和全空不产生 NaN/假零连线", async () => {
  const page = mountPage(cases.C03_partial); await settle();
  const stage = nodes(page.root).find(node => node.props.class === "stage-lines")!.props.d as string;
  expect(stage.match(/L/g)).toHaveLength(2);
  expect(nodes(page.root).find(node => node.props.class === "single-lines")!.props.d).toBe("");
  page.snapshot.value = cases.C10_same_time; await settle();
  const sameX = nodes(page.root).find(node => node.props.class === "single-lines")!.props.d as string;
  expect(sameX).toMatch(/^M276,.*L276,/); expect(sameX).not.toMatch(/NaN|Infinity/);
  await expand(page.root); expect(text(page.root)).toContain("记录 a → b"); expect(text(page.root)).toContain("记录 b → z");
  page.snapshot.value = cases.C11_amount_warning; await settle();
  expect(nodes(page.root).find(node => node.props.class === "single-lines")!.props.d).toBe("");
  page.snapshot.value = cases.C14_delete_end; await settle();
  expect(nodes(page.root).some(node => node.tag === "svg" && node.props.role === "img")).toBe(false);
});

it("逐段依据每页 50 段且折叠时不渲染明细，趋势仍覆盖全部", async () => {
  const records = Array.from({ length: 102 }, (_, i) => ({ ...cases.C03_partial[0], id: `r${i}`, occurredAtLocal: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 19), odometerTenths: i * 1000 }));
  const page = mountPage(records); await settle();
  expect(nodes(page.root).filter(node => node.props.class === "trip-row")).toHaveLength(0);
  expect(text(page.root)).toContain("101 个有效点");
  await expand(page.root); expect(nodes(page.root).filter(node => node.props.class === "trip-row")).toHaveLength(50);
  click(button(page.root, "下一页")); await settle(); expect(nodes(page.root).filter(node => node.props.class === "trip-row")).toHaveLength(50);
  click(button(page.root, "下一页")); await settle(); expect(nodes(page.root).filter(node => node.props.class === "trip-row")).toHaveLength(1);
  expect(text(page.root)).toContain("第 3 / 3 页");
});

it("同 ID 行程移出本期时关闭价格明细，仍在本期的更新保留最新明细", async () => {
  const page = mountPage(cases.C11_amount_warning); page.period.value = march;
  await settle(); await expand(page.root); click(button(page.root, "历史实付分摊")); await settle();
  expect(text(region(page.root, "历史实付分摊"))).toContain("¥0.00");
  page.snapshot.value = cases.C11_amount_warning.map(record => record.id === "A" ? { ...record, amountPaidCents: 10000 } : record);
  await settle(); expect(text(region(page.root, "历史实付分摊"))).toContain("¥50.00");
  page.snapshot.value = page.snapshot.value.map(record => record.id === "B" ? { ...record, occurredAtLocal: "2026-04-02T08:00:00" } : record);
  await settle();
  expect(text(page.root)).toContain("本期没有已结束的相邻行程");
  expect(nodes(page.root).some(node => node.props["aria-label"] === "历史实付分摊")).toBe(false);
  expect(nodes(page.root).filter(node => node.props.class === "trip-row")).toHaveLength(0);
});

it("切换统计期间不重新格式化保活记录列表，快照更新仍刷新该实例", async () => {
  const format = vi.spyOn(form, "formatQuantity");
  const app = mountApp(); await settle(); const records = app.instances("RecordsRoot")[0];
  const previousCalls = format.mock.calls.length; expect(previousCalls).toBeGreaterThan(0);
  app.workspace().setupState.updateStatisticsPeriod(march); await settle();
  expect(format).toHaveBeenCalledTimes(previousCalls);
  observed.locals.get(A).records.value = cases.C14_edit; await settle();
  expect(format.mock.calls.length).toBeGreaterThan(previousCalls);
  expect(app.instances("RecordsRoot")[0]).toBe(records);
});
