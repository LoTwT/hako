<script setup lang="ts">
defineProps<{
  ready: boolean;
  error: string;
  notice: string;
  persistent: boolean | null;
}>();
const emit = defineEmits<{ retry: []; persist: [] }>();
</script>

<template>
  <aside class="storage-status" aria-label="保存状态">
    <p class="status-text" role="status">
      <span class="status-dot" :class="{ ready }"></span>{{ notice }}
    </p>
    <p v-if="error" class="field-error" role="alert">
      {{ error }}
      <button class="text-button" @click="emit('retry')">重新读取</button>
    </p>
    <div class="storage-details">
      <span>{{
        persistent === true
          ? "浏览器已授予持久存储；清除网站数据仍会删除本机记录。"
          : "本机数据仍可能被浏览器清理。"
      }}</span
      ><button
        v-if="persistent !== true"
        class="text-button"
        @click="emit('persist')"
      >
        申请保留本机数据
      </button>
    </div>
  </aside>
</template>

<style scoped>
.storage-status {
  margin-top: 22px;
  padding: 20px 0;
  border-top: 1px solid var(--line);
}
.status-text {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #a28d64;
  flex-shrink: 0;
}
.status-dot.ready {
  background: var(--accent);
}
.storage-details {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--muted);
}
</style>
