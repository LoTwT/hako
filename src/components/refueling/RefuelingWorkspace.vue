<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue";
import { useRegisterSW } from "virtual:pwa-register/vue";
import { useLocalRefueling } from "../../composables/useLocalRefueling";
import {
  changedFields,
  type RefuelingRecord,
  type SavedRefuelingRecord,
} from "../../domain/refueling/form";
import RefuelingForm from "./RefuelingForm.vue";
import RefuelingRecords from "./RefuelingRecords.vue";
import StorageStatus from "./StorageStatus.vue";

const {
  records,
  ready,
  saving,
  error,
  notice,
  persistent,
  save,
  initialize,
  requestPersistence,
} = useLocalRefueling();
const selected = shallowRef<SavedRefuelingRecord>();
const formId = shallowRef<string>(crypto.randomUUID());
const formKey = shallowRef(0);
const dirty = shallowRef(false);
const registrationError = shallowRef("");
const { offlineReady, needRefresh } = useRegisterSW({
  onRegisterError() {
    registrationError.value = "离线资源准备失败；重新联网打开后再检查。";
  },
});
function canLeave() {
  return (
    !dirty.value || window.confirm("当前表单尚未保存，确定放弃这些输入吗？")
  );
}
function createNew() {
  if (!canLeave()) return;
  selected.value = undefined;
  formId.value = crypto.randomUUID();
  formKey.value++;
  dirty.value = false;
}
function edit(record: SavedRefuelingRecord) {
  if (!canLeave()) return;
  selected.value = { ...record };
  formId.value = record.id;
  formKey.value++;
  dirty.value = false;
}
async function submit(record: RefuelingRecord) {
  const patch = selected.value ? changedFields(selected.value, record) : record;
  if (await save(formId.value, patch, !selected.value)) {
    selected.value = undefined;
    formId.value = crypto.randomUUID();
    formKey.value++;
    dirty.value = false;
  }
}
const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
  if (dirty.value || saving.value) {
    event.preventDefault();
    event.returnValue = "";
  }
};
onMounted(() => window.addEventListener("beforeunload", warnBeforeLeaving));
onUnmounted(() =>
  window.removeEventListener("beforeunload", warnBeforeLeaving),
);
</script>

<template>
  <main class="workspace">
    <header class="page-header">
      <a class="brand" href="/" aria-label="Hako 首页"
        >hako<span class="brand-dot">.</span></a
      ><span class="version-label">本地验证版</span>
    </header>
    <div class="page-heading">
      <div>
        <p class="eyebrow">ONE CAR, EVERY JOURNEY</p>
        <h1>把每次加油，记清楚。</h1>
        <p class="intro">
          先验证本机保存与多窗口编辑。请使用测试记录，云端同步和备份尚未接入。
        </p>
      </div>
      <button v-if="selected" :disabled="saving" @click="createNew">
        新增记录
      </button>
    </div>
    <p v-if="registrationError" class="warning">{{ registrationError }}</p>
    <p v-else-if="offlineReady" class="offline-label">离线页面已准备好</p>
    <div v-if="needRefresh" class="warning">
      新版本已就绪。请保存所有窗口中的输入，再关闭并重新打开 Hako。
    </div>
    <div class="workspace-grid">
      <RefuelingForm
        :key="formKey"
        :initial="selected"
        :busy="saving"
        :available="ready"
        @dirty="dirty = $event"
        @save="submit"
      /><RefuelingRecords :records="records" :busy="saving" @edit="edit" />
    </div>
    <StorageStatus
      :ready="ready"
      :error="error"
      :notice="notice"
      :persistent="persistent"
      @retry="initialize"
      @persist="requestPersistence"
    />
  </main>
</template>

<style scoped>
.workspace {
  max-width: 1080px;
  margin: 0 auto;
  padding: 30px 28px 40px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--line);
}
.brand {
  font-size: 30px;
  font-weight: 750;
  letter-spacing: -1.5px;
  color: var(--ink);
  text-decoration: none;
}
.brand-dot {
  color: var(--accent);
}
.version-label {
  font-size: 12px;
  color: var(--muted);
}
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin: 42px 0 26px;
}
.page-heading h1 {
  margin: 9px 0 12px;
  font-size: clamp(25px, 4vw, 34px);
  font-weight: 550;
  letter-spacing: -0.8px;
}
.intro {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.9;
  max-width: 620px;
}
.workspace-grid {
  display: grid;
  grid-template-columns: 1.08fr 1fr;
  gap: 24px;
  align-items: start;
}
.offline-label {
  color: var(--accent);
  font-size: 12px;
  margin-bottom: 16px;
}
@media (max-width: 760px) {
  .workspace {
    padding: 20px 16px;
  }
  .workspace-grid {
    grid-template-columns: 1fr;
  }
  .page-heading {
    margin-top: 30px;
  }
}
</style>
