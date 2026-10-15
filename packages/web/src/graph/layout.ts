import type { RequirementNode } from '@clarifyai/shared';

/** 卡片尺寸：上半部分是信息展示，底部一条留给操作按钮 */
export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 112;

/** 卡片内部：信息区高度，操作按钮从这条线往下排 */
export const CARD_CONTENT_HEIGHT = 78;

/** 兄弟分支之间的垂直间距 */
const V_GAP = 16;
/** 层级之间的水平间距 */
const H_GAP = 76;

export interface LaidOutNode {
  node: RequirementNode;
  x: number;
  y: number;
}

/**
 * 横向思维导图布局。
 *
 * 与自上而下的树不同，思维导图沿水平方向展开：层级决定 x，兄弟顺序决定 y。
 * 父节点垂直居中于它整棵子树 —— 这样从主需求向右看过去，分支是发散开来的。
 *
 * 依旧是自算而非引入 @antv/layout：节点规模只有几十个，
 * 后序求子树高度、前序分配坐标，二十行足够，也免掉一层依赖耦合。
 */
export function layoutTree(nodes: readonly RequirementNode[]): LaidOutNode[] {
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
    const value =
      kids.length === 0
        ? CARD_HEIGHT
        : kids.reduce((sum, kid) => sum + subtreeHeight(kid), 0) + V_GAP * (kids.length - 1);

    const result = Math.max(CARD_HEIGHT, value);
    heights.set(node.id, result);
    return result;
  }

  const result: LaidOutNode[] = [];

  /** @param top 本子树在垂直方向的起始位置 */
  function place(node: RequirementNode, top: number, depth: number): void {
    const height = subtreeHeight(node);
    const kids = childrenOf.get(node.id) ?? [];

    // 父节点居中于整棵子树；叶子节点的子树高度就是它自己，自然对齐
    result.push({
      node,
      x: depth * (CARD_WIDTH + H_GAP),
      y: top + (height - CARD_HEIGHT) / 2,
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
    cursor += subtreeHeight(root) + V_GAP * 3;
  }

  return result;
}
