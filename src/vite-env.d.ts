/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue"

  // eslint-disable-next-line @typescript-eslint/ban-types
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface Window {
  __TAURI_INTERNALS__?: any
}
