<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { LogOut, Monitor, Moon, Sun, UserRound } from "@lucide/vue";
import type { Appearance } from "../../ui/appearance";

/**
 * 账号与外观（G4）：外观统一在此选择「跟随系统 / 浅色 / 深色」，本机记住
 * 选择；不提供顶栏主题快捷切换。Web 由 App 以右侧设置层呈现，手机为独立
 * 设置页；两端信息与动作一致。
 */
const props = defineProps<{
  appearance: Appearance;
  /** 跟随系统时系统当前的实际模式（用于说明行）。 */
  systemDark: boolean;
  /** 顶栏账号入口的展示文案（已登录时）。 */
  accountLabel: string;
  /** 退出请求进行中。 */
  loggingOut: boolean;
  /** 登录流程准备中的本地忙状态：退出保持禁用。 */
  busy: boolean;
}>();
const emit = defineEmits<{ setAppearance: [value: Appearance]; logout: [] }>();
const heading = shallowRef<HTMLHeadingElement | null>(null);

const options = computed(() => [
  { value: "system" as const, label: "跟随系统", icon: Monitor, note: props.systemDark ? "当前为深色" : "当前为浅色" },
  { value: "light" as const, label: "浅色", icon: Sun, note: "Paper" },
  { value: "dark" as const, label: "深色", icon: Moon, note: "Ink" },
]);

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value === "system" || value === "light" || value === "dark") emit("setAppearance", value);
}

defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) });
</script>

<template>
  <section class="settings-panel" aria-labelledby="settings-title">
    <h2 id="settings-title" ref="heading" tabindex="-1">设置</h2>

    <div class="settings-section">
      <h3>账号</h3>
      <p class="account-line">
        <UserRound aria-hidden="true" :size="18" :stroke-width="2" />
        <span>{{ accountLabel }}</span>
      </p>
      <button type="button" class="logout-button danger-outline" :disabled="busy || loggingOut" @click="emit('logout')">
        <LogOut aria-hidden="true" :size="16" :stroke-width="2" />
        {{ loggingOut ? "正在退出…" : "退出登录" }}
      </button>
    </div>

    <div class="settings-section">
      <h3>外观</h3>
      <fieldset class="appearance-field">
        <legend class="appearance-legend">主题模式</legend>
        <label v-for="option of options" :key="option.value" class="appearance-option" :class="{ selected: appearance === option.value }">
          <input type="radio" name="hako-appearance" :value="option.value" :checked="appearance === option.value" @change="onInput" />
          <component :is="option.icon" aria-hidden="true" :size="18" :stroke-width="2" />
          <span class="appearance-label">{{ option.label }}</span>
          <span class="appearance-note">{{ option.note }}</span>
        </label>
      </fieldset>
      <p class="appearance-hint">跟随系统会随系统设置切换浅色与深色；手动选择仅记住本机偏好。</p>
    </div>
  </section>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  gap: 28px;
}
.settings-panel h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}
.settings-panel h2:focus-visible {
  outline: 2px solid var(--focus-ring-color);
  outline-offset: 4px;
  box-shadow: var(--focus-ring-shadow);
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-default);
}
.settings-section:last-of-type {
  border-bottom: 0;
  padding-bottom: 0;
}
.settings-section h3 {
  margin: 0 0 2px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
}
.account-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  min-height: 36px;
  font-size: 0.875rem;
  color: var(--text-primary);
}
.logout-button {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  font-size: 0.8125rem;
}
.appearance-field {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.appearance-legend {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.appearance-option {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 6px 14px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  background: var(--surface-elevated);
  cursor: pointer;
  font-size: 0.875rem;
}
.appearance-option:hover {
  border-color: var(--border-strong);
}
.appearance-option.selected {
  background: var(--accent-soft);
  border-color: var(--accent-primary);
}
.appearance-option input {
  width: 18px;
  min-height: 18px;
  height: 18px;
  flex: 0 0 18px;
  margin: 0;
  accent-color: var(--accent-primary);
}
.appearance-option svg {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.appearance-label {
  flex: 1 1 auto;
}
.appearance-note {
  font-size: 0.75rem;
  color: var(--text-muted);
}
.appearance-hint {
  margin: 4px 0 0;
  font-size: 0.75rem;
  line-height: 1.8;
  color: var(--text-muted);
}
</style>
