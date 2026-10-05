// backup:verify 离线 CLI 验收（恢复设计 §10.1/§12.2「独立恢复材料」）：
// 合成 v1/v2 标记与包（仅来自合成 R2 桶的材料，移除 DO SQLite 依赖）验证
// 成功/失败退出码、URL 拒绝与无业务字段输出；另以真实子进程走一遍
// rolldown 打包运行链路。

import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { LoroDoc } from "loro-crdt/web";
import { initializeTestLoro, syntheticRecord } from "./helpers/sync-fixtures";
import { writeRecord } from "../src/data/refueling-document";
import {
  BACKUP_DOCUMENT_TYPE,
  BACKUP_ENVIRONMENT,
  bundleObjectKey,
  computeHistoryVersionDigest,
  encodeBundle,
  serializeManifest,
  serializeMarker,
  toIsoUtc,
  type BackupManifestV1,
  type BackupManifestV2,
  type BackupCommitMarker,
} from "../src/worker/backup/backup-format";
import { parseBackupVerifyArguments, runBackupVerify } from "../scripts/backup-verify";

const accountId = "00000000-0000-4000-8000-000000000001";
const streamId = "00000000-0000-4000-8000-000000000002";

interface SyntheticMaterials {
  directory: string;
  markerPath: string;
  bundlePath: string;
  snapshot: Uint8Array;
}

async function buildSyntheticBackup(formatVersion: 1 | 2, recordCount: number): Promise<SyntheticMaterials> {
  const doc = new LoroDoc();
  for (let index = 0; index < recordCount; index += 1) {
    writeRecord(doc, `record-${index}`, { ...syntheticRecord, occurredAtLocal: `2026-10-0${(index % 9) + 1}T12:00:00`, orderNumber: `order-${index}` }, true);
  }
  const snapshot = doc.export({ mode: "snapshot" });
  const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
  const version = doc.version();
  let historyVersionSha256: string;
  try {
    historyVersionSha256 = await computeHistoryVersionDigest(version.toJSON());
  } finally {
    version.free();
  }
  const common = {
    format: "hako-independent-backup" as const,
    environment: BACKUP_ENVIRONMENT,
    accountId,
    documentType: BACKUP_DOCUMENT_TYPE,
    backupStreamId: streamId,
    revision: 7,
    capturedAt: toIsoUtc(Date.parse("2026-10-05T00:00:00Z")),
    sourceCommittedAt: toIsoUtc(Date.parse("2026-10-04T23:59:00Z")),
    previousCompletedRevision: 6,
    firstPendingRevision: null,
    businessSchema: "hako-refueling-records-v1",
    loroVersion: "1.16.3",
    snapshotMode: "snapshot" as const,
    snapshotBytes: snapshot.byteLength,
    snapshotSha256,
    historyVersionSha256,
    recordCount,
  } as const;
  const manifest = formatVersion === 2
    ? {
      ...common,
      formatVersion: 2,
      sourceGeneration: { kind: "document-generation-v1", id: accountId },
      generationOrigin: { kind: "initial" },
      reason: "restore-baseline",
      syncProtocol: 2,
    } satisfies BackupManifestV2
    : {
      ...common,
      formatVersion: 1,
      sourceGeneration: { kind: "legacy-account-v1", id: accountId },
      reason: "baseline",
      syncProtocol: 1,
    } satisfies BackupManifestV1;
  const manifestBytes = serializeManifest(manifest);
  const bundle = encodeBundle(manifestBytes, snapshot, formatVersion);
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const marker: BackupCommitMarker = {
    format: "hako-independent-backup",
    formatVersion,
    environment: BACKUP_ENVIRONMENT,
    accountId,
    documentType: BACKUP_DOCUMENT_TYPE,
    backupStreamId: streamId,
    revision: 7,
    objectKey: bundleObjectKey(BACKUP_ENVIRONMENT, accountId, BACKUP_DOCUMENT_TYPE, streamId, 7, bundleSha256),
    bundleBytes: bundle.byteLength,
    bundleSha256,
  };
  const directory = mkdtempSync(join(tmpdir(), "hako-backup-verify-cli-"));
  const markerPath = join(directory, "marker.json");
  const bundlePath = join(directory, "bundle.hakobak");
  writeFileSync(markerPath, serializeMarker(marker));
  writeFileSync(bundlePath, bundle);
  return { directory, markerPath, bundlePath, snapshot };
}

function collectOutput() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    output: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    get out() { return out.join("\n"); },
    get err() { return err.join("\n"); },
  };
}

const baseArguments = {
  environment: BACKUP_ENVIRONMENT,
  accountId,
  streamId,
  revision: 7,
};

beforeAll(async () => {
  await initializeTestLoro();
});

describe("参数解析与 URL 拒绝", () => {
  it("缺必填参数、非整数 revision、非法 UUID 与 URL 输入都拒绝", () => {
    expect(parseBackupVerifyArguments(["--marker", "m", "--bundle", "b", "--environment", "production", "--account-id", accountId, "--stream-id", streamId]))
      .toMatchObject({ error: "缺少必填参数 --revision" });
    expect(parseBackupVerifyArguments(["--marker", "m", "--bundle", "b", "--environment", "production", "--account-id", accountId, "--stream-id", streamId, "--revision", "x"]))
      .toMatchObject({ error: "--revision 必须是非负整数" });
    expect(parseBackupVerifyArguments(["--marker", "m", "--bundle", "b", "--environment", "production", "--account-id", "not-uuid", "--stream-id", streamId, "--revision", "7"]))
      .toMatchObject({ error: "--account-id 必须是 UUID" });
    expect(parseBackupVerifyArguments(["--marker", "https://example.com/marker.json", "--bundle", "b", "--environment", "production", "--account-id", accountId, "--stream-id", streamId, "--revision", "7"]))
      .toMatchObject({ error: "--marker 只接受本地文件路径，不接受 URL 输入" });
    expect(parseBackupVerifyArguments(["--marker", "m", "--bundle", "file:///tmp/bundle", "--environment", "production", "--account-id", accountId, "--stream-id", streamId, "--revision", "7"]))
      .toMatchObject({ error: "--bundle 只接受本地文件路径，不接受 URL 输入" });
    expect(parseBackupVerifyArguments(["--marker", "m", "--bundle", "b", "--environment", "production", "--account-id", accountId, "--stream-id", streamId, "--revision", "7", "--extra", "1"]))
      .toMatchObject({ error: "未知参数：--extra" });
    // pnpm 会把可选参数分隔符原样传入：仅首位一个 `--` 被接受，其余位置严格拒绝。
    expect(parseBackupVerifyArguments(["--", "--marker", "m", "--bundle", "b", "--environment", "production", "--account-id", accountId, "--stream-id", streamId, "--revision", "7"]))
      .toEqual({ markerPath: "m", bundlePath: "b", environment: "production", accountId, streamId, revision: 7 });
    expect(parseBackupVerifyArguments(["--", "--", "--marker", "m", "--bundle", "b", "--environment", "production", "--account-id", accountId, "--stream-id", streamId, "--revision", "7"]))
      .toMatchObject({ error: "未知参数：--" });
    expect(parseBackupVerifyArguments(["--marker", "m", "--", "--bundle", "b", "--environment", "production", "--account-id", accountId, "--stream-id", streamId, "--revision", "7"]))
      .toMatchObject({ error: "未知参数：--" });
  });
});

describe("离线验证（仅合成标记与包，无 DO SQLite）", () => {
  it("v2 材料：退出 0，输出版本/代次/计数/字节/哈希，不含业务字段", async () => {
    const materials = await buildSyntheticBackup(2, 3);
    try {
      const collected = collectOutput();
      const code = await runBackupVerify({ ...baseArguments, markerPath: materials.markerPath, bundlePath: materials.bundlePath }, collected.output);
      expect(code).toBe(0);
      expect(collected.out).toContain("formatVersion: 2");
      expect(collected.out).toContain(`sourceGeneration: document-generation-v1 ${accountId}`);
      expect(collected.out).toContain("recordCount: 3");
      expect(collected.out).toContain(`snapshotBytes: ${materials.snapshot.byteLength}`);
      expect(collected.out).toContain("verification: passed");
      // 不输出业务字段：油站/油品/金额等字段值不得出现。
      expect(collected.out).not.toContain("合成加油站");
      expect(collected.out).not.toContain("order-");
      expect(collected.err).toBe("");
    } finally {
      rmSync(materials.directory, { recursive: true, force: true });
    }
  });

  it("v1 材料同样通过；归属不匹配与篡改包失败退出非 0", async () => {
    const materials = await buildSyntheticBackup(1, 1);
    try {
      const ok = collectOutput();
      expect(await runBackupVerify({ ...baseArguments, markerPath: materials.markerPath, bundlePath: materials.bundlePath }, ok.output)).toBe(0);
      expect(ok.out).toContain("formatVersion: 1");
      // 操作者预期归属不匹配：失败。
      const wrongAccount = collectOutput();
      expect(await runBackupVerify({ ...baseArguments, accountId: "00000000-0000-4000-8000-000000000009", markerPath: materials.markerPath, bundlePath: materials.bundlePath }, wrongAccount.output)).toBe(1);
      expect(wrongAccount.err).toContain("account_mismatch");
      // 篡改包内容：整包哈希失败。
      const bundleBytes = new Uint8Array(await (await import("node:fs/promises")).readFile(materials.bundlePath));
      bundleBytes[bundleBytes.byteLength - 1] ^= 0xff;
      const tamperedPath = join(materials.directory, "tampered.hakobak");
      writeFileSync(tamperedPath, bundleBytes);
      const tampered = collectOutput();
      expect(await runBackupVerify({ ...baseArguments, markerPath: materials.markerPath, bundlePath: tamperedPath }, tampered.output)).toBe(1);
      expect(tampered.err).toContain("bundle_verification_failed");
      // 标记对象键与包内归属交叉核对：换包哈希后标记不再匹配。
    } finally {
      rmSync(materials.directory, { recursive: true, force: true });
    }
  });
});

describe("完整运行链路（rolldown 打包 + Node 子进程 + 正式 pnpm 调用）", () => {
  it("运行器直调与文档形式 pnpm run backup:verify -- 一致：成功 0 / 失败非 0 / URL 输入拒绝", async () => {
    const materials = await buildSyntheticBackup(2, 2);
    try {
      const args = ["--marker", materials.markerPath, "--bundle", materials.bundlePath,
        "--environment", BACKUP_ENVIRONMENT, "--account-id", accountId, "--stream-id", streamId, "--revision", "7"];
      // 运行器直调（Node 子进程）。
      const direct = spawnSync(process.execPath, ["scripts/run-backup-verify.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
      expect(direct.status, direct.stderr).toBe(0);
      expect(direct.stdout).toContain("verification: passed");
      expect(direct.stdout).not.toContain("合成加油站");
      // 文档形式：pnpm 11 会把 `--` 原样传入；实现明确接受首位分隔符。
      const documented = spawnSync("pnpm", ["run", "backup:verify", "--", ...args], { cwd: process.cwd(), encoding: "utf8" });
      expect(documented.status, documented.stderr).toBe(0);
      expect(documented.stdout).toContain("verification: passed");
      // 校验失败：文档形式同样以非 0 退出并保留严格原因。
      const fail = spawnSync("pnpm", ["run", "backup:verify", "--", ...args.slice(0, -1), "8"], { cwd: process.cwd(), encoding: "utf8" });
      expect(fail.status).not.toBe(0);
      expect(fail.stderr).toContain("revision_mismatch");
      // URL 输入与多余分隔符仍严格拒绝。
      const urlRejected = spawnSync("pnpm", ["run", "backup:verify", "--", "--marker", "https://example.com/m.json", "--bundle", materials.bundlePath,
        "--environment", BACKUP_ENVIRONMENT, "--account-id", accountId, "--stream-id", streamId, "--revision", "7"], { cwd: process.cwd(), encoding: "utf8" });
      expect(urlRejected.status).not.toBe(0);
      expect(urlRejected.stderr).toContain("不接受 URL 输入");
      const separatorRejected = spawnSync("pnpm", ["run", "backup:verify", "--", "--", ...args], { cwd: process.cwd(), encoding: "utf8" });
      expect(separatorRejected.status).not.toBe(0);
      expect(separatorRejected.stderr).toContain("未知参数");
    } finally {
      rmSync(materials.directory, { recursive: true, force: true });
    }
  }, 180_000);
});
