import { isAccountId, isDocumentGeneration } from "../shared/sync-protocol";

/** 旧正式账号库名（v1）：A 只读取用于迁移，不再写入；原样保留。 */
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

/**
 * v2 账号库名（代次兼容基础）：记录库按账号、草稿库/锁/广播按账号+代次隔离。
 * 统一锁顺序为「旧 v1 文档锁（仅迁移读取）→ v2 账号控制锁 → v2 代次文档锁」，
 * 禁止反向嵌套。
 */
export function accountStorageNamesV2(accountId: string) {
  if (!isAccountId(accountId)) throw new Error("账号存储标识无效");
  const prefix = `hako-account-v2:${accountId}`;
  const scoped = (generation: string) => {
    if (!isDocumentGeneration(generation)) throw new Error("文档代次标识无效");
    return `${prefix}:${generation}`;
  };
  return {
    records: `${prefix}:refueling`,
    controlLock: `${prefix}:control`,
    documentLockFor: (generation: string) => `${scoped(generation)}:document`,
    draftsFor: (generation: string) => `${scoped(generation)}:drafts`,
    changesFor: (generation: string) => `${scoped(generation)}:changes`,
    draftScopeFor: (generation: string) => `${scoped(generation)}:`,
  };
}
