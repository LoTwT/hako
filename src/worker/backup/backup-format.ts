// 独立备份的包格式、完成标记与对象键布局。
// 本文件是格式的唯一权威实现：序列化、严格解析、版本向量摘要与键的构造／反解。
// 业务字段校验不在格式层做，引用既有验证器（见 backup-verify.ts 与同步合同）。
//
// 格式 v1（已部署）：8 字节 ASCII `HAKOBK1\n` + 4 字节大端 manifest 长度 + UTF-8 JSON
// manifest + 原始 Loro snapshot；总长必须精确匹配，无尾随数据。
// 格式 v2（代次兼容基础 A 新增）：魔数 `HAKOBK2\n`，二进制长度结构与上限沿用 v1；
// manifest 与 marker 的 formatVersion 均为 2 且必须彼此匹配，sourceGeneration 为
// document-generation-v1，新增 generationOrigin，syncProtocol 为 2，reason 增加
// restore-baseline。对象布局仍为 layout-v1，继续使用原 stream 与全局递增 revision。
// 解析显式区分 v1/v2，不放宽 v1 的严格字段校验，也不根据账号 ID 猜测现代次。

import { MAX_SYNC_BYTES } from "../../shared/sync-protocol";
import {
  parseGenerationOrigin,
  serializeGenerationOrigin,
  type GenerationOrigin,
} from "../../shared/document-generation";

/** 备份对象的固定环境标签；生产 Worker 与本地模拟共用同一代码路径。 */
export const BACKUP_ENVIRONMENT = "production";

/** 布局与格式的标识常量；与 Loro 库版本、同步协议版本和业务 schema 分开维护。 */
export const BACKUP_FORMAT_NAME = "hako-independent-backup";
export const BACKUP_FORMAT_VERSION_V1 = 1;
export const BACKUP_FORMAT_VERSION_V2 = 2;
export type BackupFormatVersion = typeof BACKUP_FORMAT_VERSION_V1 | typeof BACKUP_FORMAT_VERSION_V2;
export const BACKUP_DOCUMENT_TYPE = "refueling";
export const BACKUP_BUSINESS_SCHEMA = "hako-refueling-records-v1";
export const BACKUP_LORO_VERSION = "1.16.3";

const BUNDLE_MAGIC_V1 = "HAKOBK1\n";
const BUNDLE_MAGIC_V2 = "HAKOBK2\n";
const BUNDLE_MAGIC_BYTES = 8;
const MANIFEST_LENGTH_BYTES = 4;
const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_MARKER_BYTES = 4 * 1024;
/** 包内 snapshot 上限沿用同步合同的 4 MiB；包额外只有小型头部与 manifest。 */
export const MAX_SNAPSHOT_BYTES = MAX_SYNC_BYTES;
/** manifest 与 marker 之外的包开销上限，用于读回前的长度预检。 */
const MAX_BUNDLE_OVERHEAD_BYTES = BUNDLE_MAGIC_BYTES + MANIFEST_LENGTH_BYTES + MAX_MANIFEST_BYTES;

/** 读取侧对包／标记长度的共同上限；超长输入直接拒绝，不做无界缓冲。 */
export const MAX_BUNDLE_BYTES = MAX_SNAPSHOT_BYTES + MAX_BUNDLE_OVERHEAD_BYTES;

const REVISION_DIGITS = 20;

export type BackupCaptureReason = "baseline" | "history-change" | "restore-baseline";

interface BackupManifestBase {
  format: typeof BACKUP_FORMAT_NAME;
  environment: string;
  accountId: string;
  documentType: typeof BACKUP_DOCUMENT_TYPE;
  backupStreamId: string;
  revision: number;
  /** DO 冻结时刻；一旦入库不再改变。 */
  capturedAt: string;
  /** 该源版本持久提交时刻；启用前基线没有已知服务端提交时间时为 null。 */
  sourceCommittedAt: string | null;
  previousCompletedRevision: number | null;
  firstPendingRevision: number | null;
  businessSchema: typeof BACKUP_BUSINESS_SCHEMA;
  loroVersion: typeof BACKUP_LORO_VERSION;
  snapshotMode: "snapshot";
  snapshotBytes: number;
  snapshotSha256: string;
  historyVersionSha256: string;
  recordCount: number;
}

/** 格式 v1：legacy 账号来源，仅 baseline/history-change。 */
export interface BackupManifestV1 extends BackupManifestBase {
  formatVersion: typeof BACKUP_FORMAT_VERSION_V1;
  sourceGeneration: { kind: "legacy-account-v1"; id: string };
  reason: "baseline" | "history-change";
  syncProtocol: 1;
}

/** 格式 v2：文档代次来源，携带代次来源；restore-baseline 仅用于切换事务冻结的首份恢复快照。 */
export interface BackupManifestV2 extends BackupManifestBase {
  formatVersion: typeof BACKUP_FORMAT_VERSION_V2;
  sourceGeneration: { kind: "document-generation-v1"; id: string };
  generationOrigin: GenerationOrigin;
  reason: BackupCaptureReason;
  syncProtocol: 2;
}

export type BackupManifest = BackupManifestV1 | BackupManifestV2;

export interface BackupCommitMarker {
  format: typeof BACKUP_FORMAT_NAME;
  formatVersion: BackupFormatVersion;
  environment: string;
  accountId: string;
  documentType: typeof BACKUP_DOCUMENT_TYPE;
  backupStreamId: string;
  revision: number;
  objectKey: string;
  bundleBytes: number;
  bundleSha256: string;
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFormatError";
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 显式归一化视图：避免 SharedArrayBuffer 泛型影响，同时尽量不复制大包。
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toIsoUtc(timeMs: number): string {
  return new Date(timeMs).toISOString();
}

// ---------------------------------------------------------------------------
// Manifest / marker：固定字段顺序序列化，严格解析（未知字段、类型与取值都拒绝）。
// ---------------------------------------------------------------------------

function decodeJson(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new BackupFormatError("length_out_of_range");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new BackupFormatError("invalid_utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BackupFormatError("invalid_json");
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BackupFormatError("not_an_object");
  return value as Record<string, unknown>;
}

function requireExactKeys(object: Record<string, unknown>, keys: readonly string[]): void {
  const present = Object.keys(object);
  if (present.length !== keys.length || !keys.every((key) => key in object)) {
    throw new BackupFormatError("unexpected_fields");
  }
}

function requireString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new BackupFormatError("invalid_field_type");
  return value;
}

function requireFixedString<T extends string>(object: Record<string, unknown>, key: string, expected: T): T {
  const value = requireString(object, key);
  if (value !== expected) throw new BackupFormatError("unexpected_field_value");
  return expected;
}

function requireSafeInteger(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BackupFormatError("invalid_field_type");
  }
  return value;
}

function requireUuid(object: Record<string, unknown>, key: string): string {
  const value = requireString(object, key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new BackupFormatError("invalid_field_value");
  }
  return value;
}

function requireSha256Hex(object: Record<string, unknown>, key: string): string {
  const value = requireString(object, key);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new BackupFormatError("invalid_field_value");
  return value;
}

function requireIsoUtcOrNull(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    throw new BackupFormatError("invalid_field_value");
  }
  return value;
}

/** 按固定字段顺序构造 JSON 文本；字段一旦确定不再改变顺序，保证字节级稳定。 */
function serializeFixedJson(fields: readonly (readonly [string, unknown])[]): Uint8Array {
  const object: Record<string, unknown> = {};
  for (const [key, value] of fields) object[key] = value;
  return new TextEncoder().encode(JSON.stringify(object));
}

export function serializeManifest(manifest: BackupManifest): Uint8Array {
  if (manifest.formatVersion === BACKUP_FORMAT_VERSION_V2) {
    return serializeFixedJson([
      ["format", BACKUP_FORMAT_NAME],
      ["formatVersion", BACKUP_FORMAT_VERSION_V2],
      ["environment", manifest.environment],
      ["accountId", manifest.accountId],
      ["documentType", BACKUP_DOCUMENT_TYPE],
      ["sourceGeneration", { kind: "document-generation-v1", id: manifest.sourceGeneration.id }],
      ["generationOrigin", JSON.parse(serializeGenerationOrigin(manifest.generationOrigin))],
      ["backupStreamId", manifest.backupStreamId],
      ["revision", manifest.revision],
      ["reason", manifest.reason],
      ["capturedAt", manifest.capturedAt],
      ["sourceCommittedAt", manifest.sourceCommittedAt],
      ["previousCompletedRevision", manifest.previousCompletedRevision],
      ["firstPendingRevision", manifest.firstPendingRevision],
      ["businessSchema", BACKUP_BUSINESS_SCHEMA],
      ["syncProtocol", 2],
      ["loroVersion", BACKUP_LORO_VERSION],
      ["snapshotMode", "snapshot"],
      ["snapshotBytes", manifest.snapshotBytes],
      ["snapshotSha256", manifest.snapshotSha256],
      ["historyVersionSha256", manifest.historyVersionSha256],
      ["recordCount", manifest.recordCount],
    ]);
  }
  // v1 的固定字段顺序（历史兼容，字节级不变）。
  return serializeFixedJson([
    ["format", BACKUP_FORMAT_NAME],
    ["formatVersion", BACKUP_FORMAT_VERSION_V1],
    ["environment", manifest.environment],
    ["accountId", manifest.accountId],
    ["documentType", BACKUP_DOCUMENT_TYPE],
    ["sourceGeneration", { kind: "legacy-account-v1", id: manifest.accountId }],
    ["backupStreamId", manifest.backupStreamId],
    ["revision", manifest.revision],
    ["reason", manifest.reason],
    ["capturedAt", manifest.capturedAt],
    ["sourceCommittedAt", manifest.sourceCommittedAt],
    ["previousCompletedRevision", manifest.previousCompletedRevision],
    ["firstPendingRevision", manifest.firstPendingRevision],
    ["businessSchema", BACKUP_BUSINESS_SCHEMA],
    ["syncProtocol", 1],
    ["loroVersion", BACKUP_LORO_VERSION],
    ["snapshotMode", "snapshot"],
    ["snapshotBytes", manifest.snapshotBytes],
    ["snapshotSha256", manifest.snapshotSha256],
    ["historyVersionSha256", manifest.historyVersionSha256],
    ["recordCount", manifest.recordCount],
  ]);
}

const manifestV1FieldOrder = [
  "format", "formatVersion", "environment", "accountId", "documentType", "sourceGeneration",
  "backupStreamId", "revision", "reason", "capturedAt", "sourceCommittedAt",
  "previousCompletedRevision", "firstPendingRevision", "businessSchema", "syncProtocol",
  "loroVersion", "snapshotMode", "snapshotBytes", "snapshotSha256", "historyVersionSha256",
  "recordCount",
] as const;

const manifestV2FieldOrder = [
  "format", "formatVersion", "environment", "accountId", "documentType", "sourceGeneration",
  "generationOrigin", "backupStreamId", "revision", "reason", "capturedAt", "sourceCommittedAt",
  "previousCompletedRevision", "firstPendingRevision", "businessSchema", "syncProtocol",
  "loroVersion", "snapshotMode", "snapshotBytes", "snapshotSha256", "historyVersionSha256",
  "recordCount",
] as const;

export function parseManifest(bytes: Uint8Array): BackupManifest {
  const object = requireObject(decodeJson(bytes, MAX_MANIFEST_BYTES));
  const formatVersion = object.formatVersion;
  if (formatVersion === BACKUP_FORMAT_VERSION_V1) return parseManifestV1(object);
  if (formatVersion === BACKUP_FORMAT_VERSION_V2) return parseManifestV2(object);
  throw new BackupFormatError("unexpected_field_value");
}

function parseManifestV1(object: Record<string, unknown>): BackupManifestV1 {
  requireExactKeys(object, manifestV1FieldOrder);
  requireFixedString(object, "format", BACKUP_FORMAT_NAME);
  const reason = requireString(object, "reason");
  if (reason !== "baseline" && reason !== "history-change") throw new BackupFormatError("invalid_field_value");
  const sourceGeneration = requireObject(object.sourceGeneration);
  requireExactKeys(sourceGeneration, ["kind", "id"]);
  requireFixedString(sourceGeneration, "kind", "legacy-account-v1");
  const snapshotBytes = requireSafeInteger(object, "snapshotBytes");
  if (snapshotBytes > MAX_SNAPSHOT_BYTES) throw new BackupFormatError("snapshot_too_large");
  return {
    format: BACKUP_FORMAT_NAME,
    formatVersion: BACKUP_FORMAT_VERSION_V1,
    environment: requireString(object, "environment"),
    accountId: requireUuid(object, "accountId"),
    documentType: requireFixedString(object, "documentType", BACKUP_DOCUMENT_TYPE),
    sourceGeneration: { kind: "legacy-account-v1", id: requireUuid(sourceGeneration, "id") },
    backupStreamId: requireUuid(object, "backupStreamId"),
    revision: requireSafeInteger(object, "revision"),
    reason,
    capturedAt: requireIsoUtc(object, "capturedAt"),
    sourceCommittedAt: requireIsoUtcOrNull(object, "sourceCommittedAt"),
    previousCompletedRevision: requireRevisionOrNull(object, "previousCompletedRevision"),
    firstPendingRevision: requireRevisionOrNull(object, "firstPendingRevision"),
    businessSchema: requireFixedString(object, "businessSchema", BACKUP_BUSINESS_SCHEMA),
    syncProtocol: requireFixedInteger(object, "syncProtocol", 1),
    loroVersion: requireFixedString(object, "loroVersion", BACKUP_LORO_VERSION),
    snapshotMode: requireFixedString(object, "snapshotMode", "snapshot"),
    snapshotBytes,
    snapshotSha256: requireSha256Hex(object, "snapshotSha256"),
    historyVersionSha256: requireSha256Hex(object, "historyVersionSha256"),
    recordCount: requireSafeInteger(object, "recordCount"),
  };
}

function parseManifestV2(object: Record<string, unknown>): BackupManifestV2 {
  requireExactKeys(object, manifestV2FieldOrder);
  requireFixedString(object, "format", BACKUP_FORMAT_NAME);
  const reason = requireString(object, "reason");
  if (reason !== "baseline" && reason !== "history-change" && reason !== "restore-baseline") {
    throw new BackupFormatError("invalid_field_value");
  }
  const sourceGeneration = requireObject(object.sourceGeneration);
  requireExactKeys(sourceGeneration, ["kind", "id"]);
  requireFixedString(sourceGeneration, "kind", "document-generation-v1");
  const origin = parseGenerationOrigin(object.generationOrigin);
  if (origin === null) throw new BackupFormatError("invalid_field_value");
  const snapshotBytes = requireSafeInteger(object, "snapshotBytes");
  if (snapshotBytes > MAX_SNAPSHOT_BYTES) throw new BackupFormatError("snapshot_too_large");
  return {
    format: BACKUP_FORMAT_NAME,
    formatVersion: BACKUP_FORMAT_VERSION_V2,
    environment: requireString(object, "environment"),
    accountId: requireUuid(object, "accountId"),
    documentType: requireFixedString(object, "documentType", BACKUP_DOCUMENT_TYPE),
    sourceGeneration: { kind: "document-generation-v1", id: requireUuid(sourceGeneration, "id") },
    generationOrigin: origin,
    backupStreamId: requireUuid(object, "backupStreamId"),
    revision: requireSafeInteger(object, "revision"),
    reason,
    capturedAt: requireIsoUtc(object, "capturedAt"),
    sourceCommittedAt: requireIsoUtcOrNull(object, "sourceCommittedAt"),
    previousCompletedRevision: requireRevisionOrNull(object, "previousCompletedRevision"),
    firstPendingRevision: requireRevisionOrNull(object, "firstPendingRevision"),
    businessSchema: requireFixedString(object, "businessSchema", BACKUP_BUSINESS_SCHEMA),
    syncProtocol: requireFixedInteger(object, "syncProtocol", 2),
    loroVersion: requireFixedString(object, "loroVersion", BACKUP_LORO_VERSION),
    snapshotMode: requireFixedString(object, "snapshotMode", "snapshot"),
    snapshotBytes,
    snapshotSha256: requireSha256Hex(object, "snapshotSha256"),
    historyVersionSha256: requireSha256Hex(object, "historyVersionSha256"),
    recordCount: requireSafeInteger(object, "recordCount"),
  };
}

function requireIsoUtc(object: Record<string, unknown>, key: string): string {
  const value = requireIsoUtcOrNull(object, key);
  if (value === null) throw new BackupFormatError("invalid_field_value");
  return value;
}

function requireRevisionOrNull(object: Record<string, unknown>, key: string): number | null {
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BackupFormatError("invalid_field_type");
  }
  return value;
}

function requireFixedInteger<T extends number>(object: Record<string, unknown>, key: string, expected: T): T {
  const value = requireSafeInteger(object, key);
  if (value !== expected) throw new BackupFormatError("unexpected_field_value");
  return expected;
}

const markerFieldOrder = [
  "format", "formatVersion", "environment", "accountId", "documentType", "backupStreamId",
  "revision", "objectKey", "bundleBytes", "bundleSha256",
] as const;

export function serializeMarker(marker: BackupCommitMarker): Uint8Array {
  return serializeFixedJson([
    ["format", BACKUP_FORMAT_NAME],
    ["formatVersion", marker.formatVersion],
    ["environment", marker.environment],
    ["accountId", marker.accountId],
    ["documentType", BACKUP_DOCUMENT_TYPE],
    ["backupStreamId", marker.backupStreamId],
    ["revision", marker.revision],
    ["objectKey", marker.objectKey],
    ["bundleBytes", marker.bundleBytes],
    ["bundleSha256", marker.bundleSha256],
  ]);
}

export function parseMarker(bytes: Uint8Array): BackupCommitMarker {
  const object = requireObject(decodeJson(bytes, MAX_MARKER_BYTES));
  requireExactKeys(object, markerFieldOrder);
  requireFixedString(object, "format", BACKUP_FORMAT_NAME);
  const formatVersion = requireSafeInteger(object, "formatVersion");
  if (formatVersion !== BACKUP_FORMAT_VERSION_V1 && formatVersion !== BACKUP_FORMAT_VERSION_V2) {
    throw new BackupFormatError("unexpected_field_value");
  }
  const objectKey = requireString(object, "objectKey");
  if (objectKey.length === 0 || objectKey.length > 1024) throw new BackupFormatError("invalid_field_value");
  return {
    format: BACKUP_FORMAT_NAME,
    formatVersion,
    environment: requireString(object, "environment"),
    accountId: requireUuid(object, "accountId"),
    documentType: requireFixedString(object, "documentType", BACKUP_DOCUMENT_TYPE),
    backupStreamId: requireUuid(object, "backupStreamId"),
    revision: requireSafeInteger(object, "revision"),
    objectKey,
    bundleBytes: requireSafeInteger(object, "bundleBytes"),
    bundleSha256: requireSha256Hex(object, "bundleSha256"),
  };
}

// ---------------------------------------------------------------------------
// 二进制包：magic + manifest 长度 + manifest + snapshot；严格长度校验。
// 魔数显式区分 v1/v2；v2 包内 manifest 的 formatVersion 必须为 2。
// ---------------------------------------------------------------------------

export interface ParsedBackupBundle {
  manifest: BackupManifest;
  manifestBytes: Uint8Array;
  snapshot: Uint8Array;
  formatVersion: BackupFormatVersion;
}

export function encodeBundle(manifestBytes: Uint8Array, snapshot: Uint8Array, formatVersion: BackupFormatVersion = BACKUP_FORMAT_VERSION_V1): Uint8Array {
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new BackupFormatError("manifest_too_large");
  const magic = formatVersion === BACKUP_FORMAT_VERSION_V2 ? BUNDLE_MAGIC_V2 : BUNDLE_MAGIC_V1;
  const total = BUNDLE_MAGIC_BYTES + MANIFEST_LENGTH_BYTES + manifestBytes.byteLength + snapshot.byteLength;
  const bundle = new Uint8Array(total);
  bundle.set(new TextEncoder().encode(magic), 0);
  new DataView(bundle.buffer).setUint32(BUNDLE_MAGIC_BYTES, manifestBytes.byteLength, false);
  bundle.set(manifestBytes, BUNDLE_MAGIC_BYTES + MANIFEST_LENGTH_BYTES);
  bundle.set(snapshot, BUNDLE_MAGIC_BYTES + MANIFEST_LENGTH_BYTES + manifestBytes.byteLength);
  return bundle;
}

/** 严格解析：magic、manifest 长度与包总长必须精确匹配，尾随数据视为损坏。 */
export function parseBundle(bytes: Uint8Array): ParsedBackupBundle {
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new BackupFormatError("bundle_too_large");
  const headerBytes = BUNDLE_MAGIC_BYTES + MANIFEST_LENGTH_BYTES;
  if (bytes.byteLength <= headerBytes) throw new BackupFormatError("bundle_too_short");
  const magic = new TextDecoder().decode(bytes.slice(0, BUNDLE_MAGIC_BYTES));
  let formatVersion: BackupFormatVersion;
  if (magic === BUNDLE_MAGIC_V1) formatVersion = BACKUP_FORMAT_VERSION_V1;
  else if (magic === BUNDLE_MAGIC_V2) formatVersion = BACKUP_FORMAT_VERSION_V2;
  else throw new BackupFormatError("bad_magic");
  const manifestLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(BUNDLE_MAGIC_BYTES, false);
  if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES) {
    throw new BackupFormatError("manifest_length_out_of_range");
  }
  const manifestEnd = headerBytes + manifestLength;
  if (bytes.byteLength < manifestEnd) throw new BackupFormatError("bundle_truncated");
  const manifestBytes = bytes.slice(headerBytes, manifestEnd);
  const snapshot = bytes.slice(manifestEnd);
  const manifest = parseManifest(manifestBytes);
  // 魔数与 manifest 的格式版本必须一致；不能靠 JSON 外观绕过魔数区分。
  if (manifest.formatVersion !== formatVersion) throw new BackupFormatError("unexpected_field_value");
  if (manifest.snapshotBytes !== snapshot.byteLength) throw new BackupFormatError("snapshot_length_mismatch");
  return { manifest, manifestBytes, snapshot, formatVersion };
}

// ---------------------------------------------------------------------------
// 对象键布局与 revision 的十进制表示。
// ---------------------------------------------------------------------------

export function backupRootPrefix(): string {
  return `hako-backup/layout-v1`;
}

export function accountDocumentPrefix(environment: string, accountId: string, documentType: string): string {
  return `${backupRootPrefix()}/${environment}/accounts/${accountId}/${documentType}`;
}

/** 同一环境下所有账号共享的前缀；用于新序列启用时核对桶内未知账号。 */
export function backupAccountsPrefix(environment: string): string {
  return `${backupRootPrefix()}/${environment}/accounts/`;
}

/** 从备份对象键解析所属账号；不属于本布局的键返回 null。 */
export function accountIdFromBackupKey(key: string): string | null {
  const match = /^hako-backup\/layout-v1\/([a-z0-9-]+)\/accounts\/([0-9a-f-]{36})\//.exec(key);
  return match === null ? null : match[2];
}

export function backupStreamPrefix(environment: string, accountId: string, documentType: string, streamId: string): string {
  return `${accountDocumentPrefix(environment, accountId, documentType)}/${streamId}`;
}

/** revision 以 20 位补零十进制输出；排序以序号为准，缺号是合并的正常结果。 */
export function formatRevisionPathComponent(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 10 ** REVISION_DIGITS) {
    throw new BackupFormatError("revision_out_of_range");
  }
  return revision.toString().padStart(REVISION_DIGITS, "0");
}

export function bundleObjectKey(
  environment: string,
  accountId: string,
  documentType: string,
  streamId: string,
  revision: number,
  bundleSha256: string,
): string {
  return `${backupStreamPrefix(environment, accountId, documentType, streamId)}/objects/` +
    `${formatRevisionPathComponent(revision)}-${bundleSha256}.hakobak`;
}

export function commitMarkerKey(
  environment: string,
  accountId: string,
  documentType: string,
  streamId: string,
  revision: number,
): string {
  return `${backupStreamPrefix(environment, accountId, documentType, streamId)}/commits/` +
    `${formatRevisionPathComponent(revision)}.json`;
}

export interface ParsedMarkerKey {
  environment: string;
  accountId: string;
  documentType: string;
  streamId: string;
  revision: number;
}

/** 严格反解 commit 标记键；任何不符合布局的键都不参与保留集合计算。 */
export function parseCommitMarkerKey(key: string): ParsedMarkerKey | null {
  const match = key.match(
    /^hako-backup\/layout-v1\/([a-z0-9-]+)\/accounts\/([0-9a-f-]{36})\/([a-z-]+)\/([0-9a-f-]{36})\/commits\/(\d{20})\.json$/,
  );
  if (match === null) return null;
  const revision = Number.parseInt(match[5], 10);
  if (!Number.isSafeInteger(revision)) return null;
  return {
    environment: match[1],
    accountId: match[2],
    documentType: match[3],
    streamId: match[4],
    revision,
  };
}

// ---------------------------------------------------------------------------
// 版本向量摘要：PeerID 与计数都转为十进制字符串，按 PeerID 整数值排序后
// 对无空白 JSON 二元组数组做 SHA-256。PeerID 是 64 位整数，绝不能经 Number 转换。
// ---------------------------------------------------------------------------

export async function computeHistoryVersionDigest(
  entries: ReadonlyMap<string, number> | readonly (readonly [string, number])[],
): Promise<string> {
  const normalized: [string, string][] = [];
  const source = entries instanceof Map ? [...entries.entries()] : (entries as readonly (readonly [string, number])[]);
  for (const [peer, counter] of source) {
    if (!/^[0-9]+$/.test(peer)) throw new BackupFormatError("invalid_peer_id");
    if (!Number.isSafeInteger(counter) || counter < 0) throw new BackupFormatError("invalid_counter");
    normalized.push([peer.replace(/^0+(?=\d)/, ""), counter.toString(10)]);
  }
  normalized.sort((left, right) => (BigInt(left[0]) < BigInt(right[0]) ? -1 : BigInt(left[0]) > BigInt(right[0]) ? 1 : 0));
  return sha256Hex(new TextEncoder().encode(JSON.stringify(normalized)));
}
