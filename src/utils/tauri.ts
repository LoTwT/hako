import { invoke } from "@tauri-apps/api/core"
import type { Promisable } from "@ayingott/sucrose"

export const inTauri = !!window.__TAURI_INTERNALS__

export type TauriInvokeCb<R> = (f: typeof invoke) => Promisable<R>
export type ClientInvokeCb<R> = () => Promisable<R>

export async function safeInvoke<R>(
  tauriCb: TauriInvokeCb<R>,
  clientCb: ClientInvokeCb<R>,
) {
  let result: R

  if (inTauri) {
    result = await tauriCb(invoke)
  } else {
    result = await clientCb()
  }

  return result
}
