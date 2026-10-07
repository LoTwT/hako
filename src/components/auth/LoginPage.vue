<script setup lang="ts">
import { shallowRef } from "vue";
import { LockKeyhole, LogIn, RotateCw } from "@lucide/vue";

/**
 * 登录入口扩展：只在会话明确为未登录（anonymous）时呈现。会话尚未确认时的
 * 启动等待与网络/服务异常的暂不可确认，由各自独立的呈现承担；本组件不展示
 * 与登录无关的状态，也不负责解释无法确认的原因。
 */
defineProps<{
  /** 登录被本机草稿保存阻止等本地提示。 */
  notice: string;
  /** 页面正在准备登录跳转（草稿落盘确认中）：按钮保持禁用。 */
  busy: boolean;
}>();
const emit = defineEmits<{ login: []; retry: [] }>();
const heading = shallowRef<HTMLHeadingElement | null>(null);

defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) });
</script>

<template>
  <section class="login-card" aria-labelledby="login-title" :aria-busy="busy">
    <span class="login-icon" aria-hidden="true">
      <LockKeyhole :size="22" :stroke-width="2" />
    </span>
    <h1 id="login-title" ref="heading" tabindex="-1">登录后继续</h1>
    <p class="login-description">使用你的 eruoo 账号登录，即可进入 Hako。</p>
    <p v-if="notice" class="login-feedback" role="status">{{ notice }}</p>
    <div class="login-actions">
      <button class="primary" :disabled="busy" @click="emit('login')">
        <LogIn aria-hidden="true" :size="16" :stroke-width="2" />
        {{ busy ? "正在准备登录…" : "登录 eruoo" }}
      </button>
      <button :disabled="busy" @click="emit('retry')">
        <RotateCw aria-hidden="true" :size="15" :stroke-width="2" /> 重新检查登录状态
      </button>
    </div>
    <p class="login-note">本机记录与草稿会保留，登录后继续使用。</p>
  </section>
</template>

<style scoped>
.login-card {
  max-width: 440px;
  margin: 72px auto 24px;
  padding: 34px;
  border: 1px solid var(--border-default);
  border-radius: 18px;
  background: var(--surface-panel);
}
.login-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--text-accent);
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
.login-description,
.login-feedback {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.8;
  color: var(--text-secondary);
}
.login-feedback {
  margin-top: 16px;
  color: var(--status-danger-fg);
  overflow-wrap: anywhere;
}
.login-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 28px;
}
.login-actions button {
  min-height: 48px;
  width: 100%;
  font-size: 0.875rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.login-note {
  margin: 20px 0 0;
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1.8;
}
@media (max-width: 450px) {
  .login-card {
    margin-top: 44px;
    padding: 28px 24px;
  }
  h1 {
    font-size: 1.5rem;
  }
}
</style>
