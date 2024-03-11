import { createApp } from "vue"
import App from "./App.vue"
import { router } from "./router"

import "@unocss/reset/tailwind-compat.css"
import "uno.css"

createApp(App).use(router).mount("#app")
