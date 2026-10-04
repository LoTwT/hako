// workerd 集成验收的本地执行环境：用锁文件内 rolldown 打包测试 Worker 入口，
// 用锁文件内 Miniflare（真实 workerd 进程）挂载 SQLite DO、R2 模拟桶与持久化目录。
// 不访问任何远端资源；所有依赖均来自仓库锁文件（vite 的 rolldown、cf 的 miniflare）。

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableStream } from "node:stream/web";

const require = createRequire(import.meta.url);

interface RolldownBuildOptions {
  input: { entry: string };
  plugins: unknown[];
  external: (RegExp | string)[];
  output: { format: string; dir: string; entryFileNames: string };
  platform: string;
}

interface RolldownModule {
  build(options: RolldownBuildOptions): Promise<unknown>;
}

interface MiniflareModule {
  Miniflare: new (options: unknown) => MiniflareInstance;
  convertV4MiniflareOptions: (options: unknown) => {
    workers: [TestWorkerEntry];
    // v5 的持久化是顶层共享选项；per-worker persist 在转换中被忽略。
    resourcePersistencePath?: string;
  };
}

interface TestWorkerEntry {
  config: {
    name: string;
    compatibilityDate: string;
    manifest: {
      mainModule: string;
      modulesRoot: string;
      modules: Record<string, { type: string; contents: string | Uint8Array }>;
    };
  };
}

export interface MiniflareInstance {
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  getR2Bucket(bindingName: string): Promise<TestR2Bucket>;
  dispose(): Promise<void>;
  ready: Promise<URL>;
}

export interface TestR2Bucket {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: readonly { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ size: number; bytes(): Promise<Uint8Array> } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string): Promise<void>;
}

function resolveFrom(packageName: string): string {
  const manifest = require.resolve(`${packageName}/package.json`);
  return manifest.replace("/package.json", "");
}

export function loadRolldown(): RolldownModule {
  const rolldownPath = require.resolve("rolldown", { paths: [resolveFrom("vite")] });
  return require(rolldownPath) as RolldownModule;
}

export function loadMiniflare(): MiniflareModule {
  const miniflarePath = require.resolve("miniflare", { paths: [resolveFrom("cf")] });
  return require(miniflarePath) as MiniflareModule;
}

/** 打包测试 Worker：`?module` Wasm 导入外部化为运行时 CompiledWasm 模块。 */
export async function buildTestWorkerBundle(): Promise<string> {
  const rolldown = loadRolldown();
  const outDir = join(mkdtempSync(join(tmpdir(), "hako-integration-bundle-")), "worker");
  mkdirSync(outDir, { recursive: true });
  const wasmPlugin = {
    name: "hako-worker-wasm-module",
    resolveId(source: string): { id: string; external: boolean } | null {
      if (source.endsWith(".wasm?module")) {
        return { id: "./loro_wasm_bg.wasm", external: true };
      }
      return null;
    },
  };
  await rolldown.build({
    input: { entry: join(process.cwd(), "tests/integration/worker-entry.ts") },
    plugins: [wasmPlugin],
    external: [/^cloudflare:/],
    output: { format: "esm", dir: outDir, entryFileNames: "worker.mjs" },
    platform: "browser",
  });
  const projectRoot = process.cwd();
  copyFileSync(join(projectRoot, "node_modules/loro-crdt/web/loro_wasm_bg.wasm"), join(outDir, "loro_wasm_bg.wasm"));
  return outDir;
}

export interface TestWorkerOptions {
  bundleDir: string;
  persistDir: string;
}

/** 以隔离持久化目录启动真实 workerd：SQLite DO、本地 R2 模拟桶与 alarm。 */
export function createTestMiniflare(options: TestWorkerOptions): MiniflareInstance {
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const converted = convertV4MiniflareOptions({
    workers: [{
      name: "hako-test",
      compatibilityDate: "2026-10-01",
      scriptPath: join(options.bundleDir, "worker.mjs"),
      modules: true,
      bindings: {
        HAKO_LOGIN: {
          origin: "https://hako.test",
          issuer: "https://auth.eruoo.me",
          clientId: "hako-web",
          resource: "https://auth.eruoo.me/api",
        },
        HAKO_OWNER_SUBJECT: "synthetic-owner",
      },
      durableObjects: { HAKO_ACCOUNT: { className: "HakoAccountDurableObject", useSQLite: true } },
      r2Buckets: { HAKO_BACKUPS: "hako-backups-test" },
      persist: { path: options.persistDir },
    }],
  });
  const worker = converted.workers[0];
  // V4→V5 转换不会自动带上 CompiledWasm 模块规则；显式提供清单。
  worker.config.manifest = {
    mainModule: "worker.mjs",
    modulesRoot: options.bundleDir,
    modules: {
      "worker.mjs": { type: "esm", contents: readFileSync(join(options.bundleDir, "worker.mjs"), "utf8") },
      "loro_wasm_bg.wasm": { type: "wasm", contents: readFileSync(join(options.bundleDir, "loro_wasm_bg.wasm")) },
    },
  };
  // 隔离持久化：DO SQLite 与 R2 模拟数据都落在独立目录，随测试删除。
  converted.resourcePersistencePath = options.persistDir;
  return new Miniflare(converted);
}

export interface TestWorkerSession {
  token: string;
  accountId: string;
}

export interface TestWorkerHandle {
  miniflare: MiniflareInstance;
  bundleDir: string;
  persistDir: string;
  r2: TestR2Bucket;
  createSession(subject?: string): Promise<TestWorkerSession>;
  sync(account: TestWorkerSession, snapshot: Uint8Array): Promise<Response>;
  syncDirect(subject: string, account: TestWorkerSession, snapshot: Uint8Array): Promise<Response>;
  status(account: TestWorkerSession): Promise<Response>;
  debugState(): Promise<{ alarm: number | null; rows: Record<string, unknown[]> }>;
  r2Counters(): Promise<{ put: number; get: number; list: number; delete: number }>;
  sqlMeter(): Promise<{
    active: boolean;
    incomplete: boolean;
    totals: { rowsRead: number; rowsWritten: number; statements: number };
    lastAlarm: { rowsRead: number; rowsWritten: number; statements: number } | null;
    debugIncomplete: boolean;
    debugTotals: { rowsRead: number; rowsWritten: number; statements: number };
  }>;
  execSql(query: string): Promise<unknown[]>;
  setSchedule(schedule: unknown | null): Promise<void>;
  setR2Fault(fault: unknown | null): Promise<void>;
  dispose(): Promise<void>;
}

/** 列出 R2 前缀下的全部 key（Node 侧句柄，独立于 worker 内的计数）。 */
export async function listAllR2Keys(r2: TestR2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await r2.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (const object of page.objects) keys.push(object.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return keys;
}

export async function startTestWorker(options: { bundleDir: string; persistDir: string }): Promise<TestWorkerHandle> {
  const miniflare = createTestMiniflare(options);
  const r2 = await miniflare.getR2Bucket("HAKO_BACKUPS");

  async function postJson(path: string, body: unknown): Promise<unknown> {
    const response = await miniflare.dispatchFetch(`https://hako.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    if (response.status !== 200) throw new Error(`test route ${path} failed: ${response.status} ${await response.text()}`);
    return await response.json();
  }

  return {
    miniflare,
    bundleDir: options.bundleDir,
    persistDir: options.persistDir,
    r2,
    async createSession(subject = "synthetic-owner") {
      return await postJson(`/test/session?subject=${encodeURIComponent(subject)}`, {}) as TestWorkerSession;
    },
    async sync(account, snapshot) {
      return await miniflare.dispatchFetch("https://hako.test/api/sync/refueling", {
        method: "POST",
        headers: {
          Origin: "https://hako.test",
          Cookie: `__Host-hako_session=${account.token}`,
          "X-Hako-Account": account.accountId,
          "X-Hako-Sync-Protocol": "1",
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(snapshot) as unknown as BodyInit,
      });
    },
    async syncDirect(subject: string, account: TestWorkerSession, snapshot: Uint8Array): Promise<Response> {
      return await miniflare.dispatchFetch(
        `https://hako.test/test/sync-direct?subject=${encodeURIComponent(subject)}&token=${encodeURIComponent(account.token)}&account=${account.accountId}`,
        { method: "POST", body: new Uint8Array(snapshot) as unknown as BodyInit },
      );
    },
    async status(account) {
      return await miniflare.dispatchFetch("https://hako.test/api/backups/refueling/status", {
        headers: { Cookie: `__Host-hako_session=${account.token}` },
      });
    },
    async debugState() {
      return await postJson("/test/debug/state", {}) as { alarm: number | null; rows: Record<string, unknown[]> };
    },
    async r2Counters() {
      const response = await miniflare.dispatchFetch("https://hako.test/test/debug/r2-counters");
      return await response.json() as { put: number; get: number; list: number; delete: number };
    },
    async sqlMeter() {
      const response = await miniflare.dispatchFetch("https://hako.test/test/sql-meter");
      return await response.json() as {
        active: boolean;
        incomplete: boolean;
        totals: { rowsRead: number; rowsWritten: number; statements: number };
        lastAlarm: { rowsRead: number; rowsWritten: number; statements: number } | null;
        debugIncomplete: boolean;
        debugTotals: { rowsRead: number; rowsWritten: number; statements: number };
      };
    },
    async execSql(query) {
      const result = await postJson("/test/debug/sql", { query }) as { rows: unknown[] };
      return result.rows;
    },
    async setSchedule(schedule) {
      await postJson("/test/schedule", schedule);
    },
    async setR2Fault(fault) {
      await postJson("/test/fault", fault);
    },
    async dispose() {
      await miniflare.dispose();
    },
  };
}

export function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export type { ReadableStream };
