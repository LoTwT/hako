<script setup lang="ts">
import { shallowRef } from "vue";
import { LoaderCircle } from "@lucide/vue";

/**
 * 应用启动呈现：会话状态尚未确认（首次打开、刷新、缓存文档恢复或同步拒绝后的
 * 重新确认）时显示的统一等待状态。只呈现外框内的等待内容，不提供登录按钮，
 * 也不展示上一账号的记录或草稿。旋转仅对应实际进行中的会话确认。
 */
const heading = shallowRef<HTMLHeadingElement | null>(null);

defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) });
</script>

<template>
  <section class="startup-card" aria-labelledby="startup-title" aria-busy="true">
    <span class="startup-mark" aria-hidden="true">
      <LoaderCircle class="startup-spinner" :size="22" :stroke-width="2" />
    </span>
    <h1 id="startup-title" ref="heading" tabindex="-1">正在打开…</h1>
    <p class="startup-description" role="status">正在确认你的 Hako 会话，请稍候。</p>
  </section>
</template>

<style scoped>
.startup-card {
  max-width: 440px;
  margin: 72px auto 24px;
  padding: 34px;
  border: 1px solid var(--border-default);
  border-radius: 18px;
  background: var(--surface-panel);
}
.startup-mark {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--surface-subtle);
  color: var(--text-accent);
}
.startup-spinner {
  animation: startup-spin 0.9s linear infinite;
}
@keyframes startup-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .startup-spinner {
    animation: none;
  }
}
h1 {
  margin: 24px 0 12px;
  font-size: 1.625rem;
  font-weight: 600;
  letter-spacing: -0.5px;
  line-height: 1.4;
}
h1:focus-visible {
  outline: 2px solid var(--focus-ring-color);
  outline-offset: 5px;
  box-shadow: var(--focus-ring-shadow);
}
.startup-description {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.8;
  color: var(--text-secondary);
}
@media (max-width: 450px) {
  .startup-card {
    margin-top: 44px;
    padding: 28px 24px;
  }
  h1 {
    font-size: 1.5rem;
  }
}
</style>
