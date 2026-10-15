<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { marked } from 'marked';
import { fetchSpec } from '@/api/client';

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ close: [] }>();

const markdown = ref('');
const loading = ref(true);
const error = ref('');
const copied = ref(false);

const rendered = computed<string>(() => {
  if (!markdown.value) return '';
  // 本地工具，内容来自自己的后端；仍显式关掉 async 以保证同步返回 string
  return marked.parse(markdown.value, { async: false }) as string;
});

onMounted(async () => {
  try {
    const result = await fetchSpec(props.sessionId);
    markdown.value = result.markdown;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
});

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(markdown.value);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div class="drawer-mask" @click.self="emit('close')">
    <section class="drawer">
      <header class="drawer__head">
        <div>
          <div class="drawer__title">需求规格预览</div>
          <div class="drawer__hint">只包含你已确认的条目。这份内容就是 AI 最终会拿到的实现依据。</div>
        </div>
        <div class="drawer__actions">
          <button class="btn btn--ghost" :disabled="loading || !markdown" @click="copy">
            {{ copied ? '已复制' : '复制 Markdown' }}
          </button>
          <button class="btn" @click="emit('close')">关闭</button>
        </div>
      </header>

      <div class="drawer__body">
        <div v-if="loading" class="empty-hint">加载中…</div>
        <div v-else-if="error" class="empty-hint">{{ error }}</div>
        <article v-else class="spec-md" v-html="rendered"></article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(5, 7, 12, 0.66);
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}

.drawer {
  width: min(780px, 84vw);
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--bg-panel);
  border-left: 1px solid var(--border-strong);
}

.drawer__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.drawer__title {
  font-weight: 600;
}

.drawer__hint {
  color: var(--text-faint);
  font-size: 12.5px;
  margin-top: 3px;
}

.drawer__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.drawer__body {
  overflow: auto;
  padding: 20px 26px 40px;
}

/* v-html 的内容不在 scoped 作用域内，必须用 :deep 穿透 */
.spec-md {
  font-size: 13.5px;
  line-height: 1.8;
  color: #cfd5e6;
}

.spec-md :deep(h1) {
  font-size: 21px;
  margin: 0 0 16px;
  color: #fff;
  letter-spacing: -0.01em;
}

.spec-md :deep(h2) {
  font-size: 15px;
  margin: 28px 0 12px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border);
  color: #fff;
}

.spec-md :deep(h3) {
  font-size: 14px;
  margin: 20px 0 8px;
  color: #e7eaf4;
}

.spec-md :deep(ul) {
  margin: 8px 0;
  padding-left: 22px;
}

.spec-md :deep(li) {
  margin: 5px 0;
}

.spec-md :deep(li > ul) {
  margin: 4px 0;
}

.spec-md :deep(blockquote) {
  margin: 0 0 16px;
  padding: 9px 14px;
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: rgba(99, 102, 241, 0.07);
  color: var(--text-dim);
  font-size: 13px;
}

.spec-md :deep(blockquote p) {
  margin: 2px 0;
}

.spec-md :deep(code) {
  font-family: 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace;
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #0d0f16;
  border: 1px solid var(--border);
  color: #a8b4d0;
}

.spec-md :deep(strong) {
  color: #fff;
}

.spec-md :deep(a) {
  color: var(--accent-hover);
}
</style>
