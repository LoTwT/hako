// 真实 App → AccountWorkspace → Workspace → Form；仅认证、本机仓库和草稿存储受控。
// 最小宿主验证事件与归属，实际 Tab/inert/键盘焦点另由隔离浏览器验收。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, shallowRef, type VNode } from "vue";
import App from "../../src/App.vue";
import { assertRefuelingSavePrecondition, createDraft, type FormField, type RefuelingRecord, type RefuelingSavePrecondition, type SavedRefuelingRecord } from "../../src/domain/refueling/form";
import { calculateRefuelingHistory, projectRefuelingStatistics } from "../../src/domain/refueling/statistics";
import { createMinimalHostRenderer, createMinimalHostRoot, type MinimalHostNode } from "../helpers/minimal-host";

const observed = vi.hoisted(() => ({
  auth: null as any,
  locals: new Map<string, any>(),
  draftSessions: [] as any[],
  adopted: null as any,
  flushOk: true,
}));
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
  return { useAuthSession: () => ({ auth: observed.auth, authenticatedAccountLabel: shallowRef("合成账号"), localDevelopment: false,
    refresh: async () => {}, login: vi.fn(), logout: vi.fn(), recheckRejectedSession: vi.fn() }) };
});
vi.mock("../../src/composables/useLocalRefueling", () => ({ useLocalRefueling: ({ accountId }: { accountId: string }) => observed.locals.get(accountId) }));
vi.mock("../../src/composables/useRefuelingDrafts", async () => {
  const { shallowRef } = await import("vue");
  return { useRefuelingDrafts: (options: { accountId: string; generation: string }) => {
    const session = {
      ...options, drafts: shallowRef({ status: "ready", recovery: { status: "ready", candidates: [], notice: "" }, writeError: "", orphanedEditCount: 0, unsupportedCount: 0 }),
      initialize: async () => {}, attachForm: vi.fn(), updateDraft: vi.fn(), adoptedDraft: () => options.accountId === A ? observed.adopted : null,
      currentDraftId: () => null, flush: vi.fn(async () => observed.flushOk), clearAfterSave: vi.fn(async () => ({ ok: true, message: "" })),
      discard: vi.fn(async () => "cleared"), adopt: vi.fn(async () => observed.adopted),
    };
    observed.draftSessions.push(session);
    return session;
  } };
});
// PR2/恢复/导入展示不是本组验收目标；账号和编辑器实例链路保持真实。
vi.mock("../../src/components/refueling/StatisticsPage.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/DataPage.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/BackupRestore.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/LegacyImport.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/refueling/RetainedRefuelingCopy.vue", () => ({ default: { render: () => null } }));

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
const G = "00000000-0000-4000-8000-0000000000d1";
const G1 = "00000000-0000-4000-8000-0000000000d2";
const NEW_ID = "00000000-0000-4000-8000-000000000020";
function record(id: string, time: string, odometerTenths: number): SavedRefuelingRecord {
  return { id, occurredAtLocal: time, odometerTenths, fuelVolumeMillilitres: 20000, unitPriceTenThousandths: 60000,
    amountPayableCents: 12000, couponDiscountCents: 0, amountPaidCents: 12000, invoiceableAmountCents: null,
    fullTank: true, lowFuelLight: null, stationName: "SYN original", fuelGrade: "", orderNumber: "" };
}
const P = record("P", "2026-03-01T08:00:00", 10000);
const X = record("X", "2026-03-02T08:00:00", 12000);
const N = record("N", "2026-03-03T08:00:00", 14000);
function localFor(records: SavedRefuelingRecord[]) {
  const local = {
    records: shallowRef(records), ready: shallowRef(true), saving: shallowRef(false), error: shallowRef(""), notice: shallowRef(""),
    persistent: shallowRef(false), importedLegacyIds: shallowRef([]), pendingSync: shallowRef(false), confirmed: shallowRef(true), syncStatus: shallowRef({ phase: "paused", message: "" }),
    pendingRestore: shallowRef(null), importConflicts: shallowRef({}), migrationPending: shallowRef(null), restoreWritesAvailable: shallowRef(true),
    generationFlow: shallowRef<any>({ phase: "active", generation: G, serverConfirmed: true }), workspaceGeneration: shallowRef(G),
    save: vi.fn(async (id: string, patch: Partial<RefuelingRecord>, creating: boolean, precondition?: RefuelingSavePrecondition) => {
      expect(precondition).toBeDefined();
      assertRefuelingSavePrecondition(local.records.value, id, patch, creating, precondition!);
      const target = local.records.value.find(record => record.id === id);
      local.records.value = [...local.records.value.filter(record => record.id !== id), { ...target, ...patch, id } as SavedRefuelingRecord];
      return true;
    }),
    initialize: vi.fn(), requestPersistence: vi.fn(), importLegacy: vi.fn(), retrySync: vi.fn(),
    openCurrentGeneration: vi.fn(async () => {
      local.records.value = [record("generation-one", "2026-04-01T08:00:00", 100)];
      local.generationFlow.value = { phase: "active", generation: G1, serverConfirmed: true };
      local.workspaceGeneration.value = G1;
      return { ok: true, message: "" };
    }),
    recheckRestoreReceipt: vi.fn(), listRetainedGenerations: vi.fn(), readRetainedGeneration: vi.fn(), retryOpen: vi.fn(), recheckMigration: vi.fn(),
    refresh: vi.fn(), beginRestoreRequest: vi.fn(), submitPendingRestore: vi.fn(),
  };
  return local;
}
function components(vnode: VNode, name: string): any[] {
  const result: any[] = [];
  if (vnode.component) {
    if ((vnode.type as { __name?: string }).__name === name) result.push(vnode.component);
    result.push(...components(vnode.component.subTree, name));
  }
  if (Array.isArray(vnode.children)) for (const child of vnode.children)
    if (child !== null && typeof child === "object" && "type" in child) result.push(...components(child as VNode, name));
  return result;
}
function nodes(node: MinimalHostNode): MinimalHostNode[] { return [node, ...node.children.flatMap(nodes)]; }
function text(node: MinimalHostNode): string { return nodes(node).filter(node => node.kind !== "comment").map(node => node.text ?? "").join(" "); }
const renderer = createMinimalHostRenderer();
const closes: (() => void)[] = [];
const location = { hash: "#refueling", assign: vi.fn() };
const history = { replaceState: vi.fn(), pushState: vi.fn(), back: vi.fn() };
async function settle() { for (let index = 0; index < 8; index++) { await nextTick(); await Promise.resolve(); } }
function mount() {
  const root = createMinimalHostRoot();
  const app = renderer.createApp(App);
  const vm = app.mount(root) as any;
  closes.push(() => app.unmount());
  return { root, app: vm.$.setupState,
    accounts: () => components(vm.$.subTree, "AccountWorkspace"),
    workspaces: () => components(vm.$.subTree, "RefuelingWorkspace"),
    workspace: (account = A) => components(vm.$.subTree, "RefuelingWorkspace").find(instance => instance.props.accountId === account).setupState,
    form: (account = A) => components(components(vm.$.subTree, "RefuelingWorkspace").find(instance => instance.props.accountId === account).subTree, "RefuelingForm")[0],
  };
}
type Mounted = ReturnType<typeof mount>;
function editField(mounted: Mounted, field: FormField, value: string, account = A) {
  mounted.form(account).setupState.edit(field, { target: { value } });
}
async function fillNew(mounted: Mounted, odometer = "1200") {
  mounted.workspace().startNew(); await settle();
  for (const [field, value] of [["occurredAtLocal", X.occurredAtLocal], ["odometerTenths", odometer], ["fuelVolumeMillilitres", "20"], ["unitPriceTenThousandths", "6"], ["fullTank", "yes"]] as [FormField, string][])
    editField(mounted, field, value);
  await settle();
}
async function submitForm(mounted: Mounted, account = A) { mounted.form(account).setupState.submit(); await settle(); }
function auth(accountId: string) { observed.auth.value = { accountId, status: "authenticated", message: "", loggingIn: false, loggingOut: false }; }
function local(account = A): ReturnType<typeof localFor> { return observed.locals.get(account); }
function draftSession(account = A) { return observed.draftSessions.find(session => session.accountId === account); }
function dialog(mounted: Mounted) { return nodes(mounted.root).find(node => node.props["aria-labelledby"] === "save-review-title"); }

beforeEach(() => {
  observed.auth = shallowRef({ accountId: A, status: "authenticated", message: "", loggingIn: false, loggingOut: false });
  observed.locals.clear(); observed.locals.set(A, localFor([P, N])); observed.locals.set(B, localFor([record("B-only", X.occurredAtLocal, 5000)]));
  observed.draftSessions = []; observed.adopted = null; observed.flushOk = true;
  location.hash = "#refueling";
  history.replaceState.mockClear(); history.pushState.mockClear(); history.back.mockClear();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(NEW_ID);
  vi.stubGlobal("window", { location, history, scrollTo() {}, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("document", { title: "", visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { closes.splice(0).forEach(close => close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("统一保存确认：真实 Form/Workspace", () => {
  it.each([false, true])("M01：正常/首笔（%s）直接保存一次，自动草稿不携带确认状态", async first => {
    if (first) local().records.value = [];
    const mounted = mount(); await settle(); await fillNew(mounted); await submitForm(mounted);
    expect(local().save).toHaveBeenCalledTimes(1);
    expect(dialog(mounted)).toBeUndefined();
    expect(draftSession().updateDraft).toHaveBeenCalled();
    expect(Object.keys(draftSession().updateDraft.mock.calls.at(-1)[0])).toEqual(["values", "sources"]);
    expect(draftSession().clearAfterSave).toHaveBeenCalledTimes(1);
  });
  it.each([["900", "previous"], ["1500", "next"], ["1000", "previous"], ["1400", "next"]])("M02–M04：里程 %s 首次保存零次，确认只派发一次", async (distance, position) => {
    const mounted = mount(); await settle(); await fillNew(mounted, distance); await submitForm(mounted);
    const workspace = mounted.workspace(); const review = workspace.pendingSaveReview;
    expect(review.inspection.conflicts).toMatchObject([{ position }]);
    expect(local().save).not.toHaveBeenCalled();
    expect(dialog(mounted)).toBeDefined();
    expect(nodes(mounted.root).find(node => node.props.class === "workspace-main")?.props.inert).toBe(true);
    const confirm = workspace.confirmSaveReview(review);
    workspace.confirmSaveReview(review);
    await confirm; await settle();
    workspace.confirmSaveReview(review);
    expect(local().save).toHaveBeenCalledTimes(1);
    expect(local().records.value.find(record => record.id === NEW_ID)?.odometerTenths).toBe(Number(distance) * 10);
  });
  it("M03/M08/M18：双侧冲突与金额在同一层，保存后原值、警告及支出保留", async () => {
    local().records.value = [{ ...P, odometerTenths: 16000 }, N];
    const mounted = mount(); await settle(); await fillNew(mounted, "1500"); editField(mounted, "amountPaidCents", "119");
    await submitForm(mounted);
    const workspace = mounted.workspace();
    expect(workspace.pendingSaveReview.inspection.conflicts).toHaveLength(2);
    expect(text(dialog(mounted)!)).toContain("1.00 元");
    expect(nodes(mounted.root).filter(node => node.props["aria-labelledby"] === "save-review-title")).toHaveLength(1);
    expect(nodes(mounted.root).filter(node => node.tag === "input" && node.props.type === "checkbox")).toHaveLength(0);
    await workspace.confirmSaveReview(workspace.pendingSaveReview); await settle();
    expect(local().save).toHaveBeenCalledTimes(1);
    expect(workspace.recordWarningsMap.get("N")).toContain("总里程没有递增，请核对相邻记录。");
    const result = projectRefuelingStatistics(calculateRefuelingHistory(local().records.value), { kind: "total" });
    expect(result.expense.amountPaidCents).toBe(35900n);
    expect(result.fuelConsumption.reviewTripCount).toBe(2);
    expect(draftSession().clearAfterSave).toHaveBeenCalledTimes(1);
  });
  it("M06：实际 UUID 从 Form prop 到检查、前置条件和 local.save 一致", async () => {
    local().records.value = [
      { ...N, id: "00000000-0000-4000-8000-000000000030", occurredAtLocal: "2026-03-02T08:00" },
      { ...P, id: "00000000-0000-4000-8000-000000000010", occurredAtLocal: X.occurredAtLocal },
    ];
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    expect(mounted.form().props.recordId).toBe(NEW_ID);
    const review = mounted.workspace().pendingSaveReview;
    expect(review.inspection.precondition.recordId).toBe(NEW_ID);
    expect(review.inspection.precondition.previous.id).toBe("00000000-0000-4000-8000-000000000010");
    await mounted.workspace().confirmSaveReview(review); await settle();
    expect(local().save.mock.calls[0][0]).toBe(NEW_ID);
    expect(local().save.mock.calls[0][3]?.recordId).toBe(NEW_ID);
  });
  it.each(["odometerTenths", "occurredAtLocal", "amountPaidCents", "stationName"] as FormField[])("M09：%s 改后还原也使旧确认永久失效", async field => {
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const workspace = mounted.workspace(); const review = workspace.pendingSaveReview;
    const before = mounted.form().setupState.draft.values[field];
    editField(mounted, field, field === "occurredAtLocal" ? "2026-03-04T08:00:00" : "123");
    editField(mounted, field, before); await settle();
    expect(workspace.pendingSaveReview).toBeNull();
    workspace.confirmSaveReview(review); expect(local().save).not.toHaveBeenCalled();
    expect(mounted.form().setupState.draft.values[field]).toBe(before);
    await submitForm(mounted); expect(workspace.pendingSaveReview.reviewId).not.toBe(review.reviewId);
  });
  it.each(["仍然保存", "返回修改"])("M09/M12：旧弹层的实际 %s 回调不能操作新确认", async label => {
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const oldCallback = nodes(dialog(mounted)!).find(node => node.tag === "button" && node.text === label)!.props.onClick as () => void;
    await mounted.workspace().cancelSaveReview(mounted.workspace().pendingSaveReview); await settle();
    await submitForm(mounted);
    const currentReview = mounted.workspace().pendingSaveReview;
    oldCallback(); await settle();
    expect(local().save).not.toHaveBeenCalled();
    expect(mounted.workspace().pendingSaveReview).toBe(currentReview);
  });
  it.each(["mileage", "time", "delete", "insert", "target"]) ("M10：有关记录 %s 变化即使冲突消失也作废且保留输入", async change => {
    local().records.value = [P, X, N];
    const mounted = mount(); await settle(); mounted.workspace().startEdit(X); await settle(); editField(mounted, "odometerTenths", "900"); await submitForm(mounted);
    const workspace = mounted.workspace(); const review = workspace.pendingSaveReview;
    const snapshot = local().records.value;
    local().records.value = change === "delete" ? snapshot.filter(record => record.id !== "P")
      : change === "insert" ? [...snapshot, record("near", "2026-03-02T07:00:00", 8500)]
      : snapshot.map(record => change === "target" && record.id === "X" ? { ...record, stationName: "remote" }
        : record.id === "P" ? { ...record, ...(change === "time" ? { occurredAtLocal: "2026-01-01T08:00:00" } : { odometerTenths: 8000 }) } : record);
    await settle();
    expect(workspace.pendingSaveReview).toBeNull(); expect(workspace.localNotice).toContain("记录或相邻里程已变化");
    workspace.confirmSaveReview(review); expect(local().save).not.toHaveBeenCalled();
    expect(mounted.form().setupState.draft.values.odometerTenths).toBe("900");
  });
  it("M11：无关更新与重排不作废确认", async () => {
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const workspace = mounted.workspace(); const review = workspace.pendingSaveReview;
    local().records.value = [N, { ...P, stationName: "remote", amountPaidCents: 0 }, record("far", "2026-01-01T08:00:00", 0)];
    await settle(); expect(workspace.pendingSaveReview).toBe(review);
    await workspace.confirmSaveReview(review); expect(local().save).toHaveBeenCalledTimes(1);
  });
  it.each(["button", "escape", "backdrop"])("M12：%s 取消不保存、不清草稿，默认焦点返回修改", async action => {
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const review = mounted.workspace().pendingSaveReview;
    const returnButton = nodes(dialog(mounted)!).find(node => node.tag === "button" && node.text === "返回修改")!;
    expect(returnButton.focusCount).toBeGreaterThan(0);
    if (action === "escape") review.focus.onLayerKeydown({ key: "Escape", preventDefault: vi.fn() });
    else if (action === "backdrop") (nodes(dialog(mounted)!).find(node => node.props.class === "dialog-backdrop")!.props.onClick as () => void)();
    else (returnButton.props.onClick as () => void)();
    await settle();
    expect(mounted.workspace().pendingSaveReview).toBeNull(); expect(local().save).not.toHaveBeenCalled();
    expect(draftSession().clearAfterSave).not.toHaveBeenCalled();
    expect(mounted.form().setupState.draft.values.odometerTenths).toBe("900");
  });
  it("M13：实际 App A→B→A 保活输入，隐藏旧确认失效且不抢 B 路由或焦点", async () => {
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const workspaceA = mounted.workspace(); const formA = mounted.form(); const review = workspaceA.pendingSaveReview;
    const returnButton = nodes(dialog(mounted)!).find(node => node.tag === "button" && node.text === "返回修改")!;
    const focusBefore = returnButton.focusCount;
    auth(B); await settle();
    expect(mounted.workspaces()).toHaveLength(2); expect(workspaceA.pendingSaveReview).toBeNull();
    const bRoute = structuredClone(mounted.app.targetRoute);
    workspaceA.confirmSaveReview(review); await workspaceA.cancelSaveReview(review); await settle();
    expect(local(A).save).not.toHaveBeenCalled(); expect(local(B).save).not.toHaveBeenCalled();
    expect(mounted.app.targetRoute).toEqual(bRoute); expect(returnButton.focusCount).toBe(focusBefore);
    expect(mounted.form(B).setupState.draft.values.odometerTenths).not.toBe("900");
    auth(A); await settle(); await mounted.app.navigate({ name: "refueling", refueling: { name: "record-new" } }); await settle();
    expect(mounted.workspace()).toBe(workspaceA); expect(mounted.form()).toBe(formA);
    expect(formA.setupState.draft.values.odometerTenths).toBe("900"); expect(workspaceA.pendingSaveReview).toBeNull();
    await submitForm(mounted); expect(workspaceA.pendingSaveReview).not.toBe(review);
  });
  it("M14：同账号真实 generation key 重建，flush 失败不接收、不卸载", async () => {
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const old = mounted.workspace(); const oldForm = mounted.form(); const account = mounted.accounts()[0]; const review = old.pendingSaveReview;
    observed.flushOk = false;
    local().generationFlow.value = { phase: "protected", localGeneration: G, serverGeneration: G1, legacyGeneration: G, receipt: "idle", message: "synthetic protection" };
    await settle(); expect(old.pendingSaveReview).toBeNull(); expect(old.protectionStage).toBe("failed");
    await old.openCurrentData(); await settle();
    expect(local().openCurrentGeneration).not.toHaveBeenCalled(); expect(mounted.form()).toBe(oldForm);
    old.confirmSaveReview(review); expect(local().save).not.toHaveBeenCalled();
    observed.flushOk = true; await old.openCurrentData(); await settle();
    expect(local().openCurrentGeneration).toHaveBeenCalledTimes(1); expect(mounted.accounts()[0]).toBe(account);
    expect(mounted.workspace()).not.toBe(old); expect(oldForm.isUnmounted).toBe(true);
    expect(mounted.workspace().generation).toBe(G1); expect(mounted.workspace().pendingSaveReview).toBeNull();
    old.confirmSaveReview(review); expect(local().save).not.toHaveBeenCalled();
  });
  it.each(["ready", "login", "settings", "route", "draft-layer", "generation"])("M14：%s 门禁关闭作废确认，旧点击不得派发", async gate => {
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const workspace = mounted.workspace(); const review = workspace.pendingSaveReview;
    if (gate === "ready") local().ready.value = false;
    if (gate === "login") observed.auth.value = { ...observed.auth.value, loggingIn: true };
    if (gate === "settings") await mounted.app.navigate({ name: "settings" });
    if (gate === "route") await mounted.app.navigate({ name: "refueling", refueling: { name: "statistics" } });
    if (gate === "draft-layer") workspace.showDiscardConfirm = true;
    if (gate === "generation") local().generationFlow.value = { phase: "active", generation: G1, serverConfirmed: true };
    await settle(); workspace.confirmSaveReview(review); expect(local().save).not.toHaveBeenCalled(); expect(workspace.pendingSaveReview).toBeNull();
  });
  it.each(["", "-1", "1.23"])("M15：硬错误里程 %s 不开确认，伪造 save 也不能绕过", async value => {
    const mounted = mount(); await settle(); await fillNew(mounted, value); await submitForm(mounted);
    expect(dialog(mounted)).toBeUndefined(); expect(local().save).not.toHaveBeenCalled();
    const workspace = mounted.workspace();
    workspace.submit({ record: { ...X, odometerTenths: -1 }, recordId: workspace.formId, formInstanceKey: workspace.formKey });
    expect(local().save).not.toHaveBeenCalled();
  });
  it("M15/M06：恢复草稿沿用 adopted.recordId，重新确认，不带持久确认凭证", async () => {
    observed.adopted = { id: "draft", recordId: "restored-id", mode: "create", base: null, ...createDraft({ ...X, odometerTenths: 9000 }) };
    const mounted = mount(); await settle(); await mounted.app.navigate({ name: "refueling", refueling: { name: "record-new" } }); await settle();
    expect(mounted.form().props.recordId).toBe("restored-id");
    await submitForm(mounted); expect(local().save).not.toHaveBeenCalled();
    await mounted.workspace().confirmSaveReview(mounted.workspace().pendingSaveReview);
    expect(local().save.mock.calls[0][0]).toBe("restored-id");
  });
  it("M17：保存失败不清草稿、不复用旧确认；重试重新检查", async () => {
    local().save.mockResolvedValueOnce(false);
    const mounted = mount(); await settle(); await fillNew(mounted, "900"); await submitForm(mounted);
    const workspace = mounted.workspace(); const review = workspace.pendingSaveReview;
    await workspace.confirmSaveReview(review); await settle();
    expect(workspace.pendingSaveReview).toBeNull(); expect(draftSession().clearAfterSave).not.toHaveBeenCalled();
    workspace.confirmSaveReview(review); expect(local().save).toHaveBeenCalledTimes(1);
    await submitForm(mounted); await workspace.confirmSaveReview(workspace.pendingSaveReview); await settle();
    expect(local().save).toHaveBeenCalledTimes(2); expect(draftSession().clearAfterSave).toHaveBeenCalledTimes(1);
  });
  it("M17：旧保存等待期间同 ID 重开，新输入/草稿和旧 Form 迟到意图均有归属检查", async () => {
    local().records.value = [P, X, N];
    let finish!: (value: boolean) => void;
    local().save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const mounted = mount(); await settle(); mounted.workspace().startEdit(X); await settle();
    const workspace = mounted.workspace(); const oldForm = mounted.form();
    editField(mounted, "stationName", "first edit"); await submitForm(mounted);
    expect(local().save).toHaveBeenCalledTimes(1);
    await workspace.discardActiveDraft(); await settle(); workspace.startEdit(X); await settle();
    const newEditor = workspace.pendingEditor; editField(mounted, "stationName", "second edit"); await settle();
    finish(true); await settle();
    expect(workspace.pendingEditor).toBe(newEditor); expect(mounted.form().setupState.draft.values.stationName).toBe("second edit");
    expect(draftSession().clearAfterSave).not.toHaveBeenCalled();
    oldForm.setupState.submit(); await settle(); expect(local().save).toHaveBeenCalledTimes(1);
  });
  it("M19：合法同步合并按实际金额/里程确认，摘要列出保留值", async () => {
    local().records.value = [P, X, N];
    const mounted = mount(); await settle(); mounted.workspace().startEdit(X); await settle();
    editField(mounted, "couponDiscountCents", "10"); editField(mounted, "amountPaidCents", "110");
    local().records.value = [P, { ...X, fuelVolumeMillilitres: 25000, amountPayableCents: 15000, amountPaidCents: 15000, odometerTenths: 9000 }, N];
    await submitForm(mounted);
    const workspace = mounted.workspace(); const review = workspace.pendingSaveReview;
    expect(text(dialog(mounted)!)).toContain("30.00 元"); expect(text(dialog(mounted)!)).toContain("最新记录保留的未修改字段");
    expect(text(dialog(mounted)!)).toContain("总里程：900 公里");
    expect(review.inspection.patch).toEqual({ couponDiscountCents: 1000, amountPaidCents: 11000 });
    await workspace.confirmSaveReview(review); await settle();
    expect(local().save.mock.calls[0][1]).toBe(review.inspection.patch);
    expect(local().records.value.find(record => record.id === "X")).toMatchObject({ fuelVolumeMillilitres: 25000, amountPayableCents: 15000, odometerTenths: 9000, amountPaidCents: 11000 });
  });
  it.each([null, "2026-03-02T08:01", "2026-03-02T08:00:01"])("M20–M22：真实 Form 时间编辑 %s，检查/确认/precondition/save 共用补丁", async time => {
    const baseline = { ...X, occurredAtLocal: "2026-03-02T08:00" };
    local().records.value = [baseline, { ...P, occurredAtLocal: "2026-03-02T08:30:00", odometerTenths: 11000 }];
    const mounted = mount(); await settle(); mounted.workspace().startEdit(baseline); await settle();
    editField(mounted, "stationName", "SYN edited");
    if (time !== null) { editField(mounted, "occurredAtLocal", time); editField(mounted, "odometerTenths", "1250"); editField(mounted, "amountPaidCents", "119"); }
    local().records.value = local().records.value.map(record => record.id === "X" ? { ...record, occurredAtLocal: "2026-03-02T09:00:00" } : record);
    await submitForm(mounted);
    if (time === null) {
      expect(dialog(mounted)).toBeUndefined(); expect(local().save).toHaveBeenCalledTimes(1);
      expect(local().save.mock.calls[0][1]).toEqual({ stationName: "SYN edited" });
    } else {
      const review = mounted.workspace().pendingSaveReview;
      expect(review.inspection.conflicts).toMatchObject([{ position: "next", deltaTenths: -1500n }]);
      expect(review.inspection.patch).toEqual({ stationName: "SYN edited", occurredAtLocal: time.length === 16 ? `${time}:00` : time, odometerTenths: 12500, amountPaidCents: 11900 });
      await mounted.workspace().confirmSaveReview(review); await settle();
      expect(local().save.mock.calls[0][1]).toBe(review.inspection.patch);
    }
    const call = local().save.mock.calls[0]; expect(call[3]?.patch).toEqual(call[1]);
    expect(local().records.value.find(record => record.id === "X")?.occurredAtLocal).toBe(time === null ? "2026-03-02T09:00:00" : time.length === 16 ? `${time}:00` : time);
  });
  it("M23：纯检查器硬拒绝损坏目标，工作区不弹可绕过的确认", async () => {
    local().records.value = [X];
    const mounted = mount(); await settle(); mounted.workspace().startEdit(X); await settle(); editField(mounted, "stationName", "edited");
    local().records.value = [{ ...X, amountPaidCents: -1 }]; await submitForm(mounted);
    expect(local().save).not.toHaveBeenCalled(); expect(dialog(mounted)).toBeUndefined(); expect(draftSession().clearAfterSave).not.toHaveBeenCalled();
    expect(mounted.workspace().localNotice).toContain("记录字段无效");
  });
});
