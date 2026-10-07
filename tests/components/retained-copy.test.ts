// 保留副本视图组件测试（R5 二轮 + UI-C01）：真实编译 RetainedRefuelingCopy
// SFC，验证草稿原始输入核对包含完整布尔字段（是否加满/油灯），保护流程
// （allowBringBack=false）仍可展开记录的只读字段详情、无勾选与带回入口；
// 已激活代次展开记录显示「保留值/当前值」对照，业务值相同的字段禁选（相同
// 标记），不同字段提供勾选与按当前记录编辑的带入入口。自定义 renderer +
// vnode 树断言；不冒充真实浏览器。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRenderer, nextTick, type VNode } from "vue";
import RetainedRefuelingCopy from "../../src/components/refueling/RetainedRefuelingCopy.vue";
import { accountA, syntheticRecord } from "../helpers/sync-fixtures";
import type { RetainedGenerationSummary, RetainedGenerationView } from "../../src/data/local-refueling-v2";
import type { StoredRefuelingDraft } from "../../src/domain/refueling/draft-recovery";
import type { RetainedDraftSource } from "../../src/data/retained-content";
import { createDraft } from "../../src/domain/refueling/form";

const G1 = "00000000-0000-4000-8000-0000000000a2";
const record = { ...syntheticRecord, id: "one", stationName: "旧记录", fullTank: true, lowFuelLight: false };
const draft: StoredRefuelingDraft = {
  id: "draft-one", mode: "edit", recordId: "one", base: record,
  ...createDraft(record), createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null,
};
// 草稿原始输入里的布尔字段（表单字符串值）：带回时复制的就是这些值。
(draft.values as Record<string, string>).fullTank = "yes";
(draft.values as Record<string, string>).lowFuelLight = "no";

const summaries: RetainedGenerationSummary[] = [{
  generation: G1, legacyGeneration: false, retainedAtMs: 1, pendingSync: false,
  recordCount: 1, importedLegacyIds: [],
}];
const view: RetainedGenerationView = {
  ...summaries[0]!, records: [record],
};
const draftSources: RetainedDraftSource[] = [{ kind: "generation", generation: G1, drafts: [draft], unsupportedCount: 0 }];

const renderer = createRenderer({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const closes: Array<() => void> = [];
type SetupState = Record<string, unknown>;

function mountRetained(allowBringBack: boolean, known: Map<string, unknown> = new Map()): SetupState {
  const app = renderer.createApp(RetainedRefuelingCopy, {
    accountId: accountA,
    allowBringBack,
    summaries: () => Promise.resolve(summaries),
    readGeneration: (generation: string) => Promise.resolve(generation === G1 ? view : null),
    draftSources: () => Promise.resolve(draftSources),
    knownRecords: () => known as unknown as Map<string, never>,
  });
  const instance = app.mount({}) as unknown as { $: { subTree: VNode; setupState: SetupState } };
  closes.push(() => app.unmount());
  lastRoot = instance.$;
  return instance.$.setupState;
}
let lastRoot: { subTree: VNode; setupState: SetupState } | null = null;

/** 收集 vnode 树的全部文本（含子组件子树）。 */
function collectText(vnode: VNode | null | undefined): string {
  if (vnode === null || vnode === undefined) return "";
  const parts: string[] = [];
  if (vnode.component?.subTree !== null && vnode.component?.subTree !== undefined) parts.push(collectText(vnode.component.subTree));
  const children = vnode.children;
  if (typeof children === "string") parts.push(children);
  else if (Array.isArray(children)) {
    for (const child of children) {
      if (typeof child === "string") parts.push(child);
      else if (child !== null && typeof child === "object" && "children" in (child as VNode)) parts.push(collectText(child as VNode));
    }
  }
  return parts.join("");
}

/** 统计 vnode 树中的 <input> 元素数量（勾选框存在性）。 */
function countInputs(vnode: VNode | null | undefined): number {
  if (vnode === null || vnode === undefined) return 0;
  let count = vnode.type === "input" ? 1 : 0;
  if (vnode.component?.subTree !== null && vnode.component?.subTree !== undefined) count += countInputs(vnode.component.subTree);
  const children = vnode.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child !== null && typeof child === "object" && "children" in (child as VNode)) count += countInputs(child as VNode);
    }
  }
  return count;
}

beforeEach(() => { vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} }); });
afterEach(() => { closes.splice(0).forEach((close) => close()); lastRoot = null; vi.unstubAllGlobals(); });

it("保护流程（allowBringBack=false）：可展开记录的完整只读字段详情，无勾选与带回入口", async () => {
  const state = mountRetained(false);
  await nextTick(); await nextTick(); await nextTick();
  await (state.open as (generation: string) => Promise<void>)(G1);
  await nextTick();
  const expandedBefore = collectText(lastRoot?.subTree);
  expect(expandedBefore).toContain("旧记录");
  // 展开字段详情（保护态仍可查看）。
  state.openRecordId = "one";
  await nextTick(); await nextTick();
  const text = collectText(lastRoot?.subTree);
  // 完整业务字段：数值字段 + 时间/是否加满/油灯/加油站/油品/订单号。
  expect(text).toContain("是否加满");
  expect(text).toContain("油灯");
  expect(text).toContain("是");
  expect(text).toContain("否");
  expect(text).toContain("加油站");
  // 只读：没有勾选框与带回按钮。
  expect(countInputs(lastRoot?.subTree)).toBe(0);
  expect(text).not.toContain("填入当前记录的表单");
  expect(text).not.toContain("作为新记录填写");
});

it("已激活代次（allowBringBack=true）：保留值/当前值对照，相同禁选、不同可勾选带回", async () => {
  // 当前代次同 ID 记录的站名不同、其余字段相同 → 只有站名可选，其余显示「相同」。
  const current = { ...record, stationName: "当前站名" };
  const state = mountRetained(true, new Map([["one", current]]));
  await nextTick(); await nextTick(); await nextTick();
  await (state.open as (generation: string) => Promise<void>)(G1);
  await nextTick();
  state.openRecordId = "one";
  await nextTick(); await nextTick();
  const text = collectText(lastRoot?.subTree);
  expect(text).toContain("保留值");
  expect(text).toContain("当前值");
  expect(text).toContain("相同");
  expect(text).toContain("旧记录");
  expect(text).toContain("当前站名");
  expect(text).toContain("填入当前记录的表单");
  expect(text).toContain("已选 0 项");
  // 站名不同可勾选；相同字段禁选（显示「相同」标记而非勾选框）。
  expect(countInputs(lastRoot?.subTree)).toBeGreaterThan(0);
  expect(text.match(/相同/g)?.length ?? 0).toBeGreaterThan(0);
});

it("草稿原始输入核对包含是否加满与油灯（yes/no/空的原始值）", async () => {
  const state = mountRetained(false);
  await nextTick(); await nextTick(); await nextTick();
  state.openDraftKey = "draft-one";
  await nextTick(); await nextTick();
  const text = collectText(lastRoot?.subTree);
  expect(text).toContain("是否加满");
  expect(text).toContain("油灯");
  expect(collectText(lastRoot?.subTree)).toContain("是");
  expect(text).toContain("否");
  // 空值同样按（空）显示，不省略字段本身。
  (draft.values as Record<string, string>).fullTank = "";
  state.openDraftKey = null;
  await nextTick();
  state.openDraftKey = "draft-one";
  await nextTick(); await nextTick();
  expect(collectText(lastRoot?.subTree)).toContain("（空）");
  (draft.values as Record<string, string>).fullTank = "yes";
});

// ---------------------------------------------------------------------------
// 父审第二轮修复（UI-C01：草稿对照与相等判定）
// ---------------------------------------------------------------------------

it("UI-C01 二轮：草稿对照含当前值列；空油灯对当前未填写判同、无效数值不与空判同", async () => {
  // 当前记录：可开票金额未填写（null）、油灯未填写（null）、站名不同。
  const current = { ...record, invoiceableAmountCents: null, lowFuelLight: null, stationName: "当前站名" };
  const state = mountRetained(true, new Map([["one", current]]));
  await nextTick(); await nextTick(); await nextTick();
  await (state.open as (generation: string) => Promise<void>)(G1);
  await nextTick();
  // 草稿原始输入：油灯留空（与当前 null 相同）、可开票金额 1.234（解析失败，
  // 不得与当前未填写判同，须保留可勾选带回交表单校验纠正）。
  (draft.values as Record<string, string>).lowFuelLight = "";
  (draft.values as Record<string, string>).invoiceableAmountCents = "1.234";
  state.openDraftKey = "draft-one";
  await nextTick(); await nextTick();
  // 直接断言对照条目结构（渲染顺序不参与判定）。
  const entries = (state as unknown as { draftFieldEntries: (draft: unknown) => Array<{ field: string; label: string; valueText: string; currentText: string; same: boolean }> }).draftFieldEntries(draft);
  const byField = new Map(entries.map((entry) => [entry.field, entry]));
  // 当前值列存在且内容正确（含未填写显示「（空）」）。
  expect(byField.get("stationName")).toMatchObject({ valueText: "旧记录", currentText: "当前站名", same: false });
  expect(byField.get("invoiceableAmountCents")).toMatchObject({ valueText: "1.234", currentText: "（空）", same: false });
  expect(byField.get("lowFuelLight")).toMatchObject({ valueText: "（空）", currentText: "（空）", same: true });
  expect(byField.get("fullTank")).toMatchObject({ valueText: "是", currentText: "是", same: true });
  expect(byField.get("odometerTenths")).toMatchObject({ same: true });
  // 表头包含当前值列。
  expect(collectText(lastRoot?.subTree)).toContain("当前值");
});

it("UI-C01 二轮：明确「否」与当前 false 判同、与当前未填写不判同", async () => {
  const currentNoLight = { ...record, lowFuelLight: false, invoiceableAmountCents: null };
  const state = mountRetained(true, new Map([["one", currentNoLight]]));
  await nextTick(); await nextTick(); await nextTick();
  await (state.open as (generation: string) => Promise<void>)(G1);
  await nextTick();
  (draft.values as Record<string, string>).lowFuelLight = "no";
  state.openDraftKey = "draft-one";
  await nextTick(); await nextTick();
  const entries = (state as unknown as { draftFieldEntries: (draft: unknown) => Array<{ field: string; valueText: string; currentText: string; same: boolean }> }).draftFieldEntries(draft);
  const oil = entries.find((entry) => entry.field === "lowFuelLight");
  expect(oil).toMatchObject({ valueText: "否", currentText: "否", same: true });

  // 当前未填写（null）时明确的「否」是差异，可勾选带回。
  const currentNullLight = { ...record, lowFuelLight: null, invoiceableAmountCents: null };
  const state2 = mountRetained(true, new Map([["one", currentNullLight]]));
  await nextTick(); await nextTick(); await nextTick();
  await (state2.open as (generation: string) => Promise<void>)(G1);
  await nextTick();
  state2.openDraftKey = "draft-one";
  await nextTick(); await nextTick();
  const entries2 = (state2 as unknown as { draftFieldEntries: (draft: unknown) => Array<{ field: string; valueText: string; currentText: string; same: boolean }> }).draftFieldEntries(draft);
  const oil2 = entries2.find((entry) => entry.field === "lowFuelLight");
  expect(oil2).toMatchObject({ valueText: "否", currentText: "（空）", same: false });
});

// ---------------------------------------------------------------------------
// 父审第三轮修复（UI-C01.1：草稿时间按领域语义判同）
// ---------------------------------------------------------------------------

it("UI-C01.1：草稿分钟时间与当前零秒时间是同一业务时间——判同禁选，原文展示保留", async () => {
  const current = { ...record, occurredAtLocal: "2026-10-02T12:00:00" };
  const state = mountRetained(true, new Map([["one", current]]));
  await nextTick(); await nextTick(); await nextTick();
  await (state.open as (generation: string) => Promise<void>)(G1);
  await nextTick();
  (draft.values as Record<string, string>).occurredAtLocal = "2026-10-02T12:00";
  state.openDraftKey = "draft-one";
  await nextTick(); await nextTick();
  const entries = (state as unknown as { draftFieldEntries: (draft: unknown) => Array<{ field: string; valueText: string; currentText: string; same: boolean }> }).draftFieldEntries(draft);
  const time = entries.find((entry) => entry.field === "occurredAtLocal");
  // 业务相等（分钟补零秒）：禁选；两侧原文照常展示（带回保留原文）。
  expect(time).toMatchObject({ valueText: "2026-10-02T12:00", currentText: "2026-10-02T12:00:00", same: true });
});
