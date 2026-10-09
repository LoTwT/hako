<script setup lang="ts">
import { shallowRef } from "vue";
import { Info, RotateCw } from "@lucide/vue";

/**
 * 会话暂不可确认呈现：网络或服务异常、离线等无法读取会话事实时的独立状态。
 * 它不表示未登录，因此不提供登录入口，只给出可读原因与重试；重试成功后由
 * 调用方按原目标进入页面。停止等待后的重试按钮保持静态图标。
 */
defineProps<{
  /** 可读原因：优先本次命令失败提示，否则为会话客户端的当前说明。 */
  message: string;
  /** 页面正在准备登录跳转等本地忙状态：重试按钮保持禁用。 */
  busy?: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
const heading = shallowRef<HTMLHeadingElement | null>(null);

defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) });
</script>

<template>
  <section class="unavailable-card" aria-labelledby="unavailable-title">
    <span class="unavailable-mark" aria-hidden="true">
      <Info :size="22" :stroke-width="2" />
    </span>
    <h1 id="unavailable-title" ref="heading" tabindex="-1" class="programmatic-focus-heading">暂时无法确认登录状态</h1>
    <p class="unavailable-description" role="status">{{ message }}</p>
    <div class="unavailable-actions">
      <button class="primary" :disabled="busy" @click="emit('retry')">
        <RotateCw aria-hidden="true" :size="16" :stroke-width="2" /> 重试
      </button>
    </div>
  </section>
</template>

<style scoped>
.unavailable-card {
  max-width: 440px;
  margin: 72px auto 24px;
  padding: 34px;
  border: 1px solid var(--border-default);
  border-radius: 18px;
  background: var(--surface-panel);
}
.unavailable-mark {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--surface-subtle);
  color: var(--text-secondary);
}
h1 {
  margin: 24px 0 12px;
  font-size: 1.625rem;
  font-weight: 500;
  letter-spacing: -0.5px;
  line-height: 1.4;
}
.unavailable-description {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.8;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.unavailable-actions {
  margin-top: 28px;
}
.unavailable-actions button {
  min-height: 48px;
  width: 100%;
  font-size: 0.875rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
@media (max-width: 450px) {
  .unavailable-card {
    margin-top: 44px;
    padding: 28px 24px;
  }
  h1 {
    font-size: 1.5rem;
  }
}
</style>
