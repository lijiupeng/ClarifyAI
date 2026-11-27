import type { RequirementNode } from '@clarifyai/shared';

/** 卡片宽度固定：思维导图靠层级展开，宽度一致才有节奏 */
export const CARD_WIDTH = 300;

/** 兄弟分支之间的垂直间距 */
const V_GAP = 18;
/** 层级之间的水平间距 */
const H_GAP = 84;

/** 估算一行能放几个中文字符（300 - 左右 padding，13px 字号） */
const TITLE_CHARS_PER_LINE = 17;
const BODY_CHARS_PER_LINE = 22;

export interface LaidOutNode {
  node: RequirementNode;
  x: number;
  y: number;
}

function lineCount(text: string, perLine: number): number {
  return text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

export interface CardHeightOptions {
  isRoot: boolean;
  selected: boolean;
  editable: boolean;
  /** 该节点上待处理的建议条数，每条会撑高一段灰字 */
  suggestionCount: number;
}

/**
 * 卡片高度按内容估算。
 *
 * X6 的 HTML 节点不会随内容自适应，高度必须由外部给定；
 * 所以这里用与 CSS 成对的常量做估算 —— 改样式时要同步改这里。
 */
export function cardHeight(node: RequirementNode, options: CardHeightOptions): number {
  const { isRoot, selected, editable, suggestionCount } = options;
  const titleLine = isRoot ? 24 : 19;

  let height = 24; // 上下内边距
  height += 16 + 4; // 类型 / 状态行
  height += lineCount(node.title, isRoot ? 13 : TITLE_CHARS_PER_LINE) * titleLine;

  if (node.detail.trim()) {
    height += 4 + lineCount(node.detail, BODY_CHARS_PER_LINE) * 17;
  } else if (selected && editable) {
    // 选中时会给空说明留一行输入提示
    height += 4 + 17;
  }

  for (const criterion of node.acceptance) {
    height += lineCount(criterion, BODY_CHARS_PER_LINE) * 16 + 2;
  }

  // 待裁决的 AI 假设自带一行「接受 / 否决」
  if (node.kind === 'assumption' && editable) height += 40;

  height += suggestionCount * 70;

  // 只有选中且可编辑时才出现操作按钮
  if (selected && editable) height += 36;

  return Math.max(64, Math.round(height));
}

/**
 * 横向思维导图布局。
 *
 * 与自上而下的树不同，思维导图沿水平方向展开：层级决定 x，兄弟顺序决定 y。
 * 父节点垂直居中于它整棵子树 —— 这样从根需求向右看过去，分支是发散开来的。
 *
 * 依旧是自算而非引入 @antv/layout：节点规模只有几十个，
 * 后序求子树高度、前序分配坐标，二十行足够，也免掉一层依赖耦合。
 */
export function layoutTree(
  nodes: readonly RequirementNode[],
  heightOf: (node: RequirementNode) => number,
): LaidOutNode[] {
  const childrenOf = new Map<string | null, RequirementNode[]>();

  for (const node of nodes) {
    const key = node.parentId ?? null;
    const list = childrenOf.get(key) ?? [];
    list.push(node);
    childrenOf.set(key, list);
  }

  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  const heights = new Map<string, number>();

  /** 整棵子树在垂直方向占用的总高度 */
  function subtreeHeight(node: RequirementNode): number {
    const cached = heights.get(node.id);
    if (cached !== undefined) return cached;

    const kids = childrenOf.get(node.id) ?? [];
    const own = heightOf(node);
    const value =
      kids.length === 0
        ? own
        : Math.max(
            own,
            kids.reduce((sum, kid) => sum + subtreeHeight(kid), 0) + V_GAP * (kids.length - 1),
          );

    heights.set(node.id, value);
    return value;
  }

  const result: LaidOutNode[] = [];

  /** @param top 本子树在垂直方向的起始位置 */
  function place(node: RequirementNode, top: number, depth: number): void {
    const height = subtreeHeight(node);
    const own = heightOf(node);
    const kids = childrenOf.get(node.id) ?? [];

    // 父节点居中于整棵子树；叶子节点的子树高度就是它自己，自然对齐
    result.push({
      node,
      x: depth * (CARD_WIDTH + H_GAP),
      y: top + (height - own) / 2,
    });

    if (kids.length === 0) return;

    const kidsHeight =
      kids.reduce((sum, kid) => sum + subtreeHeight(kid), 0) + V_GAP * (kids.length - 1);

    let cursor = top + (height - kidsHeight) / 2;
    for (const kid of kids) {
      place(kid, cursor, depth + 1);
      cursor += subtreeHeight(kid) + V_GAP;
    }
  }

  let cursor = 0;
  for (const root of childrenOf.get(null) ?? []) {
    place(root, cursor, 0);
    cursor += subtreeHeight(root);
  }

  return result;
}
