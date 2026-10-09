<script setup lang="ts">
import { shallowRef } from "vue";
import { ChevronRight, Fuel, UserRound } from "@lucide/vue";

/**
 * Hako 工具首页（G3）：唯一的真实工具入口是加油记录。工具卡只有图标与完整
 * 名称，不放描述；整卡可点。Web 为居中限宽网格（行随最高卡片等高），手机为
 * 单面板列表；名称自然换行，不为布局添加示例工具。
 */
defineProps<{
  /** 顶栏账号入口的展示文案（已登录时）。 */
  accountLabel: string;
  /** 导航忙状态（登录准备中）：入口保持可点但不重复跳转。 */
  busy: boolean;
}>();
const emit = defineEmits<{ openSettings: [event: Event]; openRefueling: [] }>();
const heading = shallowRef<HTMLHeadingElement | null>(null);

defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) });
</script>

<template>
  <div class="home-page">
    <header class="home-header">
      <span class="brand">
        <img class="brand-mark" :src="'/hako-mark-32.png'" :srcset="'/hako-mark-48.png 1.5x, /hako-mark-64.png 2x'" width="32" height="32" alt="" decoding="async" />
        <span class="brand-name brand-wordmark">Hako</span>
      </span>
      <button type="button" class="account-button" :disabled="busy" @click="emit('openSettings', $event)">
        <UserRound aria-hidden="true" :size="18" :stroke-width="2" />
        <span class="account-label">{{ accountLabel }}</span>
      </button>
    </header>

    <img class="home-illustration" :src="'/hako-illustration-256.png'" width="256" height="256" alt="" decoding="async" aria-hidden="true" />

    <section class="tools" aria-labelledby="tools-title">
      <h1 id="tools-title" ref="heading" tabindex="-1" class="programmatic-focus-heading">我的工具</h1>
      <div class="tool-grid">
        <a class="tool-card" href="/#refueling" :aria-disabled="busy" @click.prevent="emit('openRefueling')">
          <span class="tool-icon" aria-hidden="true">
            <Fuel :size="26" :stroke-width="2" />
          </span>
          <span class="tool-name">加油记录</span>
          <ChevronRight class="tool-chevron" aria-hidden="true" :size="18" :stroke-width="2" />
        </a>
      </div>
      <p class="home-note">当前账号的记录在前台联网时自动同步；草稿仅保存在本机。</p>
    </section>
  </div>
</template>

<style scoped>
.home-page {
  max-width: 65rem;
  margin: 0 auto;
  padding: 22px 24px 48px;
}
.home-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border-default);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  color: var(--text-primary);
  text-decoration: none;
}
.brand-mark {
  display: block;
  width: 32px;
  height: 32px;
}
.brand-name {
  font-size: 1.25rem;
  letter-spacing: -0.3px;
}
.account-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 999px;
  border-color: var(--border-default);
  background: var(--surface-panel);
  color: var(--text-primary);
  font-size: 0.8125rem;
}
.account-button:hover:not(:disabled) {
  background: var(--surface-elevated);
  border-color: var(--border-strong);
}
.home-illustration {
  display: block;
  width: min(224px, 52vw);
  height: auto;
  margin: 44px auto 8px;
}
.tools h1 {
  margin: 28px 0 16px;
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--text-secondary);
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  grid-auto-rows: 1fr;
  gap: 14px;
}
.tool-card {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 86px;
  padding: 16px 18px;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  background: var(--surface-panel);
  color: var(--text-primary);
  text-decoration: none;
}
.tool-card:hover {
  background: var(--surface-elevated);
  border-color: var(--border-strong);
}
.tool-card:focus-visible {
  outline: 2px solid var(--focus-ring-color);
  outline-offset: 2px;
  box-shadow: var(--focus-ring-shadow);
}
.tool-icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--text-accent);
}
.tool-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1.0625rem;
  font-weight: 500;
  line-height: 1.5;
  text-wrap: balance;
  overflow-wrap: anywhere;
}
.tool-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  display: none;
}
.home-note {
  margin: 18px 0 0;
  font-size: 0.75rem;
  line-height: 1.8;
  color: var(--text-muted);
}
@media (max-width: 719px) {
  .home-page {
    padding: 16px 16px 40px;
  }
  .home-illustration {
    margin-top: 28px;
  }
  .tool-grid {
    grid-template-columns: 1fr;
    gap: 0;
    border: 1px solid var(--border-default);
    border-radius: 16px;
    background: var(--surface-panel);
    overflow: hidden;
  }
  .tool-card {
    min-height: 60px;
    padding: 10px 16px;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: inset 0 -1px 0 var(--border-default);
  }
  .tool-card:last-child {
    box-shadow: none;
  }
  .tool-card:hover {
    background: var(--surface-elevated);
  }
  .tool-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }
  .tool-name {
    font-size: 1rem;
  }
  .tool-chevron {
    display: block;
  }
}
</style>
