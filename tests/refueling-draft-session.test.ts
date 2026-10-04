// 草稿会话测试：合并写与 flush、写失败保留待重试、已保存草稿清理、
// 找不到记录的编辑草稿保留、页面占用与恢复决策、多窗口不互相覆盖。

import { describe, expect, it, vi } from "vitest";
import {
  createMemoryLocatorStorage,
  createWebLocksPageClaim,
  type DraftPageClaim,
} from "../src/data/draft-environment";
import { RefuelingDraftSession } from "../src/data/refueling-draft-session";
import type {
  RefuelingDraftList,
  RefuelingDraftStore,
} from "../src/data/refueling-draft-store";
import type { StoredRefuelingDraft } from "../src/domain/refueling/draft-recovery";
import {
  createDraft,
  updateDraft,
  type RefuelingDraft,
  type SavedRefuelingRecord,
} from "../src/domain/refueling/form";

const T0 = Date.parse("2026-10-02T00:00:00.000Z");

class FakeDraftStore implements RefuelingDraftStore {
  readonly entries = new Map<string, StoredRefuelingDraft>();
  putCalls = 0;
  failPuts = false;
  failRemoves = false;
  /** 测试挂起某次写入，用于构造“写入在途期间又发生输入”的时序。 */
  beforePut: (() => Promise<void>) | null = null;

  async list(): Promise<RefuelingDraftList> {
    return { drafts: [...this.entries.values()], unsupportedCount: 0 };
  }

  async get(id: string): Promise<StoredRefuelingDraft | null> {
    return this.entries.get(id) ?? null;
  }

  async put(draft: StoredRefuelingDraft): Promise<void> {
    this.putCalls += 1;
    if (this.beforePut !== null) {
      const gate = this.beforePut;
      this.beforePut = null;
      await gate();
    }
    if (this.failPuts) throw new DOMException("quota", "QuotaExceededError");
    this.entries.set(draft.id, structuredClone(draft));
  }

  async remove(id: string): Promise<void> {
    if (this.failRemoves) throw new Error("remove failed");
    this.entries.delete(id);
  }

  close(): void {}
}

class FakeClaim implements DraftPageClaim {
  /** 本页持有的草稿。 */
  readonly held = new Set<string>();
  /** 其他页面持有的草稿（本页无法占用）。 */
  readonly foreign = new Set<string>();
  tryClaimResult = true;

  async isHeldByAnotherPage(draftId: string): Promise<boolean> {
    return this.foreign.has(draftId);
  }

  async tryClaim(draftId: string): Promise<boolean> {
    if (this.foreign.has(draftId)) return false;
    if (!this.tryClaimResult) return false;
    this.held.add(draftId);
    return true;
  }

  release(draftId: string): void {
    this.held.delete(draftId);
  }

  releaseAll(): void {
    this.held.clear();
  }
}

function draftValues(entries: [Parameters<typeof updateDraft>[1], string][]): RefuelingDraft {
  return entries.reduce(
    (draft, [field, value]) => updateDraft(draft, field, value),
    createDraft(undefined, new Date("2026-08-08T06:49:42Z")),
  );
}

function storedCreateDraft(id: string, updatedAt = T0): StoredRefuelingDraft {
  const draft = draftValues([["stationName", `站点-${id}`]]);
  return {
    id,
    mode: "create",
    recordId: `record-${id}`,
    base: null,
    values: draft.values,
    sources: draft.sources,
    createdAt: updatedAt,
    updatedAt,
    formatVersion: 1,
    savedAt: null,
  };
}

function recordFixture(id: string): SavedRefuelingRecord {
  return {
    id,
    odometerTenths: 100000,
    fuelVolumeMillilitres: 43000,
    unitPriceTenThousandths: 79400,
    amountPayableCents: 34142,
    couponDiscountCents: 0,
    amountPaidCents: 34142,
    invoiceableAmountCents: null,
    occurredAtLocal: "2026-08-08T14:49:42",
    fullTank: true,
    lowFuelLight: null,
    stationName: "",
    fuelGrade: "",
    orderNumber: "",
  };
}

function createSession(
  store: FakeDraftStore,
  options: {
    locator?: ReturnType<typeof createMemoryLocatorStorage>;
    claim?: DraftPageClaim;
    knownRecords?: Map<string, SavedRefuelingRecord>;
    now?: () => number;
    createId?: () => string;
  } = {},
) {
  const locator = options.locator ?? createMemoryLocatorStorage();
  const claim = options.claim ?? new FakeClaim();
  const knownRecords = options.knownRecords ?? new Map<string, SavedRefuelingRecord>();
  let idCounter = 0;
  const session = new RefuelingDraftSession({
    store,
    locator,
    claim,
    knownRecords: () => knownRecords,
    now: options.now ?? (() => T0),
    createId: options.createId ?? (() => `draft-${++idCounter}`),
  });
  return { session, locator, claim, knownRecords };
}

describe("草稿会话写入", () => {
  it("合并写入并保证 flush 后保存的是最新输入", async () => {
    const store = new FakeDraftStore();
    const { session } = createSession(store);
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "record-new", base: null });

    session.updateDraft(draftValues([["stationName", "站点 A"]]));
    session.updateDraft(draftValues([["stationName", "站点 B"]]));
    session.updateDraft(draftValues([["stationName", "站点 C"], ["amountPaidCents", "341.42"]]));
    expect(await session.flush()).toBe(true);

    const saved = [...store.entries.values()];
    expect(saved).toHaveLength(1);
    expect(saved[0].values.stationName).toBe("站点 C");
    expect(saved[0].values.amountPaidCents).toBe("341.42");
    // 合并写：三次变更不应触发三次写事务
    expect(store.putCalls).toBeLessThanOrEqual(2);
    expect(session.writeError).toBe("");
  });

  it("写失败时保留待写内容、提示错误，并在恢复后重试成功", async () => {
    const store = new FakeDraftStore();
    const { session } = createSession(store);
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "record-new", base: null });

    store.failPuts = true;
    session.updateDraft(draftValues([["stationName", "站点 A"]]));
    expect(await session.flush()).toBe(false);
    expect(session.writeError).toContain("草稿未保存");
    expect(store.entries.size).toBe(0);

    store.failPuts = false;
    expect(await session.flush()).toBe(true);
    expect([...store.entries.values()][0].values.stationName).toBe("站点 A");
    expect(session.writeError).toBe("");
  });

  it("写入在途期间的旧版本失败不覆盖新输入", async () => {
    const store = new FakeDraftStore();
    const { session } = createSession(store);
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "record-race", base: null });

    let releaseWrite: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    store.beforePut = () => gate;
    store.failPuts = true;

    session.updateDraft(draftValues([["stationName", "旧输入"]]));
    // 第一次写入仍在等待：用户又输入了新内容，形成同一草稿的更新版本
    session.updateDraft(draftValues([["stationName", "最新输入"]]));
    releaseWrite();
    await session.flush();
    expect(session.writeError).not.toBe("");

    store.failPuts = false;
    expect(await session.flush()).toBe(true);
    const stored = [...store.entries.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].values.stationName).toBe("最新输入");
  });

  it("切换表单时不会挤掉另一份仍未落盘的草稿", async () => {
    const store = new FakeDraftStore();
    const { session } = createSession(store);
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "record-one", base: null });
    session.updateDraft(draftValues([["stationName", "第一份"]]));
    await session.flush();

    // 第一份草稿的写入开始失败，用户切到另一条记录继续输入
    store.failPuts = true;
    session.attachForm({ mode: "create", recordId: "record-two", base: null });
    session.updateDraft(draftValues([["stationName", "第二份"]]));
    await session.flush();
    expect(session.writeError).not.toBe("");

    store.failPuts = false;
    expect(await session.flush()).toBe(true);
    const names = [...store.entries.values()]
      .map((draft) => draft.values.stationName)
      .sort();
    expect(names).toEqual(["第一份", "第二份"]);
  });

  it("业务保存后清除草稿；清理失败时不谎报成功", async () => {
    const store = new FakeDraftStore();
    const { session, locator } = createSession(store);
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "record-new", base: null });
    session.updateDraft(draftValues([["stationName", "站点 A"]]));
    await session.flush();

    expect(await session.clearAfterSave()).toEqual({ ok: true, message: "" });
    expect(store.entries.size).toBe(0);
    expect(session.currentDraft()).toBeNull();
    expect(locator.get("hako-refueling-draft-locator")).toBeNull();

    session.attachForm({ mode: "create", recordId: "record-new-2", base: null });
    session.updateDraft(draftValues([["stationName", "站点 B"]]));
    await session.flush();
    store.failRemoves = true;
    const failed = await session.clearAfterSave();
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("草稿未能删除");
    // 删除失败也要留下“已保存”标记，重开时据此清理
    const remaining = [...store.entries.values()];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].savedAt).not.toBeNull();
  });

  it("标记也失败时不承诺自动清理", async () => {
    const store = new FakeDraftStore();
    const { session } = createSession(store);
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "record-marker", base: null });
    session.updateDraft(draftValues([["stationName", "站点 C"]]));
    await session.flush();

    store.failPuts = true;
    store.failRemoves = true;
    const failed = await session.clearAfterSave();
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("核对内容");
    expect(failed.message).not.toContain("会自动清理");
  });
});

describe("草稿恢复决策", () => {
  it("已保存的新建草稿被清理，不再提示恢复", async () => {
    const store = new FakeDraftStore();
    const ghost = storedCreateDraft("ghost");
    store.entries.set(ghost.id, ghost);
    const { session, knownRecords } = createSession(store);
    knownRecords.set(ghost.recordId, recordFixture(ghost.recordId));

    await session.initialize();
    expect(store.entries.size).toBe(0);
    expect(session.recovery).toEqual({ status: "ready", candidates: [], notice: "" });
  });

  it("线索对应的编辑草稿（记录存在）可以自动恢复", async () => {
    const store = new FakeDraftStore();
    const base = {
      id: "record-existing",
      odometerTenths: 100000,
      fuelVolumeMillilitres: 43000,
      unitPriceTenThousandths: 79400,
      amountPayableCents: 34142,
      couponDiscountCents: 0,
      amountPaidCents: 34142,
      invoiceableAmountCents: null,
      occurredAtLocal: "2026-08-08T14:49:42",
      fullTank: true,
      lowFuelLight: null,
      stationName: "",
      fuelGrade: "",
      orderNumber: "",
    };
    const draft: StoredRefuelingDraft = {
      ...storedCreateDraft("edit-draft"),
      mode: "edit",
      recordId: "record-existing",
      base,
    };
    store.entries.set(draft.id, draft);
    const locator = createMemoryLocatorStorage();
    locator.set("hako-refueling-draft-locator", draft.id);
    const { session, knownRecords } = createSession(store, { locator });
    knownRecords.set("record-existing", base);

    await session.initialize();
    expect(session.currentDraft()).toBe(draft.id);
    expect(session.currentFormContext()).toEqual({
      mode: "edit",
      recordId: "record-existing",
      base,
    });
    expect(session.orphanedEditCount).toBe(0);
  });

  it("新建草稿的页面立即持有占用", async () => {
    const store = new FakeDraftStore();
    const claim = new FakeClaim();
    const { session } = createSession(store, { claim });
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "record-1", base: null });
    session.updateDraft(draftValues([["stationName", "某站"]]));

    const draftId = session.currentDraft() ?? "";
    expect(draftId).not.toBe("");
    await vi.waitFor(() => expect(claim.held.has(draftId)).toBe(true));
  });

  it("清理失败但留下标记的编辑草稿不再恢复", async () => {
    const store = new FakeDraftStore();
    const base = recordFixture("record-marked");
    const draft: StoredRefuelingDraft = {
      ...storedCreateDraft("marked-edit"),
      mode: "edit",
      recordId: base.id,
      base,
      savedAt: T0,
    };
    store.entries.set(draft.id, draft);
    const knownRecords = new Map([[base.id, base]]);
    const { session } = createSession(store, { knownRecords });

    await session.initialize();
    expect(store.entries.size).toBe(0);
    expect(session.recovery).toMatchObject({ status: "ready", candidates: [] });
  });

  it("改动已经体现在记录里的编辑草稿（保存后未清理）按已保存处理", async () => {
    const store = new FakeDraftStore();
    const base = recordFixture("record-equal");
    // 草稿内容与记录完全一致：保存事务已完成，只是页面没走到清理
    const draft: StoredRefuelingDraft = {
      ...storedCreateDraft("equal-edit"),
      mode: "edit",
      recordId: base.id,
      base,
      values: createDraft(base, new Date("2026-08-08T14:49:42Z")).values,
      savedAt: null,
    };
    store.entries.set(draft.id, draft);
    const knownRecords = new Map([[base.id, base]]);
    const { session } = createSession(store, { knownRecords });

    await session.initialize();
    expect(store.entries.size).toBe(0);
  });

  it("保存后其他窗口改了别的字段时仍按已保存处理", async () => {
    const store = new FakeDraftStore();
    const base = recordFixture("record-merged");
    // 本窗口草稿只改了加油站，保存成功后另一个窗口改了油品
    const draft: StoredRefuelingDraft = {
      ...storedCreateDraft("merged-edit"),
      mode: "edit",
      recordId: base.id,
      base,
      values: updateDraft(
        createDraft(base, new Date("2026-08-08T14:49:42Z")),
        "stationName",
        "本窗口改的站点",
      ).values,
      savedAt: null,
    };
    store.entries.set(draft.id, draft);
    const knownRecords = new Map([
      [base.id, { ...base, stationName: "本窗口改的站点", fuelGrade: "别的窗口改的油品" }],
    ]);
    const { session } = createSession(store, { knownRecords });

    await session.initialize();
    expect(store.entries.size).toBe(0);
    expect(session.recovery).toMatchObject({ status: "ready", candidates: [] });
  });

  it("草稿改动还没进入记录时保留草稿（不猜已保存）", async () => {
    const store = new FakeDraftStore();
    const base = recordFixture("record-changed");
    const changed = { ...base, stationName: "别的窗口改过" };
    const draft: StoredRefuelingDraft = {
      ...storedCreateDraft("changed-edit"),
      mode: "edit",
      recordId: base.id,
      base,
      values: updateDraft(
        createDraft(base, new Date("2026-08-08T14:49:42Z")),
        "stationName",
        "本窗口未保存的修改",
      ).values,
      savedAt: null,
    };
    store.entries.set(draft.id, draft);
    const knownRecords = new Map([[base.id, changed]]);
    const { session } = createSession(store, { knownRecords });

    await session.initialize();
    expect(store.entries.size).toBe(1);
    expect(session.recovery).toMatchObject({ status: "ready" });
    if (session.recovery.status !== "ready") throw new Error("状态错误");
    expect(session.recovery.candidates.map((entry) => entry.id)).toEqual([draft.id]);
  });

  it("找不到对应记录的编辑草稿保留但不提供恢复", async () => {
    const store = new FakeDraftStore();
    const orphan: StoredRefuelingDraft = {
      ...storedCreateDraft("orphan"),
      mode: "edit",
      recordId: "record-missing",
    };
    store.entries.set(orphan.id, orphan);
    const { session } = createSession(store);

    await session.initialize();
    expect(session.orphanedEditCount).toBe(1);
    expect(session.recovery).toEqual({ status: "ready", candidates: [], notice: "" });
    expect(store.entries.size).toBe(1);
  });

  it("定位线索命中且未被占用时自动恢复", async () => {
    const store = new FakeDraftStore();
    const draft = storedCreateDraft("mine");
    store.entries.set(draft.id, draft);
    const locator = createMemoryLocatorStorage();
    locator.set("hako-refueling-draft-locator", draft.id);
    const { session } = createSession(store, { locator });

    await session.initialize();
    expect(session.currentDraft()).toBe(draft.id);
    expect(session.currentFormContext()).toEqual({
      mode: "create",
      recordId: draft.recordId,
      base: null,
    });
  });

  it("线索对应的草稿被其他活跃页面占用时不领取", async () => {
    const store = new FakeDraftStore();
    const draft = storedCreateDraft("other-window");
    store.entries.set(draft.id, draft);
    const locator = createMemoryLocatorStorage();
    locator.set("hako-refueling-draft-locator", draft.id);
    const claim = new FakeClaim();
    claim.foreign.add(draft.id);
    const { session } = createSession(store, { locator, claim });

    await session.initialize();
    expect(session.currentDraft()).toBeNull();
    expect(session.recovery).toMatchObject({ status: "ready", candidates: [] });
    expect(store.entries.size).toBe(1);
  });

  it("没有线索时提供按时间排序的恢复/放弃候选", async () => {
    const store = new FakeDraftStore();
    store.entries.set("older", storedCreateDraft("older", T0));
    store.entries.set("newer", storedCreateDraft("newer", T0 + 60_000));
    const { session } = createSession(store);

    await session.initialize();
    expect(session.recovery).toMatchObject({ status: "ready" });
    if (session.recovery.status !== "ready") throw new Error("状态错误");
    expect(session.recovery.candidates.map((draft) => draft.id)).toEqual(["newer", "older"]);
  });

  it("无法原子占用时不恢复（其他窗口正在使用）", async () => {
    const store = new FakeDraftStore();
    const draft = storedCreateDraft("contended");
    store.entries.set(draft.id, draft);
    const claim = new FakeClaim();
    const { session } = createSession(store, { claim });
    claim.tryClaimResult = false;

    expect(await session.adopt(draft.id)).toBeNull();
    expect(session.currentDraft()).toBeNull();
    expect(store.entries.size).toBe(1);
  });

  it("用户明确放弃后草稿被删除且不再提示", async () => {
    const store = new FakeDraftStore();
    const draft = storedCreateDraft("discard-me");
    store.entries.set(draft.id, draft);
    const claim = new FakeClaim();
    const { session } = createSession(store, { claim });

    await session.initialize();
    expect(await session.discard(draft.id)).toBe("discarded");
    expect(store.entries.size).toBe(0);
    expect(claim.held.size).toBe(0);
  });

  it("无法原子占用时不删除草稿（其他窗口正在使用）", async () => {
    const store = new FakeDraftStore();
    const draft = storedCreateDraft("held-elsewhere");
    store.entries.set(draft.id, draft);
    const claim = new FakeClaim();
    const { session } = createSession(store, { claim });
    // 恢复列表只是快照：放弃时占用已被其他页面拿走
    claim.foreign.add(draft.id);

    expect(await session.discard(draft.id)).toBe("held");
    expect(store.entries.size).toBe(1);
    expect(await session.discard(draft.id)).toBe("held");
  });

  it("真实 Web Locks 占用：探测、接管与失败后的保守判断", async () => {
    // Node 提供真实的 navigator.locks；两个 claim 相当于两个标签页
    const pageA = createWebLocksPageClaim(navigator.locks);
    const pageB = createWebLocksPageClaim(navigator.locks);
    const draftId = `locks-${crypto.randomUUID()}`;

    expect(await pageA.tryClaim(draftId)).toBe(true);
    expect(await pageA.isHeldByAnotherPage(draftId)).toBe(false);
    // 探测必须识别出别的页面正持有（ifAvailable 拿不到锁时回调收到 null）
    expect(await pageB.isHeldByAnotherPage(draftId)).toBe(true);
    expect(await pageB.tryClaim(draftId)).toBe(false);

    pageA.release(draftId);
    await vi.waitFor(async () => expect(await pageB.isHeldByAnotherPage(draftId)).toBe(false));
    expect(await pageB.tryClaim(draftId)).toBe(true);
    pageB.release(draftId);

    // 锁 API 出错时按“可能被占用”处理，不能当作无人使用
    const broken = createWebLocksPageClaim({
      request: () => Promise.reject(new Error("locks unavailable")),
      query: async () => ({ held: [], pending: [] }),
    } as unknown as LockManager);
    expect(await broken.isHeldByAnotherPage("draft-x")).toBe(true);
    expect(await broken.tryClaim("draft-x")).toBe(false);
  });

  it("切换表单后仍持有占用，其他页面不能在补写完成前接管", async () => {
    const store = new FakeDraftStore();
    const pageA = createWebLocksPageClaim(navigator.locks);
    const pageB = createWebLocksPageClaim(navigator.locks);
    const a = createSession(store, { claim: pageA });
    await a.session.initialize();
    a.session.attachForm({ mode: "create", recordId: "record-a", base: null });
    a.session.updateDraft(draftValues([["stationName", "初次输入"]]));
    expect(await a.session.flush()).toBe(true);
    const draftId = a.session.currentDraft() ?? "";
    expect(draftId).not.toBe("");

    // 第二次输入写入失败：内容仍在待写队列，占用必须继续持有
    store.failPuts = true;
    a.session.updateDraft(draftValues([["stationName", "A 未写完的输入"]]));
    expect(await a.session.flush()).toBe(false);
    // 即使切换表单离开这份草稿，其他页面也不能接管
    a.session.attachForm({ mode: "create", recordId: "record-a2", base: null });
    expect(a.session.currentFormContext()?.recordId).toBe("record-a2");

    const b = createSession(store, { claim: pageB });
    await b.session.initialize();
    expect(await b.session.adopt(draftId)).toBeNull();
    expect(b.session.recovery).toMatchObject({ status: "ready", candidates: [] });

    // 存储恢复后旧页面补写成功并释放占用，之后其他页面才能接管
    store.failPuts = false;
    expect(await a.session.flush()).toBe(true);
    expect(await b.session.adopt(draftId)).not.toBeNull();
    expect(store.entries.get(draftId)?.values.stationName).toBe("A 未写完的输入");
    a.session.close();
    b.session.close();
  });

  it("在途写入结算前不释放占用", async () => {
    const store = new FakeDraftStore();
    const pageA = createWebLocksPageClaim(navigator.locks);
    const pageB = createWebLocksPageClaim(navigator.locks);
    let releaseWrite: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    store.beforePut = () => gate;

    const a = createSession(store, { claim: pageA });
    await a.session.initialize();
    a.session.attachForm({ mode: "create", recordId: "record-inflight", base: null });
    a.session.updateDraft(draftValues([["stationName", "在途输入"]]));
    const draftId = a.session.currentDraft() ?? "";

    a.session.attachForm({ mode: "create", recordId: "record-next", base: null });
    expect(await pageB.tryClaim(draftId)).toBe(false);

    releaseWrite();
    expect(await a.session.flush()).toBe(true);
    expect(await pageB.tryClaim(draftId)).toBe(true);
    pageB.release(draftId);
    a.session.close();
  });

  it("其他真实页面持有的草稿不会被列出，也不会被放弃操作删除", async () => {
    const draftId = `hosted-${crypto.randomUUID()}`;
    const pageA = createWebLocksPageClaim(navigator.locks);
    const pageB = createWebLocksPageClaim(navigator.locks);
    expect(await pageA.tryClaim(draftId)).toBe(true);

    const store = new FakeDraftStore();
    const draft: StoredRefuelingDraft = { ...storedCreateDraft(draftId), id: draftId };
    store.entries.set(draftId, draft);
    const locator = createMemoryLocatorStorage();
    locator.set("hako-refueling-draft-locator", draftId);
    const { session } = createSession(store, { locator, claim: pageB });

    await session.initialize();
    expect(session.currentDraft()).toBeNull();
    expect(session.recovery).toMatchObject({ status: "ready", candidates: [] });
    expect(await session.discard(draftId)).toBe("held");
    expect(store.entries.has(draftId)).toBe(true);
    pageA.release(draftId);
  });

  it("释放占用后其他页面可以接管同一份草稿", async () => {
    const store = new FakeDraftStore();
    const draft = storedCreateDraft("shared");
    store.entries.set(draft.id, draft);
    const first = createSession(store);
    await first.session.initialize();
    expect(await first.session.adopt(draft.id)).not.toBeNull();

    // 关闭第一个页面后，占用被释放
    first.session.close();
    const second = createSession(store);
    await second.session.initialize();
    expect(second.session.recovery.status).toBe("ready");
  });
});

describe("保留内容带回后的草稿上下文持久化（R9 二轮）", () => {
  it("带回绑定的编辑上下文随输入落盘：重开恢复为同记录编辑草稿，不误当新增", async () => {
    // 保留记录带回后的表单：attachForm 绑定当前记录与当前基线（非旧随机 ID/新增）。
    const store = new FakeDraftStore();
    const current = recordFixture("one");
    const { session } = createSession(store, { knownRecords: new Map([["one", current]]) });
    await session.initialize();
    session.attachForm({ mode: "edit", recordId: "one", base: current });
    const draft = draftValues([["stationName", "retained input"]]);
    session.updateDraft(draft);
    expect(await session.flush()).toBe(true);

    // 落盘的草稿属于编辑 one、基线为当前记录；关闭重开（新会话）可恢复同一上下文。
    const stored = [...store.entries.values()].at(-1)!;
    expect(stored.mode).toBe("edit");
    expect(stored.recordId).toBe("one");
    expect(stored.base).toMatchObject({ id: "one" });
    const { session: reopened } = createSession(store, { knownRecords: new Map([["one", current]]) });
    await reopened.initialize();
    const adopted = await reopened.adopt(stored.id);
    expect(adopted).not.toBeNull();
    expect(adopted).toMatchObject({ mode: "edit", recordId: "one" });
    // 恢复后继续输入仍写入同一份草稿（不生成第二份）。
    reopened.updateDraft(updateDraft(draft, "stationName", "retained input 2"));
    expect(await reopened.flush()).toBe(true);
    expect(store.entries.size).toBe(1);
    session.close();
    reopened.close();
  });

  it("带回新记录（记录不存在）时落盘为新增草稿：重开不误绑旧记录基线", async () => {
    const store = new FakeDraftStore();
    const { session } = createSession(store);
    await session.initialize();
    session.attachForm({ mode: "create", recordId: "fresh-id", base: null });
    session.updateDraft(draftValues([["stationName", "retained input"]]));
    expect(await session.flush()).toBe(true);
    const stored = [...store.entries.values()].at(-1)!;
    expect(stored.mode).toBe("create");
    expect(stored.recordId).toBe("fresh-id");
    expect(stored.base).toBeNull();
    session.close();
  });
});
