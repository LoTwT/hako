<script setup lang="ts">
import type { AuthSnapshot } from "../../domain/auth/session-client";

defineProps<{
  auth: AuthSnapshot;
  /** 登录被本机草稿保存阻止等本地提示。 */
  notice: string;
  /** 页面正在准备登录跳转（草稿落盘确认中）：按钮保持禁用。 */
  busy?: boolean;
}>();
const emit = defineEmits<{ login: []; logout: []; retry: [] }>();
</script>

<template>
  <section class="auth-panel" aria-labelledby="auth-title">
    <div class="auth-main">
      <p class="eyebrow" id="auth-title">ACCOUNT</p>
      <p class="status-text" role="status" aria-live="polite">
        <span class="status-dot" :class="auth.status"></span>{{ auth.message }}
      </p>
      <p v-if="notice" class="notice-line" role="status">{{ notice }}</p>
      <p class="auth-note">
        登录仅用于云端身份；现有本地验证数据不会自动关联或上传。
      </p>
    </div>
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
        class="text-button"
        :disabled="busy || auth.loggingIn || auth.loggingOut"
        @click="emit('retry')"
      >
        重新检查登录状态
      </button>
    </div>
  </section>
</template>

<style scoped>
.auth-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 22px;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}
.auth-main {
  min-width: 260px;
  flex: 1 1 420px;
}
.status-text {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 6px 0 4px;
  font-size: 13px;
  line-height: 1.7;
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
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--accent);
  line-height: 1.7;
}
.auth-note {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}
.auth-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}
</style>
