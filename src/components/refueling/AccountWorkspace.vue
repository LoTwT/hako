<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useLocalRefueling } from "../../composables/useLocalRefueling";
import RefuelingWorkspace from "./RefuelingWorkspace.vue";

const props = defineProps<{ accountId: string; active: boolean; opened: boolean; visible: boolean; navigatingForLogin: boolean }>();
const emit = defineEmits<{ sessionRejected: [] }>();
const local = useLocalRefueling({ accountId: props.accountId, active: () => props.active,
  onSessionRejected: () => emit("sessionRejected") });
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
    :locked="!active" :navigating-for-login="navigatingForLogin" />
</template>
