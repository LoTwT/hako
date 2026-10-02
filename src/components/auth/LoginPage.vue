<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { AuthSnapshot } from "../../domain/auth/session-client";

const props = defineProps<{
  auth: AuthSnapshot;
  notice: string;
  busy: boolean;
}>();
const emit = defineEmits<{ login: []; retry: [] }>();
const heading = shallowRef<HTMLHeadingElement | null>(null);
const checking = computed(() => props.auth.status === "checking");
const unavailable = computed(() => props.auth.status === "unavailable");
const title = computed(() => checking.value
  ? "正在确认登录状态"
  : unavailable.value ? "暂时无法确认登录状态" : "登录后继续");
const description = computed(() => checking.value
  ? "稍等片刻，正在确认你的 Hako 会话。"
  : unavailable.value
    ? "请检查网络后重试，确认登录状态后即可进入 Hako。"
    : "使用你的 eruoo 账号登录，即可进入 Hako。");
const disabled = computed(() => props.busy || checking.value || props.auth.loggingIn || props.auth.loggingOut);

defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) });
</script>

<template>
  <section class="login-card" aria-labelledby="login-title" :aria-busy="checking || busy">
    <span class="login-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </svg>
    </span>
    <h1 id="login-title" ref="heading" tabindex="-1">{{ title }}</h1>
    <p class="login-description" role="status">{{ description }}</p>
    <p v-if="notice" class="login-feedback" role="status">{{ notice }}</p>
    <div class="login-actions">
      <button :class="{ primary: !unavailable }" :disabled="disabled" @click="emit('login')">
        {{ checking ? "正在确认…" : busy || auth.loggingIn ? "正在准备登录…" : "登录 eruoo" }}
      </button>
      <button :class="{ primary: unavailable }" :disabled="disabled" @click="emit('retry')">
        重新检查登录状态
      </button>
    </div>
    <p class="login-note">本机记录与草稿会保留，登录后继续使用。</p>
  </section>
</template>

<style scoped>
.login-card {
  max-width: 440px;
  margin: 64px auto 24px;
  padding: 32px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: #fff;
}
.login-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #eef3ec;
  color: var(--accent);
}
.login-icon svg {
  width: 24px;
  height: 24px;
}
h1 {
  margin: 24px 0 12px;
  font-size: 26px;
  font-weight: 550;
  letter-spacing: -0.5px;
  line-height: 1.4;
}
h1:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 5px;
}
.login-description,
.login-feedback {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
  color: var(--muted);
}
.login-feedback {
  margin-top: 16px;
  color: #9b3829;
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
  font-size: 14px;
}
.login-note {
  margin: 20px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
@media (max-width: 450px) {
  .login-card {
    margin-top: 40px;
    padding: 28px 24px;
  }
  h1 {
    font-size: 24px;
  }
}
</style>
