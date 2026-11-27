<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSessionStore } from '@/stores/session';

const store = useSessionStore();
const freeText = ref('');
const submitting = ref(false);

const canAct = computed(() => store.editable && !submitting.value);
const canExpand = computed(() => canAct.value && Boolean(store.selectedId));

async function submit(action: 'confirmed' | 'need-more' | 'abort'): Promise<void> {
  submitting.value = true;
  try {
    await store.submit(action, {
      freeText: freeText.value.trim(),
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
        <span class="pill">共 {{ store.nodes.length }} 条</span>
        <span v-if="store.pendingAssumptions.length" class="pill kind-assumption">
          假设待裁决 {{ store.pendingAssumptions.length }}
        </span>
        <span v-if="store.pendingSuggestions.length" class="pill kind-assumption">
          建议待定 {{ store.pendingSuggestions.length }}
        </span>
      </div>

      <div class="toolbar__actions">
        <button
          class="btn btn--ghost"
          :disabled="!canAct"
          title="让 AI 通盘优化这棵树：调顺序、删冗余、补缺口，整体意思不变；建议以灰字挂在节点上"
          @click="store.requestSuggest(null)"
        >
          AI 优化整棵树
        </button>
        <button class="btn" :disabled="!canExpand" @click="submit('need-more')">
          继续拆解选中项
        </button>
        <button class="btn btn--primary" :disabled="!canAct" @click="submit('confirmed')">
          提交给 AI
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
