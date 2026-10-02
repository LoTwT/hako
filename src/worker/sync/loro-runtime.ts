import { initSync } from "loro-crdt/web/loro_wasm.js";
import module from "loro-crdt/web/loro_wasm_bg.wasm?module";

// Cloudflare 提供已编译 Wasm 模块；不 fetch 资产、不在运行时编译二进制。
export function initializeWorkerLoro(): void {
  initSync({ module });
}
