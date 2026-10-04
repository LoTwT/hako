// 保留副本视图组件测试（R5 二轮）：真实编译 RetainedRefuelingCopy SFC，验证
// 草稿原始输入核对包含完整布尔字段（是否加满/油灯），且保护流程（allowBringBack
// =false）仍可展开记录的只读字段详情、无勾选与带回入口。自定义 renderer +
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

it("已激活代次（allowBringBack=true）：展开详情提供勾选与带回入口", async () => {
  // 当前代次仍有同 ID 记录 → 带回按钮按当前记录表单文案显示。
  const state = mountRetained(true, new Map([["one", record]]));
  await nextTick(); await nextTick(); await nextTick();
  await (state.open as (generation: string) => Promise<void>)(G1);
  await nextTick();
  state.openRecordId = "one";
  await nextTick(); await nextTick();
  const text = collectText(lastRoot?.subTree);
  expect(text).toContain("填入当前记录的表单");
  expect(countInputs(lastRoot?.subTree)).toBeGreaterThan(0);
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
