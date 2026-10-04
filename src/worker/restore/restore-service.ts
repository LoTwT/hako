// 恢复服务（A 版本）：提交入口只做鉴权、账号匹配与 requestId 查重——
// 已有同指纹回执返回 committed（持久边界），不同指纹返回 request_id_conflict，
// 无回执返回 unknown；不执行恢复切换，也不为判定终态删除任何预览。
// B 的切换实现复用同一回执表与查重语义，先查重后切换。

import type { HakoAccountState } from "../auth/account-state";
import type { AccountDocuments } from "../sync/account-documents";
import type {
  ReadRestoreReceiptInput,
  ReadRestoreReceiptResult,
  SubmitRestoreInput,
  SubmitRestoreResult,
} from "../auth/account-rpc";
import type { RestoreStore } from "./restore-store";

export class RestoreService {
  constructor(
    private readonly sessions: HakoAccountState,
    private readonly documents: AccountDocuments,
    private readonly store: RestoreStore,
  ) {}

  /** A 的恢复 POST：先鉴权与账号匹配，再按 requestId 查回执；无任何写入。 */
  submit(input: SubmitRestoreInput): SubmitRestoreResult {
    if (this.sessions.readSession(input) === null) return { ok: false, error: "unauthorized" };
    const accountId = this.documents.findAccountId(input.identity);
    if (accountId === null || accountId !== input.expectedAccountId) {
      return { ok: false, error: "account_changed" };
    }
    const receipt = this.store.findReceipt(accountId, input.requestId);
    if (receipt !== null) {
      if (receipt.requestFingerprint === input.requestFingerprint) {
        return { ok: true, outcome: "committed", receipt };
      }
      return { ok: true, outcome: "request_id_conflict" };
    }
    // 无回执：不能证明确定未执行（预览仍可能被 B 执行），按 unknown 处理。
    return { ok: true, outcome: "unknown" };
  }

  /** 回执只读查询：不存在返回 receipt=null（HTTP 404），不证明请求未提交。 */
  read(input: ReadRestoreReceiptInput): ReadRestoreReceiptResult {
    if (this.sessions.readSession(input) === null) return { ok: false, error: "unauthorized" };
    const accountId = this.documents.findAccountId(input.identity);
    if (accountId === null || accountId !== input.expectedAccountId) {
      return { ok: false, error: "account_changed" };
    }
    return { ok: true, receipt: this.store.findReceipt(accountId, input.requestId) };
  }
}
