import type { NodeKind, RequirementNode } from '@clarifyai/shared';

/**
 * 卡片节点用 HTML 而非 SVG 绘制。
 *
 * 起因是 SVG `<text>` 的 x/y 定位在这个场景下不可控（文字被居中并溢出卡片），
 * 而卡片需要「图标方块 + 两行标题截断 + 描述 + 一排按钮」这种典型排版 ——
 * 交给 CSS 一个 flex 就解决，用 SVG 手算坐标则又脆又难维护。
 * 参考的 agentFlow 案例用的也是组件节点，思路一致。
 */

const KIND_ICON: Record<NodeKind, string> = {
  functional: '功能',
  'non-functional': '质量',
  constraint: '约束',
  assumption: '假设',
  'out-of-scope': '不做',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 描述行：交代来源与完成度，让「这条是谁写的」一眼可见 */
function describe(node: RequirementNode): string {
  const parts: string[] = [node.origin === 'ai' ? 'AI 拆解' : '你补充'];
  parts.push(node.acceptance.length > 0 ? `验收 ${node.acceptance.length} 条` : '尚无验收标准');
  if (node.userNote.trim()) parts.push('含批注');
  return parts.join(' · ');
}

const ACTIONS: Array<{ action: string; label: string; variant?: string }> = [
  { action: 'edit', label: '修改' },
  { action: 'delete', label: '删除', variant: 'danger' },
  { action: 'expand', label: '推断分支', variant: 'primary' },
  { action: 'child', label: '+ 子需求' },
  { action: 'sibling', label: '+ 同级' },
];

export function cardHtml(node: RequirementNode, selected: boolean, editable: boolean): string {
  const classes = [
    'req-card',
    `req-card--${node.kind}`,
    `is-${node.status}`,
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // 按钮只在选中且可编辑时出现 —— 每张卡片常驻五个按钮会把画布糊成一片
  const actions =
    selected && editable
      ? `<div class="req-card__actions">${ACTIONS.map(
          (item) =>
            `<button type="button" data-action="${item.action}"${
              item.variant ? ` class="is-${item.variant}"` : ''
            }>${item.label}</button>`,
        ).join('')}</div>`
      : '';

  const title = escapeHtml(node.title);
  const titleClass =
    node.title.length > 30 ? 'req-card__title is-long' : 'req-card__title';

  return `<div class="${classes}">
  <div class="req-card__body">
    <div class="req-card__icon">${KIND_ICON[node.kind]}</div>
    <div class="req-card__text">
      <div class="${titleClass}" title="${title}">${title}</div>
      <div class="req-card__desc">${escapeHtml(describe(node))}</div>
    </div>
    <span class="req-card__dot"></span>
  </div>
  ${actions}
</div>`;
}
