import init from "loro-crdt/web/loro_wasm.js";
import wasmUrl from "loro-crdt/web/loro_wasm_bg.wasm?url";

let initialization: Promise<unknown> | undefined;
export async function initializeLoro(): Promise<void> {
  initialization ??= init({ module_or_path: wasmUrl }).catch((error) => {
    initialization = undefined;
    throw error;
  });
  await initialization;
}
