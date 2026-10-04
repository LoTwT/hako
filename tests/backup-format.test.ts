import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_ENVIRONMENT,
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
  type BackupManifest,
} from "../src/worker/backup/backup-format";
import { initializeTestLoro } from "./helpers/sync-fixtures";
import { LoroDoc } from "loro-crdt/web";
import { writeRecord } from "../src/data/refueling-document";
import { syntheticRecord } from "./helpers/sync-fixtures";

const accountId = "00000000-0000-4000-8000-00000000000a";
const streamId = "00000000-0000-4000-8000-00000000000b";

function sampleManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    format: "hako-independent-backup",
    formatVersion: 1,
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeAll(initializeTestLoro);

describe("备份包格式", () => {
  it("manifest 固定字段顺序序列化，解析往返一致且拒绝未知字段与坏值", () => {
    const manifest = sampleManifest();
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
    const badSnapshotBytes = new TextEncoder().encode(
      text.replace('"snapshotBytes":128', '"snapshotBytes":5000000'),
    );
    expect(() => parseManifest(badSnapshotBytes)).toThrow(BackupFormatError);
  });

  it("manifest 允许 sourceCommittedAt 为 null（启用前基线），但 capturedAt 必须存在", () => {
    const manifest = sampleManifest({ reason: "baseline", sourceCommittedAt: null, previousCompletedRevision: null, firstPendingRevision: null, revision: 1 });
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    const text = new TextDecoder().decode(serializeManifest(manifest));
    expect(() => parseManifest(new TextEncoder().encode(text.replace('"capturedAt"', '"capturedAtX"')))).toThrow(BackupFormatError);
  });

  it("完成标记序列化与解析；未知字段、坏 UUID 与坏哈希都拒绝", () => {
    const key = bundleObjectKey(BACKUP_ENVIRONMENT, accountId, "refueling", streamId, 7, "c".repeat(64));
    const marker = {
      format: "hako-independent-backup",
      formatVersion: 1,
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
    const text = new TextDecoder().decode(serializeMarker(marker));
    expect(() => parseMarker(new TextEncoder().encode(text.replace('"revision":7', '"revision":"7"')))).toThrow(BackupFormatError);
    expect(() => parseMarker(new TextEncoder().encode(text.replace(streamId, "stream")))).toThrow(BackupFormatError);
    expect(() => parseMarker(new TextEncoder().encode(text.replace('"bundleSha256"', '"bundleSha2562"')))).toThrow(BackupFormatError);
    expect(serializeMarker(marker).byteLength).toBeLessThanOrEqual(4096);
  });

  it("包编码与严格解析：magic、长度、尾随数据与截断", () => {
    const manifestBytes = serializeManifest(sampleManifest());
    const snapshot = new Uint8Array(128).fill(7);
    const bundle = encodeBundle(manifestBytes, snapshot);
    const parsed = parseBundle(bundle);
    expect(new TextDecoder().decode(parsed.manifestBytes)).toBe(new TextDecoder().decode(manifestBytes));
    expect([...parsed.snapshot]).toEqual([...snapshot]);
    expect(parsed.manifest.snapshotBytes).toBe(128);

    const trailing = new Uint8Array(bundle.byteLength + 1);
    trailing.set(bundle, 0); trailing[bundle.byteLength] = 9;
    expect(() => parseBundle(trailing)).toThrow(BackupFormatError);
    const truncated = bundle.slice(0, bundle.byteLength - 1);
    expect(() => parseBundle(truncated)).toThrow(BackupFormatError);
    const badMagic = new Uint8Array(bundle); badMagic[3] = "X".charCodeAt(0);
    expect(() => parseBundle(badMagic)).toThrow(BackupFormatError);
    const badLength = new Uint8Array(bundle);
    new DataView(badLength.buffer).setUint32(8, 0, false);
    expect(() => parseBundle(badLength)).toThrow(BackupFormatError);
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
