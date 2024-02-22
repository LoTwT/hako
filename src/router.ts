import { createRouter, createWebHistory } from "vue-router/auto"

export const router = createRouter({
  history: createWebHistory(),
})

router.beforeResolve(() => {
  LoadingBar.start()
})

router.afterEach(() => {
  setTimeout(() => {
    LoadingBar.finish()
  }, 200)
})

router.onError(() => {
  LoadingBar.error()
})
