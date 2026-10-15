import { NODE_KIND_LABEL } from '@clarifyai/shared';
import type { RequirementNode, Session } from '@clarifyai/shared';

/**
 * 递归渲染一个节点及其子树。
 *
 * 这里必须整棵树一次性递归完成 —— 早先按「类型」分组后再各自递归的做法，
 * 会让每个分组都把自己的子树重渲一遍，同一节点在文档里出现多次。
 * 类型信息改用行内标签承载，层级结构才是需求文档的主干。
 */
function renderNode(
  node: RequirementNode,
  childrenOf: Map<string | null, RequirementNode[]>,
  depth: number,
): string[] {
  const pad = '  '.repeat(depth);
  const inner = `${pad}  `;
  const lines: string[] = [];

  const meta = [NODE_KIND_LABEL[node.kind]];
  if (node.origin === 'user') meta.push('用户补充');
  if (node.dependsOn.length > 0) meta.push(`依赖 ${node.dependsOn.length} 项`);

  lines.push(`${pad}- **${node.title}**　\`${meta.join(' · ')}\``);

  if (node.detail.trim()) {
    for (const line of node.detail.trim().split('\n')) {
      lines.push(`${inner}${line}`);
    }
  }

  if (node.acceptance.length > 0) {
    lines.push(`${inner}- 验收标准：`);
    for (const criterion of node.acceptance) {
      lines.push(`${inner}  - [ ] ${criterion}`);
    }
  }

  if (node.userNote.trim()) {
    lines.push(`${inner}- 用户批注：${node.userNote.trim()}`);
  }

  for (const child of childrenOf.get(node.id) ?? []) {
    lines.push(...renderNode(child, childrenOf, depth + 1));
  }

  return lines;
}

/**
 * 把确认后的需求树渲染成 Markdown。
 * 主 Agent 拿到后可直接当作实现依据写回自己的上下文，无需二次整理。
 */
export function renderSpecMarkdown(
  session: Session,
  confirmed: readonly RequirementNode[],
  implementationPlan: string,
): string {
  const confirmedIds = new Set(confirmed.map((n) => n.id));
  const childrenOf = new Map<string | null, RequirementNode[]>();

  for (const node of confirmed) {
    // 父节点被否决时，子节点上浮到顶层，避免整棵子树凭空消失
    const parentKey = node.parentId && confirmedIds.has(node.parentId) ? node.parentId : null;
    const list = childrenOf.get(parentKey) ?? [];
    list.push(node);
    childrenOf.set(parentKey, list);
  }

  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  const lines: string[] = [];
  const title = session.projectContext.projectName || '未命名项目';

  lines.push(`# 需求规格 · ${title}`);
  lines.push('');
  lines.push(`> 原始需求：${session.rawRequirement}`);
  lines.push(`> 会话：\`${session.id}\`　已确认条目：${confirmed.length} 条`);
  lines.push('');
  lines.push('## 需求清单');
  lines.push('');

  const roots = childrenOf.get(null) ?? [];
  if (roots.length === 0) {
    lines.push('_（暂无已确认的需求条目）_');
  } else {
    for (const root of roots) {
      lines.push(...renderNode(root, childrenOf, 0));
    }
  }
  lines.push('');

  const excluded = session.nodes.filter((n) => n.kind === 'out-of-scope');
  if (excluded.length > 0) {
    lines.push('## 本期明确不做');
    lines.push('');
    for (const node of excluded) {
      lines.push(`- ${node.title}${node.detail.trim() ? ` —— ${node.detail.trim()}` : ''}`);
    }
    lines.push('');
  }

  if (implementationPlan.trim()) {
    lines.push('## 实现路径');
    lines.push('');
    lines.push(implementationPlan.trim());
    lines.push('');
  }

  return lines.join('\n');
}
