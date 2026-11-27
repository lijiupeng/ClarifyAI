import { naturalizeCriterion } from '@clarifyai/shared';
import type { NodeKind, NodeSuggestion, RequirementNode } from '@clarifyai/shared';

/**
 * 卡片节点用 HTML 而非 SVG 绘制。
 *
 * 起因是 SVG `<text>` 的 x/y 定位在这个场景下不可控（文字被居中并溢出卡片），
 * 而卡片需要「徽标 + 可编辑标题 + 说明 + 验收 + 建议」这种典型排版 ——
 * 交给 CSS 一个 flex 就解决，用 SVG 手算坐标则又脆又难维护。
 */

const KIND_LABEL: Record<NodeKind, string> = {
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

export interface CardSuggestion extends NodeSuggestion {
  /** move 建议要显示「移到谁下面」，标题由数据层查出来塞进来 */
  moveTargetTitle?: string;
}

export interface CardView {
  node: RequirementNode;
  isRoot: boolean;
  selected: boolean;
  editable: boolean;
  suggestions: readonly CardSuggestion[];
  /** 当前正在审阅的建议 id —— 高亮它，让用户知道画布正带他过哪一条 */
  activeSuggestionId?: string | null;
  /**
   * 灰色幽灵节点：AI 建议新增的子节点。
   * 它还不是真实节点，只是画布上的一个候选位置，点「采纳」才落地。
   */
  ghost?: { suggestionId: string; note: string };
}

const ROOT_ACTIONS: Array<{ action: string; label: string; variant?: string }> = [
  { action: 'child', label: '+ 子需求' },
  { action: 'expand', label: 'AI 拆解', variant: 'primary' },
];

const NODE_ACTIONS: Array<{ action: string; label: string; variant?: string }> = [
  { action: 'child', label: '+ 子' },
  { action: 'sibling', label: '+ 同级' },
  { action: 'expand', label: 'AI 拆解', variant: 'primary' },
  { action: 'delete', label: '删除', variant: 'danger' },
];

/** 一条建议在卡片里长什么样：说清楚「改哪里、改成什么」 */
function suggestionHtml(suggestion: CardSuggestion, active: boolean): string {
  const parts: string[] = [];

  if (suggestion.action === 'expand') {
    parts.push(`<div class="req-card__suggestion-main">新增子需求：${escapeHtml(suggestion.title)}</div>`);
    if (suggestion.detail.trim()) {
      parts.push(`<div class="req-card__suggestion-sub">${escapeHtml(suggestion.detail)}</div>`);
    }
  } else if (suggestion.action === 'remove') {
    parts.push('<div class="req-card__suggestion-main">建议删掉这个节点</div>');
  } else if (suggestion.action === 'move') {
    parts.push(
      `<div class="req-card__suggestion-main">挪到「${escapeHtml(
        suggestion.moveTargetTitle ?? '根节点',
      )}」下面</div>`,
    );
  } else {
    if (suggestion.title) {
      parts.push(`<div class="req-card__suggestion-main">改标题：${escapeHtml(suggestion.title)}</div>`);
    }
    if (suggestion.detail.trim()) {
      parts.push(`<div class="req-card__suggestion-sub">补说明：${escapeHtml(suggestion.detail)}</div>`);
    }
    for (const criterion of suggestion.acceptance) {
      parts.push(`<div class="req-card__suggestion-sub">补验收：${escapeHtml(criterion)}</div>`);
    }
  }

  const note = suggestion.note.trim()
    ? `<div class="req-card__suggestion-note">${escapeHtml(suggestion.note)}</div>`
    : '';

  // 删除是不可逆的，按钮不能也叫「采纳」
  const acceptLabel = suggestion.action === 'remove' ? '删除' : '采纳';

  return `<div class="req-card__suggestion${active ? ' is-active' : ''}" data-suggestion="${suggestion.id}">
      ${parts.join('')}
      ${note}
      <div class="req-card__suggestion-actions">
        <button type="button" data-suggestion-accept="${suggestion.id}">${acceptLabel}</button>
        <button type="button" data-suggestion-ignore="${suggestion.id}">忽略</button>
      </div>
    </div>`;
}

/** 灰色建议节点：只展示内容 + 采纳 / 忽略，不可编辑、不可选中 */
function ghostHtml(view: CardView): string {
  const { node, ghost } = view;
  const active = Boolean(ghost && view.activeSuggestionId === ghost.suggestionId);
  const parts: string[] = [
    `<div class="req-card req-card--ghost${active ? ' is-active' : ''}">`,
    '<div class="req-card__meta"><span class="req-card__kind is-ghost">AI 建议</span></div>',
    `<div class="req-card__title">${escapeHtml(node.title)}</div>`,
  ];

  if (node.detail.trim()) {
    parts.push(`<div class="req-card__detail">${escapeHtml(node.detail)}</div>`);
  }

  for (const criterion of node.acceptance) {
    const text = naturalizeCriterion(criterion);
    if (text) parts.push(`<div class="req-card__criterion">${escapeHtml(text)}</div>`);
  }

  if (ghost?.note.trim()) {
    parts.push(`<div class="req-card__suggestion-note">${escapeHtml(ghost.note)}</div>`);
  }

  if (ghost) {
    parts.push(`<div class="req-card__ghost-actions">
      <button type="button" data-suggestion-accept="${ghost.suggestionId}">采纳</button>
      <button type="button" data-suggestion-ignore="${ghost.suggestionId}">忽略</button>
    </div>`);
  }

  parts.push('</div>');
  return parts.join('');
}

export function cardHtml(view: CardView): string {
  if (view.ghost) return ghostHtml(view);

  const { node, isRoot, selected, editable, suggestions } = view;

  // 画布上没有「待确认 / 已确认」这种状态：落到图上的条目就是正式的，
  // 还在犹豫的东西一律先以灰色建议的形式存在
  const classes = [
    'req-card',
    isRoot ? 'req-card--root' : `req-card--${node.kind}`,
    selected ? 'is-selected' : '',
    editable ? 'is-editable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const editAttr = editable ? ' contenteditable="true" spellcheck="false"' : '';

  // 按钮只在选中且可编辑时出现 —— 每张卡片常驻一排按钮会把画布糊成一片
  const actions =
    selected && editable
      ? `<div class="req-card__actions">${(isRoot ? ROOT_ACTIONS : NODE_ACTIONS)
          .map(
            (item) =>
              `<button type="button" data-action="${item.action}"${
                item.variant ? ` class="is-${item.variant}"` : ''
              }>${item.label}</button>`,
          )
          .join('')}</div>`
      : '';

  // 空说明不占位：阅读态下多一行灰色「补充说明」会被当成真内容。
  // 只有选中（即将编辑）时才给输入提示。
  const detail = node.detail.trim()
    ? `<div class="req-card__detail" data-field="detail"${editAttr}>${escapeHtml(node.detail)}</div>`
    : selected && editable
      ? `<div class="req-card__detail is-empty" data-field="detail"${editAttr} data-placeholder="补充说明"></div>`
      : '';

  // 验收标准只读：数据里保留 WHEN/THEN 供 AI 使用，画布上只呈现「条件 → 结果」
  const acceptance =
    node.acceptance.length > 0
      ? `<div class="req-card__acceptance">${node.acceptance
          .map((criterion) => naturalizeCriterion(criterion))
          .filter(Boolean)
          .map((criterion) => `<div class="req-card__criterion">${escapeHtml(criterion)}</div>`)
          .join('')}</div>`
      : '';

  // AI 假设必须能就地裁决：右侧详情栏没了，这块能力不能跟着没
  const assumptionPanel =
    node.kind === 'assumption' && editable
      ? `<div class="req-card__assumption">
      <span class="req-card__assumption-text">AI 的推断，还没被你确认</span>
      <span class="req-card__assumption-actions">
        <button type="button" data-action="accept">接受</button>
        <button type="button" data-action="reject">否决</button>
      </span>
    </div>`
      : '';

  const suggestionsHtml =
    suggestions.length > 0
      ? `<div class="req-card__suggestions">${suggestions
          .map((item) => suggestionHtml(item, view.activeSuggestionId === item.id))
          .join('')}</div>`
      : '';

  const meta = isRoot
    ? '<span class="req-card__kind">需求书</span>'
    : `<span class="req-card__kind">${KIND_LABEL[node.kind]}</span>`;

  return `<div class="${classes}">
  <div class="req-card__meta">${meta}</div>
  <div class="req-card__title" data-field="title"${editAttr}>${escapeHtml(node.title)}</div>
  ${detail}
  ${acceptance}
  ${assumptionPanel}
  ${suggestionsHtml}
  ${actions}
</div>`;
}
