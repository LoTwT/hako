<script setup lang="ts">
import { shallowRef } from "vue";

/**
 * 会话暂不可确认呈现：网络或服务异常、离线等无法读取会话事实时的独立状态。
 * 它不表示未登录，因此不提供登录入口，只给出可读原因与重试；重试成功后由
 * 调用方按原目标进入页面。
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
    <h1 id="unavailable-title" ref="heading" tabindex="-1">暂时无法确认登录状态</h1>
    <p class="unavailable-description" role="status">{{ message }}</p>
    <div class="unavailable-actions">
      <button class="primary" :disabled="busy" @click="emit('retry')">重试</button>
    </div>
  </section>
</template>

<style scoped>
.unavailable-card {
  max-width: 440px;
  margin: 64px auto 24px;
  padding: 32px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: #fff;
}
h1 {
  margin: 0 0 12px;
  font-size: 26px;
  font-weight: 550;
  letter-spacing: -0.5px;
  line-height: 1.4;
}
h1:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 5px;
}
.unavailable-description {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.unavailable-actions {
  margin-top: 28px;
}
.unavailable-actions button {
  min-height: 48px;
  width: 100%;
  font-size: 14px;
}
@media (max-width: 450px) {
  .unavailable-card {
    margin-top: 40px;
    padding: 28px 24px;
  }
  h1 {
    font-size: 24px;
  }
}
</style>
