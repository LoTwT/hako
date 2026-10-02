// 草稿接线测试：草稿库打开完成前收到的输入不能丢，也不能让登录跳转
// 在草稿未落盘时放行。

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountStorageNames } from "../src/data/account-storage";
import { useRefuelingDrafts } from "../src/composables/useRefuelingDrafts";
import { createDraft, updateDraft } from "../src/domain/refueling/form";

function createDrafts() {
  return useRefuelingDrafts({ accountId: "00000000-0000-4000-8000-000000000001", knownRecords: () => new Map() });
}

beforeEach(() => {
  // 组合式函数在组件外调用时 Vue 会提示缺少实例；这里不需要实例
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await deleteDB(accountStorageNames("00000000-0000-4000-8000-000000000001").drafts);
  vi.restoreAllMocks();
});

describe("草稿接线", () => {
  it("会话建立前收到的输入在就绪后补写，并可经 flush 确认落盘", async () => {
    const drafts = createDrafts();
    drafts.attachForm({ mode: "create", recordId: "record-early", base: null });
    const typed = updateDraft(
      updateDraft(createDraft(undefined, new Date("2026-10-02T00:00:00Z")), "stationName", "早输入"),
      "amountPaidCents",
      "100.00",
    );

    // 草稿库还没打开：此时不能谎报已落盘
    drafts.updateDraft(typed);
    await expect(drafts.flush()).resolves.toBe(false);

    await drafts.initialize();
    await expect(drafts.flush()).resolves.toBe(true);
    const stored = await drafts.adopt(drafts.currentDraftId() ?? "");
    expect(stored?.values.stationName).toBe("早输入");
    expect(stored?.values.amountPaidCents).toBe("100.00");
    await drafts.discard(stored?.id ?? "");
  });

  it("就绪前没有输入时 flush 不阻塞，且不会凭空写入草稿", async () => {
    const drafts = createDrafts();
    drafts.attachForm({ mode: "create", recordId: "record-empty", base: null });
    await drafts.initialize();
    await expect(drafts.flush()).resolves.toBe(true);
    expect(drafts.currentDraftId()).toBeNull();
  });
});
