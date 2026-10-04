// 正式账号记录库 v2（代次兼容基础，A 版本）。
//
// 存储与锁（恢复设计 §6.1）：
// - 库名 hako-account-v2:<accountId>:refueling：documents 按代次保存完整快照、
//   确认向量、待传标记与 legacy 导入映射；control 保存 activeGeneration、待确认
//   恢复请求（B 写入，A 保留/读取）、按 §7.5 持久确认的终态、迁移来源指纹与
//   需人工核对的导入映射冲突。
// - 草稿库/草稿锁/广播按账号+代次隔离（见 account-storage.ts 与草稿接线）。
// - 统一锁顺序：旧 v1 文档锁（仅迁移读取需要）→ v2 账号控制锁 → v2 代次文档锁；
//   禁止反向嵌套。所有正式保存、远端确认落盘与代次切换都经过同一个控制锁，
//   读 activeGeneration 与写 documents/control 在同一 IndexedDB 事务内完成。
// - 实例代次绑定：保存/导入/准备同步都携带调用实例绑定的代次，并在事务内复核
//   持久 activeGeneration——活动代次一致才写当前工作区；已失活时写入仍归属原
//   代次的保留副本（依合同保留在原代次，不上传），绝不写入或重贴新代次。
// - 迁移：旧 v1 库原样保留；目标 G0 尚不存在时复制旧副本及其确认信息，已存在时
//   只合并旧库新发现的历史（保留 G0 确认向量，重算待传状态，合并不覆盖新增导入
//   映射；同来源映射冲突持久记录为需核对）；指纹只在合并落盘成功时推进。写失败
//   保留两份原数据。未知 legacy 绑定（尚未 bootstrap）不迁移、不随机生成代次。
// - 代次接收（CAS）：下载发起时的本机前置代次在提交事务内复核；目标已是活动
//   代次时幂等读回，前置已推进或目标副本已存在（可能含未同步编辑）时拒绝迟到
//   切换，不覆盖、不重新激活已保留旧代次。
// - 导入映射冲突（同来源指向多个仍存在目标）持久保存为需核对：禁止再次自动
//   导入该来源，不丢失两边映射、不猜测目标。

import { LoroDoc, VersionVector } from "loro-crdt/web";
import { openDB, type DBSchema, type IDBPTransaction } from "idb";
import { readRecords, refuelingRecordFields, writeRecord } from "./refueling-document";
import { importSyncSnapshot, validateSyncDocument } from "./sync-document";
import { initializeLoro } from "./loro-runtime";
import { accountStorageNames, accountStorageNamesV2 } from "./account-storage";
import type { RefuelingRecord, SavedRefuelingRecord } from "../domain/refueling/form";
import { MAX_SYNC_BYTES } from "../shared/sync-protocol";
import type { PendingRestoreRequest, RestoreOutcomeRecord } from "./refueling-restore";

const CONTROL_KEY = "control";

interface StoredGenerationDocument {
  schemaVersion: 2;
  generation: string;
  snapshot: Uint8Array;
  version: Uint8Array;
  acknowledgedVersion: Uint8Array | null;
  pendingSync: boolean;
  legacyImports: Record<string, string>;
  /** 非空表示保留副本（已不是活动工作区）；保留副本不上传、只读查看。 */
  retainedAtMs: number | null;
}

interface StoredControl {
  schemaVersion: 2;
  activeGeneration: string | null;
  legacyGeneration: string | null;
  migrationFingerprint: string | null;
  pendingRestore: PendingRestoreRequest | null;
  restoreOutcomes: Record<string, RestoreOutcomeRecord>;
  /** 需人工核对的导入映射冲突：来源 ID → 多个仍存在的目标记录 ID。 */
  importConflicts: Record<string, string[]>;
}

interface LocalV2Database extends DBSchema {
  documents: { key: string; value: StoredGenerationDocument };
  control: { key: string; value: StoredControl };
}

/** 控制锁内的读写事务：documents 与 control 在同一事务中读写。 */
type ControlTransaction = IDBPTransaction<LocalV2Database, ("documents" | "control")[], "readwrite">;

interface LegacyV1Document {
  schemaVersion: 1;
  snapshot: Uint8Array;
  version: Uint8Array;
  acknowledgedVersion: Uint8Array | null;
  pendingSync: boolean;
  legacyImports: Record<string, string>;
}

export interface LocalRefuelingState {
  generation: string | null;
  records: SavedRefuelingRecord[];
  pendingSync: boolean;
  confirmed: boolean;
  importedLegacyIds: string[];
}

/** 一次代次绑定读写的完整上下文：状态 + 持久控制字段的即时快照（漂移检测用）。 */
export interface GenerationReadResult extends LocalRefuelingState {
  /** 请求绑定的代次已不是活动代次（调用实例失活）：应进入保护流程。 */
  inactive: boolean;
  activeGeneration: string | null;
  legacyGeneration: string | null;
  pendingRestore: PendingRestoreRequest | null;
  importConflicts: Record<string, string[]>;
}

export interface GenerationWriteResult extends GenerationReadResult {}

export interface RetainedGenerationSummary {
  generation: string;
  legacyGeneration: boolean;
  retainedAtMs: number | null;
  pendingSync: boolean;
  recordCount: number;
  importedLegacyIds: string[];
}

export interface RetainedGenerationView extends RetainedGenerationSummary {
  records: SavedRefuelingRecord[];
}

export interface MigrationCheckResult {
  /** 迁移或合并写入了 G0（活动工作区可能需要刷新显示）。 */
  changed: boolean;
  /** 合并失败（超限/校验/落盘）：两份原数据保留，显示待处理。 */
  pendingMergeError: string | null;
}

export type ReceiveGenerationResult =
  | { status: "received"; state: LocalRefuelingState }
  | { status: "already-active"; state: LocalRefuelingState }
  | { status: "stale"; message: string };

export type ActivateGenerationResult =
  | { status: "activated"; state: LocalRefuelingState }
  | { status: "stale"; message: string };

export interface OpenLocalRefuelingV2Options {
  accountId: string;
  /**
   * bootstrap 给出的固定 legacy 绑定；离线打开尚未 bootstrap 的账号时可为 null
   * （此前已迁移过的账号以 control.legacyGeneration 为准），此时不执行迁移、
   * 不随机生成代次，待 bootstrap 成功后经 setLegacyBinding 补齐再迁移。
   */
  legacyGeneration: string | null;
}

export async function openLocalRefuelingV2(options: OpenLocalRefuelingV2Options) {
  if (!navigator.locks) throw new Error("此浏览器缺少安全写入所需的 Web Locks，请使用受支持的浏览器。");
  await initializeLoro();
  const names = accountStorageNamesV2(options.accountId);
  const identity = new LoroDoc();
  const peerId = identity.peerId;
  identity.free();
  const database = await openDB<LocalV2Database>(names.records, 1, {
    upgrade(db) {
      db.createObjectStore("documents");
      db.createObjectStore("control");
    },
    blocking() { database.close(); },
  });
  /** 当前已知的 legacy 绑定：构造参数或 setLegacyBinding 提供；null 时不迁移。 */
  let legacyBinding: string | null = options.legacyGeneration;

  function emptyDocumentRecord(generation: string): StoredGenerationDocument {
    return {
      schemaVersion: 2, generation, snapshot: new Uint8Array(), version: new Uint8Array(),
      acknowledgedVersion: null, pendingSync: false, legacyImports: {}, retainedAtMs: null,
    };
  }

  function project(doc: LoroDoc, stored: StoredGenerationDocument, generation: string | null): LocalRefuelingState {
    return {
      generation,
      records: readRecords(doc),
      pendingSync: stored.pendingSync,
      confirmed: stored.acknowledgedVersion !== null,
      importedLegacyIds: Object.keys(stored.legacyImports),
    };
  }

  function defaultControl(): StoredControl {
    return {
      schemaVersion: 2, activeGeneration: null, legacyGeneration: null,
      migrationFingerprint: null, pendingRestore: null, restoreOutcomes: {},
      importConflicts: {},
    };
  }

  function computePendingSync(stored: StoredGenerationDocument, version: VersionVector): boolean {
    const acknowledged = stored.acknowledgedVersion ? VersionVector.decode(stored.acknowledgedVersion) : null;
    try {
      return acknowledged === null ? version.length() > 0 : version.compare(acknowledged) !== 0;
    } finally { acknowledged?.free(); }
  }

  /** 控制 + 文档在同一事务内读写；所有正式写入都经过账号控制锁。 */
  async function withControl<T>(operation: (tx: ControlTransaction) => Promise<T>): Promise<T> {
    return navigator.locks.request(names.controlLock, async () => {
      const tx = database.transaction(["documents", "control"], "readwrite", { durability: "strict" });
      try {
        const result = await operation(tx);
        await tx.done;
        return result;
      } catch (error) {
        try { tx.abort(); } catch { /* Already finished. */ }
        await tx.done.catch(() => undefined);
        throw error;
      }
    });
  }

  async function readControlWithin(tx: ControlTransaction): Promise<StoredControl> {
    return (await tx.objectStore("control").get(CONTROL_KEY)) ?? defaultControl();
  }

  function writeControlWithin(tx: ControlTransaction, control: StoredControl): void {
    tx.objectStore("control").put(control, CONTROL_KEY);
  }

  function persistWithin(tx: ControlTransaction, doc: LoroDoc, stored: StoredGenerationDocument): void {
    // 所有本机写入都先满足下一次加载/同步的同一合同，旧数据导入也不能绕过。
    try { validateSyncDocument(doc); }
    catch { throw new Error("记录格式不受支持，未改动本机已保存的数据"); }
    const version = doc.version();
    try {
      stored.version = version.encode();
      stored.pendingSync = computePendingSync(stored, version);
    } finally { version.free(); }
    stored.snapshot = doc.export({ mode: "snapshot" });
    tx.objectStore("documents").put(stored, stored.generation);
  }

  async function loadDocumentWithin(tx: ControlTransaction, generation: string | null): Promise<{ doc: LoroDoc; stored: StoredGenerationDocument } | null> {
    if (generation === null) return null;
    const stored = (await tx.objectStore("documents").get(generation)) ?? emptyDocumentRecord(generation);
    const doc = new LoroDoc();
    try {
      if (stored.snapshot.byteLength > 0) doc.import(stored.snapshot);
      doc.setPeerId(peerId);
      validateSyncDocument(doc);
      return { doc, stored };
    } catch (error) {
      doc.free();
      throw error;
    }
  }

  /** 组装代次绑定读结果：请求代次的投影 + 控制快照（漂移/保护检测在同一事务内）。 */
  async function generationReadResultWithin(tx: ControlTransaction, control: StoredControl, generation: string | null): Promise<GenerationReadResult> {
    const loaded = await loadDocumentWithin(tx, generation);
    try {
      const state = loaded === null
        ? { generation: null, records: [], pendingSync: false, confirmed: false, importedLegacyIds: [] }
        : project(loaded.doc, loaded.stored, generation);
      return {
        ...state,
        inactive: generation !== null && control.activeGeneration !== generation,
        activeGeneration: control.activeGeneration,
        legacyGeneration: control.legacyGeneration,
        pendingRestore: control.pendingRestore,
        importConflicts: control.importConflicts,
      };
    } finally { loaded?.doc.free(); }
  }

  /** 旧 v1 库只读打开（不创建）；在旧文档锁内读取，供迁移与迟到写入发现使用。 */
  async function readLegacyV1Document(): Promise<LegacyV1Document | null> {
    const v1Names = accountStorageNames(options.accountId);
    return navigator.locks.request(v1Names.documentLock, async () => {
      let absent = false;
      const v1 = await openDB<Record<"documents", { key: string; value: LegacyV1Document }>>(v1Names.records, undefined, {
        upgrade(_db, _old, _next, transaction) {
          absent = true;
          void transaction.done.catch(() => undefined);
          transaction.abort();
        },
      }).catch((error) => { if (absent) return null; throw error; });
      if (v1 === null) return null;
      try {
        const stored = await v1.get("documents", "main");
        if (!stored) return null;
        if (stored.schemaVersion !== 1) throw new Error("旧账号数据版本不受支持，原库已保留。");
        return stored;
      } finally {
        v1.close();
      }
    });
  }

  async function computeLegacyFingerprint(value: LegacyV1Document | null): Promise<string | null> {
    if (value === null) return null;
    const parts = [
      value.snapshot,
      value.version,
      new TextEncoder().encode(JSON.stringify(sortRecordEntries(value.legacyImports))),
    ];
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
    const digest = await crypto.subtle.digest("SHA-256", joined);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /**
   * 迁移/再迁移（在 v1 文档锁 → 控制锁的顺序内执行）：
   * - 未知 legacy 绑定（尚未 bootstrap 且 control 无记录）：不迁移、不生成代次。
   * - G0 尚不存在：复制验证过的旧副本及其确认信息（只在目标为空时允许）。
   * - G0 已存在且旧库出现新历史：把新发现的历史合并进 G0，保留 G0 确认向量并按
   *   合并后向量重算待传状态；导入映射合并不覆盖 G0 新增条目，同来源冲突持久
   *   记录为需核对。
   * - 指纹只在快照、待传状态与导入映射一起持久成功时推进；合并超限/校验/落盘
   *   失败保留两份原数据与旧指纹，并报告待处理。G0 已失活时同样追加保留历史，
   *   但不改 activeGeneration。
   */
  async function migrateFromV1(): Promise<MigrationCheckResult> {
    if (legacyBinding === null) return { changed: false, pendingMergeError: null };
    const legacy = await readLegacyV1Document();
    const fingerprint = await computeLegacyFingerprint(legacy);
    const binding = legacyBinding;
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      const documentsStore = tx.objectStore("documents");
      const g0 = (await documentsStore.get(binding)) ?? null;
      control.legacyGeneration = binding;
      if (legacy === null || fingerprint === null) {
        writeControlWithin(tx, control);
        return { changed: false, pendingMergeError: null };
      }
      if (control.migrationFingerprint === fingerprint) {
        writeControlWithin(tx, control);
        return { changed: false, pendingMergeError: null };
      }
      if (g0 === null) {
        // 首次迁移：目标 G0 尚不存在，才允许复制旧副本及其确认信息。
        const stored: StoredGenerationDocument = {
          schemaVersion: 2, generation: binding,
          snapshot: legacy.snapshot, version: legacy.version,
          acknowledgedVersion: legacy.acknowledgedVersion,
          pendingSync: legacy.pendingSync, legacyImports: { ...legacy.legacyImports },
          retainedAtMs: control.activeGeneration !== null && control.activeGeneration !== binding
            ? Date.now()
            : null,
        };
        const doc = new LoroDoc();
        try {
          importSyncSnapshot(doc, legacy.snapshot);
          persistWithin(tx, doc, stored);
        } finally { doc.free(); }
        control.migrationFingerprint = fingerprint;
        writeControlWithin(tx, control);
        return { changed: control.activeGeneration === binding, pendingMergeError: null };
      }
      // 再次读取：旧标签页可能继续写 v1 库；合并新发现的历史，不以旧快照替换 G0。
      const candidate = new LoroDoc();
      const legacyDoc = new LoroDoc();
      try {
        if (g0.snapshot.byteLength > 0) candidate.import(g0.snapshot);
        importSyncSnapshot(legacyDoc, legacy.snapshot);
        importSyncSnapshot(candidate, legacy.snapshot);
        const merged = candidate.export({ mode: "snapshot" });
        if (merged.byteLength > MAX_SYNC_BYTES) {
          throw new Error("待合并的旧记录超出本版容量，两份数据均已保留。");
        }
        g0.snapshot = merged;
        const mergedImports = mergeImportMaps(g0.legacyImports, legacy.legacyImports);
        for (const [source, targets] of Object.entries(mergedImports.conflicts)) {
          control.importConflicts = { ...control.importConflicts, [source]: targets };
        }
        g0.legacyImports = mergedImports.merged;
        const version = candidate.version();
        try { g0.version = version.encode(); g0.pendingSync = computePendingSync(g0, version); }
        finally { version.free(); }
        documentsStore.put(g0, g0.generation);
        control.migrationFingerprint = fingerprint;
        writeControlWithin(tx, control);
        return { changed: control.activeGeneration === binding, pendingMergeError: null };
      } catch (error) {
        // 合并失败：事务回滚，两份原数据与旧指纹保留。
        throw error instanceof Error ? error : new Error("旧记录合并失败，两份数据均已保留。");
      } finally {
        candidate.free();
        legacyDoc.free();
      }
    });
  }

  /** bootstrap 成功后补齐 legacy 绑定（未知绑定期不迁移）；幂等。 */
  function setLegacyBinding(generation: string): void {
    legacyBinding = generation;
  }

  /**
   * 代次绑定读取：请求代次的投影 + 同事务的控制快照。活动代次的调用方用
   * load()；工作区实例用 readGenerationState(绑定代次) 检测失活漂移。
   */
  async function readGenerationState(generation: string | null): Promise<GenerationReadResult> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      return await generationReadResultWithin(tx, control, generation);
    });
  }

  /** 读取共享活动代次的状态（内部/同步确认路径使用）。 */
  async function load(): Promise<LocalRefuelingState> {
    const result = await readGenerationState(null);
    // null 表示读取共享活动代次；此时按控制快照中的活动代次重新读取。
    if (result.activeGeneration === null) {
      return { generation: null, records: [], pendingSync: false, confirmed: false, importedLegacyIds: [] };
    }
    const active = await readGenerationState(result.activeGeneration);
    return {
      generation: active.generation,
      records: active.records,
      pendingSync: active.pendingSync,
      confirmed: active.confirmed,
      importedLegacyIds: active.importedLegacyIds,
    };
  }

  /**
   * 代次绑定的普通保存：调用实例绑定的代次在事务内复核——仍为活动代次时写当前
   * 工作区；已失活但该代次副本存在时，写入仍归属原代次的保留副本（依合同保留
   * 在原代次，不上传），并返回 inactive 供调用方进入保护流程；副本不存在时拒绝。
   */
  async function save(generation: string, id: string, patch: Partial<RefuelingRecord>, creating: boolean): Promise<GenerationWriteResult> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      const documentsStore = tx.objectStore("documents");
      const stored = await documentsStore.get(generation);
      if (stored === undefined && control.activeGeneration !== generation) {
        throw new Error("该代次在本机没有副本，保存被拒绝；输入已保留在表单与草稿中。");
      }
      const loaded = await loadDocumentWithin(tx, generation);
      if (loaded === null) throw new Error("本机没有活动代次，无法保存。");
      try {
        writeRecord(loaded.doc, id, patch, creating);
        persistWithin(tx, loaded.doc, loaded.stored);
        return await generationReadResultWithin(tx, control, generation);
      } finally { loaded.doc.free(); }
    });
  }

  /**
   * 代次绑定的旧记录导入：冲突判定按本次操作代次中仍存在的目标数区分——
   * 零个仍存在目标允许本人重新选取（生成新 ID）；唯一仍存在目标沿用历史映射
   * （幂等，不新建重复记录）；多个仍存在目标拒绝自动导入。历史冲突证据保留
   * 不清除。失活代次的导入与保存同样只写原代次保留副本。
   */
  async function importLegacy(generation: string, selected: SavedRefuelingRecord[]): Promise<GenerationWriteResult> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      const documentsStore = tx.objectStore("documents");
      const stored = await documentsStore.get(generation);
      if (stored === undefined && control.activeGeneration !== generation) {
        throw new Error("该代次在本机没有副本，导入被拒绝；原旧库不变。");
      }
      const loaded = await loadDocumentWithin(tx, generation);
      if (loaded === null) throw new Error("本机没有活动代次，无法导入。");
      try {
        // 阻断决策与历史冲突证据分开：按本次操作代次中仍存在的不同目标计算——
        // 零个仍存在目标允许本人重新选取（新 ID）；唯一仍存在目标沿用该映射
        // （幂等，不新建重复记录，映射缺失时也补记映射而不创建第三个目标）；
        // 多个仍存在目标才是多目标歧义，拒绝自动导入。历史证据保留不清除。
        const existingIds = new Set(readRecords(loaded.doc).map((record) => record.id));
        for (const { id, ...record } of selected) {
          if (Object.hasOwn(loaded.stored.legacyImports, id)) continue;
          const surviving = [...new Set((control.importConflicts[id] ?? []).filter((target) => existingIds.has(target)))];
          if (surviving.length > 1) {
            throw new Error(`所选旧记录来源（${id}）存在多个仍存在的导入目标，需人工核对；已拒绝自动导入。`);
          }
          if (surviving.length === 1) {
            // 唯一存活目标：沿用历史映射，不创建重复记录。
            loaded.stored.legacyImports = { ...loaded.stored.legacyImports, [id]: surviving[0]! };
            continue;
          }
          if (Object.keys(record).some((key) => !refuelingRecordFields.has(key))) {
            throw new Error("记录格式不受支持，未改动本机已保存的数据");
          }
          const fields = Object.fromEntries([...refuelingRecordFields].map((key) => [key, record[key as keyof RefuelingRecord]])) as RefuelingRecord;
          const targetId = crypto.randomUUID();
          writeRecord(loaded.doc, targetId, fields, true);
          // 映射与新记录同一事务；重试或多标签页导入不会再次创建/覆盖该记录。
          loaded.stored.legacyImports = { ...loaded.stored.legacyImports, [id]: targetId };
        }
        persistWithin(tx, loaded.doc, loaded.stored);
        return await generationReadResultWithin(tx, control, generation);
      } finally { loaded.doc.free(); }
    });
  }

  /**
   * 代次绑定的同步准备：只有调用实例绑定的代次仍是共享活动代次时才提供快照；
   * 已失活代次不上传（返回 null），旧窗口不能替新代次发送。
   */
  async function prepareSync(generation: string): Promise<{ snapshot: Uint8Array; version: Uint8Array; generation: string } | null> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      if (control.activeGeneration !== generation) return null;
      const loaded = await loadDocumentWithin(tx, generation);
      if (loaded === null) return null;
      try {
        const version = loaded.doc.version();
        try {
          return {
            snapshot: loaded.doc.export({ mode: "snapshot" }),
            version: version.encode(),
            generation,
          };
        } finally { version.free(); }
      } finally { loaded.doc.free(); }
    });
  }

  /**
   * 接收服务端确认：仅当当前活动代次仍是发送绑定的代次时应用；
   * 已失活代次的迟到响应不能写入新代次或更新其确认游标。
   */
  async function acceptSync(
    generation: string,
    snapshot: Uint8Array,
    sentVersion: Uint8Array,
    applies: () => boolean,
  ): Promise<GenerationWriteResult | null> {
    return await withControl(async (tx) => {
      if (!applies()) return null;
      const control = await readControlWithin(tx);
      if (control.activeGeneration !== generation) return null;
      const loaded = await loadDocumentWithin(tx, generation);
      if (loaded === null) return null;
      const server = new LoroDoc();
      try {
        importSyncSnapshot(server, snapshot);
        const acknowledged = server.version();
        const sent = VersionVector.decode(sentVersion);
        try {
          const coverage = acknowledged.compare(sent);
          if (coverage === undefined || coverage < 0) throw new Error("服务端未确认本次发送的版本");
          loaded.stored.acknowledgedVersion = acknowledged.encode();
        } finally { acknowledged.free(); sent.free(); }
        importSyncSnapshot(loaded.doc, snapshot);
        if (!applies()) return null;
        persistWithin(tx, loaded.doc, loaded.stored);
        return await generationReadResultWithin(tx, control, generation);
      } finally {
        server.free();
        loaded.doc.free();
      }
    });
  }

  /**
   * 代次切换接收（恢复设计 §6.2 步骤 5，带 CAS 复核）：下载发起时的本机前置
   * activeGeneration 在同一控制事务内复核。
   * - 目标已是活动代次：幂等读回，不覆盖任何未同步编辑。
   * - 前置代次已被其他窗口推进（本机已接收更晚代次）：拒绝迟到切换。
   * - 目标副本已存在（保留副本，可能含未同步编辑）：拒绝覆盖或重新激活。
   * - 其余：旧活动副本登记为保留副本（不上传、不清待传），写入已验证的新快照，
   *   切换活动代次；导入映射只继承目标记录仍存在于新快照且无冲突的条目。
   */
  async function receiveGeneration(generation: string, snapshot: Uint8Array | null, expectedActive: string | null): Promise<ReceiveGenerationResult> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      const documentsStore = tx.objectStore("documents");
      if (control.activeGeneration === generation) {
        const loaded = await loadDocumentWithin(tx, generation);
        if (loaded === null) throw new Error("本机活动代次数据缺失。");
        try { return { status: "already-active", state: project(loaded.doc, loaded.stored, generation) }; } finally { loaded.doc.free(); }
      }
      if (control.activeGeneration !== expectedActive) {
        return { status: "stale", message: "本机代次已被其他窗口推进，本次下载已过期；请重新确认当前数据。" };
      }
      if (await documentsStore.get(generation) !== undefined) {
        return { status: "stale", message: "目标代次副本已在本机保留（可能含未同步修改），已拒绝覆盖。" };
      }
      const nowMs = Date.now();
      // 旧活动副本登记为保留副本（如存在）。
      if (control.activeGeneration !== null) {
        const previous = await documentsStore.get(control.activeGeneration);
        if (previous !== undefined && previous.retainedAtMs === null) {
          previous.retainedAtMs = nowMs;
          documentsStore.put(previous, previous.generation);
        }
      }
      const stored: StoredGenerationDocument = {
        schemaVersion: 2, generation,
        snapshot: new Uint8Array(), version: new Uint8Array(),
        acknowledgedVersion: null, pendingSync: false,
        legacyImports: {}, retainedAtMs: null,
      };
      if (snapshot !== null && snapshot.byteLength > 0) {
        const server = new LoroDoc();
        try {
          importSyncSnapshot(server, snapshot);
          const version = server.version();
          try {
            stored.version = version.encode();
            stored.snapshot = server.export({ mode: "snapshot" });
          } finally { version.free(); }
          // 新确认向量来自已验证的当前服务端下载，与新快照一起落盘。
          stored.acknowledgedVersion = stored.version;
        } finally { server.free(); }
        stored.legacyImports = await inheritImportMaps(tx, snapshot, control);
      }
      documentsStore.put(stored, generation);
      control.activeGeneration = generation;
      writeControlWithin(tx, control);
      const loaded = await loadDocumentWithin(tx, generation);
      if (loaded === null) throw new Error("新代次数据写入失败。");
      try { return { status: "received", state: project(loaded.doc, loaded.stored, generation) }; } finally { loaded.doc.free(); }
    });
  }

  /**
   * 激活既有本机代次（首次升级或本机 G0 与服务端一致的常规路径）：
   * 只设置 activeGeneration，不复制或改写任何快照字节。带 CAS 前置复核——
   * 决策与激活之间存在异步边界，其他窗口已接收新代次时拒绝把共享控制改回
   * 旧代次（stale，不写入），由调用方重新决策。
   */
  async function activateGeneration(generation: string, expectedActive: string | null): Promise<ActivateGenerationResult> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      if (control.activeGeneration !== generation && control.activeGeneration !== expectedActive) {
        return { status: "stale", message: "本机代次已被其他窗口推进，本次激活已过期；请重新确认当前数据。" };
      }
      if (control.activeGeneration !== generation) {
        control.activeGeneration = generation;
        writeControlWithin(tx, control);
      }
      const loaded = await loadDocumentWithin(tx, generation);
      if (loaded === null) throw new Error("本机代次数据缺失。");
      try {
        return { status: "activated", state: project(loaded.doc, loaded.stored, generation) };
      } finally { loaded.doc.free(); }
    });
  }

  /** 本机是否存有任意代次数据（区分「全新浏览器」与「已有保留数据」）。 */
  async function hasAnyGeneration(): Promise<boolean> {
    return await withControl(async (tx) => (await tx.objectStore("documents").count()) > 0);
  }

  /**
   * 列出本机代次副本。exclude 为 null 时列出全部（保护流程中查看被保护的旧副本）；
   * 传入当前活动代次时列出其余保留副本（接收后的查看入口）。
   */
  async function listRetainedGenerations(exclude: string | null = null): Promise<RetainedGenerationSummary[]> {
    const control = await readControl();
    const generations = await database.getAllKeys("documents");
    const summaries: RetainedGenerationSummary[] = [];
    for (const generation of generations) {
      if (generation === exclude) continue;
      // 保留副本读取只占代次文档锁，不占控制锁（见统一锁顺序）。
      const view = await readRetainedGeneration(generation);
      if (view === null) continue;
      summaries.push({
        generation,
        legacyGeneration: generation === control.legacyGeneration,
        retainedAtMs: view.retainedAtMs,
        pendingSync: view.pendingSync,
        recordCount: view.records.length,
        importedLegacyIds: view.importedLegacyIds,
      });
    }
    return summaries.sort((left, right) => (left.retainedAtMs ?? 0) - (right.retainedAtMs ?? 0));
  }

  /** 只读读取某代次副本（保留副本查看）；不创建、不改写。 */
  async function readRetainedGeneration(generation: string): Promise<RetainedGenerationView | null> {
    return navigator.locks.request(accountStorageNamesV2(options.accountId).documentLockFor(generation), async () => {
      const stored = await database.get("documents", generation);
      if (stored === undefined) return null;
      const doc = new LoroDoc();
      try {
        if (stored.snapshot.byteLength > 0) doc.import(stored.snapshot);
        validateSyncDocument(doc);
        return {
          generation,
          legacyGeneration: generation === legacyBinding,
          retainedAtMs: stored.retainedAtMs,
          pendingSync: stored.pendingSync,
          recordCount: readRecords(doc).length,
          importedLegacyIds: Object.keys(stored.legacyImports),
          records: readRecords(doc),
        };
      } finally { doc.free(); }
    });
  }

  /**
   * 写入待确认恢复请求：同一账号已有待确认请求时复用原记录，
   * 不能用另一请求覆盖 control（多标签页通过控制锁串行）。
   */
  async function setPendingRestore(pending: PendingRestoreRequest): Promise<PendingRestoreRequest> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      if (control.pendingRestore !== null && control.pendingRestore.requestId !== pending.requestId) {
        return control.pendingRestore;
      }
      if (control.pendingRestore !== null) return control.pendingRestore;
      control.pendingRestore = pending;
      writeControlWithin(tx, control);
      return pending;
    });
  }

  /**
   * 落盘终态并解除待确认：锁内重查当前待确认记录，旧请求响应不能覆盖后来的请求；
   * requestId 与指纹必须完全匹配。返回 true 表示终态已持久（允许重新确认新请求）。
   */
  async function resolveRestoreOutcome(outcome: RestoreOutcomeRecord): Promise<boolean> {
    return await withControl(async (tx) => {
      const control = await readControlWithin(tx);
      const pending = control.pendingRestore;
      if (pending === null || pending.requestId !== outcome.requestId
        || pending.requestFingerprint !== outcome.requestFingerprint) {
        // 已被其他标签页或后续请求处理：不覆盖，也不重复清除。
        return Object.hasOwn(control.restoreOutcomes, outcome.requestId);
      }
      control.pendingRestore = null;
      control.restoreOutcomes = { ...control.restoreOutcomes, [outcome.requestId]: outcome };
      writeControlWithin(tx, control);
      return true;
    });
  }

  /** 同 requestId 的已判定终态（重开时避免重复处理）。 */
  async function readRestoreOutcome(requestId: string): Promise<RestoreOutcomeRecord | null> {
    const control = await readControl();
    return control.restoreOutcomes[requestId] ?? null;
  }

  /** 读 control（外部只读用途：代次判定、待确认恢复展示）。 */
  async function readControl(): Promise<StoredControl> {
    return await withControl(async (tx) => await readControlWithin(tx));
  }

  /**
   * 导入映射继承：遍历本机各代次的映射，目标记录仍存在于新快照的条目才继承；
   * 同来源指向多个仍存在的目标时不自动继承，持久记录为需核对（写入 control 的
   * importConflicts，由调用方随事务提交），禁止再次自动导入该来源。
   */
  async function inheritImportMaps(tx: ControlTransaction, snapshot: Uint8Array, control: StoredControl): Promise<Record<string, string>> {
    const server = new LoroDoc();
    try {
      importSyncSnapshot(server, snapshot);
      const existing = new Set(readRecords(server).map((record) => record.id));
      const generations = await tx.objectStore("documents").getAllKeys();
      const bySource = new Map<string, Set<string>>();
      for (const generation of generations) {
        const stored = await tx.objectStore("documents").get(generation);
        if (stored === undefined) continue;
        for (const [sourceId, targetId] of Object.entries(stored.legacyImports)) {
          if (!existing.has(targetId)) continue;
          const targets = bySource.get(sourceId) ?? new Set<string>();
          targets.add(targetId);
          bySource.set(sourceId, targets);
        }
      }
      const inherited: Record<string, string> = {};
      for (const [sourceId, targets] of bySource) {
        if (targets.size === 1) {
          inherited[sourceId] = [...targets][0];
          continue;
        }
        // 多目标冲突：持久标记需核对，不自动继承、不丢失两边映射。
        const sorted = [...targets].sort();
        const previous = control.importConflicts[sourceId];
        control.importConflicts = {
          ...control.importConflicts,
          [sourceId]: previous ? [...new Set([...previous, ...sorted])].sort() : sorted,
        };
      }
      return inherited;
    } finally { server.free(); }
  }

  return {
    migrateFromV1,
    setLegacyBinding,
    readControl,
    load,
    readGenerationState,
    save,
    importLegacy,
    prepareSync,
    acceptSync,
    receiveGeneration,
    activateGeneration,
    hasAnyGeneration,
    listRetainedGenerations,
    readRetainedGeneration,
    setPendingRestore,
    resolveRestoreOutcome,
    readRestoreOutcome,
    close: () => database.close(),
  };
}

function sortRecordEntries(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/**
 * 导入映射合并：旧库映射只补充缺失条目，不覆盖 G0 新增条目；同来源双方各有不同
 * 目标时记录冲突事实（返回给调用方持久化），保留当前一方映射。
 */
function mergeImportMaps(current: Record<string, string>, incoming: Record<string, string>): { merged: Record<string, string>; conflicts: Record<string, string[]> } {
  const merged = { ...current };
  const conflicts: Record<string, string[]> = {};
  for (const [sourceId, targetId] of Object.entries(incoming)) {
    if (!Object.hasOwn(merged, sourceId)) {
      merged[sourceId] = targetId;
      continue;
    }
    if (merged[sourceId] !== targetId) {
      conflicts[sourceId] = [merged[sourceId], targetId].sort();
    }
  }
  return { merged, conflicts };
}

export type LocalRefuelingV2Repository = Awaited<ReturnType<typeof openLocalRefuelingV2>>;
