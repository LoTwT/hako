// backup:verify 的运行器：用仓库锁定的 rolldown（经 vite 解析，与集成测试同一
// 来源）把 scripts/backup-verify.ts 连同共享验证器打包为临时 ESM 产物，再用锁定
// 的 Node 运行；不新增依赖，不包含云端写能力。Loro Wasm 的绝对路径经环境变量
// 传入，避免临时目录内解析 node_modules。

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

function resolveFrom(packageName) {
  const manifest = require.resolve(`${packageName}/package.json`);
  return manifest.replace("/package.json", "");
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  let rolldown;
  try {
    const rolldownPath = require.resolve("rolldown", { paths: [resolveFrom("vite")] });
    rolldown = require(rolldownPath);
  } catch {
    process.stderr.write("backup:verify 打包器不可用（rolldown 解析失败）。\n");
    return 1;
  }
  const outDir = mkdtempSync(join(tmpdir(), "hako-backup-verify-"));
  // 不用 process.exit 直接终止：先经 finally 清理临时目录，再由退出码结束进程。
  try {
    await rolldown.build({
      input: { entry: join(scriptDir, "backup-verify.ts") },
      // 仅 node 内建外部化；loro-crdt 及共享验证器一并打包为自包含产物，
      // 避免临时目录内解析 node_modules（Wasm 由运行器按绝对路径注入）。
      external: [/^node:/],
      output: { format: "esm", dir: outDir, entryFileNames: "backup-verify.mjs" },
      platform: "node",
    });
    const wasmPath = join(resolveFrom("loro-crdt"), "web", "loro_wasm_bg.wasm");
    const result = spawnSync(process.execPath, [join(outDir, "backup-verify.mjs"), ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, HAKO_BACKUP_VERIFY_WASM: wasmPath },
    });
    return result.status ?? 1;
  } catch (error) {
    process.stderr.write(`backup:verify 打包失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
