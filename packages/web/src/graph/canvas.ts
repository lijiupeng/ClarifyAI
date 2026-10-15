import { Graph, Shape } from '@antv/x6';
import type { Cell } from '@antv/x6';
import type { RequirementNode } from '@clarifyai/shared';
import { cardHtml } from './cardHtml';
import { CARD_HEIGHT, CARD_WIDTH, layoutTree } from './layout';

export type CardAction = 'edit' | 'delete' | 'expand' | 'child' | 'sibling';

export interface CanvasCallbacks {
  onSelect: (id: string | null) => void;
  onCardAction: (id: string, action: CardAction) => void;
  onAddRoot: () => void;
}

/** 挂在节点上的渲染数据。X6 的 HTML 节点从 cell 读它来生成内容 */
interface CardData {
  requirement: RequirementNode;
  selected: boolean;
  editable: boolean;
}

/**
 * shape 注册是模块级的，但回调属于控制器实例 —— 用这个变量把两者接上。
 * 单页里只会有一个画布实例，够用。
 */
let activeCallbacks: CanvasCallbacks | null = null;

/**
 * 注册卡片节点。
 *
 * 两个关键点（都是实测踩出来的）：
 * 1. X6 的 HTML 节点把内容绑在 **shape** 上（`HTML.shapeMaps[cell.shape]`），
 *    所以必须走 register + `cell.setData()`，直接给 addNode 传 `html` 完全不渲染。
 * 2. 卡片里的按钮**必须在生成 DOM 时直接绑监听**。X6 会拦下冒泡阶段的指针事件，
 *    在容器上做事件委托（无论冒泡还是捕获）都收不到点击。
 */
Shape.HTML.register({
  shape: 'clarify-card',
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
  html(cell: Cell) {
    const data = cell.getData() as CardData | undefined;
    if (!data?.requirement) return '';

    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.innerHTML = cardHtml(data.requirement, data.selected, data.editable);

    for (const button of wrapper.querySelectorAll<HTMLElement>('[data-action]')) {
      const action = button.dataset.action as CardAction | undefined;
      if (!action) continue;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        activeCallbacks?.onCardAction(data.requirement.id, action);
      });
    }

    return wrapper;
  },
});

/**
 * AntV X6 画布封装。
 *
 * 外部把最新的需求树交给 render()，这里只负责映射成图 ——
 * Vue 侧数据始终是唯一真源，不需要在图和 store 之间做双向同步。
 */
export class CanvasController {
  private readonly graph: Graph;
  /** nodeId → 上一次生成的 HTML，用来跳过无谓的重渲染 */
  private readonly htmlById = new Map<string, string>();
  private structureKey = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: CanvasCallbacks,
  ) {
    activeCallbacks = callbacks;

    this.graph = new Graph({
      container,
      autoResize: true,
      background: { color: 'transparent' },
      grid: { visible: true, type: 'dot', size: 18, args: { color: '#181d29', thickness: 1 } },
      panning: { enabled: true, eventTypes: ['leftMouseDown', 'mouseWheel'] },
      mousewheel: {
        enabled: true,
        modifiers: ['ctrl', 'meta'],
        minScale: 0.35,
        maxScale: 2.2,
        factor: 1.1,
      },
      // 连线全部由系统绘制：四个 allow* 全关，用户拖拽不会产生任何落点，
      // 从根上杜绝手工连线把需求树改乱。
      connecting: {
        allowBlank: false,
        allowLoop: false,
        allowNode: false,
        allowEdge: false,
        allowPort: false,
      },
      interacting: {
        nodeMovable: true,
        edgeMovable: false,
        edgeLabelMovable: false,
        arrowheadMovable: false,
        vertexMovable: false,
        vertexAddable: false,
        vertexDeletable: false,
      },
    });

    this.graph.on('node:click', ({ node }) => this.callbacks.onSelect(node.id));
    this.graph.on('blank:click', () => this.callbacks.onSelect(null));
    this.graph.on('blank:dblclick', () => this.callbacks.onAddRoot());
  }

  render(nodes: readonly RequirementNode[], selectedId: string | null, editable: boolean): void {
    const layout = layoutTree(nodes);
    const nextKey = nodes.map((n) => `${n.id}:${n.parentId ?? ''}:${n.order}`).join('|');
    const layoutChanged = nextKey !== this.structureKey;
    this.structureKey = nextKey;

    const alive = new Set<string>();

    for (const { node, x, y } of layout) {
      alive.add(node.id);

      const selected = selectedId === node.id;
      const html = cardHtml(node, selected, editable);
      const existing = this.graph.getCellById(node.id);

      if (existing && existing.isNode()) {
        // 只在结构变化时重排位置，否则用户阅读时整张图会跳来跳去
        if (layoutChanged) existing.setPosition(x, y);
        if (this.htmlById.get(node.id) === html) continue;
        // setData 会触发 shape 的 html 函数重跑，不需要重建节点
        existing.setData({ requirement: node, selected, editable } satisfies CardData);
      } else {
        this.graph.addNode({
          id: node.id,
          shape: 'clarify-card',
          x,
          y,
          zIndex: 10,
          data: { requirement: node, selected, editable } satisfies CardData,
        });
      }

      this.htmlById.set(node.id, html);
    }

    for (const cell of [...this.graph.getCells()]) {
      if (cell.isNode() && !alive.has(cell.id)) {
        this.graph.removeCell(cell);
        this.htmlById.delete(cell.id);
      }
    }

    this.syncEdges(nodes, alive);
  }

  private syncEdges(nodes: readonly RequirementNode[], alive: Set<string>): void {
    const expected = new Set<string>();

    for (const node of nodes) {
      if (node.parentId && alive.has(node.parentId)) {
        const id = `tree:${node.parentId}__${node.id}`;
        expected.add(id);
        this.ensureEdge(id, node.parentId, node.id, false);
      }

      for (const dependency of node.dependsOn) {
        if (!alive.has(dependency)) continue;
        const id = `dep:${node.id}__${dependency}`;
        expected.add(id);
        this.ensureEdge(id, node.id, dependency, true);
      }
    }

    for (const cell of [...this.graph.getCells()]) {
      if (cell.isEdge() && !expected.has(cell.id)) this.graph.removeCell(cell);
    }
  }

  private ensureEdge(id: string, source: string, target: string, isDependency: boolean): void {
    if (this.graph.getCellById(id)) return;

    this.graph.addEdge({
      id,
      // 父节点右侧出发、接到子节点左侧，配合横向思维导图的方向
      source: { cell: source, anchor: { name: 'right' } },
      target: { cell: target, anchor: { name: 'left' } },
      zIndex: isDependency ? 20 : 0,
      connector: { name: 'smooth' },
      attrs: {
        line: {
          stroke: isDependency ? '#f59e0b' : '#33405e',
          strokeWidth: isDependency ? 1.5 : 1.6,
          strokeDasharray: isDependency ? '5 4' : null,
          targetMarker: isDependency ? { name: 'block', size: 5 } : null,
        },
      },
    });
  }

  fit(): void {
    // 内容比视口高时（例如一堆并列的顶层需求）不要无限缩小硬塞，
    // 缩到 0.5 就停，剩下的交给滚动 —— 总比小到字都看不清强
    this.graph.zoomToFit({ padding: 48, maxScale: 1, minScale: 0.5 });
  }

  resetZoom(): void {
    this.graph.zoomTo(1);
    this.graph.centerContent();
  }

  dispose(): void {
    if (activeCallbacks === this.callbacks) activeCallbacks = null;
    this.graph.dispose();
  }
}
