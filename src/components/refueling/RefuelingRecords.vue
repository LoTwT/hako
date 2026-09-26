<script setup lang="ts">
import { computed } from "vue";
import {
  formatPaidAmount,
  recordWarnings,
  unscale,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";
const props = defineProps<{
  records: readonly SavedRefuelingRecord[];
  busy: boolean;
}>();
const emit = defineEmits<{ edit: [record: SavedRefuelingRecord] }>();
const warnings = computed(() => recordWarnings([...props.records]));
</script>

<template>
  <section class="panel" aria-labelledby="records-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">YOUR LOG</p>
        <h2 id="records-title">加油记录</h2>
      </div>
      <span class="count">{{ records.length }} 笔</span>
    </div>
    <div v-if="records.length === 0" class="empty">
      <div class="empty-mark">↗</div>
      <h3>从一次加油开始</h3>
      <p>填好表单，保存后会出现在这里。</p>
      <p>此版本请使用测试数据。</p>
    </div>
    <ul v-else class="records">
      <li v-for="record of records" :key="record.id" class="record">
        <div class="record-top">
          <time>{{ record.occurredAtLocal.replace("T", " ") }}</time
          ><strong>{{ formatPaidAmount(record.amountPaidCents) }}</strong>
        </div>
        <div class="record-detail">
          <span>{{ unscale(record.fuelVolumeMillilitres, 3) }} 升</span
          ><span>{{ unscale(record.odometerTenths, 1) }} 公里</span
          ><span>{{ record.fullTank ? "加满" : "没加满" }}</span>
        </div>
        <p v-if="record.stationName || record.fuelGrade" class="muted">
          {{
            [record.stationName, record.fuelGrade].filter(Boolean).join(" · ")
          }}
        </p>
        <p
          v-for="warning of warnings.get(record.id)"
          :key="warning"
          class="record-warning"
        >
          待核对：{{ warning }}
        </p>
        <button
          class="text-button"
          :disabled="busy"
          @click="emit('edit', record)"
        >
          编辑这条记录
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.count {
  border: 1px solid var(--line);
  border-radius: 30px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--muted);
}
.empty {
  text-align: center;
  padding: 74px 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
}
.empty h3 {
  color: var(--ink);
  font-size: 17px;
  font-weight: 500;
}
.empty-mark {
  font-size: 36px;
  font-weight: 300;
  color: var(--accent);
}
.records {
  list-style: none;
  margin: 22px 0 0;
  padding: 0;
}
.record {
  padding: 22px 0;
  border-top: 1px solid var(--line);
}
.record-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
.record-top time {
  font-size: 13px;
  color: var(--muted);
}
.record-top strong {
  font-size: 23px;
  font-weight: 550;
}
.record-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 13px;
  font-size: 14px;
}
.record .muted {
  font-size: 13px;
}
.record-warning {
  color: #915700;
  font-size: 13px;
  line-height: 1.7;
}
.text-button {
  margin-top: 10px;
}
</style>
