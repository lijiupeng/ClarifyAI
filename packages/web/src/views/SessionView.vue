<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { RequirementNode } from '@clarifyai/shared';
import { CanvasController } from '@/graph/canvas';
import type { CardAction } from '@/graph/canvas';
import { useSessionStore } from '@/stores/session';
import SessionToolbar from '@/components/SessionToolbar.vue';

const props = defineProps<{ id: string }>();

const store = useSessionStore();
const canvasHost = ref<HTMLElement | null>(null);
/** 逐条审阅走完最后一条时给个收尾提示 */
const reviewDone = ref(false);
let reviewDoneTimer: number | undefined;

let canvas: CanvasController | null = null;

const statusText = computed(() => {
  switch (store.status) {
    case 'awaiting-agent':
      return 'AI 正在处理';
    case 'aborted':
      return '已终止';
    default:
      return '可继续编辑';
  }
});

const connectionText = computed(() => {
  switch (store.connection) {
    case 'online':
      return '实时同步中';
    case 'connecting':
      return '连接中';
    default:
      return '连接已断开';
  }
});

const projectName = computed(() => store.session?.projectContext.projectName || '未命名项目');

function render(): void {
  canvas?.render({
    nodes: store.nodes,
    suggestions: store.suggestions,
    rootId: store.rootId,
    selectedId: store.selectedId,
    editingId: store.editingId,
    editable: store.editable,
    activeSuggestionId: store.activeSuggestionId,
  });
}

/** 卡片内那排按钮的落点 */
function handleCardAction(id: string, action: CardAction): void {
  switch (action) {
    case 'delete':
      store.removeNode(id);
      return;

    case 'expand':
      // 点完立即提交，画布随即进入只读，等 AI 把新分支推回来
      void store.requestExpand(id);
      return;

    case 'child':
      store.addChild(id);
      return;

    case 'sibling': {
      const current = store.nodes.find((item) => item.id === id);
      if (!current) return;
      // 根节点没有同级，退化成新增子节点
      store.addChild(current.parentId ?? current.id);
      return;
    }

    case 'accept':
      store.ruleAssumption(id, 'accept');
      return;

    case 'reject':
      store.ruleAssumption(id, 'reject');
      return;
  }
}

function handleFieldChange(id: string, patch: Partial<RequirementNode>): void {
  store.updateNode(id, patch);
}

/* --------------------------- 键盘：Tab / Enter --------------------------- */

function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;

  if (event.key === 'Escape') {
    (event.target as HTMLElement | null)?.blur();
    store.endEdit();
    return;
  }

  if (!store.editable) return;
  const selectedId = store.selectedId;
  if (!selectedId) return;

  // Tab = 当前节点下加一个子节点
  if (event.key === 'Tab') {
    event.preventDefault();
    store.addChild(selectedId);
    return;
  }

  // Enter = 当前节点后面加一个同级；根节点没有同级，退化为加子节点
  if (event.key === 'Enter' && !event.shiftKey) {
    const current = store.nodes.find((node) => node.id === selectedId);
    if (!current) return;
    event.preventDefault();
    store.addChild(current.parentId ?? current.id);
  }
}

onMounted(async () => {
  await store.load(props.id);
  if (!canvasHost.value) return;

  canvas = new CanvasController(canvasHost.value, {
    onSelect: (id) => store.select(id),
    onCardAction: handleCardAction,
    onFieldChange: handleFieldChange,
    onEditFocus: (id) => store.beginEdit(id),
    onEditBlur: (id) => store.endEdit(id),
    onSuggestion: (suggestionId, accept) => {
      void store.resolveSuggestion(suggestionId, accept);
    },
  });

  render();
  // 等布局稳定后再对齐视口，避免首帧尺寸为 0
  window.setTimeout(() => canvas?.fit(), 60);

  // 捕获阶段监听：卡片内的 keydown 会被 X6 拦在冒泡路上
  window.addEventListener('keydown', handleKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown, true);
  window.clearTimeout(reviewDoneTimer);
  canvas?.dispose();
  canvas = null;
  store.dispose();
});

// 一批建议处理完就提示一下，别让画布悄无声息地停在最后一条
watch(
  () => store.pendingSuggestions.length,
  (length, previous) => {
    if (previous > 0 && length === 0) {
      reviewDone.value = true;
      window.clearTimeout(reviewDoneTimer);
      reviewDoneTimer = window.setTimeout(() => {
        reviewDone.value = false;
      }, 2600);
    }
  },
);

// 深度监听：节点内容或结构任一变化都要重绘图
watch(
  () => store.nodes,
  () => render(),
  { deep: true },
);
watch(() => store.suggestions, () => render(), { deep: true });
watch(() => store.activeSuggestionId, () => render());
watch(() => store.selectedId, () => render());
watch(() => store.editingId, () => render());
// 可编辑态变化时要重绘，否则卡片上的操作按钮不会随只读态一起消失
watch(() => store.editable, () => render());
</script>

<template>
  <div class="session">
    <header class="session__header">
      <div class="session__title">
        <RouterLink to="/" class="back" title="返回会话列表">←</RouterLink>
        <div class="session__title-text">
          <div class="project">{{ store.root?.title || projectName }}</div>
          <div class="raw" :title="store.session?.rawRequirement">
            {{ store.session?.rawRequirement }}
          </div>
        </div>
      </div>

      <div class="session__meta">
        <span class="pill" :class="{ 'status-confirmed': store.status === 'completed' }">
          {{ statusText }}
        </span>
        <span class="pill">第 {{ store.round }} 轮</span>
        <span class="pill" :class="{ 'dot-offline': store.connection !== 'online' }">
          {{ connectionText }}
        </span>
      </div>
    </header>

    <div v-if="store.errorMessage" class="error-banner">
      <span class="error-banner__text">{{ store.errorMessage }}</span>
      <button class="error-banner__close" title="关闭" @click="store.clearError()">×</button>
    </div>

    <main class="canvas-area">
      <div ref="canvasHost" class="canvas-host"></div>

      <div class="canvas-tools">
        <button class="btn btn--ghost" @click="canvas?.fit()">适应画布</button>
        <button class="btn btn--ghost" @click="canvas?.resetZoom()">100%</button>
        <button
          class="btn btn--ghost"
          :disabled="!store.editable"
          title="选中节点就只优化它；没选中则优化整棵树 —— 可调顺序、删冗余、补缺口，但整体意思不会变"
          @click="store.requestSuggest(store.selectedId)"
        >
          AI 优化
        </button>
      </div>

      <div v-if="store.agentBusy" class="canvas-banner canvas-banner--busy">
        AI 正在优化这份需求…
      </div>
      <div v-else-if="store.agentNote" class="canvas-banner" :title="store.agentNote">
        {{ store.agentNote }}
      </div>

      <div v-if="reviewDone" class="review-done">建议已逐条处理完</div>

      <div class="canvas-hint">
        <kbd>Tab</kbd> 加子节点　<kbd>Enter</kbd> 加同级　双击文字直接改　<span class="hint-dim">灰字是 AI 建议，逐条决定要不要</span>
      </div>

      <div v-if="store.pendingAssumptions.length" class="assumption-banner">
        <span>有 {{ store.pendingAssumptions.length }} 条 AI 假设尚未裁决</span>
        <span class="assumption-banner__actions">
          <button
            class="btn btn--ghost banner-btn"
            :disabled="!store.editable"
            @click="store.ruleAllAssumptions('accept')"
          >
            全部接受
          </button>
          <button
            class="btn btn--ghost banner-btn"
            :disabled="!store.editable"
            @click="store.ruleAllAssumptions('reject')"
          >
            全部否决
          </button>
        </span>
      </div>
    </main>

    <SessionToolbar />
  </div>
</template>

<style scoped>
.session {
  /* 用 flex 而非固定行数的 grid：错误条是按需出现的，行数不固定 */
  display: flex;
  flex-direction: column;
  height: 100%;
}

.session__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}

.session__title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.back {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  text-decoration: none;
  flex-shrink: 0;
}

.back:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.session__title-text {
  min-width: 0;
}

.project {
  font-weight: 600;
  font-size: 14px;
}

.raw {
  color: var(--text-dim);
  font-size: 12px;
  max-width: 62ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session__meta {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 18px;
  font-size: 13px;
  color: #a32424;
  background: #fdf2f2;
  border-bottom: 1px solid #f2cccc;
}

.error-banner__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-banner__close {
  border: none;
  background: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  opacity: 0.7;
  flex-shrink: 0;
}

.error-banner__close:hover {
  opacity: 1;
}

.canvas-area {
  position: relative;
  flex: 1;
  min-height: 0;
  background:
    radial-gradient(circle at 20% 0%, rgba(91, 91, 214, 0.05), transparent 55%),
    var(--bg);
}

.canvas-host {
  width: 100%;
  height: 100%;
}

.canvas-tools {
  position: absolute;
  right: 14px;
  top: 14px;
  display: flex;
  gap: 6px;
  padding: 4px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  box-shadow: 0 1px 3px rgba(23, 32, 50, 0.06);
}

.canvas-banner {
  position: absolute;
  left: 14px;
  top: 14px;
  max-width: 46ch;
  padding: 8px 13px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  backdrop-filter: blur(6px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-banner--busy {
  color: #4a4ac4;
  border-color: #c7c9f7;
  background: rgba(240, 241, 255, 0.95);
}

.review-done {
  position: absolute;
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 12.5px;
  color: #2f8a5b;
  background: rgba(238, 250, 242, 0.96);
  border: 1px solid #bfe6cd;
  box-shadow: 0 2px 10px rgba(23, 32, 50, 0.08);
  pointer-events: none;
}

.canvas-hint {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-faint);
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid var(--border);
  box-shadow: 0 1px 3px rgba(23, 32, 50, 0.06);
  backdrop-filter: blur(6px);
  white-space: nowrap;
  pointer-events: none;
}

.canvas-hint kbd {
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border-strong);
  background: #f2f4f8;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 11px;
}

.hint-dim {
  color: #a8b0bd;
}

.assumption-banner {
  position: absolute;
  left: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 13px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  color: #8a6524;
  border: 1px solid #f0dcb0;
  background: rgba(253, 247, 234, 0.95);
  backdrop-filter: blur(6px);
}

.assumption-banner__actions {
  display: flex;
  gap: 4px;
}

.banner-btn {
  padding: 2px 9px;
  font-size: 12px;
  color: #8a6524;
}

.dot-offline {
  color: #b91c1c;
  border-color: #f2cccc;
}
</style>
