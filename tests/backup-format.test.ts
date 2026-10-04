import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_ENVIRONMENT,
  BACKUP_FORMAT_VERSION_V1,
  BACKUP_FORMAT_VERSION_V2,
  BackupFormatError,
  accountDocumentPrefix,
  backupStreamPrefix,
  bundleObjectKey,
  commitMarkerKey,
  computeHistoryVersionDigest,
  encodeBundle,
  formatRevisionPathComponent,
  parseBundle,
  parseCommitMarkerKey,
  parseManifest,
  parseMarker,
  serializeManifest,
  serializeMarker,
  toIsoUtc,
  type BackupManifestV1,
  type BackupManifestV2,
} from "../src/worker/backup/backup-format";
import { initializeTestLoro } from "./helpers/sync-fixtures";
import { LoroDoc } from "loro-crdt/web";
import { writeRecord } from "../src/data/refueling-document";
import { syntheticRecord } from "./helpers/sync-fixtures";

const accountId = "00000000-0000-4000-8000-00000000000a";
const streamId = "00000000-0000-4000-8000-00000000000b";

function sampleManifestV1(overrides: Partial<BackupManifestV1> = {}): BackupManifestV1 {
  return {
    format: "hako-independent-backup",
    formatVersion: BACKUP_FORMAT_VERSION_V1,
    environment: BACKUP_ENVIRONMENT,
    accountId,
    documentType: "refueling",
    sourceGeneration: { kind: "legacy-account-v1", id: accountId },
    backupStreamId: streamId,
    revision: 3,
    reason: "history-change",
    capturedAt: toIsoUtc(Date.parse("2026-10-04T01:02:03.456Z")),
    sourceCommittedAt: toIsoUtc(Date.parse("2026-10-04T01:01:59.000Z")),
    previousCompletedRevision: 2,
    firstPendingRevision: 3,
    businessSchema: "hako-refueling-records-v1",
    syncProtocol: 1,
    loroVersion: "1.16.3",
    snapshotMode: "snapshot",
    snapshotBytes: 128,
    snapshotSha256: "a".repeat(64),
    historyVersionSha256: "b".repeat(64),
    recordCount: 4,
    ...overrides,
  };
}

function sampleManifestV2(overrides: Partial<BackupManifestV2> = {}): BackupManifestV2 {
  return {
    format: "hako-independent-backup",
    formatVersion: BACKUP_FORMAT_VERSION_V2,
    environment: BACKUP_ENVIRONMENT,
    accountId,
    documentType: "refueling",
    sourceGeneration: { kind: "document-generation-v1", id: accountId },
    generationOrigin: { kind: "initial" },
    backupStreamId: streamId,
    revision: 3,
    reason: "history-change",
    capturedAt: toIsoUtc(Date.parse("2026-10-04T01:02:03.456Z")),
    sourceCommittedAt: toIsoUtc(Date.parse("2026-10-04T01:01:59.000Z")),
    previousCompletedRevision: 2,
    firstPendingRevision: 3,
    businessSchema: "hako-refueling-records-v1",
    syncProtocol: 2,
    loroVersion: "1.16.3",
    snapshotMode: "snapshot",
    snapshotBytes: 128,
    snapshotSha256: "a".repeat(64),
    historyVersionSha256: "b".repeat(64),
    recordCount: 4,
    ...overrides,
  };
}

const restoreOrigin = {
  kind: "restore" as const,
  requestId: "00000000-0000-4000-8000-00000000000c",
  previousGeneration: "00000000-0000-4000-8000-00000000000d",
  targetBackup: { backupStreamId: streamId, revision: 2, bundleSha256: "c".repeat(64) },
  protectionBackup: { backupStreamId: streamId, revision: 3, bundleSha256: "d".repeat(64) },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeAll(initializeTestLoro);

describe("备份包格式", () => {
  it("manifest 固定字段顺序序列化，解析往返一致且拒绝未知字段与坏值", () => {
    const manifest = sampleManifestV1();
    const bytes = serializeManifest(manifest);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('{"format":"hako-independent-backup","formatVersion":1,')).toBe(true);
    expect(parseManifest(bytes)).toEqual(manifest);

    const withUnknown = new TextEncoder().encode(text.replace('{"format"', '{"extra":1,"format"'));
    expect(() => parseManifest(withUnknown)).toThrow(BackupFormatError);
    const badVersion = new TextEncoder().encode(text.replace('"formatVersion":1', '"formatVersion":2'));
    expect(() => parseManifest(badVersion)).toThrow(BackupFormatError);
    const badSha = new TextEncoder().encode(text.replace(`"${"a".repeat(64)}"`, `"${"A".repeat(64)}"`));
    expect(() => parseManifest(badSha)).toThrow(BackupFormatError);
    const badAccount = new TextEncoder().encode(text.replace(accountId, "not-a-uuid"));
    expect(() => parseManifest(badAccount)).toThrow(BackupFormatError);
    const negativeRevision = new TextEncoder().encode(text.replace('"revision":3', '"revision":-1'));
    expect(() => parseManifest(negativeRevision)).toThrow(BackupFormatError);
    const badReason = new TextEncoder().encode(text.replace('"reason":"history-change"', '"reason":"manual"'));
    expect(() => parseManifest(badReason)).toThrow(BackupFormatError);
    // v1 不接受 restore-baseline 与 v2 专属字段。
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"reason":"history-change"', '"reason":"restore-baseline"')))).toThrow(BackupFormatError);
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"businessSchema"', '"generationOrigin":{"kind":"initial"},"businessSchema"')))).toThrow(BackupFormatError);
    const badSnapshotBytes = new TextEncoder().encode(
      text.replace('"snapshotBytes":128', '"snapshotBytes":5000000'),
    );
    expect(() => parseManifest(badSnapshotBytes)).toThrow(BackupFormatError);
  });

  it("v2 manifest：document-generation 来源、generationOrigin、restore-baseline 与协议 2；严格拒绝未知字段", () => {
    const manifest = sampleManifestV2({ generationOrigin: restoreOrigin, reason: "restore-baseline" });
    const bytes = serializeManifest(manifest);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('{"format":"hako-independent-backup","formatVersion":2,')).toBe(true);
    expect(text).toContain('"sourceGeneration":{"kind":"document-generation-v1"');
    expect(parseManifest(bytes)).toEqual(manifest);

    const initial = sampleManifestV2({ reason: "baseline" });
    expect(parseManifest(serializeManifest(initial))).toEqual(initial);
    // v2 拒绝 legacy 来源、错误 syncProtocol 与未知来源对象/字段。
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"document-generation-v1"', '"legacy-account-v1"')))).toThrow(BackupFormatError);
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"syncProtocol":2', '"syncProtocol":1')))).toThrow(BackupFormatError);
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"generationOrigin":{"kind":"restore"', '"generationOrigin":{"kind":"other"')))).toThrow(BackupFormatError);
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"requestId"', '"requestIdx"')))).toThrow(BackupFormatError);
    // restore 来源字段非法值拒绝。
    expect(() => parseManifest(new TextEncoder().encode(text.replace(restoreOrigin.requestId, "not-a-uuid")))).toThrow(BackupFormatError);
  });

  it("manifest 允许 sourceCommittedAt 为 null（启用前基线），但 capturedAt 必须存在", () => {
    const manifest = sampleManifestV1({ reason: "baseline", sourceCommittedAt: null, previousCompletedRevision: null, firstPendingRevision: null, revision: 1 });
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    const text = new TextDecoder().decode(serializeManifest(manifest));
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"capturedAt"', '"capturedAtX"')))).toThrow(BackupFormatError);
  });

  it("完成标记序列化与解析（v1/v2 双版本）；未知字段、坏 UUID 与坏哈希都拒绝", () => {
    const key = bundleObjectKey(BACKUP_ENVIRONMENT, accountId, "refueling", streamId, 7, "c".repeat(64));
    for (const formatVersion of [BACKUP_FORMAT_VERSION_V1, BACKUP_FORMAT_VERSION_V2] as const) {
      const marker = {
        format: "hako-independent-backup",
        formatVersion,
        environment: BACKUP_ENVIRONMENT,
        accountId,
        documentType: "refueling",
        backupStreamId: streamId,
        revision: 7,
        objectKey: key,
        bundleBytes: 512,
        bundleSha256: "c".repeat(64),
      } as const;
      expect(parseMarker(serializeMarker(marker))).toEqual(marker);
      expect(serializeMarker(marker).byteLength).toBeLessThanOrEqual(4096);
    }
    const marker = {
      format: "hako-independent-backup",
      formatVersion: BACKUP_FORMAT_VERSION_V1,
      environment: BACKUP_ENVIRONMENT,
      accountId,
      documentType: "refueling",
      backupStreamId: streamId,
      revision: 7,
      objectKey: key,
      bundleBytes: 512,
      bundleSha256: "c".repeat(64),
    } as const;
    const text = new TextDecoder().decode(serializeMarker(marker));
    expect(() => parseMarker(new TextEncoder().encode(text.replace('"revision":7', '"revision":"7"')))).toThrow(BackupFormatError);
    expect(() => parseMarker(new TextEncoder().encode(text.replace(streamId, "stream")))).toThrow(BackupFormatError);
    expect(() => parseMarker(new TextEncoder().encode(text.replace('"bundleSha256"', '"bundleSha2562"')))).toThrow(BackupFormatError);
    expect(() => parseMarker(new TextEncoder().encode(text.replace('"formatVersion":1', '"formatVersion":3')))).toThrow(BackupFormatError);
  });

  it("包编码与严格解析：v1/v2 魔数区分、长度、尾随数据与截断；魔数与 manifest 版本必须一致", () => {
    for (const [name, manifest, formatVersion] of [
      ["v1", sampleManifestV1(), BACKUP_FORMAT_VERSION_V1],
      ["v2", sampleManifestV2(), BACKUP_FORMAT_VERSION_V2],
    ] as const) {
      const manifestBytes = serializeManifest(manifest);
      const snapshot = new Uint8Array(128).fill(7);
      const bundle = encodeBundle(manifestBytes, snapshot, formatVersion);
      const parsed = parseBundle(bundle);
      expect(new TextDecoder().decode(parsed.manifestBytes)).toBe(new TextDecoder().decode(manifestBytes));
      expect([...parsed.snapshot]).toEqual([...snapshot]);
      expect(parsed.manifest.snapshotBytes).toBe(128);
      expect(parsed.formatVersion).toBe(formatVersion);
      expect(parsed.manifest.formatVersion).toBe(formatVersion);

      const trailing = new Uint8Array(bundle.byteLength + 1);
      trailing.set(bundle, 0); trailing[bundle.byteLength] = 9;
      expect(() => parseBundle(trailing), name).toThrow(BackupFormatError);
      const truncated = bundle.slice(0, bundle.byteLength - 1);
      expect(() => parseBundle(truncated), name).toThrow(BackupFormatError);
      const badLength = new Uint8Array(bundle);
      new DataView(badLength.buffer).setUint32(8, 0, false);
      expect(() => parseBundle(badLength), name).toThrow(BackupFormatError);
    }
    // v1 魔数配 v2 manifest：拒绝（不能靠 JSON 外观绕过魔数区分），反之亦然。
    const mixedV1 = encodeBundle(serializeManifest(sampleManifestV2()), new Uint8Array(8), BACKUP_FORMAT_VERSION_V1);
    expect(() => parseBundle(mixedV1)).toThrow(BackupFormatError);
    const mixedV2 = encodeBundle(serializeManifest(sampleManifestV1()), new Uint8Array(8), BACKUP_FORMAT_VERSION_V2);
    expect(() => parseBundle(mixedV2)).toThrow(BackupFormatError);
    const badMagic = encodeBundle(serializeManifest(sampleManifestV1()), new Uint8Array(8), BACKUP_FORMAT_VERSION_V1);
    badMagic[3] = "X".charCodeAt(0);
    expect(() => parseBundle(badMagic)).toThrow(BackupFormatError);
  });

  it("版本向量摘要：十进制字符串、按整数值排序、去前导零、64 位精度不丢失", async () => {
    // 与 node:crypto 独立计算的期望值对照。
    const expected = sha256(new TextEncoder().encode(JSON.stringify([["123", "5"], ["999", "1"]])));
    await expect(computeHistoryVersionDigest(new Map([["999", 1], ["123", 5]]))).resolves.toBe(expected);
    // 数值排序而非字典序：10000000000000000000 < 18446744073709551615，但字典序相反。
    const numericOrder = sha256(new TextEncoder().encode(
      JSON.stringify([["10000000000000000000", "1"], ["18446744073709551615", "2"]]),
    ));
    await expect(computeHistoryVersionDigest([
      ["18446744073709551615", 2],
      ["10000000000000000000", 1],
    ])).resolves.toBe(numericOrder);
    // 前导零规范化：007 与 7 是同一 PeerID。
    await expect(computeHistoryVersionDigest([["007", 3]])).resolves.toBe(
      await computeHistoryVersionDigest([["7", 3]]),
    );
    await expect(computeHistoryVersionDigest([["0x10", 1]])).rejects.toThrow(BackupFormatError);
    await expect(computeHistoryVersionDigest([["7", -1]])).rejects.toThrow(BackupFormatError);
  });

  it("对象键布局与 revision 路径组件", () => {
    expect(formatRevisionPathComponent(1)).toBe("00000000000000000001");
    // JS 安全整数上界以内可表示的最大 revision；超出安全整数即拒绝。
    expect(formatRevisionPathComponent(9007199254740991)).toBe("00009007199254740991");
    expect(() => formatRevisionPathComponent(9007199254740992)).toThrow(BackupFormatError);
    expect(() => formatRevisionPathComponent(10 ** 20)).toThrow(BackupFormatError);
    const key = commitMarkerKey(BACKUP_ENVIRONMENT, accountId, "refueling", streamId, 42);
    expect(key).toBe(`${backupStreamPrefix(BACKUP_ENVIRONMENT, accountId, "refueling", streamId)}/commits/00000000000000000042.json`);
    expect(parseCommitMarkerKey(key)).toEqual({
      environment: BACKUP_ENVIRONMENT, accountId, documentType: "refueling", streamId, revision: 42,
    });
    const bundleKey = bundleObjectKey(BACKUP_ENVIRONMENT, accountId, "refueling", streamId, 42, "d".repeat(64));
    expect(bundleKey.endsWith(`/objects/00000000000000000042-${"d".repeat(64)}.hakobak`)).toBe(true);
    expect(parseCommitMarkerKey(`${accountDocumentPrefix(BACKUP_ENVIRONMENT, accountId, "refueling")}/other`)).toBeNull();
    expect(parseCommitMarkerKey(key.replace(".json", ".txt"))).toBeNull();
    expect(parseCommitMarkerKey(key.replace("00000000000000000042", "42"))).toBeNull();
  });

  it("摘要对真实 Loro 文档版本向量稳定且随历史推进变化", async () => {
    const doc = new LoroDoc();
    const empty = await computeHistoryVersionDigest(doc.version().toJSON());
    expect(empty).toBe(sha256(new TextEncoder().encode("[]")));
    writeRecord(doc, "one", syntheticRecord, true);
    doc.commit();
    const digest = await computeHistoryVersionDigest(doc.version().toJSON());
    expect(digest).not.toBe(empty);
    // 相同历史再次导入到新文档，摘要一致。
    const copy = new LoroDoc();
    copy.import(doc.export({ mode: "snapshot" }));
    await expect(computeHistoryVersionDigest(copy.version().toJSON())).resolves.toBe(digest);
    doc.free();
    copy.free();
  });
});
