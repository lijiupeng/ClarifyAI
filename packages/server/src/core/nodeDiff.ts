import type { NodeChange, RequirementNode } from '@clarifyai/shared';

/** 这些字段属于系统维护的元数据，不参与差分展示 */
const IGNORED_FIELDS = new Set(['updatedAt', 'sessionId']);

function changedFields(before: RequirementNode, after: RequirementNode): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];

  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a ?? []) !== JSON.stringify(b ?? [])) changed.push(key);
    } else if (a !== b) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * 计算两版需求树的差异。
 * 这个 diff 会直接回灌给主 Agent，让它不必反复读全量节点、把 token 花在理解变化上。
 */
export function diffNodes(
  before: readonly RequirementNode[],
  after: readonly RequirementNode[],
): NodeChange[] {
  const beforeMap = new Map(before.map((n) => [n.id, n]));
  const afterMap = new Map(after.map((n) => [n.id, n]));
  const changes: NodeChange[] = [];

  for (const [id, node] of afterMap) {
    const prev = beforeMap.get(id);
    if (!prev) {
      changes.push({ id, change: 'added', fields: [], before: null, after: node });
      continue;
    }
    const fields = changedFields(prev, node);
    if (fields.length > 0) {
      changes.push({ id, change: 'modified', fields, before: prev, after: node });
    }
  }

  for (const [id, node] of beforeMap) {
    if (!afterMap.has(id)) {
      changes.push({ id, change: 'removed', fields: [], before: node, after: null });
    }
  }

  return changes;
}
