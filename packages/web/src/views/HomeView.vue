<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { fetchSessions } from '@/api/client';
import type { SessionSummary } from '@/api/client';

const sessions = ref<SessionSummary[]>([]);
const loading = ref(true);
const error = ref('');

const STATUS_TEXT: Record<string, string> = {
  'awaiting-user': '等待用户裁决',
  'awaiting-agent': 'AI 正在处理',
  completed: '已收口',
  aborted: '已终止',
};

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

onMounted(async () => {
  try {
    const result = await fetchSessions();
    sessions.value = result.sessions;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="home">
    <header class="home__head">
      <h1>ClarifyAI</h1>
      <p>
        让 AI 先把需求问清楚再动手。会话由主 Agent 通过 MCP 创建，这里列出全部历史澄清记录。
      </p>
    </header>

    <div v-if="loading" class="empty-hint">加载中…</div>
    <div v-else-if="error" class="empty-hint">{{ error }}</div>
    <div v-else-if="sessions.length === 0" class="empty-hint">
      还没有任何澄清会话。<br />
      在你的 AI 编程助手里配置好 ClarifyAI 的 MCP server，然后让它调用 clarify_start 即可。
    </div>

    <ul v-else class="session-list">
      <li v-for="item in sessions" :key="item.id">
        <RouterLink :to="`/session/${item.id}`" class="card">
          <div class="card__top">
            <span class="pill" :class="{ 'status-confirmed': item.status === 'completed' }">
              {{ STATUS_TEXT[item.status] ?? item.status }}
            </span>
            <span class="card__time">{{ formatTime(item.updatedAt) }}</span>
          </div>
          <div class="card__title">{{ item.rawRequirement }}</div>
          <div class="card__foot">
            <code>{{ item.id }}</code>
            <span>第 {{ item.round }} 轮</span>
          </div>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.home {
  max-width: 960px;
  margin: 0 auto;
  padding: 56px 24px 80px;
}

.home__head h1 {
  margin: 0 0 8px;
  font-size: 26px;
  letter-spacing: -0.01em;
}

.home__head p {
  margin: 0 0 34px;
  color: var(--text-dim);
  max-width: 62ch;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}

.card {
  display: block;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
}

.card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
  transform: translateY(-1px);
}

.card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.card__time {
  color: var(--text-faint);
  font-size: 12px;
}

.card__title {
  font-size: 14.5px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card__foot {
  display: flex;
  gap: 14px;
  margin-top: 11px;
  color: var(--text-faint);
  font-size: 12px;
}

.card__foot code {
  font-family: 'Cascadia Code', Consolas, monospace;
}
</style>
