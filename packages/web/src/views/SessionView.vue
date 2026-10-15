<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { CanvasController } from '@/graph/canvas';
import type { CardAction } from '@/graph/canvas';
import { useSessionStore } from '@/stores/session';
import NodeInspector from '@/components/NodeInspector.vue';
import SessionToolbar from '@/components/SessionToolbar.vue';
import SpecDrawer from '@/components/SpecDrawer.vue';

const props = defineProps<{ id: string }>();

const store = useSessionStore();
const canvasHost = ref<HTMLElement | null>(null);
const specOpen = ref(false);

let canvas: CanvasController | null = null;

const statusText = computed(() => {
  switch (store.status) {
    case 'awaiting-user':
      return '等待你裁决';
    case 'awaiting-agent':
      return 'AI 正在处理';
    case 'completed':
      return '已收口';
    default:
      return '已终止';
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
  canvas?.render(store.nodes, store.selectedId, store.editable);
}

/** 卡片内那排按钮的落点 */
function handleCardAction(id: string, action: CardAction): void {
  switch (action) {
    case 'edit':
      store.requestEdit(id);
      break;

    case 'delete':
      store.removeNode(id);
      render();
      break;

    case 'expand':
      // 点完立即提交，画布随即进入只读，等 AI 把新分支推回来
      void store.requestExpand(id);
      break;

    case 'child':
      store.addChild(id);
      render();
      break;

    case 'sibling': {
      const current = store.nodes.find((item) => item.id === id);
      store.addChild(current?.parentId ?? null);
      render();
      break;
    }
  }
}

onMounted(async () => {
  await store.load(props.id);
  if (!canvasHost.value) return;

  canvas = new CanvasController(canvasHost.value, {
    onSelect: (id) => store.select(id),
    onCardAction: handleCardAction,
    onAddRoot: () => {
      store.addChild(null);
      render();
    },
  });

  render();
  // 等布局稳定后再对齐视口，避免首帧尺寸为 0
  window.setTimeout(() => canvas?.fit(), 60);
});

onBeforeUnmount(() => {
  canvas?.dispose();
  canvas = null;
  store.dispose();
});

// 深度监听：节点内容或结构任一变化都要重绘图
watch(
  () => store.nodes,
  () => render(),
  { deep: true },
);
watch(() => store.selectedId, () => render());
// 可编辑态变化时要重绘，否则卡片上的操作按钮不会随只读态一起消失
watch(() => store.editable, () => render());
</script>

<template>
  <div class="session">
    <header class="session__header">
      <div class="session__title">
        <RouterLink to="/" class="back" title="返回会话列表">←</RouterLink>
        <div class="session__title-text">
          <div class="project">{{ projectName }}</div>
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

    <!-- 之前 errorMessage 只存在于 store 里，用户看不到任何失败反馈 -->
    <div v-if="store.errorMessage" class="error-banner">
      <span class="error-banner__text">{{ store.errorMessage }}</span>
      <button class="error-banner__close" title="关闭" @click="store.clearError()">×</button>
    </div>

    <div class="session__body">
      <main class="canvas-area">
        <div ref="canvasHost" class="canvas-host"></div>

        <div class="canvas-tools">
          <button class="btn btn--ghost" @click="canvas?.fit()">适应画布</button>
          <button class="btn btn--ghost" @click="canvas?.resetZoom()">100%</button>
        </div>

        <div v-if="store.agentBusy" class="canvas-banner canvas-banner--busy">
          AI 正在根据你的裁决重新拆解…
        </div>
        <div v-else-if="store.agentNote" class="canvas-banner" :title="store.agentNote">
          {{ store.agentNote }}
        </div>

        <div v-if="store.pendingAssumptions.length" class="assumption-banner">
          <span>有 {{ store.pendingAssumptions.length }} 条 AI 假设尚未裁决，裁决完再让 AI 往下拆</span>
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

      <aside class="inspector">
        <NodeInspector v-if="store.selected" :node="store.selected" />
        <div v-else class="empty-hint">
          在左侧选中一条需求开始编辑<br />
          双击画布空白处可新增顶层需求<br />
          拖动节点边缘圆点可声明依赖关系
        </div>
      </aside>
    </div>

    <SessionToolbar @open-spec="specOpen = true" />

    <SpecDrawer v-if="specOpen" :session-id="id" @close="specOpen = false" />
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

.session__body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 372px;
  min-height: 0;
}

.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 18px;
  font-size: 13px;
  color: #ffb4b4;
  background: #2a1619;
  border-bottom: 1px solid #5a2b32;
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
  min-width: 0;
  background:
    radial-gradient(circle at 20% 0%, rgba(99, 102, 241, 0.07), transparent 55%),
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
  background: rgba(12, 14, 21, 0.72);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
}

.canvas-banner {
  position: absolute;
  left: 14px;
  top: 14px;
  max-width: 46ch;
  padding: 8px 13px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  background: rgba(18, 22, 31, 0.9);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  backdrop-filter: blur(6px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-banner--busy {
  color: #c7c9ff;
  border-color: rgba(99, 102, 241, 0.5);
  background: rgba(30, 30, 62, 0.92);
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
  color: #ffd79a;
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: rgba(43, 32, 17, 0.92);
  backdrop-filter: blur(6px);
}

.assumption-banner__actions {
  display: flex;
  gap: 4px;
}

.banner-btn {
  padding: 2px 9px;
  font-size: 12px;
  color: #ffd79a;
}

.inspector {
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  overflow-y: auto;
  min-height: 0;
}

.dot-offline {
  color: #ffb4b4;
  border-color: #5a2b32;
}
</style>
