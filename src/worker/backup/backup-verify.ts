// 独立备份的读回验证器：发布完成标记前，对 R2 读回的字节做完整验证，
// 并用全新 Loro 文档独立导入核对结构、业务字段、版本摘要与记录数。
// 这证明该备份在验证时可读、可解析且与捕获版本一致；不是恢复到生产应用的证明。

import { LoroDoc } from "loro-crdt/web";
import { importSyncSnapshot, InvalidSyncDocument } from "../../data/sync-document";
import { readRecords } from "../../data/refueling-document";
import type { BackupCompletionRecord } from "./backup-store";
import {
  BackupFormatError,
  BACKUP_DOCUMENT_TYPE,
  BACKUP_ENVIRONMENT,
  BACKUP_FORMAT_VERSION_V1,
  BACKUP_FORMAT_VERSION_V2,
  computeHistoryVersionDigest,
  parseBundle,
  parseMarker,
  sha256Hex,
  type BackupCommitMarker,
  type BackupManifest,
} from "./backup-format";

/** 固定错误码：进入 blocked 后停止自动 R2 写入／删除，但同步继续。 */
export type BackupBlockedCode =
  | "content_conflict"
  | "format_conflict"
  | "ownership_conflict"
  | "sequence_conflict"
  | "retention_verify_failed"
  | "invalid_source_document"
  | "generation_state_unavailable";

export class BackupVerificationError extends Error {
  constructor(readonly blockedCode: BackupBlockedCode, readonly detail: string) {
    super(`${blockedCode}: ${detail}`);
    this.name = "BackupVerificationError";
  }
}

export interface BackupSnapshotAnalysis {
  historyVersionSha256: string;
  recordCount: number;
}

/** 对冻结快照做独立导入验证并计算 manifest 的摘要字段；失败视为源文档损坏。 */
export async function analyzeBackupSnapshot(snapshot: Uint8Array): Promise<BackupSnapshotAnalysis> {
  const doc = new LoroDoc();
  try {
    importSyncSnapshot(doc, snapshot);
    const version = doc.version();
    try {
      const historyVersionSha256 = await computeHistoryVersionDigest(version.toJSON());
      return { historyVersionSha256, recordCount: readRecords(doc).length };
    } finally {
      version.free();
    }
  } catch (error) {
    if (error instanceof InvalidSyncDocument || error instanceof BackupFormatError) {
      throw new BackupVerificationError("invalid_source_document", "snapshot_import_failed");
    }
    throw error;
  } finally {
    doc.free();
  }
}

export interface BackupBundleReadBack {
  manifest: BackupManifest;
  snapshot: Uint8Array;
}

/**
 * 由完成缓存构造期望的完成标记：保留检查、恢复预览与恢复保护读回共用同一构造。
 * v1/v2 混合序列按各自完成缓存记录的格式验证；旧缓存行缺失时按 v1。
 */
export function buildCompletionMarker(completion: BackupCompletionRecord): BackupCommitMarker {
  return {
    format: "hako-independent-backup",
    formatVersion: completion.formatVersion === BACKUP_FORMAT_VERSION_V2 ? BACKUP_FORMAT_VERSION_V2 : BACKUP_FORMAT_VERSION_V1,
    environment: BACKUP_ENVIRONMENT,
    accountId: completion.accountId,
    documentType: BACKUP_DOCUMENT_TYPE,
    backupStreamId: completion.streamId,
    revision: completion.revision,
    objectKey: completion.bundleKey,
    bundleBytes: completion.bundleBytes,
    bundleSha256: completion.bundleSha256,
  };
}

/**
 * 已完成备份的读回验证（恢复预览、恢复保护与离线 CLI 共用）：整包哈希与长度 →
 * 严格格式解析 → 归属匹配 → manifest 内部一致（快照长度/哈希）→ 全新 Loro 导入
 * 与业务校验 → 版本摘要与记录数 → 完成缓存/标记交叉核对（期望为 null 的字段
 * 只核对 manifest 内部一致性，不做外部交叉核对）。
 */
export interface CompletedBackupExpectations {
  environment: string;
  accountId: string;
  documentType: string;
  streamId: string;
  revision: number;
  bundleSha256: string;
  bundleBytes: number;
  /** 完成缓存/标记携带的格式版本；null 表示无外部来源（如离线 CLI 的部分核对）。 */
  formatVersion: number | null;
  historySha256: string | null;
  recordCount: number | null;
  snapshotSha256: string | null;
}

export async function verifyCompletedBackup(options: {
  bytes: Uint8Array;
  expected: CompletedBackupExpectations;
}): Promise<BackupBundleReadBack> {
  const bundleSha256 = await sha256Hex(options.bytes);
  if (bundleSha256 !== options.expected.bundleSha256) {
    throw new BackupVerificationError("content_conflict", "bundle_sha256_mismatch");
  }
  if (options.bytes.byteLength !== options.expected.bundleBytes) {
    throw new BackupVerificationError("content_conflict", "bundle_length_mismatch");
  }
  let parsed: ReturnType<typeof parseBundle>;
  try {
    parsed = parseBundle(options.bytes);
  } catch (error) {
    if (error instanceof BackupFormatError) throw new BackupVerificationError("format_conflict", error.message);
    throw error;
  }
  const manifest = parsed.manifest;
  if (options.expected.formatVersion !== null && manifest.formatVersion !== options.expected.formatVersion) {
    throw new BackupVerificationError("content_conflict", "format_version_mismatch");
  }
  if (manifest.environment !== options.expected.environment
    || manifest.accountId !== options.expected.accountId
    || manifest.documentType !== options.expected.documentType
    || manifest.backupStreamId !== options.expected.streamId
    || manifest.revision !== options.expected.revision) {
    throw new BackupVerificationError("ownership_conflict", "manifest_ownership_mismatch");
  }
  if (parsed.snapshot.byteLength !== manifest.snapshotBytes) {
    throw new BackupVerificationError("content_conflict", "snapshot_length_mismatch");
  }
  const snapshotSha256 = await sha256Hex(parsed.snapshot);
  if (snapshotSha256 !== manifest.snapshotSha256) {
    throw new BackupVerificationError("content_conflict", "snapshot_sha256_mismatch");
  }
  if (options.expected.snapshotSha256 !== null && manifest.snapshotSha256 !== options.expected.snapshotSha256) {
    throw new BackupVerificationError("content_conflict", "cached_snapshot_sha_mismatch");
  }
  const doc = new LoroDoc();
  try {
    try {
      importSyncSnapshot(doc, parsed.snapshot);
    } catch (error) {
      if (error instanceof InvalidSyncDocument) {
        throw new BackupVerificationError("content_conflict", "snapshot_import_failed");
      }
      throw error;
    }
    const version = doc.version();
    try {
      const digest = await computeHistoryVersionDigest(version.toJSON());
      if (digest !== manifest.historyVersionSha256) {
        throw new BackupVerificationError("content_conflict", "history_digest_mismatch");
      }
      if (options.expected.historySha256 !== null && digest !== options.expected.historySha256) {
        throw new BackupVerificationError("content_conflict", "cached_history_digest_mismatch");
      }
    } finally {
      version.free();
    }
    const recordCount = readRecords(doc).length;
    if (recordCount !== manifest.recordCount) {
      throw new BackupVerificationError("content_conflict", "record_count_mismatch");
    }
    if (options.expected.recordCount !== null && recordCount !== options.expected.recordCount) {
      throw new BackupVerificationError("content_conflict", "cached_record_count_mismatch");
    }
  } finally {
    doc.free();
  }
  return { manifest, snapshot: parsed.snapshot };
}

/**
 * 完整读回验证：整体哈希 → 严格格式解析 → manifest 与任务内固定字节一致 →
 * 归属匹配 → 快照长度与哈希 → 全新 Loro 导入与业务校验 → 版本摘要与记录数。
 */
export async function verifyBundleReadBack(options: {
  bytes: Uint8Array;
  expectedBundleSha256: string;
  expectedManifestJson: string;
  expectedOwnership: {
    environment: string;
    accountId: string;
    documentType: string;
    streamId: string;
    revision: number;
  };
}): Promise<BackupBundleReadBack> {
  const bundleSha256 = await sha256Hex(options.bytes);
  if (bundleSha256 !== options.expectedBundleSha256) {
    throw new BackupVerificationError("content_conflict", "bundle_sha256_mismatch");
  }
  let parsed: ReturnType<typeof parseBundle>;
  try {
    parsed = parseBundle(options.bytes);
  } catch (error) {
    if (error instanceof BackupFormatError) throw new BackupVerificationError("format_conflict", error.message);
    throw error;
  }
  const manifestText = new TextDecoder().decode(parsed.manifestBytes);
  if (manifestText !== options.expectedManifestJson) {
    throw new BackupVerificationError("content_conflict", "manifest_bytes_mismatch");
  }
  const manifest = parsed.manifest;
  if (manifest.environment !== options.expectedOwnership.environment
    || manifest.accountId !== options.expectedOwnership.accountId
    || manifest.documentType !== options.expectedOwnership.documentType
    || manifest.backupStreamId !== options.expectedOwnership.streamId
    || manifest.revision !== options.expectedOwnership.revision) {
    throw new BackupVerificationError("ownership_conflict", "manifest_ownership_mismatch");
  }
  if (parsed.snapshot.byteLength !== manifest.snapshotBytes) {
    throw new BackupVerificationError("content_conflict", "snapshot_length_mismatch");
  }
  const snapshotSha256 = await sha256Hex(parsed.snapshot);
  if (snapshotSha256 !== manifest.snapshotSha256) {
    throw new BackupVerificationError("content_conflict", "snapshot_sha256_mismatch");
  }
  const doc = new LoroDoc();
  try {
    try {
      importSyncSnapshot(doc, parsed.snapshot);
    } catch (error) {
      if (error instanceof InvalidSyncDocument) {
        throw new BackupVerificationError("content_conflict", "snapshot_import_failed");
      }
      throw error;
    }
    const version = doc.version();
    try {
      const digest = await computeHistoryVersionDigest(version.toJSON());
      if (digest !== manifest.historyVersionSha256) {
        throw new BackupVerificationError("content_conflict", "history_digest_mismatch");
      }
    } finally {
      version.free();
    }
    const recordCount = readRecords(doc).length;
    if (recordCount !== manifest.recordCount) {
      throw new BackupVerificationError("content_conflict", "record_count_mismatch");
    }
  } finally {
    doc.free();
  }
  return { manifest, snapshot: parsed.snapshot };
}

/**
 * 读回完成标记并核对确定内容：解析必须成功，且全部字段与任务固定的标记一致；
 * 仅字段外观不同（空白、顺序）不构成冲突，任何字段差异都是冲突。
 */
export function verifyMarkerContent(options: {
  bytes: Uint8Array;
  expectedMarker: BackupCommitMarker;
}): BackupCommitMarker {
  let marker: BackupCommitMarker;
  try {
    marker = parseMarker(options.bytes);
  } catch (error) {
    if (error instanceof BackupFormatError) throw new BackupVerificationError("format_conflict", error.message);
    throw error;
  }
  const expected = options.expectedMarker;
  if (marker.format !== expected.format
    || marker.formatVersion !== expected.formatVersion
    || marker.environment !== expected.environment
    || marker.accountId !== expected.accountId
    || marker.documentType !== expected.documentType
    || marker.backupStreamId !== expected.backupStreamId
    || marker.revision !== expected.revision
    || marker.objectKey !== expected.objectKey
    || marker.bundleBytes !== expected.bundleBytes
    || marker.bundleSha256 !== expected.bundleSha256) {
    throw new BackupVerificationError("content_conflict", "marker_content_mismatch");
  }
  return marker;
}
