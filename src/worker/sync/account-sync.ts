import { InvalidSyncDocument } from "../../data/sync-document";
import type { HakoAccountState, AccountStateStorage } from "../auth/account-state";
import type { ReadHakoSessionInput, SyncRefuelingInput, SyncRefuelingResult } from "../auth/account-rpc";
import { SESSION_RENEWAL_INTERVAL_MS, SESSION_TTL_MS } from "../auth/session-policy";
import { AccountDocuments } from "./account-documents";

/** DO 的同步段：检查、合并、续期之间不让出执行权；运行时包装随后等待落盘。 */
export class AccountSync {
  private readonly documents: AccountDocuments;
  constructor(storage: AccountStateStorage, private readonly sessions: HakoAccountState) {
    this.documents = new AccountDocuments(storage);
  }
  readAccountId(input: ReadHakoSessionInput): string | null {
    if (this.sessions.readSession(input) === null) return null;
    return this.documents.resolveAccountId(input.identity);
  }
  exchange(input: SyncRefuelingInput): SyncRefuelingResult {
    const accountId = this.readAccountId(input);
    if (accountId === null) return { ok: false, error: "unauthorized" };
    if (accountId !== input.expectedAccountId) return { ok: false, error: "account_changed" };
    let snapshot: Uint8Array;
    try { snapshot = this.documents.merge(accountId, input.snapshot); }
    catch (error) {
      if (error instanceof InvalidSyncDocument) return { ok: false, error: "invalid_document" };
      if (error instanceof Error && error.message === "document_too_large") return { ok: false, error: "document_too_large" };
      throw error;
    }
    this.sessions.renewSessionIfDue({
      ...input, sessionTtlMs: SESSION_TTL_MS, renewalIntervalMs: SESSION_RENEWAL_INTERVAL_MS,
    });
    return { ok: true, accountId, snapshot };
  }
}
