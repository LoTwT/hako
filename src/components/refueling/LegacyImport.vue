<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { readLegacyRefueling } from "../../data/legacy-refueling";
import type { SavedRefuelingRecord } from "../../domain/refueling/form";

const props = defineProps<{
  disabled: boolean;
  importedIds: readonly string[];
  importRecords: (records: SavedRefuelingRecord[]) => Promise<boolean>;
}>();
const opened = shallowRef(false);
const loading = shallowRef(false);
const records = shallowRef<SavedRefuelingRecord[]>([]);
const selected = ref<string[]>([]);
const message = shallowRef("");
const candidates = computed(() => records.value.filter((record) => !props.importedIds.includes(record.id)));
const chosen = computed(() => candidates.value.filter((record) => selected.value.includes(record.id)));
async function preview() {
  if (props.disabled || loading.value) return;
  loading.value = true;
  message.value = "";
  try {
    records.value = await readLegacyRefueling();
    selected.value = [];
    opened.value = true;
  } catch {
    message.value = "无法读取旧验证数据，原库已保留，请稍后重试。";
  } finally { loading.value = false; }
}
async function importSelected() {
  if (props.disabled || !chosen.value.length) return;
  const count = chosen.value.length;
  if (await props.importRecords(chosen.value)) {
    selected.value = [];
    message.value = `已导入 ${count} 条到当前账号的本机副本，联网时自动同步。原库仍保留。`;
  } else message.value = "导入未完成，原库和选择均保留，可重试。";
}
</script>

<template>
  <section class="legacy-import" aria-label="旧验证数据">
    <h2>旧验证数据</h2>
    <p>旧记录和旧草稿保留在此浏览器，不会自动关联账号。可以继续保留原样，也可以查看并选择已保存的记录导入。</p>
    <button v-if="!opened" :disabled="disabled || loading" @click="preview">查看可导入的旧记录</button>
    <template v-else>
      <p>仅复制勾选记录的当前字段值到此账号，联网时上传。原库及原修改历史保留；旧草稿不在此次导入范围内。已在本机导入的记录不会重复导入或覆盖账号记录。</p>
      <p v-if="!candidates.length">没有尚未导入的旧记录。</p>
      <fieldset :disabled="disabled || loading">
        <legend>选择要导入的旧记录</legend>
        <label v-for="record in candidates" :key="record.id" class="legacy-record">
          <input v-model="selected" type="checkbox" :value="record.id" />
          <span>
            {{ record.occurredAtLocal.replace('T', ' ') }} · {{ record.stationName || '未填加油站' }} · 实付 ¥{{ (record.amountPaidCents / 100).toFixed(2) }}
            <small>{{ record.odometerTenths / 10 }} km · {{ record.fuelVolumeMillilitres / 1000 }} L · {{ record.fuelGrade || '未填油品' }} · {{ record.fullTank ? '加满' : '未加满' }}</small>
          </span>
        </label>
        <button :disabled="!chosen.length" @click="importSelected">导入选中的 {{ chosen.length }} 条并同步</button>
        <button class="text-button" @click="opened = false; selected = []">保留原样，关闭</button>
      </fieldset>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.legacy-import { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; line-height: 1.8; }
h2 { font-size: 15px; }
fieldset { border: 0; padding: 0; margin: 0; }
.legacy-record { display: flex; gap: 12px; align-items: center; min-height: 48px; padding: 8px 0; }
.legacy-record input { flex: 0 0 20px; width: 20px; min-height: 20px; height: 20px; padding: 0; }
.legacy-record span { min-width: 0; overflow-wrap: anywhere; }
.legacy-import button { min-height: 44px; }
small { display: block; color: var(--muted); }
.text-button { margin-left: 12px; }
</style>
