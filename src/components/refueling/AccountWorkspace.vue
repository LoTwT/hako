<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useLocalRefueling } from "../../composables/useLocalRefueling";
import RefuelingWorkspace from "./RefuelingWorkspace.vue";
import type { AppRoute, RefuelingRoute } from "../../ui/app-route";

const props = defineProps<{
  accountId: string;
  active: boolean;
  opened: boolean;
  visible: boolean;
  navigatingForLogin: boolean;
  /** 加油区当前路由；门禁期间保留原值，重新确认后恢复。 */
  route: RefuelingRoute;
  /** 应用级当前路由（含 home/settings 等）：工作区据此决定自身可见性之外的导航。 */
  appRoute: AppRoute;
  navigate: (next: AppRoute) => void;
  replaceRoute: (next: AppRoute) => void;
  backTo: (target: AppRoute) => void;
  openSettings: (event?: Event) => void;
}>();
const emit = defineEmits<{ sessionRejected: [] }>();
const local = useLocalRefueling({ accountId: props.accountId, active: () => props.active,
  onSessionRejected: () => emit("sessionRejected") });

/**
 * 导航/设置转发门禁（UI-R03）：工作区以 v-show 保活，隐藏的旧账号实例的
 * 异步出口（保存清理、放弃完成等迟到回调）不得改变当前账号页面。调用时
 * 复核自身仍是活动账号；本机清理照常完成，只有全局路由/设置动作被拦。
 */
function guardRouteAction(action: (arg: AppRoute) => void): (arg: AppRoute) => void {
  return (arg: AppRoute) => {
    if (!props.active) return;
    action(arg);
  };
}
const guardedNavigate = guardRouteAction((next: AppRoute) => { void props.navigate(next); });
const guardedReplaceRoute = guardRouteAction((next: AppRoute) => { props.replaceRoute(next); });
const guardedBackTo = guardRouteAction((target: AppRoute) => { props.backTo(target); });
const guardedOpenSettings = (event?: Event) => {
  if (!props.active) return;
  props.openSettings(event);
};
const workspace = shallowRef<InstanceType<typeof RefuelingWorkspace> | null>(null);
const saving = computed(() => local.saving.value);
/**
 * 工作区按本机工作区代次挂载（key 由组合式统一维护，刷新/保存也绑定同一代次）：
 * 代次切换（本人打开恢复后数据）在旧实例草稿 flush 完成之后才发生 key 变化，
 * 旧实例随之卸载，新代次的表单/草稿/锁按账号+代次装配。保护流程沿用本机代次的
 * 实例（保存冻结、提示选择）；本机从未激活时保持单一占位实例。
 */
const workspaceKey = computed(() => local.workspaceGeneration.value ?? "pending");
async function flushDraft() {
  return workspace.value?.flushDraft() ?? { ok: true, message: "" };
}
defineExpose({ saving, flushDraft });
</script>

<template>
  <RefuelingWorkspace v-if="opened" v-show="visible" :key="workspaceKey" ref="workspace" :account-id="accountId" :local="local"
    :locked="!active" :navigating-for-login="navigatingForLogin" :route="route" :app-route="appRoute"
    :navigate="guardedNavigate" :replace-route="guardedReplaceRoute" :back-to="guardedBackTo" :open-settings="guardedOpenSettings" />
</template>
