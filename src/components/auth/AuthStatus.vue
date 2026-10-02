<script setup lang="ts">
import { computed } from "vue";
import type { AuthSnapshot } from "../../domain/auth/session-client";

const props = defineProps<{
  auth: AuthSnapshot;
  /** 登录被本机草稿保存阻止等本地提示。 */
  notice: string;
  /** 页面正在准备登录跳转（草稿落盘确认中）：按钮保持禁用。 */
  busy?: boolean;
}>();
const emit = defineEmits<{ login: []; logout: []; retry: [] }>();
const statusLabel = computed(() => ({
  checking: "确认中…",
  anonymous: "未登录",
  authenticated: "已登录",
  unavailable: "状态暂不可用",
})[props.auth.status]);
const feedback = computed(() =>
  props.notice || (props.auth.status === "unavailable" ? props.auth.message : ""),
);
</script>

<template>
  <section class="auth-panel" aria-label="账号状态">
    <p class="status-text" role="status" aria-live="polite">
      <span class="status-dot" :class="auth.status" aria-hidden="true"></span>{{ statusLabel }}
    </p>
    <div class="auth-actions">
      <button
        v-if="auth.status === 'authenticated'"
        :disabled="busy || auth.loggingIn || auth.loggingOut"
        @click="emit('logout')"
      >
        {{ auth.loggingOut ? "正在退出…" : "退出登录" }}
      </button>
      <button
        v-else
        class="primary"
        :disabled="
          busy ||
          auth.status === 'checking' ||
          auth.loggingIn ||
          auth.loggingOut
        "
        @click="emit('login')"
      >
        {{ busy || auth.loggingIn ? "正在准备登录…" : "登录 eruoo" }}
      </button>
      <button
        class="refresh-button"
        aria-label="重新检查登录状态"
        title="重新检查登录状态"
        :disabled="busy || auth.loggingIn || auth.loggingOut"
        @click="emit('retry')"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" />
        </svg>
      </button>
    </div>
    <p v-if="feedback" class="notice-line" role="status">{{ feedback }}</p>
  </section>
</template>

<style scoped>
.auth-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  max-width: 440px;
  margin-left: auto;
}
.status-text {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  white-space: nowrap;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #a28d64;
  flex-shrink: 0;
}
.status-dot.authenticated {
  background: var(--accent);
}
.status-dot.unavailable {
  background: #b7563a;
}
.notice-line {
  flex-basis: 100%;
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--accent);
  line-height: 1.7;
  text-align: right;
  overflow-wrap: anywhere;
}
.auth-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.auth-actions button {
  min-height: 44px;
  font-size: 13px;
}
.refresh-button {
  display: grid;
  place-items: center;
  width: 44px;
  padding: 10px;
  border-color: transparent;
  background: transparent;
  color: var(--accent);
}
.refresh-button svg {
  width: 20px;
  height: 20px;
}
</style>
