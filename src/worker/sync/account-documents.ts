import { LoroDoc } from "loro-crdt/web";
import { exportSyncSnapshot, importSyncSnapshot } from "../../data/sync-document";
import type { AccountStateRow, AccountStateStorage, HakoIdentity } from "../auth/account-state";
import { parseGenerationOrigin, serializeGenerationOrigin, type GenerationOrigin } from "../../shared/document-generation";

interface AccountIdRow extends AccountStateRow { account_id: string }
interface SnapshotChunkRow extends AccountStateRow { snapshot: ArrayBuffer; document_generation: string | null }
interface HeadRow extends AccountStateRow {
  account_id: string;
  current_generation: string;
  legacy_generation: string;
  origin_kind: string;
  restore_origin: string | null;
  switched_at_ms: number;
}
const CHUNK_BYTES = 512 * 1024;

/** 文档代次的持久状态；每个账号至多一行，legacyGeneration 一经记录不再改变。 */
export interface DocumentGenerationHead {
  accountId: string;
  currentGeneration: string;
  legacyGeneration: string;
  origin: GenerationOrigin;
  switchedAtMs: number;
}

/** 主分块/冻结任务/完成缓存已带现代代次痕迹但 head 缺失等不可解释状态。 */
export class GenerationStateUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`generation_state_unavailable: ${detail}`);
    this.name = "GenerationStateUnavailableError";
  }
}

/** 合并结果；preMergeSnapshot 仅在启用基线需要时物化，避免每次同步复制整包。 */
export interface MergeOutcome {
  snapshot: Uint8Array;
  /** 合并前后 OpLog 版本向量是否推进（有已存储文档时才计算）。 */
  historyAdvanced: boolean;
  /** 本次是否首次持久保存服务端文档（空客户端快照也会创建）。 */
  documentCreated: boolean;
  preMergeSnapshot: Uint8Array | null;
}

/** 与既有会话同库、独立表；不迁移或删除登录事务/会话。 */
export class AccountDocuments {
  constructor(private readonly storage: AccountStateStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS account_data_ids (
      issuer TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (issuer, subject))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS refueling_snapshots (
      account_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, snapshot BLOB NOT NULL,
      PRIMARY KEY (account_id, chunk_index))`);
    // 增量补列：升级前的分块为 NULL（legacy），升级时与 head 同事务绑定 G0。
    ensureColumn(storage, "refueling_snapshots", "document_generation", "TEXT");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS refueling_document_heads (
      account_id TEXT PRIMARY KEY,
      current_generation TEXT NOT NULL,
      legacy_generation TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      restore_origin TEXT,
      switched_at_ms INTEGER NOT NULL
    )`);
  }

  /** 仅在调用方刚验证有效会话后使用；随机 ID 不派生自真实 subject。 */
  resolveAccountId(identity: HakoIdentity): string {
    const existing = this.storage.sql.exec<AccountIdRow>(
      "SELECT account_id FROM account_data_ids WHERE issuer = ? AND subject = ?",
      identity.issuer, identity.subject,
    ).toArray()[0];
    if (existing) return existing.account_id;
    const accountId = crypto.randomUUID();
    this.storage.sql.exec("INSERT INTO account_data_ids VALUES (?, ?, ?)", identity.issuer, identity.subject, accountId);
    return accountId;
  }

  /** 只读身份映射查询；无映射时不创建，供只读状态接口使用。 */
  findAccountId(identity: HakoIdentity): string | null {
    return this.storage.sql.exec<AccountIdRow>(
      "SELECT account_id FROM account_data_ids WHERE issuer = ? AND subject = ?",
      identity.issuer, identity.subject,
    ).toArray()[0]?.account_id ?? null;
  }

  /** 只读 head；无 head 返回 null，不初始化、不修复。 */
  readDocumentHead(accountId: string): DocumentGenerationHead | null {
    const row = this.storage.sql.exec<HeadRow>(
      "SELECT * FROM refueling_document_heads WHERE account_id = ?", accountId,
    ).toArray()[0];
    if (row === undefined) return null;
    if (row.origin_kind === "initial") {
      return { accountId, currentGeneration: row.current_generation, legacyGeneration: row.legacy_generation, origin: { kind: "initial" }, switchedAtMs: row.switched_at_ms };
    }
    if (row.origin_kind !== "restore" || row.restore_origin === null) {
      // 不可解释的来源：视为状态不可用，而不是猜测或改写。
      throw new GenerationStateUnavailableError("head_origin_unreadable");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(row.restore_origin); } catch { throw new GenerationStateUnavailableError("head_origin_unreadable"); }
    const origin = parseGenerationOrigin(parsed);
    if (origin === null || origin.kind !== "restore") throw new GenerationStateUnavailableError("head_origin_unreadable");
    return {
      accountId,
      currentGeneration: row.current_generation,
      legacyGeneration: row.legacy_generation,
      origin,
      switchedAtMs: row.switched_at_ms,
    };
  }

  /**
   * 受控且幂等的代次初始化：必须在外层事务内调用（bootstrap、同步合并点、备份捕获共用）。
   * - 已有 head：直接返回（并发 bootstrap 复用已提交的同一个 G0）。
   * - 无主文档、无备份痕迹的干净账号：创建 origin=initial 的 G0。
   * - 仅有 legacy 分块（document_generation 为 NULL）且无现代代次痕迹：创建 G0 并
   *   在同一事务把分块绑定到 G0。
   * - 分块已带代次、冻结任务/完成缓存已带现代代次、或分块混代而 head 缺失：
   *   抛出 GenerationStateUnavailableError，不随机补建 G0。
   * 初始化不等待 R2，也不改原始快照字节、revision 或已冻结任务。
   */
  ensureDocumentGeneration(accountId: string, nowMs: number = Date.now()): DocumentGenerationHead {
    const existing = this.readDocumentHead(accountId);
    if (existing !== null) return existing;
    const chunkGenerations = this.storage.sql.exec<AccountStateRow & { document_generation: string | null; total: number }>(
      "SELECT document_generation, count(*) AS total FROM refueling_snapshots WHERE account_id = ? GROUP BY document_generation",
      accountId,
    ).toArray();
    const modernGenerationTraces = this.hasModernBackupGenerationTrace(accountId);
    if (chunkGenerations.some((row) => row.document_generation !== null) || modernGenerationTraces) {
      throw new GenerationStateUnavailableError("modern_generation_without_head");
    }
    const generation = crypto.randomUUID();
    this.storage.sql.exec(
      `INSERT INTO refueling_document_heads
         (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
       VALUES (?, ?, ?, 'initial', NULL, ?)`,
      accountId, generation, generation, nowMs,
    );
    if (chunkGenerations.length > 0) {
      // 与 head 同事务把既有 legacy 分块绑定到 G0；不改快照字节本身。
      this.storage.sql.exec(
        "UPDATE refueling_snapshots SET document_generation = ? WHERE account_id = ?",
        generation, accountId,
      );
    }
    return { accountId, currentGeneration: generation, legacyGeneration: generation, origin: { kind: "initial" }, switchedAtMs: nowMs };
  }

  /** B 的恢复切换在同一事务调用：创建新代次并登记 restore 来源；旧代次永不复用。 */
  switchDocumentGeneration(accountId: string, origin: Extract<GenerationOrigin, { kind: "restore" }>, nowMs: number = Date.now()): DocumentGenerationHead {
    const existing = this.readDocumentHead(accountId);
    if (existing === null) throw new GenerationStateUnavailableError("head_missing_at_switch");
    const generation = crypto.randomUUID();
    this.storage.sql.exec(
      `INSERT OR REPLACE INTO refueling_document_heads
         (account_id, current_generation, legacy_generation, origin_kind, restore_origin, switched_at_ms)
       VALUES (?, ?, ?, 'restore', ?, ?)`,
      accountId, generation, existing.legacyGeneration, serializeGenerationOrigin(origin), nowMs,
    );
    return { accountId, currentGeneration: generation, legacyGeneration: existing.legacyGeneration, origin, switchedAtMs: nowMs };
  }

  /**
   * 恢复切换在同一事务内用已验证的暂存快照整体替换主分块：删除旧分块、按 512 KiB
   * 重新分块并以新代次标签写入。恢复专用替换不调用 merge()，也不把「历史向量推进」
   * 当作恢复成功条件；旧代次字节不再保留在主表（旧副本由 R2 备份与本机保留副本承担）。
   */
  replaceMainSnapshot(accountId: string, generation: string, snapshot: Uint8Array): void {
    this.storage.sql.exec("DELETE FROM refueling_snapshots WHERE account_id = ?", accountId);
    for (let offset = 0; offset < snapshot.byteLength; offset += CHUNK_BYTES) {
      this.storage.sql.exec(
        "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, ?, ?, ?)",
        accountId, offset / CHUNK_BYTES, snapshot.slice(offset, offset + CHUNK_BYTES).buffer, generation,
      );
    }
  }

  hasSnapshot(accountId: string): boolean {
    return this.storage.sql.exec<AccountStateRow>(
      "SELECT account_id FROM refueling_snapshots WHERE account_id = ? LIMIT 1",
      accountId,
    ).toArray().length > 0;
  }

  /**
   * 读取主分块并核对每块的代次与 head 一致；用于发现 head 丢失、分块混代等残缺状态。
   * 返回 null 表示没有主文档（bootstrap 的代次信息仍有效）。
   * 全 NULL 标签只在可证明的 legacy 边界（期望代次即 legacyGeneration，即部署回退
   * 窗口旧版本整批写入的 G0 当前文档）内接受；恢复代次或未知代次下的 NULL 不可
   * 解释，一律拒绝，不能把这些字节当作当前代次读取或重新贴标签。
   */
  readSnapshotBytesForGeneration(accountId: string, expectedGeneration: string): Uint8Array | null {
    const chunks = this.readSnapshotChunks(accountId, expectedGeneration);
    if (chunks === null) return null;
    return joinChunks(chunks);
  }

  /**
   * 只核对分块代次标签是否可证明属于期望代次（不加载快照字节）：
   * 全部分块标签等于期望代次，或全部为 NULL 且期望代次等于 head 的 legacyGeneration
   * （legacy G0 回退窗口）。混排、异代或无 head 均不可解释。捕获、同步/GET 与覆盖
   * 判断共用这一规则；不可解释时保留责任/对象并失败或 blocked，不能发出新对象。
   */
  snapshotGenerationExplainable(accountId: string, expectedGeneration: string): boolean {
    const head = this.readDocumentHead(accountId);
    if (head === null) return false;
    return this.snapshotLabelsExplainable(accountId, expectedGeneration, head);
  }

  /**
   * 只核对分块代次标签（调用方已持有 head，避免重复读取）：全部标签等于期望代次，
   * 或全为 NULL 且期望代次等于该 head 的 legacyGeneration（legacy G0 回退窗口）。
   */
  snapshotLabelsExplainable(accountId: string, expectedGeneration: string, head: DocumentGenerationHead): boolean {
    const rows = this.storage.sql.exec<AccountStateRow & { document_generation: string | null }>(
      "SELECT document_generation FROM refueling_snapshots WHERE account_id = ?",
      accountId,
    ).toArray();
    if (rows.length === 0) return false;
    const labels = new Set(rows.map((row) => row.document_generation));
    if (labels.size > 1) return false;
    const label = [...labels][0];
    if (label === expectedGeneration) return true;
    return label === null && expectedGeneration === head.legacyGeneration;
  }

  /**
   * 宽容读取主分块（不校验代次标签）：备份覆盖核对/状态等 legacy 账号仍需读取；
   * 同步合并与快照读取使用 readSnapshotBytesForGeneration 的严格校验。
   */
  readSnapshotBytes(accountId: string): Uint8Array | null {
    const rows = this.storage.sql.exec<SnapshotChunkRow>(
      "SELECT snapshot, document_generation FROM refueling_snapshots WHERE account_id = ? ORDER BY chunk_index",
      accountId,
    ).toArray();
    if (rows.length === 0) return null;
    return joinChunks(rows.map((row) => new Uint8Array(row.snapshot)));
  }

  /**
   * 同步段内读取、合并和切换所有分块。本方法不拥有事务边界：
   * 授权→代次→合并→待备责任→续期由 AccountSync 的外层事务统一提交或回滚；
   * 不把失败候选留在实例内存。写入显式列名并保存同一代次。
   */
  merge(accountId: string, generation: string, incoming: Uint8Array, options?: { capturePreMergeSnapshot?: boolean }): MergeOutcome {
    const candidate = new LoroDoc();
    const remote = new LoroDoc();
    try {
      // 独立校验提交的完整副本，不能靠现有文档掩盖缺依赖/非法记录。
      importSyncSnapshot(remote, incoming);
      const chunks = this.readSnapshotChunks(accountId, generation);
      const documentExisted = chunks !== null;
      const preMergeSnapshot = options?.capturePreMergeSnapshot && documentExisted ? joinChunks(chunks) : null;
      if (documentExisted) importSyncSnapshot(candidate, joinChunks(chunks));
      const previous = candidate.version();
      try {
        importSyncSnapshot(candidate, incoming);
        const merged = exportSyncSnapshot(candidate);
        const version = candidate.version();
        try {
          const historyAdvanced = documentExisted && version.compare(previous) !== 0;
          if (!documentExisted || historyAdvanced) {
            this.storage.sql.exec("DELETE FROM refueling_snapshots WHERE account_id = ?", accountId);
            for (let offset = 0; offset < merged.byteLength; offset += CHUNK_BYTES) {
              this.storage.sql.exec(
                "INSERT INTO refueling_snapshots (account_id, chunk_index, snapshot, document_generation) VALUES (?, ?, ?, ?)",
                accountId, offset / CHUNK_BYTES, merged.slice(offset, offset + CHUNK_BYTES).buffer, generation,
              );
            }
          }
          return { snapshot: merged, historyAdvanced, documentCreated: !documentExisted, preMergeSnapshot };
        } finally { version.free(); }
      } finally { previous.free(); }
    } finally {
      remote.free();
      candidate.free();
    }
  }

  /** 冻结任务/完成缓存中的现代代次痕迹（source_generation 非空）；head 缺失时不可解释。 */
  private hasModernBackupGenerationTrace(accountId: string): boolean {
    const taskTrace = this.storage.sql.exec<AccountStateRow>(
      "SELECT account_id FROM backup_frozen_task WHERE account_id = ? AND source_generation IS NOT NULL LIMIT 1",
      accountId,
    ).toArray().length > 0;
    if (taskTrace) return true;
    return this.storage.sql.exec<AccountStateRow>(
      "SELECT account_id FROM backup_completions WHERE account_id = ? AND source_generation IS NOT NULL LIMIT 1",
      accountId,
    ).toArray().length > 0;
  }

  private readSnapshotChunks(accountId: string, expectedGeneration: string): Uint8Array[] | null {
    const rows = this.storage.sql.exec<SnapshotChunkRow>(
      "SELECT snapshot, document_generation FROM refueling_snapshots WHERE account_id = ? ORDER BY chunk_index",
      accountId,
    ).toArray();
    if (rows.length === 0) return null;
    // head 存在时的分块标签核对：全部分块要么是当前代次（v2 写入），要么全部为
    // NULL 且期望代次就是 legacyGeneration（部署回退窗口由旧版本代码整批写入的
    // G0 当前文档）。NULL 与代次混排、整批属于其他代次，或在非 legacy 代次下
    // 出现 NULL，都是 head 丢失/分块混代等残缺状态：发现而不是继续。
    const labels = new Set(rows.map((row) => row.document_generation));
    if (labels.size > 1) throw new GenerationStateUnavailableError("snapshot_generation_mixed");
    const label = [...labels][0];
    if (label !== null && label !== expectedGeneration) {
      throw new GenerationStateUnavailableError("snapshot_generation_mismatch");
    }
    if (label === null) {
      const head = this.readDocumentHead(accountId);
      if (head === null || expectedGeneration !== head.legacyGeneration) {
        throw new GenerationStateUnavailableError("snapshot_generation_mismatch");
      }
    }
    return rows.map((row) => new Uint8Array(row.snapshot));
  }
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** 幂等补列：既有库升级新列（与 auth/account-state 的迁移方式一致）。 */
function ensureColumn(storage: AccountStateStorage, table: string, column: string, definition: string): void {
  const columns = storage.sql.exec<AccountStateRow & { name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (columns.some((entry) => entry.name === column)) return;
  storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
