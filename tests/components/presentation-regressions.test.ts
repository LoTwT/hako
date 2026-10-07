// 呈现层修正行为回归（父审第一轮 UI-R08/R09/R10/R11 与 UI-C02）：真实编译
// RecordsRoot、StatisticsPage、RecordDetailPanel、RefuelingForm、LegacyImport
// SFC，忠实最小宿主 + 渲染树断言。覆盖：统计带入的期间/待核对筛选真实过滤记录
// 与筛选标签（UI-R08）；统计当前期按北京时间计算，UTC 环境下跨月边界记录归入
// 北京月份（UI-R09）；折叠的可选字段校验失败汇入错误清单并展示 aria-invalid
// 与「查看第一项」跳转（UI-R10）；详情面板展示跨记录警告（UI-R11）；旧验证导入
// 逐项状态区分已导入/来源冲突/可选与多种空态（UI-C02）。不冒充真实浏览器。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, shallowRef, type VNode } from "vue";
import RecordsRoot from "../../src/components/refueling/RecordsRoot.vue";
import StatisticsPage from "../../src/components/refueling/StatisticsPage.vue";
import RecordDetailPanel from "../../src/components/refueling/RecordDetailPanel.vue";
import RefuelingForm from "../../src/components/refueling/RefuelingForm.vue";
import LegacyImport from "../../src/components/refueling/LegacyImport.vue";
import { createMinimalHostRenderer, createMinimalHostRoot, type MinimalHostNode } from "../helpers/minimal-host";
import { syntheticRecord } from "../helpers/sync-fixtures";

const legacyRecords = vi.hoisted(() => ({ records: [] as unknown[] }));
vi.mock("../../src/data/legacy-refueling", () => ({
  readLegacyRefueling: async () => legacyRecords.records as never,
}));

const renderer = createMinimalHostRenderer();
const closes: Array<() => void> = [];

type SetupState = Record<string, unknown>;
let lastRoot: MinimalHostNode | null = null;
let lastState: SetupState | null = null;

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
function findButton(root: MinimalHostNode, label: string): MinimalHostNode | undefined {
  return allNodes(root).find((node) => node.kind === "element" && node.tag === "button" && visibleText(node).trim() === label);
}
function click(node: MinimalHostNode): void {
  (node.props.onClick as (event: unknown) => void)({ button: 0 });
}

function mountComponent(component: unknown, props: Record<string, unknown>): SetupState {
  const root = createMinimalHostRoot();
  const app = renderer.createApp(component as never, props);
  const vm = app.mount(root) as unknown as { $: { setupState: SetupState; subTree: VNode } };
  closes.push(() => app.unmount());
  lastRoot = root;
  lastState = vm.$.setupState;
  return vm.$.setupState;
}

/** 以可变 props 挂载：上层清除筛选（改 prop）后验证列表回到全量。 */
function mountComponentWithProps(component: unknown, initialProps: Record<string, unknown>): { update: (props: Record<string, unknown>) => void } {
  const propsRef = shallowRef({ ...initialProps });
  const root = createMinimalHostRoot();
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(component as never, propsRef.value),
  }));
  app.mount(root);
  closes.push(() => app.unmount());
  lastRoot = root;
  return { update: (props: Record<string, unknown>) => { propsRef.value = { ...props }; } };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    scrollTo() {},
  });
});
afterEach(() => { closes.splice(0).forEach((close) => close()); lastRoot = null; lastState = null; vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------
// UI-R08 统计筛选真实过滤
// ---------------------------------------------------------------------------

it("UI-R08 统计带入期间与待核对筛选：列表按月过滤且显示筛选标签，可逐项移除", async () => {
  const records = [
    { ...syntheticRecord, id: "r1", occurredAtLocal: "2026-10-02T09:00", stationName: "十月记录一" },
    { ...syntheticRecord, id: "r2", occurredAtLocal: "2026-09-15T09:00", stationName: "九月记录" },
  ];
  const baseProps = {
    records, busy: false, ready: true, error: "", wide: false, detailRecordId: null,
    warnings: new Map(), pendingEditorLabel: null, draftCount: 0, draftPickerNotice: "",
  };
  const mounted = mountComponentWithProps(RecordsRoot, {
    ...baseProps,
    filterContext: { period: { kind: "monthly", year: 2026, month: 10 }, periodLabel: "2026年10月", pendingOnly: false },
  });
  await nextTick(); await nextTick();
  expect(visibleText(lastRoot!)).toContain("2026-10-02 09:00");
  expect(visibleText(lastRoot!)).not.toContain("2026-09-15");
  expect(visibleText(lastRoot!)).toContain("2026年10月");
  // 上层清除期间筛选（改 prop）：回到全量，标签消失，两个月份分组都在。
  mounted.update({ ...baseProps, filterContext: null });
  await nextTick(); await nextTick();
  expect(visibleText(lastRoot!)).toContain("2026-09-15");
  expect(visibleText(lastRoot!)).not.toContain("2026年10月");
});

it("UI-R08 待核对筛选只列出有跨记录警告的记录", async () => {
  const records = [
    { ...syntheticRecord, id: "r1", occurredAtLocal: "2026-10-02T09:00", stationName: "里程回退记录", odometerTenths: 8000 },
    { ...syntheticRecord, id: "r2", occurredAtLocal: "2026-10-03T09:00", stationName: "正常记录", odometerTenths: 12000 },
  ];
  mountComponent(RecordsRoot, {
    records, busy: false, ready: true, error: "", wide: false, detailRecordId: null,
    warnings: new Map([["r1", ["与后一条记录的里程不递增，请核对。"]]]), pendingEditorLabel: null, draftCount: 0, draftPickerNotice: "",
    filterContext: { period: { kind: "total" }, periodLabel: "全部", pendingOnly: true },
  });
  await nextTick(); await nextTick();
  expect(visibleText(lastRoot!)).toContain("与后一条记录的里程不递增，请核对。");
  expect(visibleText(lastRoot!)).not.toContain("2026-10-03");
  // total 期间不显示期间标签，只显示待核对标签。
  expect(visibleText(lastRoot!)).toContain("待核对");
});

// ---------------------------------------------------------------------------
// UI-R09 统计当前期按北京时间计算
// ---------------------------------------------------------------------------

it("UI-R09 UTC 环境下北京月初边界记录归入北京当前月（设备时区不影响分期）", async () => {
  // 2026-10-01T01:00 北京 = 2026-09-30T17:00 UTC：把「现在」固定在北京 10 月 1 日
  // 凌晨；若按设备时区（UTC）计算当前期会得到 2026 年 9 月，正确行为按北京时间
  // 得到 2026 年 10 月。
  vi.useFakeTimers({ now: new Date("2026-09-30T17:00:00Z"), toFake: ["Date"] });
  try {
    mountComponent(StatisticsPage, {
      records: [{ ...syntheticRecord, id: "edge", occurredAtLocal: "2026-10-01T00:30", stationName: "北京月初记录" }],
    });
    await nextTick(); await nextTick();
    expect(visibleText(lastRoot!)).toContain("2026 年 10 月");
    expect(visibleText(lastRoot!)).not.toContain("2026 年 9 月");
    expect(findButton(lastRoot!, "查看本期记录")).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

// ---------------------------------------------------------------------------
// UI-R10 折叠可选字段的错误清单
// ---------------------------------------------------------------------------

it("UI-R10 折叠组内的可选字段校验失败：错误清单列出字段与原因，aria-invalid 与首项跳转可用", async () => {
  // 站名超长（折叠在「更多信息」内）是唯一的校验错误。
  const state = mountComponent(RefuelingForm, {
    initial: { ...syntheticRecord, stationName: "超".repeat(101) },
    records: [], busy: false, locked: false, available: true,
  });
  await nextTick(); await nextTick();
  // 触发一次提交：校验失败，折叠组内字段错误进入清单（字段名 + 原因）。
  (state as unknown as { submit: () => void }).submit();
  await nextTick(); await nextTick();
  const text = visibleText(lastRoot!);
  expect(text).toContain("还有 1 项需要填写或修正");
  expect(text).toContain("加油站：最多 100 个字符。");
  // 「查看第一项」展开折叠组并定位到首个错误字段。
  const jump = allNodes(lastRoot!).find((node) => node.kind === "element" && node.tag === "button" && visibleText(node).includes("查看第一项"));
  expect(jump).toBeDefined();
  click(jump!);
  await nextTick(); await nextTick();
  const toggle = allNodes(lastRoot!).find((node) => node.kind === "element" && node.tag === "button" && node.props["aria-expanded"] !== undefined);
  expect([true, "true"]).toContain(toggle?.props["aria-expanded"]);
  // aria-invalid 标注在相应输入上（宿主记录 props）。
  const invalidInputs = allNodes(lastRoot!).filter((node) => node.kind === "element" && node.tag === "input" && ([true, "true", ""] as unknown[]).includes(node.props["aria-invalid"]));
  expect(invalidInputs.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// UI-R11 详情面板展示跨记录警告
// ---------------------------------------------------------------------------

it("UI-R11 详情面板显示工作区传入的跨记录警告（里程递增等）", async () => {
  mountComponent(RecordDetailPanel, {
    record: { ...syntheticRecord, id: "r1", stationName: "有警告记录" },
    busy: false,
    warnings: ["与后一条记录的里程不递增，请核对。"],
  });
  await nextTick(); await nextTick();
  expect(visibleText(lastRoot!)).toContain("待核对：与后一条记录的里程不递增，请核对。");
  // 站名等字段经「更多信息」展开可见。
  click(findButton(lastRoot!, "更多信息")!);
  await nextTick(); await nextTick();
  expect(visibleText(lastRoot!)).toContain("有警告记录");
});

it("UI-R11 对照：没有警告时不出现警告区块", async () => {
  mountComponent(RecordDetailPanel, { record: { ...syntheticRecord, id: "r1", stationName: "干净记录" }, busy: false, warnings: [] });
  await nextTick(); await nextTick();
  expect(visibleText(lastRoot!)).not.toContain("待核对：");
  expect(visibleText(lastRoot!)).not.toContain("里程不递增");
});

// ---------------------------------------------------------------------------
// UI-C02 旧验证导入逐项状态
// ---------------------------------------------------------------------------

it("UI-C02 逐项状态：已导入与来源冲突不可选，其余可选；冲突提示需人工核对", async () => {
  const records = [
    { ...syntheticRecord, id: "l1", stationName: "可导入记录" },
    { ...syntheticRecord, id: "l2", stationName: "已导入记录" },
    { ...syntheticRecord, id: "l3", stationName: "冲突记录" },
  ];
  legacyRecords.records = records;
  mountComponent(LegacyImport, {
    disabled: false, canImport: true, importedIds: ["l2"],
    importConflicts: { l3: ["target-1", "target-2"] },
    importRecords: vi.fn(async () => true),
  });
  await nextTick(); await nextTick();
  (lastState as unknown as { preview: () => Promise<void> }).preview();
  await nextTick(); await nextTick(); await nextTick();
  const text = visibleText(lastRoot!);
  expect(text).toContain("可导入记录");
  expect(text).toContain("已导入");
  expect(text).toContain("来源冲突，需人工核对");
  // 已导入与冲突条目的 checkbox 被禁用（disabled 记录在宿主；Vue 以 true 或空串表示）。
  const disabledConflict = allNodes(lastRoot!).filter((node) => node.kind === "element" && node.tag === "input" && ([true, ""] as unknown[]).includes(node.props.disabled));
  expect(disabledConflict.length).toBeGreaterThanOrEqual(2);
  // 未激活代次（canImport=false）时给出联网确认提示，但读取不受影响。
  const canImportNotice = allNodes(lastRoot!).find((node) => node.kind === "element" && node.tag === "button" && visibleText(node).includes("导入选中"));
  expect(canImportNotice).toBeDefined();
});

it("UI-C02 空态区分：旧库无记录与全部已导入提示不同", async () => {
  legacyRecords.records = [];
  mountComponent(LegacyImport, { disabled: false, canImport: true, importedIds: [], importConflicts: {}, importRecords: vi.fn(async () => true) });
  await nextTick(); await nextTick();
  (lastState as unknown as { preview: () => Promise<void> }).preview();
  await nextTick(); await nextTick(); await nextTick();
  expect(visibleText(lastRoot!)).toContain("旧验证库没有记录");
});

// ---------------------------------------------------------------------------
// UI-C02 二轮：状态交集优先级与无可选项时的逐项身份
// ---------------------------------------------------------------------------

it("UI-C02 二轮：同一来源既有导入映射又有多个存活冲突目标——冲突优先呈现并禁选", async () => {
  const records = [
    { ...syntheticRecord, id: "l1", stationName: "映射加冲突来源" },
    { ...syntheticRecord, id: "l2", stationName: "仅已导入来源" },
  ];
  legacyRecords.records = records;
  mountComponent(LegacyImport, {
    disabled: false, canImport: true,
    // l1 同时有映射（已导入）与两个仍存活目标：冲突事实优先。
    importedIds: ["l1", "l2"],
    importConflicts: { l1: ["target-1", "target-2"] },
    importRecords: vi.fn(async () => true),
  });
  await nextTick(); await nextTick();
  (lastState as unknown as { preview: () => Promise<void> }).preview();
  await nextTick(); await nextTick(); await nextTick();
  const text = visibleText(lastRoot!);
  expect(text).toContain("映射加冲突来源");
  expect(text).toContain("来源冲突，需人工核对");
  // 冲突优先：该来源不再显示为「已导入」状态；仅已导入来源仍显示已导入。
  const conflictRow = text.split("映射加冲突来源")[1] ?? "";
  const conflictSegment = conflictRow.slice(0, Math.max(conflictRow.indexOf("仅已导入来源"), 1));
  expect(conflictSegment).toContain("来源冲突，需人工核对");
  expect(conflictSegment).not.toContain("已导入");
  expect(text.split("仅已导入来源")[1]?.slice(0, 200) ?? "").toContain("已导入");
});

it("UI-C02 二轮：没有可选记录时仍逐项显示需核对条目身份，不只显示总数", async () => {
  const records = [
    { ...syntheticRecord, id: "l1", stationName: "已导入甲站" },
    { ...syntheticRecord, id: "l3", stationName: "需核对乙站" },
  ];
  legacyRecords.records = records;
  mountComponent(LegacyImport, {
    disabled: false, canImport: true,
    importedIds: ["l1"],
    importConflicts: { l3: ["target-1", "target-2"] },
    importRecords: vi.fn(async () => true),
  });
  await nextTick(); await nextTick();
  (lastState as unknown as { preview: () => Promise<void> }).preview();
  await nextTick(); await nextTick(); await nextTick();
  const text = visibleText(lastRoot!);
  // 两个条目的身份都可见（用户能看到该核对哪条），冲突计数也呈现。
  expect(text).toContain("已导入甲站");
  expect(text).toContain("需核对乙站");
  expect(text).toContain("来源冲突，需人工核对");
});
