// 管理员离线验证 CLI（恢复设计 §10.1）：输入本地完成标记与精确包，以及操作者
// 指定的预期环境/账号/stream/revision；复用同一 v1/v2 严格解析与验证函数，不另写
// 宽松解析器，不包含任何云端写能力，拒绝 URL 输入。默认仅输出版本、代次、记录数、
// 字节数、哈希及通过/失败；成功退出 0，验证失败退出非 0，不打印业务字段。
//
// 运行方式（Node 24 + 现有 Vite/Rolldown 打包能力，见 scripts/run-backup-verify.mjs）：
//   pnpm run backup:verify -- --marker <本地标记文件> --bundle <本地包文件> \
//     --environment production --account-id <账号UUID> --stream-id <序列UUID> --revision <整数>

import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import init from "loro-crdt/web/loro_wasm.js";
import {
  BACKUP_DOCUMENT_TYPE,
  BACKUP_ENVIRONMENT,
  bundleObjectKey,
  MAX_BUNDLE_BYTES,
  MAX_MARKER_BYTES,
  parseMarker,
} from "../src/worker/backup/backup-format";
import { verifyCompletedBackup } from "../src/worker/backup/backup-verify";

export interface BackupVerifyArguments {
  markerPath: string;
  bundlePath: string;
  environment: string;
  accountId: string;
  streamId: string;
  revision: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KNOWN_FLAGS = new Set(["marker", "bundle", "environment", "account-id", "stream-id", "revision"]);

/** 解析并校验命令行参数；任何缺失、未知、非法值或 URL 形式的文件输入都拒绝。 */
export function parseBackupVerifyArguments(argv: readonly string[]): BackupVerifyArguments | { error: string } {
  // pnpm（锁定 11.25.0 实测）会把可选参数分隔符 `--` 原样传给脚本：只在首位
  // 允许一个分隔符；其余位置的 `--`/未知参数仍严格拒绝。
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) return { error: `未知参数：${flag ?? ""}` };
    if (!KNOWN_FLAGS.has(flag.slice(2))) return { error: `未知参数：${flag}` };
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { error: `参数 ${flag} 缺少取值` };
    if (values.has(flag.slice(2))) return { error: `参数 ${flag} 重复` };
    values.set(flag.slice(2), value);
  }
  const requireValue = (name: string): string | { error: string } => {
    const value = values.get(name);
    if (value === undefined || value === "") return { error: `缺少必填参数 --${name}` };
    return value;
  };
  const markerPath = requireValue("marker");
  if (typeof markerPath !== "string") return markerPath;
  const bundlePath = requireValue("bundle");
  if (typeof bundlePath !== "string") return bundlePath;
  const environment = requireValue("environment");
  if (typeof environment !== "string") return environment;
  const accountId = requireValue("account-id");
  if (typeof accountId !== "string") return accountId;
  const streamId = requireValue("stream-id");
  if (typeof streamId !== "string") return streamId;
  const revisionText = requireValue("revision");
  if (typeof revisionText !== "string") return revisionText;
  // 拒绝 URL 输入：只接受本地文件路径（http(s)/file/data 等均含协议形态）。
  for (const [name, path] of [["marker", markerPath], ["bundle", bundlePath]] as const) {
    if (path.includes("://") || path.startsWith("data:") || path.startsWith("http:") || path.startsWith("https:")) {
      return { error: `--${name} 只接受本地文件路径，不接受 URL 输入` };
    }
  }
  if (!UUID_PATTERN.test(accountId)) return { error: "--account-id 必须是 UUID" };
  if (!UUID_PATTERN.test(streamId)) return { error: "--stream-id 必须是 UUID" };
  const revision = Number.parseInt(revisionText, 10);
  if (!Number.isSafeInteger(revision) || revision < 0 || String(revision) !== revisionText.trim()) {
    return { error: "--revision 必须是非负整数" };
  }
  return { markerPath, bundlePath, environment, accountId, streamId, revision };
}

export interface BackupVerifyOutput {
  out(text: string): void;
  err(text: string): void;
}

/**
 * 执行离线验证并返回进程退出码（0=通过，非 0=失败）。输出只包含版本、代次、
 * 记录数、字节数、哈希与通过/失败；不输出业务字段、身份或凭据。
 */
export async function runBackupVerify(
  arguments_: BackupVerifyArguments,
  output: BackupVerifyOutput,
  read: (path: string, limit: number) => Uint8Array | { error: string } = readBoundedFile,
): Promise<number> {
  try {
    await ensureLoroInitialized();
  } catch {
    output.err("verification: failed (loro_unavailable)");
    return 1;
  }
  const fail = (detail: string): number => {
    output.err(`verification: failed (${detail})`);
    return 1;
  };
  const markerRead = read(arguments_.markerPath, MAX_MARKER_BYTES);
  if ("error" in markerRead) return fail(markerRead.error);
  const bundleRead = read(arguments_.bundlePath, MAX_BUNDLE_BYTES);
  if ("error" in bundleRead) return fail(bundleRead.error);
  const markerBytes = markerRead as Uint8Array;
  const bundleBytes = bundleRead as Uint8Array;
  let marker: ReturnType<typeof parseMarker>;
  try {
    marker = parseMarker(markerBytes);
  } catch {
    return fail("marker_unparseable");
  }
  // 操作者提供的预期归属必须与标记完全一致；不能用文件名代替包内归属核对。
  if (marker.environment !== arguments_.environment) return fail("environment_mismatch");
  if (marker.accountId !== arguments_.accountId) return fail("account_mismatch");
  if (marker.backupStreamId !== arguments_.streamId) return fail("stream_mismatch");
  if (marker.revision !== arguments_.revision) return fail("revision_mismatch");
  if (marker.documentType !== BACKUP_DOCUMENT_TYPE) return fail("document_type_mismatch");
  if (marker.environment !== BACKUP_ENVIRONMENT) return fail("unknown_environment");
  // 标记声明的对象键必须与其自身字段重新构造的键一致（键内嵌哈希交叉核对）。
  const expectedKey = bundleObjectKey(
    marker.environment, marker.accountId, marker.documentType, marker.backupStreamId, marker.revision, marker.bundleSha256,
  );
  if (marker.objectKey !== expectedKey) return fail("marker_object_key_mismatch");
  let manifest: Awaited<ReturnType<typeof verifyCompletedBackup>>["manifest"];
  try {
    const read = await verifyCompletedBackup({
      bytes: bundleBytes,
      expected: {
        environment: marker.environment,
        accountId: marker.accountId,
        documentType: marker.documentType,
        streamId: marker.backupStreamId,
        revision: marker.revision,
        bundleSha256: marker.bundleSha256,
        bundleBytes: marker.bundleBytes,
        formatVersion: marker.formatVersion,
        // 离线验证没有完成缓存：历史/记录数/快照哈希按 manifest 内部一致性核对。
        historySha256: null,
        recordCount: null,
        snapshotSha256: null,
      },
    });
    manifest = read.manifest;
  } catch {
    return fail("bundle_verification_failed");
  }
  output.out(`formatVersion: ${manifest.formatVersion}`);
  output.out(`sourceGeneration: ${manifest.sourceGeneration.kind} ${manifest.sourceGeneration.id}`);
  output.out(`recordCount: ${manifest.recordCount}`);
  output.out(`snapshotBytes: ${manifest.snapshotBytes}`);
  output.out(`bundleBytes: ${marker.bundleBytes}`);
  output.out(`bundleSha256: ${marker.bundleSha256}`);
  output.out(`snapshotSha256: ${manifest.snapshotSha256}`);
  output.out(`historyVersionSha256: ${manifest.historyVersionSha256}`);
  output.out("verification: passed");
  return 0;
}

/** 有界读取本地文件；不存在、超限或读取失败按错误返回。 */
function readBoundedFile(path: string, limit: number): Uint8Array | { error: string } {
  try {
    if (statSync(path).size > limit) return { error: "file_too_large" };
    return new Uint8Array(readFileSync(path));
  } catch {
    return { error: "file_unreadable" };
  }
}

let loroInitialization: Promise<unknown> | undefined;

/** 初始化锁定的 Loro Wasm：优先使用运行器提供的绝对路径，其次从模块位置解析。 */
async function ensureLoroInitialized(): Promise<void> {
  loroInitialization ??= (async () => {
    const wasmPath = process.env.HAKO_BACKUP_VERIFY_WASM ?? resolveWasmPath();
    await init({ module_or_path: await readFile(wasmPath) });
  })().catch((error) => {
    loroInitialization = undefined;
    throw error;
  });
  await loroInitialization;
}

function resolveWasmPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("loro-crdt/package.json")), "web", "loro_wasm_bg.wasm");
}

/** 作为入口运行时执行 main；被测试导入时不自动执行（argv[1] 经 realpath 解析，兼容 /var 等符号链接）。 */
function isEntryRun(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isEntryRun()) {
  const parsed = parseBackupVerifyArguments(process.argv.slice(2));
  const output: BackupVerifyOutput = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
  if ("error" in parsed) {
    output.err(parsed.error);
    process.exit(2);
  }
  process.exit(await runBackupVerify(parsed, output));
}
