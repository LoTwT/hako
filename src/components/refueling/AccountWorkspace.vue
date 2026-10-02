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
async function flushDraft() {
  return workspace.value?.flushDraft() ?? { ok: true, message: "" };
}
defineExpose({ saving, flushDraft });
</script>

<template>
  <RefuelingWorkspace v-if="opened" v-show="visible" ref="workspace" :account-id="accountId" :local="local"
    :locked="!active" :navigating-for-login="navigatingForLogin" />
</template>
