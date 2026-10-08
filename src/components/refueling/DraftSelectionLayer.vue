<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { LockKeyhole, X } from "@lucide/vue";
import type { StoredRefuelingDraft } from "../../domain/refueling/draft-recovery";
import { createModalFocus } from "../../ui/modal-focus";

/**
 * 草稿选择层：查看未完成的草稿并选择继续或放弃。有挂起编辑时须先完成或放弃
 * 当前编辑，才能继续其他草稿；关闭此层不丢弃任何草稿。被其他窗口占用的草稿
 * 不可继续、不可放弃、不可接管（占用失败在继续/放弃结果中说明）。
 * 直接编辑地址（mode=edit）下只列该记录草稿，替代动作为「不用草稿，直接编辑」；
 * 新建地址（mode=new）的替代动作为「空白新建」并进入编辑地址（UI-R05）。
 */
const props = defineProps<{
  candidates: readonly StoredRefuelingDraft[];
  hasPendingEditor: boolean;
  mode: "new" | "edit";
  draftTime: (updatedAt: number) => string;
  draftSummary: (draft: StoredRefuelingDraft) => string;
}>();
const emit = defineEmits<{
  continue: [draft: StoredRefuelingDraft];
  discard: [draft: StoredRefuelingDraft];
  alternate: [];
  close: [];
}>();

const alternateLabel = computed(() => (props.mode === "edit" ? "不用草稿，直接编辑" : "空白新建"));
const emptyText = computed(() =>
  props.mode === "edit" ? "该记录没有未占用的草稿。" : "当前没有未完成的草稿。");

const layerFocus = createModalFocus({
  close: () => emit("close"),
  initialFocus: () => closeButton.value,
});
const closeButton = shallowRef<HTMLButtonElement | null>(null);
onMounted(() => layerFocus.focusOnOpen());
</script>

<template>
  <div :ref="(element) => { layerFocus.layerRoot.value = element as HTMLElement | null; }"
    class="draft-layer" role="dialog" aria-modal="true" aria-labelledby="draft-layer-title"
    @keydown="layerFocus.onLayerKeydown">
    <div class="draft-backdrop" @click="layerFocus.focusOnClose()"></div>
    <section class="draft-sheet" role="document" aria-labelledby="draft-layer-title">
      <header class="draft-header">
        <h2 id="draft-layer-title">未完成的草稿</h2>
        <button ref="closeButton" type="button" class="draft-close" aria-label="关闭草稿选择" @click="layerFocus.focusOnClose()">
          <X aria-hidden="true" :size="18" :stroke-width="2" />
        </button>
      </header>
      <p class="draft-note">
        有挂起编辑时：先完成或放弃当前编辑，才能继续其他草稿。关闭此层不会丢弃任何草稿。
      </p>
      <ul v-if="candidates.length" class="draft-items">
        <li v-for="draft of candidates" :key="draft.id" class="draft-item">
          <span class="draft-item-meta">{{ draft.mode === "edit" ? "编辑记录" : "新建记录" }} · {{ draftTime(draft.updatedAt) }}</span>
          <span class="draft-item-summary">{{ draftSummary(draft) }}</span>
          <span class="draft-item-actions">
            <button type="button" class="text-button" @click="emit('discard', draft)">放弃</button>
            <button v-if="hasPendingEditor" type="button" class="draft-continue" disabled
              aria-describedby="draft-pending-note">
              继续
            </button>
            <button v-else type="button" class="draft-continue" @click="emit('continue', draft)">继续</button>
          </span>
        </li>
      </ul>
      <p v-else class="draft-note">{{ emptyText }}</p>
      <p v-if="hasPendingEditor" id="draft-pending-note" class="draft-note">
        <LockKeyhole aria-hidden="true" :size="14" :stroke-width="2" /> 先完成或放弃当前编辑
      </p>
      <div class="draft-footer">
        <button type="button" @click="emit('alternate')">{{ alternateLabel }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.draft-layer {
  position: fixed;
  inset: 0;
  z-index: 65;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.draft-backdrop {
  position: absolute;
  inset: 0;
  background: rgb(9 8 12 / 0.32);
}
.draft-sheet {
  position: relative;
  width: min(560px, 100%);
  max-height: min(78vh, 640px);
  overflow-y: auto;
  padding: 20px 20px calc(20px + env(safe-area-inset-bottom));
  border: 1px solid var(--border-default);
  border-bottom: 0;
  border-radius: 18px 18px 0 0;
  background: var(--surface-panel);
}
.draft-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.draft-header h2 { margin: 0; font-size: 1rem; font-weight: 600; }
.draft-close {
  display: grid;
  place-items: center;
  width: 38px;
  min-height: 38px;
  padding: 0;
  border-radius: 50%;
}
.draft-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 12px;
  font-size: 0.75rem;
  line-height: 1.7;
  color: var(--text-muted);
}
.draft-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.draft-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border-default);
}
.draft-item-meta { font-size: 0.8125rem; font-weight: 600; }
.draft-item-summary { flex: 1 1 140px; font-size: 0.8125rem; color: var(--text-secondary); overflow-wrap: anywhere; }
.draft-item-actions { display: inline-flex; align-items: center; gap: 10px; }
.draft-continue { min-height: 36px; padding: 5px 14px; font-size: 0.8125rem; }
.draft-footer {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
@media (min-width: 880px) {
  .draft-layer { align-items: center; }
  .draft-sheet {
    border-radius: 18px;
    border-bottom: 1px solid var(--border-default);
  }
}
</style>
