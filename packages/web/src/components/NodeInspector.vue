<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NODE_KIND_LABEL } from '@clarifyai/shared';
import type { NodeKind, RequirementNode } from '@clarifyai/shared';
import { useSessionStore } from '@/stores/session';

const props = defineProps<{ node: RequirementNode }>();
const store = useSessionStore();

const titleRef = ref<HTMLTextAreaElement | null>(null);

// 点画布卡片上的「修改」后，把光标直接送到标题框，省掉再点一次的成本
watch(
  () => store.editingId,
  (editingId) => {
    if (editingId !== props.node.id) return;
    void nextTick(() => {
      titleRef.value?.focus();
      titleRef.value?.setSelectionRange(0, titleRef.value.value.length);
    });
  },
);

const editable = computed(() => store.editable);
const kinds = Object.keys(NODE_KIND_LABEL) as NodeKind[];
const isAssumption = computed(() => props.node.kind === 'assumption');
const originText = computed(() => (props.node.origin === 'ai' ? 'AI 拆解' : '你补充'));

function update(patch: Partial<RequirementNode>): void {
  store.updateNode(props.node.id, patch);
}

function setAcceptance(index: number, value: string): void {
  const next = [...props.node.acceptance];
  next[index] = value;
  update({ acceptance: next });
}

function addAcceptance(): void {
  update({ acceptance: [...props.node.acceptance, 'WHEN  THEN '] });
}

function removeAcceptance(index: number): void {
  update({ acceptance: props.node.acceptance.filter((_, i) => i !== index) });
}

async function rule(decision: 'accept' | 'reject'): Promise<void> {
  store.ruleAssumption(props.node.id, decision);
  await store.flush();
}
</script>

<template>
  <div class="inspector-body">
    <div class="inspector-head">
      <div class="chips">
        <span class="pill" :class="`kind-${node.kind}`">{{ NODE_KIND_LABEL[node.kind] }}</span>
        <span class="pill" :class="{ 'status-confirmed': node.status === 'confirmed' }">
          {{ node.status === 'confirmed' ? '已确认' : node.status === 'rejected' ? '已否决' : '待确认' }}
        </span>
        <span class="pill">{{ originText }}</span>
      </div>
      <div class="depth">第 {{ node.depth + 1 }} 层</div>
    </div>

    <div v-if="isAssumption" class="assumption-card">
      <div class="assumption-card__title">这是 AI 的推断，还没被你确认</div>
      <div class="assumption-card__hint">
        AI 认为需要这样做，但它并不确定。请裁决 —— 否决会让 AI 知道这条路走不通。
      </div>
      <div class="assumption-card__actions">
        <button class="btn btn--primary" :disabled="!editable" @click="rule('accept')">
          接受，转为正式需求
        </button>
        <button class="btn btn--danger" :disabled="!editable" @click="rule('reject')">
          否决，删掉它
        </button>
      </div>
    </div>

    <label class="field">
      <span class="field__label">需求内容</span>
      <textarea
        ref="titleRef"
        class="textarea"
        :value="node.title"
        :disabled="!editable"
        rows="3"
        placeholder="一句话说清这条需求"
        @input="update({ title: ($event.target as HTMLTextAreaElement).value })"
      ></textarea>
    </label>

    <label class="field">
      <span class="field__label">类型</span>
      <select
        class="select"
        :value="node.kind"
        :disabled="!editable"
        @change="update({ kind: ($event.target as HTMLSelectElement).value as NodeKind })"
      >
        <option v-for="kind in kinds" :key="kind" :value="kind">
          {{ NODE_KIND_LABEL[kind] }}
        </option>
      </select>
    </label>

    <label class="field">
      <span class="field__label">补充说明</span>
      <textarea
        class="textarea"
        :value="node.detail"
        :disabled="!editable"
        rows="3"
        placeholder="边界条件、异常分支、AI 的答复会追加在这里"
        @input="update({ detail: ($event.target as HTMLTextAreaElement).value })"
      ></textarea>
    </label>

    <div class="field">
      <div class="field__row">
        <span class="field__label">验收标准</span>
        <button class="btn btn--ghost tiny" :disabled="!editable" @click="addAcceptance">+ 添加</button>
      </div>
      <p class="field__hint">
        写成「WHEN 前置条件 THEN 可观测结果」。写不出来，说明这条需求还没拆到位。
      </p>

      <div v-if="node.acceptance.length === 0" class="field__empty">暂无验收标准</div>

      <div v-for="(item, index) in node.acceptance" :key="index" class="acceptance-row">
        <textarea
          class="textarea acceptance-row__input"
          :value="item"
          :disabled="!editable"
          rows="2"
          @input="setAcceptance(index, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
        <button class="btn btn--ghost tiny" :disabled="!editable" @click="removeAcceptance(index)">
          删除
        </button>
      </div>
    </div>

    <label class="field">
      <span class="field__label">你的批注（AI 必须逐条回应）</span>
      <textarea
        class="textarea"
        :value="node.userNote"
        :disabled="!editable"
        rows="3"
        placeholder="这条哪里不对、你要的是什么 —— 写在这里，AI 下一轮必须回应"
        @input="update({ userNote: ($event.target as HTMLTextAreaElement).value })"
      ></textarea>
    </label>

    <div v-if="node.dependsOn.length" class="field">
      <span class="field__label">依赖（实现路径）</span>
      <div class="dep-list">
        <span v-for="dep in node.dependsOn" :key="dep" class="pill">
          {{ store.nodes.find((n) => n.id === dep)?.title ?? dep }}
          <button class="dep-remove" :disabled="!editable" @click="store.removeDependency(node.id, dep)">
            ×
          </button>
        </span>
      </div>
    </div>

    <div class="inspector-actions">
      <button
        class="btn btn--primary"
        :disabled="!editable"
        title="让 AI 沿这个节点再推断出一个子需求分支"
        @click="store.requestExpand(node.id)"
      >
        推断下一个分支
      </button>
    </div>

    <div class="inspector-actions">
      <button class="btn" :disabled="!editable" @click="store.addChild(node.id)">添加子需求</button>
      <button class="btn" :disabled="!editable" @click="store.addChild(node.parentId)">添加同级</button>
      <button class="btn btn--danger" :disabled="!editable" @click="store.removeNode(node.id)">
        删除
      </button>
    </div>
  </div>
</template>

<style scoped>
.inspector-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 18px;
}

.inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.depth {
  color: var(--text-faint);
  font-size: 12px;
  flex-shrink: 0;
}

.assumption-card {
  padding: 13px 14px;
  border-radius: var(--radius);
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.09);
}

.assumption-card__title {
  color: #ffd79a;
  font-weight: 600;
  margin-bottom: 5px;
}

.assumption-card__hint {
  color: #c3ab84;
  font-size: 12.5px;
  line-height: 1.6;
}

.assumption-card__actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.assumption-card__actions .btn {
  flex: 1;
  justify-content: center;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.field__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field__label {
  color: var(--text-dim);
  font-size: 12.5px;
  font-weight: 500;
}

.field__hint {
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}

.field__empty {
  color: var(--text-faint);
  font-size: 12.5px;
  padding: 8px 0;
}

.tiny {
  padding: 3px 9px;
  font-size: 12px;
}

.acceptance-row {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.acceptance-row__input {
  min-height: 50px;
  font-size: 13px;
}

.dep-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dep-remove {
  margin-left: 5px;
  border: none;
  background: none;
  color: inherit;
  opacity: 0.6;
  padding: 0;
  font-size: 13px;
}

.dep-remove:hover {
  opacity: 1;
}

.inspector-actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.inspector-actions .btn {
  flex: 1;
  justify-content: center;
}
</style>
