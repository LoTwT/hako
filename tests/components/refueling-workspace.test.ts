// 工作区组件接线测试（R9 二轮）：真实编译 RefuelingWorkspace SFC，验证保留
// 记录/草稿带回后草稿会话绑定新的表单上下文（当前代次、目标记录与当前基线），
// 以及保护流程切换前草稿 flush 失败时不卸载旧工作区。自定义 renderer + 草稿
// 接口观测器；不冒充真实浏览器（边界见本地验证记录）。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRenderer, nextTick, shallowRef } from "vue";
import RefuelingWorkspace from "../../src/components/refueling/RefuelingWorkspace.vue";
import { accountA, syntheticRecord } from "../helpers/sync-fixtures";
import { createDraft } from "../../src/domain/refueling/form";

const observed = vi.hoisted(() => ({ contexts: [] as unknown[], draftContexts: [] as unknown[], flushOk: true as boolean }));
vi.mock("../../src/composables/useRefuelingDrafts", async () => {
  const { shallowRef } = await import("vue");
  return {
    useRefuelingDrafts: () => ({
      drafts: shallowRef({ status: "ready", recovery: { status: "ready", candidates: [], notice: "" }, writeError: "", orphanedEditCount: 0, unsupportedCount: 0 }),
      initialize: async () => undefined,
      attachForm: (context: unknown) => observed.contexts.push(structuredClone(context)),
      updateDraft: () => observed.draftContexts.push(structuredClone(observed.contexts.at(-1))),
      adoptedDraft: () => null, currentDraftId: () => null,
      flush: async () => observed.flushOk,
      clearAfterSave: async () => ({ ok: true, message: "" }),
    }),
  };
});
vi.mock("../../src/components/refueling/RefuelingForm.vue", async () => {
  const { defineComponent, onMounted } = await import("vue");
  const { createDraft } = await import("../../src/domain/refueling/form");
  return { default: defineComponent({
    props: ["initial", "initialDraft", "busy", "locked", "available"], emits: ["dirty", "draft", "save"],
    setup(props, { emit }) { onMounted(() => emit("draft", props.initialDraft ?? createDraft(props.initial))); return () => null; },
  }) };
});
vi.mock("../../src/components/refueling/RefuelingRecords.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/LegacyImport.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/StorageStatus.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/RetainedRefuelingCopy.vue", () => ({ default: { render: () => null } }));

const renderer = createRenderer({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const closes: Array<() => void> = [];
type SetupState = Record<string, (...args: unknown[]) => unknown>;

function mountWorkspace(): { state: SetupState; local: Record<string, unknown> } {
  const generation = "00000000-0000-4000-8000-0000000000a2";
  const current = { ...syntheticRecord, id: "one", stationName: "current baseline" };
  const local = {
    records: shallowRef([current]), ready: shallowRef(true), saving: shallowRef(false), error: shallowRef(""),
    notice: shallowRef(""), persistent: shallowRef(false), importedLegacyIds: shallowRef([]), pendingSync: shallowRef(false), confirmed: shallowRef(false),
    pendingRestore: shallowRef(null), importConflicts: shallowRef({}), migrationPending: shallowRef(null),
    restoreWritesAvailable: shallowRef(false),
    generationFlow: shallowRef({ phase: "active", generation, serverConfirmed: true }), workspaceGeneration: shallowRef(generation),
    save: vi.fn(), initialize: vi.fn(), requestPersistence: vi.fn(), importLegacy: vi.fn(), retrySync: vi.fn(),
    openCurrentGeneration: vi.fn(), recheckRestoreReceipt: vi.fn(), listRetainedGenerations: vi.fn(), readRetainedGeneration: vi.fn(), retryOpen: vi.fn(), recheckMigration: vi.fn(),
  };
  const app = renderer.createApp(RefuelingWorkspace, { accountId: accountA, local, locked: false, navigatingForLogin: false });
  const instance = app.mount({}) as unknown as { $: { setupState: SetupState } };
  closes.push(() => app.unmount());
  return { state: instance.$.setupState, local };
}

beforeEach(() => {
  observed.contexts.length = 0;
  observed.draftContexts.length = 0;
  observed.flushOk = true;
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { closes.splice(0).forEach((close) => close()); vi.unstubAllGlobals(); });

it("保留记录带回：新草稿绑定当前记录与当前基线（同 ID 编辑）", async () => {
  const { state } = mountWorkspace();
  await nextTick(); await nextTick();
  const beforeCount = observed.contexts.length;
  state.bringBackFromRetained({ recordId: "one", exists: true, patch: { stationName: "retained input" } });
  await nextTick();
  // 带回后重新 attachForm：不再是带回前的 create + 原随机 ID + base=null。
  expect(observed.contexts.length).toBeGreaterThan(beforeCount);
  expect(observed.contexts.at(-1)).toMatchObject({ mode: "edit", recordId: "one" });
  expect((observed.contexts.at(-1) as { base: { stationName: string } }).base.stationName).toBe("current baseline");
  // 表单产生草稿事件时，持久草稿使用带回后的上下文。
  state.onFormDraft(createDraft({ ...syntheticRecord, stationName: "retained input" }));
  expect(observed.draftContexts.at(-1)).toMatchObject({ mode: "edit", recordId: "one", base: { stationName: "current baseline" } });
});

it("保留记录带回（记录已不存在）：作为新记录绑定新 ID、无基线", async () => {
  const { state } = mountWorkspace();
  await nextTick(); await nextTick();
  const previousCreateId = (observed.contexts.at(-1) as { recordId: string }).recordId;
  state.bringBackFromRetained({ recordId: "gone", exists: false, patch: { stationName: "retained input" } });
  await nextTick();
  const context = observed.contexts.at(-1) as { mode: string; recordId: string; base: unknown };
  expect(context.mode).toBe("create");
  expect(context.base).toBeNull();
  expect(context.recordId).not.toBe(previousCreateId);
  state.onFormDraft(createDraft({ ...syntheticRecord, stationName: "retained input" }));
  expect(observed.draftContexts.at(-1)).toMatchObject({ mode: "create", base: null });
});

it("保留草稿带回：新草稿绑定当前记录与当前基线，不接旧 base", async () => {
  const { state } = mountWorkspace();
  await nextTick(); await nextTick();
  const current = { ...syntheticRecord, id: "one", stationName: "current baseline" };
  state.bringBackDraftFromRetained({
    id: "retained-draft", mode: "edit", recordId: "one", base: { ...current, stationName: "old baseline" },
    ...createDraft({ ...current, stationName: "retained input" }), createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null,
  });
  await nextTick();
  expect(observed.contexts.at(-1)).toMatchObject({ mode: "edit", recordId: "one" });
  expect((observed.contexts.at(-1) as { base: { stationName: string } }).base.stationName).toBe("current baseline");
  state.onFormDraft(createDraft({ ...syntheticRecord, stationName: "retained input" }));
  expect(observed.draftContexts.at(-1)).toMatchObject({ mode: "edit", recordId: "one", base: { stationName: "current baseline" } });
});

it("带回后普通保存：按带回后的目标记录提交（编辑同 ID，不误建新增）", async () => {
  const { state, local } = mountWorkspace();
  await nextTick(); await nextTick();
  state.bringBackFromRetained({ recordId: "one", exists: true, patch: { stationName: "retained input" } });
  await nextTick();
  await state.submit({ ...syntheticRecord, stationName: "retained input" });
  expect(local.save).toHaveBeenCalledWith("one", expect.objectContaining({ stationName: "retained input" }), false);
});

it("打开恢复后数据前草稿 flush 失败：不切换工作区、不调用接收", async () => {
  const { state, local } = mountWorkspace();
  await nextTick(); await nextTick();
  observed.flushOk = false;
  await state.openCurrentData();
  await nextTick();
  expect(local.openCurrentGeneration).not.toHaveBeenCalled();
  expect(state.openCurrentNotice).toContain("草稿尚未保存到本机");
});
