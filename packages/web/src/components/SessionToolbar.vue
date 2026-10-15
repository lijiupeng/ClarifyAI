<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSessionStore } from '@/stores/session';

const emit = defineEmits<{ openSpec: [] }>();

const store = useSessionStore();
const freeText = ref('');
const submitting = ref(false);

const canAct = computed(() => store.editable && !submitting.value);
const canExpand = computed(() => canAct.value && Boolean(store.selectedId));

async function submit(
  action: 'confirmed' | 'need-more' | 'abort',
  freeTextOverride?: string,
): Promise<void> {
  submitting.value = true;
  try {
    // 「确认本轮」隐含「剩下这些我都要」——先把待确认的条目统一确认，
    // 否则用户点了确认、规格里却少了它们（实测踩过：两条最关键的凭空消失）
    if (action === 'confirmed') store.confirmAllDrafts();

    await store.submit(action, {
      freeText: freeTextOverride ?? freeText.value.trim(),
      expand: action === 'need-more' && store.selectedId ? [store.selectedId] : [],
    });
    freeText.value = '';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <footer class="toolbar">
    <textarea
      v-model="freeText"
      class="textarea toolbar__note"
      rows="2"
      :disabled="!store.editable"
      placeholder="补充说明：AI 没问到、但你临时想到的需求写在这里。提交后 AI 必须归类并回应。"
    ></textarea>

    <div class="toolbar__side">
      <div class="toolbar__stats">
        <span class="pill">共 {{ store.nodes.length }}</span>
        <span class="pill status-confirmed">已确认 {{ store.confirmedCount }}</span>
        <span class="pill">待确认 {{ store.draftCount }}</span>
        <span v-if="store.pendingAssumptions.length" class="pill kind-assumption">
          假设待裁决 {{ store.pendingAssumptions.length }}
        </span>
      </div>

      <div class="toolbar__actions">
        <button class="btn btn--ghost" @click="emit('openSpec')">预览规格</button>
        <button class="btn" :disabled="!canExpand" @click="submit('need-more')">
          继续拆解选中项
        </button>
        <button
          class="btn"
          :disabled="!canAct"
          @click="submit('confirmed', `${freeText.trim()} 需求已确认完毕，请调用 clarify_finalize 生成需求规格并收口。`)"
        >
          可以收口了
        </button>
        <button class="btn btn--primary" :disabled="!canAct" @click="submit('confirmed')">
          确认本轮
        </button>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: end;
  padding: 13px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
}

.toolbar__note {
  min-height: 52px;
  max-height: 120px;
}

.toolbar__side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-end;
}

.toolbar__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
</style>
