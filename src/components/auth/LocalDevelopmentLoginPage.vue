<script setup lang="ts">
import { shallowRef } from "vue";
import { FlaskConical, LogIn, RotateCw } from "@lucide/vue";

/**
 * 本地开发登录入口（只有 dev:local 构建载入本组件，见 App.vue 的 __HAKO_LOCAL_DEV__）。
 * 与生产登录页面的职责一致：只在会话明确为未登录（anonymous）时呈现，不展示与
 * 登录无关的状态。差别是明确标注这是隔离的本地开发环境，入口是本地测试账号；
 * 不自动登录，也不把合成身份呈现成 eruoo 身份验证。
 */
defineProps<{
  /** 登录被本机草稿保存阻止等本地提示。 */
  notice: string;
  /** 页面正在准备建立本地会话（草稿落盘确认中）：按钮保持禁用。 */
  busy: boolean;
}>();
const emit = defineEmits<{ login: []; retry: [] }>();
const heading = shallowRef<HTMLHeadingElement | null>(null);

defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) });
</script>

<template>
  <section class="login-card" aria-labelledby="login-title" :aria-busy="busy">
    <span class="login-icon" aria-hidden="true">
      <FlaskConical :size="22" :stroke-width="2" />
    </span>
    <p class="environment-badge">本地开发环境</p>
    <h1 id="login-title" ref="heading" tabindex="-1" class="programmatic-focus-heading">使用本地测试账号</h1>
    <p class="login-description">
      这是 pnpm dev:local 启动的隔离本地环境，数据只在本机独立目录；不是 eruoo 账号登录，也不会读取生产数据或凭据。
    </p>
    <p v-if="notice" class="login-feedback" role="status">{{ notice }}</p>
    <div class="login-actions">
      <button class="primary" :disabled="busy" @click="emit('login')">
        <LogIn aria-hidden="true" :size="16" :stroke-width="2" />
        {{ busy ? "正在准备本地会话…" : "使用本地测试账号" }}
      </button>
      <button :disabled="busy" @click="emit('retry')">
        <RotateCw aria-hidden="true" :size="15" :stroke-width="2" /> 重新检查登录状态
      </button>
    </div>
    <p class="login-note">本地测试账号、Worker、Durable Object 与模拟 R2 都只在本机；本机记录与草稿会保留。</p>
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
.environment-badge {
  display: inline-block;
  margin: 18px 0 0;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--surface-canvas);
  color: var(--text-secondary);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
}
h1 {
  margin: 14px 0 12px;
  font-size: 1.625rem;
  font-weight: 500;
  letter-spacing: -0.5px;
  line-height: 1.4;
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
