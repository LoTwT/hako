import { isAccountId } from "../shared/sync-protocol";

export function accountStorageNames(accountId: string) {
  if (!isAccountId(accountId)) throw new Error("账号存储标识无效");
  const prefix = `hako-account-v1:${accountId}`;
  return {
    records: `${prefix}:refueling`,
    drafts: `${prefix}:drafts`,
    documentLock: `${prefix}:document`,
    changes: `${prefix}:changes`,
    draftScope: `${prefix}:`,
  };
}
