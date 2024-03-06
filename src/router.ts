import { createRouter, createWebHistory } from "vue-router/auto"
import { setupLayouts } from "virtual:generated-layouts"

export const router = createRouter({
  history: createWebHistory(),
  extendRoutes: (routes) => setupLayouts(routes),
})

router.beforeResolve(() => {})

router.afterEach(() => {})

router.onError(() => {})
