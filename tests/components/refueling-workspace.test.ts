// 工作区组件接线测试（父审第一轮修复后）：真实编译 RefuelingWorkspace SFC。
// 覆盖：保留记录/草稿逐字段带回后的草稿上下文绑定、保护分段（草稿保护成功前
// 不卸载表单/失败保留输入可重试，UI-R01）、同 ID 再进入恢复实例（UI-R02）、
// 草稿选择层的空白新建进入编辑地址与直接编辑多草稿先选（UI-R05）。自定义
// renderer + 草稿接口观测器；不冒充真实浏览器（边界见本地验证记录）。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computed, defineComponent, h, nextTick, shallowRef } from "vue";
import { createMinimalHostRenderer, createMinimalHostRoot } from "../helpers/minimal-host";
import RefuelingWorkspace from "../../src/components/refueling/RefuelingWorkspace.vue";
import { accountA, syntheticRecord } from "../helpers/sync-fixtures";
import { createDraft } from "../../src/domain/refueling/form";
import type { AppRoute, RefuelingRoute } from "../../src/ui/app-route";

const observed = vi.hoisted(() => ({
  contexts: [] as unknown[],
  draftContexts: [] as unknown[],
  drafts: [] as unknown[],
  candidates: [] as unknown[],
  flushOk: true as boolean,
  flushCalls: 0 as number,
  formMounts: 0 as number,
  formUnmounts: 0 as number,
  pendingClearAfterSave: null as Promise<{ ok: boolean; message: string }> | null,
}));
vi.mock("../../src/composables/useRefuelingDrafts", async () => {
  const { shallowRef } = await import("vue");
  return {
    useRefuelingDrafts: () => ({
      drafts: shallowRef({ status: "ready", recovery: { status: "ready", candidates: observed.candidates, notice: "" }, writeError: "", orphanedEditCount: 0, unsupportedCount: 0 }),
      initialize: async () => undefined,
      attachForm: (context: unknown) => observed.contexts.push(structuredClone(context)),
      updateDraft: (draft: unknown) => { observed.drafts.push(structuredClone(draft)); observed.draftContexts.push(structuredClone(observed.contexts.at(-1))); },
      adoptedDraft: () => null, currentDraftId: () => null,
      flush: async () => { observed.flushCalls += 1; return observed.flushOk; },
      // 保存清理是异步出口（UI-R03.3）：受控可阻塞，观察迟到完成对新编辑实例的影响。
      clearAfterSave: async () => {
        if (observed.pendingClearAfterSave !== null) return await observed.pendingClearAfterSave;
        return { ok: true, message: "" };
      },
    }),
  };
});
vi.mock("../../src/components/refueling/RefuelingForm.vue", async () => {
  const { defineComponent, h, onMounted, onUnmounted } = await import("vue");
  const { createDraft } = await import("../../src/domain/refueling/form");
  return { default: defineComponent({
    props: ["initial", "initialDraft", "busy", "locked", "available", "records", "editingRecordId"], emits: ["dirty", "draft", "save", "continueLater"],
    setup(props, { emit }) {
      onMounted(() => { observed.formMounts += 1; emit("draft", props.initialDraft ?? createDraft(props.initial)); });
      onUnmounted(() => { observed.formUnmounts += 1; });
      return () => h("div", "synthetic-form");
    },
  }) };
});
// 路由子视图以最小桩替代：本组测试只观测草稿上下文与保护流程接线。
vi.mock("../../src/components/refueling/RecordsRoot.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/RecordDetailPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/StatisticsPage.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/DataPage.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/BackupRestore.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/LegacyImport.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/RetainedRefuelingCopy.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/DraftSelectionLayer.vue", () => ({ default: { render: () => null } }));

const renderer = createMinimalHostRenderer();
const closes: Array<() => void> = [];
type SetupState = Record<string, (...args: unknown[]) => unknown>;

function mountWorkspace(): { state: SetupState; local: Record<string, unknown> } {
  const generation = "00000000-0000-4000-8000-0000000000a2";
  const current = { ...syntheticRecord, id: "one", stationName: "current baseline" };
  const local = {
    records: shallowRef([current]), ready: shallowRef(true), saving: shallowRef(false), error: shallowRef(""),
    notice: shallowRef(""), persistent: shallowRef(false), importedLegacyIds: shallowRef([]), pendingSync: shallowRef(false), confirmed: shallowRef(false),
    syncStatus: shallowRef<{ phase: "paused" | "syncing" | "waiting" | "failed"; message: string }>({ phase: "paused", message: "" }),
    pendingRestore: shallowRef(null), importConflicts: shallowRef({}), migrationPending: shallowRef(null),
    restoreWritesAvailable: shallowRef(false),
    generationFlow: shallowRef({ phase: "active", generation, serverConfirmed: true }), workspaceGeneration: shallowRef(generation),
    save: vi.fn(), initialize: vi.fn(), requestPersistence: vi.fn(), importLegacy: vi.fn(), retrySync: vi.fn(),
    openCurrentGeneration: vi.fn(), recheckRestoreReceipt: vi.fn(), listRetainedGenerations: vi.fn(), readRetainedGeneration: vi.fn(), retryOpen: vi.fn(), recheckMigration: vi.fn(),
    refresh: vi.fn(), beginRestoreRequest: vi.fn(), submitPendingRestore: vi.fn(),
  };
  const route: RefuelingRoute = { name: "records" };
  const appRoute: AppRoute = { name: "refueling", refueling: route };
  const app = renderer.createApp(RefuelingWorkspace, {
    accountId: accountA, local, locked: false, navigatingForLogin: false,
    route, appRoute,
    navigate: vi.fn(), replaceRoute: vi.fn(), backTo: vi.fn(), openSettings: vi.fn(),
  });
  const instance = app.mount(createMinimalHostRoot()) as unknown as { $: { setupState: SetupState } };
  closes.push(() => app.unmount());
  return { state: instance.$.setupState, local };
}

beforeEach(() => {
  observed.contexts.length = 0;
  observed.draftContexts.length = 0;
  observed.drafts.length = 0;
  observed.candidates.length = 0;
  observed.flushOk = true;
  observed.flushCalls = 0;
  observed.formMounts = 0;
  observed.formUnmounts = 0;
  observed.pendingClearAfterSave = null;
  vi.stubGlobal("window", {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
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

it("保留草稿逐字段带回：只带入勾选字段并绑定当前记录与当前基线，不接旧 base", async () => {
  const { state } = mountWorkspace();
  await nextTick(); await nextTick();
  const current = { ...syntheticRecord, id: "one", stationName: "current baseline" };
  state.bringBackDraftFromRetained({
    draft: {
      id: "retained-draft", mode: "edit", recordId: "one", base: { ...current, stationName: "old baseline" },
      ...createDraft({ ...current, stationName: "retained input", odometerTenths: 11000 }), createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null,
    },
    fields: ["stationName"],
  });
  await nextTick();
  // 只带入勾选字段：里程保持当前基线（10000），站名改为勾选值。
  expect(observed.contexts.at(-1)).toMatchObject({ mode: "edit", recordId: "one" });
  expect((observed.contexts.at(-1) as { base: { stationName: string } }).base.stationName).toBe("current baseline");
  const values = (state as unknown as { initialDraft: { values: { stationName: string; odometerTenths: string } } }).initialDraft.values;
  expect(values.stationName).toBe("retained input");
  expect(values.odometerTenths).toBe("1000");
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

// ---------------------------------------------------------------- 编辑器路由接线
/** 用响应式包装组件挂载工作区：允许测试在挂载后推进 route 属性。 */
function mountWorkspaceWithRouteRef(initialRoute?: RefuelingRoute): { state: SetupState; local: Record<string, unknown>; routeRef: { value: RefuelingRoute }; navigate: ReturnType<typeof vi.fn>; replaceRoute: ReturnType<typeof vi.fn>; backTo: ReturnType<typeof vi.fn> } {
  const generation = "00000000-0000-4000-8000-0000000000a2";
  const current = { ...syntheticRecord, id: "one", stationName: "current baseline" };
  const local = {
    records: shallowRef([current]), ready: shallowRef(true), saving: shallowRef(false), error: shallowRef(""),
    notice: computed(() => ""), persistent: shallowRef(false), importedLegacyIds: shallowRef([]), pendingSync: shallowRef(false), confirmed: shallowRef(false),
    syncStatus: shallowRef<{ phase: "paused" | "syncing" | "waiting" | "failed"; message: string }>({ phase: "paused", message: "" }),
    pendingRestore: shallowRef(null), importConflicts: shallowRef({}), migrationPending: shallowRef(null),
    restoreWritesAvailable: shallowRef(false),
    generationFlow: shallowRef<import("../../src/composables/useLocalRefueling").GenerationFlow>({ phase: "active", generation, serverConfirmed: true }), workspaceGeneration: shallowRef(generation),

    save: vi.fn(async () => true), initialize: vi.fn(), requestPersistence: vi.fn(), importLegacy: vi.fn(), retrySync: vi.fn(),
    openCurrentGeneration: vi.fn(), recheckRestoreReceipt: vi.fn(), listRetainedGenerations: vi.fn(), readRetainedGeneration: vi.fn(), retryOpen: vi.fn(), recheckMigration: vi.fn(),
    refresh: vi.fn(), beginRestoreRequest: vi.fn(), submitPendingRestore: vi.fn(),
  };
  const routeRef = shallowRef<RefuelingRoute>(initialRoute ?? { name: "records" });
  const navigate = vi.fn();
  const replaceRoute = vi.fn();
  const backTo = vi.fn();
  let captured: unknown = null;
  const app = renderer.createApp(defineComponent({
    setup() {
      return () => h(RefuelingWorkspace, {
        accountId: accountA,
        // 模拟组合层返回结构：受控桩以宽化类型传入（行为断言不依赖精确类型）。
        local: local as unknown as InstanceType<typeof RefuelingWorkspace>["$props"]["local"],
        locked: false, navigatingForLogin: false,
        route: routeRef.value, appRoute: { name: "refueling", refueling: routeRef.value },
        navigate, replaceRoute, backTo, openSettings: vi.fn(),
        ref: (instance: unknown) => { captured = instance; },
      });
    },
  }));
  app.mount(createMinimalHostRoot());
  closes.push(() => app.unmount());
  const instance = captured as { $: { setupState: SetupState } } | null;
  if (instance === null) throw new Error("工作区实例未捕获");
  return { state: instance.$.setupState, local, routeRef, navigate, replaceRoute, backTo };
}

it("开始新编辑：建立挂起编辑器并推进到 /new，来源为记录根页", async () => {
  const { state, navigate } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  state.startNew();
  await nextTick();
  expect(navigate).toHaveBeenCalledWith({ name: "refueling", refueling: { name: "record-new" } });
  expect(state.pendingEditor).toMatchObject({ mode: "create" });
});

it("已有挂起编辑时编辑其他记录：不更换编辑器，路由回到原编辑目标", async () => {
  const { state, navigate } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  state.startEdit({ ...syntheticRecord, id: "one" });
  await nextTick();
  state.startEdit({ ...syntheticRecord, id: "two" });
  await nextTick();
  expect(state.pendingEditor).toMatchObject({ mode: "edit", recordId: "one" });
  expect(navigate).toHaveBeenLastCalledWith({ name: "refueling", refueling: { name: "record-edit", recordId: "one" } });
});

it("保存成功：结束编辑并按一次性来源返回记录根页", async () => {
  const { state, local, backTo } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  state.startNew();
  await nextTick();
  await state.submit({ ...syntheticRecord });
  await nextTick();
  expect(local.save).toHaveBeenCalledTimes(1);
  expect(state.pendingEditor).toBeNull();
  expect(backTo).toHaveBeenCalledWith({ name: "refueling", refueling: { name: "records" } });
});

it("挂起编辑器与地址不一致时：替换回编辑器实际目标，不静默接管", async () => {
  const { state, routeRef, replaceRoute } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  state.startEdit({ ...syntheticRecord, id: "one" });
  await nextTick();
  // 地址被外部推进到另一条记录的编辑页：挂起编辑器优先。
  routeRef.value = { name: "record-edit", recordId: "two" };
  await nextTick(); await nextTick();
  expect(replaceRoute).toHaveBeenCalledWith({ name: "refueling", refueling: { name: "record-edit", recordId: "one" } });
  expect(state.localNotice).toContain("正在编辑另一份记录");
});

// ---------------------------------------------------------------- 父审第一轮修复契约
const G2 = "00000000-0000-4000-8000-0000000000a3";

it("UI-R01 保护分段：进入 protected 先做草稿保护，flush 失败保留表单实例与输入，可重试", async () => {
  const { state, local } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  state.startNew();
  await nextTick();
  (state as unknown as { dirty: boolean }).dirty = true;
  const formMountsBefore = observed.formMounts;
  const formUnmountsBefore = observed.formUnmounts;
  observed.flushOk = false;
  observed.flushCalls = 0;
  (local.generationFlow as { value: import("../../src/composables/useLocalRefueling").GenerationFlow }).value =
    { phase: "protected", localGeneration: "00000000-0000-4000-8000-0000000000a2", serverGeneration: G2, legacyGeneration: null, receipt: "idle", message: "synthetic generation changed" };
  await nextTick(); await nextTick();
  // 草稿保护被调用且失败：表单不卸载，普通工作区保持可见，进入 failed 分段。
  expect(observed.flushCalls).toBe(1);
  expect(observed.formUnmounts).toBe(formUnmountsBefore);
  expect(observed.formMounts).toBe(formMountsBefore);
  expect((state as unknown as { protectionStage: string }).protectionStage).toBe("failed");
  expect((state as unknown as { normalViewportVisible: boolean }).normalViewportVisible).toBe(true);
  // 保护未完成前打开恢复后数据仍被 flush 拒绝；原输入仍在。
  await state.openCurrentData();
  await nextTick();
  expect(local.openCurrentGeneration).not.toHaveBeenCalled();
  expect((state as unknown as { protectionStage: string }).protectionStage).toBe("failed");
  // 重试保存草稿成功后才切换到保护页（工作区仅隐藏，实例保留）。
  observed.flushOk = true;
  await state.protectDrafts();
  await nextTick(); await nextTick();
  expect((state as unknown as { protectionStage: string }).protectionStage).toBe("protected");
  expect((state as unknown as { normalViewportVisible: boolean }).normalViewportVisible).toBe(false);
  expect(observed.formUnmounts).toBe(formUnmountsBefore);
});

it("UI-R01 无未保存输入时进入 protected：保护立即完成并显示保护页", async () => {
  const { state, local } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  (local.generationFlow as { value: import("../../src/composables/useLocalRefueling").GenerationFlow }).value =
    { phase: "protected", localGeneration: "00000000-0000-4000-8000-0000000000a2", serverGeneration: G2, legacyGeneration: null, receipt: "idle", message: "synthetic generation changed" };
  await nextTick(); await nextTick();
  expect((state as unknown as { protectionStage: string }).protectionStage).toBe("protected");
  expect((state as unknown as { normalViewportVisible: boolean }).normalViewportVisible).toBe(false);
});

it("UI-R02 同 ID 再进入：恢复既有实例与原来源，不重置输入、不重新绑定草稿上下文", async () => {
  const { state, local } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  const current = (local.records as { value: import("../../src/domain/refueling/form").SavedRefuelingRecord[] }).value[0]!;
  state.startEdit(current);
  await nextTick();
  const lastDraft = observed.drafts.at(-1) as { values: { odometerTenths: string } };
  lastDraft.values.odometerTenths = "1234.5";
  (state as unknown as { onFormDraft: (draft: unknown) => void }).onFormDraft(lastDraft);
  await state.flushDraft();
  state.continueLater();
  await nextTick(); await nextTick();
  const contextCount = observed.contexts.length;
  state.startEdit(current);
  await nextTick(); await nextTick();
  // 同 ID 再进入：不再 attachForm、pendingEditor 保留、仍处于挂起编辑。
  expect(observed.contexts).toHaveLength(contextCount);
  expect((state as unknown as { pendingEditor: { mode: string; recordId: string } | null }).pendingEditor)
    .toMatchObject({ mode: "edit", recordId: current.id });
  // 同 ID 再进入不重置输入：草稿值仍保留手动修改，未被基线值覆盖。
  expect((observed.drafts.at(-1) as { values: { odometerTenths: string } }).values.odometerTenths).toBe("1234.5");
});

it("UI-R05 草稿层「空白新建」进入编辑地址并建立新实例", async () => {
  const { state, navigate } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  (state as unknown as { showDraftPicker: boolean }).showDraftPicker = true;
  await nextTick();
  state.alternateFromPicker();
  await nextTick();
  expect(navigate).toHaveBeenCalledWith({ name: "refueling", refueling: { name: "record-new" } });
  expect((state as unknown as { pendingEditor: unknown }).pendingEditor).toMatchObject({ mode: "create" });
});

it("UI-R05 直接编辑地址且该记录有未占用草稿：先出选择层，不自动任选", async () => {
  const record = { ...syntheticRecord, id: "one" } as import("../../src/domain/refueling/form").SavedRefuelingRecord;
  observed.candidates.push(
    { id: "draft-1", mode: "edit", recordId: "one", base: record, ...createDraft(record), createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null },
    { id: "draft-2", mode: "edit", recordId: "one", base: record, ...createDraft(record), createdAt: 2, updatedAt: 2, formatVersion: 1, savedAt: null },
  );
  const { state } = mountWorkspaceWithRouteRef({ name: "record-edit", recordId: "one" } as import("../../src/ui/app-route").RefuelingRoute);
  await nextTick(); await nextTick();
  expect((state as unknown as { showDraftPicker: boolean }).showDraftPicker).toBe(true);
  expect((state as unknown as { pendingEditor: unknown }).pendingEditor).toBeNull();
});

it("UI-R05 选择层「不用草稿，直接编辑」：忽略草稿按当前记录建立编辑", async () => {
  const record = { ...syntheticRecord, id: "one" } as import("../../src/domain/refueling/form").SavedRefuelingRecord;
  observed.candidates.push(
    { id: "draft-1", mode: "edit", recordId: "one", base: record, ...createDraft({ ...record, stationName: "草稿站名" }), createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null },
  );
  const { state } = mountWorkspaceWithRouteRef({ name: "record-edit", recordId: "one" } as import("../../src/ui/app-route").RefuelingRoute);
  await nextTick(); await nextTick();
  state.alternateFromPicker();
  await nextTick(); await nextTick();
  expect((state as unknown as { showDraftPicker: boolean }).showDraftPicker).toBe(false);
  expect((state as unknown as { pendingEditor: unknown }).pendingEditor).toMatchObject({ mode: "edit", recordId: "one" });
  // 直接编辑以当前记录为基线，不采用草稿站名。
  const lastValues = (observed.drafts.at(-1) as { values: { stationName: string } }).values;
  expect(lastValues.stationName).toBe("current baseline");
  expect(lastValues.stationName).not.toBe("草稿站名");
});

// ---------------------------------------------------------------------------
// 父审第二轮修复契约（R01 初始 protected / R05 详情入口 / C01 原始字符串带回）
// ---------------------------------------------------------------------------

it("UI-R01 二轮：retained-only 首次挂载即 protected——草稿初始化后直接完成保护，不显示失败提示", async () => {
  // retained-only 形状：active=null、legacy=G0，AccountWorkspace 按代次 key 重挂载
  // 的新实例初始 isProtectedFlow=true（父审 ARCH2-4 的 caller 链形状）。
  observed.flushCalls = 0;
  const generation = "00000000-0000-4000-8000-0000000000a4";
  const local = {
    records: shallowRef([]), ready: shallowRef(true), saving: shallowRef(false), error: shallowRef(""),
    notice: computed(() => ""), persistent: shallowRef(false), importedLegacyIds: shallowRef([]), pendingSync: shallowRef(false), confirmed: shallowRef(false),
    syncStatus: shallowRef({ phase: "paused", message: "" }),
    pendingRestore: shallowRef(null), importConflicts: shallowRef({}), migrationPending: shallowRef(null),
    restoreWritesAvailable: shallowRef(false),
    generationFlow: shallowRef<import("../../src/composables/useLocalRefueling").GenerationFlow>({
      phase: "protected", localGeneration: null, serverGeneration: null, legacyGeneration: "00000000-0000-4000-8000-0000000000a3",
      receipt: "idle", message: "本机只有保留副本",
    }),
    workspaceGeneration: shallowRef(generation),
    save: vi.fn(async () => true), initialize: vi.fn(), requestPersistence: vi.fn(), importLegacy: vi.fn(), retrySync: vi.fn(),
    openCurrentGeneration: vi.fn(), recheckRestoreReceipt: vi.fn(), listRetainedGenerations: vi.fn(), readRetainedGeneration: vi.fn(), retryOpen: vi.fn(), recheckMigration: vi.fn(),
    refresh: vi.fn(), beginRestoreRequest: vi.fn(), submitPendingRestore: vi.fn(),
  };
  const routeRef = shallowRef<RefuelingRoute>({ name: "data-retained" });
  let capturedInstance: unknown = null;
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(RefuelingWorkspace, {
      accountId: accountA,
      local: local as unknown as InstanceType<typeof RefuelingWorkspace>["$props"]["local"],
      locked: false, navigatingForLogin: false,
      route: routeRef.value, appRoute: { name: "refueling", refueling: routeRef.value },
      navigate: vi.fn(), replaceRoute: vi.fn(), backTo: vi.fn(), openSettings: vi.fn(),
      ref: (instance: unknown) => { capturedInstance = instance; },
    }),
  }));
  app.mount(createMinimalHostRoot());
  closes.push(() => app.unmount());
  await nextTick(); await nextTick(); await nextTick(); await nextTick();
  const state = (capturedInstance as unknown as { $: { setupState: SetupState } }).$.setupState;
  // 草稿初始化完成后统一解析保护状态：无待写输入时 flush 直接成功并显示保护页，
  // 不停留 idle（"当前输入尚未保存"的失败提示），无需手动重试。
  expect((state as unknown as { protectionStage: string }).protectionStage).toBe("protected");
  expect((state as unknown as { normalViewportVisible: boolean }).normalViewportVisible).toBe(false);
  expect(observed.flushCalls).toBe(1);
});

it("UI-R05 二轮：详情「编辑记录」入口遇同记录多份未占用草稿也先出选择层，不建立新编辑器", async () => {
  const record = { ...syntheticRecord, id: "one" } as import("../../src/domain/refueling/form").SavedRefuelingRecord;
  observed.candidates.push(
    { id: "draft-1", mode: "edit", recordId: "one", base: record, ...createDraft(record), createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null },
    { id: "draft-2", mode: "edit", recordId: "one", base: record, ...createDraft(record), createdAt: 2, updatedAt: 2, formatVersion: 1, savedAt: null },
  );
  const { state, navigate } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  // 详情入口（无挂起编辑器）：与直接编辑地址共用决策——先选择，不 edit()。
  state.startEdit(record);
  await nextTick(); await nextTick();
  expect(navigate).toHaveBeenCalledWith({ name: "refueling", refueling: { name: "record-edit", recordId: "one" } });
  expect((state as unknown as { pendingEditor: unknown }).pendingEditor).toBeNull();
});

it("UI-C01 二轮：草稿带回保留所选原始字符串（解析失败值交由表单校验纠正，不转为空）", async () => {
  const { state } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  const current = { ...syntheticRecord, id: "one", stationName: "current baseline", invoiceableAmountCents: 5000 };
  const record = current as import("../../src/domain/refueling/form").SavedRefuelingRecord;
  const draftValues = { ...createDraft(record).values } as Record<string, string>;
  draftValues.invoiceableAmountCents = "1.234";
  state.bringBackDraftFromRetained({
    draft: {
      id: "retained-invalid", mode: "edit", recordId: "one", base: record,
      ...createDraft(record),
      values: draftValues as unknown as import("../../src/domain/refueling/form").RefuelingDraft["values"],
      createdAt: 1, updatedAt: 1, formatVersion: 1, savedAt: null,
    },
    fields: ["invoiceableAmountCents"],
  });
  await nextTick();
  // 原始字符串 1.234 原样进入表单（表单校验将提示超精度），未选字段保持当前基线。
  const initial = (state as unknown as { initialDraft: { values: Record<string, string> } }).initialDraft;
  expect(initial.values.invoiceableAmountCents).toBe("1.234");
  // 未勾选的站名保持当前记录基线。
  expect(initial.values.stationName).toBe("current baseline");
  expect(initial.values.odometerTenths).toBe("1000");
});

// ---------------------------------------------------------------------------
// 父审第四轮修复（UI-R03.3 同记录新编辑实例 / R06.2 承接层归属核对）
// ---------------------------------------------------------------------------

it("UI-R03.3：同记录保存清理在途时放弃并重开新编辑——旧完成不清理新实例、不重置输入", async () => {
  const { state } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  const record = { ...syntheticRecord, id: "one" } as import("../../src/domain/refueling/form").SavedRefuelingRecord;
  state.startEdit(record);
  await nextTick(); await nextTick();
  const firstContext = (state as unknown as { pendingEditor: { mode: string; recordId: string } | null }).pendingEditor;
  // 保存成功，草稿清理在途（真实会话在首个 await 前已清 currentDraftId）。
  let releaseClearAfterSave!: (value: { ok: boolean; message: string }) => void;
  observed.pendingClearAfterSave = new Promise((resolve) => { releaseClearAfterSave = resolve; });
  const submitDone = (state as unknown as { submit: (record: unknown) => Promise<void> }).submit(record);
  await nextTick(); await nextTick();
  // 本人确认放弃旧编辑，再从详情重开同一记录的新编辑并输入。
  await (state as unknown as { discardActiveDraft: () => Promise<void> }).discardActiveDraft();
  await nextTick(); await nextTick();
  state.startEdit(record);
  await nextTick(); await nextTick();
  const newContext = (state as unknown as { pendingEditor: { mode: string; recordId: string } | null }).pendingEditor;
  expect(newContext).not.toBe(firstContext);
  const newDraft = observed.drafts.at(-1) as { values: { odometerTenths: string } };
  newDraft.values.odometerTenths = "2468.9";
  (state as unknown as { onFormDraft: (draft: unknown) => void }).onFormDraft(newDraft);
  const newFormKey = (state as unknown as { formKey: number }).formKey;
  // 旧保存的清理迟到完成：按实例身份不匹配，不动新编辑。
  releaseClearAfterSave({ ok: true, message: "" });
  await submitDone;
  await nextTick(); await nextTick();
  expect((state as unknown as { pendingEditor: unknown }).pendingEditor).toBe(newContext);
  expect((state as unknown as { formKey: number }).formKey).toBe(newFormKey);
  const lastValues = (observed.drafts.at(-1) as { values: { odometerTenths: string } }).values;
  expect(lastValues.odometerTenths).toBe("2468.9");
});

it("UI-R06.2 四轮：承接层按投递代次核对——新流程作废旧取消，无新流程时照常可读", async () => {
  const { state } = mountWorkspaceWithRouteRef();
  await nextTick(); await nextTick();
  const delivery = state as unknown as {
    onBackupCancelDelivery: (message: string, deliveryEpoch?: number) => void;
    backupCancelNotice: string;
    backupCancelEpoch: number;
  };
  // 没有新流程：旧取消失败（代次 0 === 当前 0）照常呈现。
  delivery.onBackupCancelDelivery("未能确认预览已关闭；返回后请重新预览。", 0);
  expect(delivery.backupCancelNotice).toBe("未能确认预览已关闭；返回后请重新预览。");
  // 新预览/新确认开始（清除消息）：代次推进，作废更早的在途取消。
  delivery.onBackupCancelDelivery("");
  expect(delivery.backupCancelNotice).toBe("");
  expect(delivery.backupCancelEpoch).toBe(1);
  // 旧取消结果晚到（携带发起时代次 0）：已被新流程作废，不写呈现。
  delivery.onBackupCancelDelivery("未能确认预览已关闭；返回后请重新预览。", 0);
  expect(delivery.backupCancelNotice).toBe("");
  // 新一代次的取消失败照常可读。
  delivery.onBackupCancelDelivery("未能确认预览已关闭；返回后请重新预览。", 1);
  expect(delivery.backupCancelNotice).toBe("未能确认预览已关闭；返回后请重新预览。");
});
