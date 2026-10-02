// 浏览器侧草稿环境：sessionStorage 定位线索与 Web Locks 页面占用。
// 定位线索只是“这一页此前用过哪份草稿”的提示：关闭标签页会被清理，
// 复制标签页可能复制初始值，因此不能作为唯一载体；占用只能由
// Web Locks 的原子获取结果决定（应用本身已经依赖 Web Locks 做安全写入）。
// locks.query() 返回锁管理器快照；快照不是原子依据，不能支撑恢复/删除/清理
// 决定，危险操作必须在操作时用 ifAvailable 重新占用并检查 lock === null。

export interface DraftLocatorStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const draftClaimPrefix = "hako-refueling-draft:";

export function draftClaimName(draftId: string): string {
  return `${draftClaimPrefix}${draftId}`;
}

/** sessionStorage 包装；不可用时退回进程内内存，页面仍能工作但失去重载线索。 */
export function createSessionLocatorStorage(): DraftLocatorStorage {
  const memory = new Map<string, string>();
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
    const probe = "__hako_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
  } catch {
    storage = null;
  }
  const fallback: DraftLocatorStorage = {
    get: (key) => memory.get(key) ?? null,
    set: (key, value) => void memory.set(key, value),
    remove: (key) => void memory.delete(key),
  };
  if (storage === null) return fallback;
  const session = storage;
  return {
    get(key) {
      try {
        return session.getItem(key);
      } catch {
        return fallback.get(key);
      }
    },
    set(key, value) {
      try {
        session.setItem(key, value);
      } catch {
        fallback.set(key, value);
      }
    },
    remove(key) {
      try {
        session.removeItem(key);
      } catch {
        fallback.remove(key);
      }
    },
  };
}

export function createMemoryLocatorStorage(): DraftLocatorStorage {
  const memory = new Map<string, string>();
  return {
    get: (key) => memory.get(key) ?? null,
    set: (key, value) => void memory.set(key, value),
    remove: (key) => void memory.delete(key),
  };
}

export interface DraftPageClaim {
  /**
   * 只读探测：该草稿是否正被其他页面持有。结果只用于展示与筛选，
   * 危险操作（恢复、删除、清理）必须在操作时重新原子占用。
   */
  isHeldByAnotherPage(draftId: string): Promise<boolean>;
  /** 原子占用；返回 false 表示已被其他页面持有。 */
  tryClaim(draftId: string): Promise<boolean>;
  release(draftId: string): void;
  releaseAll(): void;
}

/** 基于 Web Locks 的页面占用：页面关闭或崩溃时浏览器自动释放。 */
export function createWebLocksPageClaim(locks: LockManager = navigator.locks): DraftPageClaim {
  const held = new Map<string, () => void>();
  return {
    async isHeldByAnotherPage(draftId) {
      if (held.has(draftId)) return false;
      // 用 ifAvailable 原子探测：拿到锁说明无人持有，立即释放；
      // 拿不到锁时回调收到 null，说明别的页面正持有。
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        void locks
          .request(draftClaimName(draftId), { ifAvailable: true }, (lock) => {
            finish(lock === null);
          })
          .catch(() => {
            // 锁 API 不可用或文档状态异常：无法确认时按“可能被占用”处理
            finish(true);
          });
      });
    },
    async tryClaim(draftId) {
      if (held.has(draftId)) return true;
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        void locks
          .request(draftClaimName(draftId), { ifAvailable: true }, async (lock) => {
            if (lock === null) {
              settled = true;
              resolve(false);
              return;
            }
            await new Promise<void>((releaseLock) => {
              held.set(draftId, releaseLock);
              settled = true;
              resolve(true);
            });
            held.delete(draftId);
          })
          .catch(() => {
            if (!settled) {
              settled = true;
              resolve(false);
            }
          });
      });
    },
    release(draftId) {
      held.get(draftId)?.();
      held.delete(draftId);
    },
    releaseAll() {
      for (const release of [...held.values()]) release();
      held.clear();
    },
  };
}

/** 无 Web Locks 环境（理论不可达）或测试用：不阻止任何占用。 */
export function createUnclaimedPageClaim(): DraftPageClaim {
  return {
    isHeldByAnotherPage: async () => false,
    tryClaim: async () => true,
    release: () => undefined,
    releaseAll: () => undefined,
  };
}
