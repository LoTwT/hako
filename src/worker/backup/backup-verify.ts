// 独立备份的读回验证器：发布完成标记前，对 R2 读回的字节做完整验证，
// 并用全新 Loro 文档独立导入核对结构、业务字段、版本摘要与记录数。
// 这证明该备份在验证时可读、可解析且与捕获版本一致；不是恢复到生产应用的证明。

import { LoroDoc } from "loro-crdt/web";
import { importSyncSnapshot, InvalidSyncDocument } from "../../data/sync-document";
import { readRecords } from "../../data/refueling-document";
import {
  BackupFormatError,
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
  | "invalid_source_document";

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
