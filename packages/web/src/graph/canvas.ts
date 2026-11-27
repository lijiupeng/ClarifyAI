import { Graph, Shape } from '@antv/x6';
import type { Cell } from '@antv/x6';
import type { NodeSuggestion, RequirementNode } from '@clarifyai/shared';
import { cardHtml } from './cardHtml';
import type { CardSuggestion } from './cardHtml';
import { CARD_WIDTH, cardHeight, layoutTree } from './layout';

export type CardAction = 'delete' | 'expand' | 'child' | 'sibling' | 'accept' | 'reject';

export interface CanvasCallbacks {
  onSelect: (id: string | null) => void;
  onCardAction: (id: string, action: CardAction) => void;
  /** 卡片内联编辑的落点：标题 / 说明 / 某条验收标准 */
  onFieldChange: (id: string, patch: Partial<RequirementNode>) => void;
  onEditFocus: (id: string) => void;
  onEditBlur: (id?: string) => void;
  onSuggestion: (suggestionId: string, accept: boolean) => void;
}

/** 挂在节点上的渲染数据。X6 的 HTML 节点从 cell 读它来生成内容 */
interface CardData {
  node: RequirementNode;
  isRoot: boolean;
  selected: boolean;
  editable: boolean;
  suggestions: CardSuggestion[];
  /** 刚新建的节点：渲染后把光标送进标题 */
  focusTitle: boolean;
  /** 非空表示这是 AI 建议的灰色幽灵节点，还不是真实需求 */
  ghost?: { suggestionId: string; note: string };
  activeSuggestionId?: string | null;
}

/**
 * shape 注册是模块级的，但回调属于控制器实例 —— 用这个变量把两者接上。
 * 单页里只会有一个画布实例，够用。
 */
let activeCallbacks: CanvasCallbacks | null = null;
/** 同理：渲染完要回调控制器做高度修正 */
let activeController: CanvasController | null = null;

function readText(element: HTMLElement): string {
  return element.innerText.replace(/\u00a0/g, ' ');
}

/**
 * 卡片内容的自然高度。
 *
 * 不能用 scrollHeight：卡片本身是 height:100%，flex 容器的 scrollHeight
 * 至少等于容器高度，测出来永远比当前高一点 —— 每轮 +4px，卡片会无限长高。
 * 这里按子项实际高度累加，与容器当前高度无关。
 */
function naturalHeight(card: HTMLElement): number {
  const style = window.getComputedStyle(card);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const gap = parseFloat(style.rowGap) || 0;

  let total = padding;
  const children = card.children;
  for (let index = 0; index < children.length; index += 1) {
    // offsetHeight 是布局尺寸，不受画布缩放（transform）影响
    total += (children[index] as HTMLElement).offsetHeight;
  }
  total += gap * Math.max(0, children.length - 1);

  return total;
}

function focusTitleOf(wrapper: HTMLElement): void {
  const title = wrapper.querySelector<HTMLElement>('[data-field="title"]');
  if (!title) return;

  // 等 X6 把节点真正插进画布再聚焦，否则 focus 会落在游离的 DOM 上
  requestAnimationFrame(() => {
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

/**
 * 注册卡片节点。
 *
 * 两个关键点（都是实测踩出来的）：
 * 1. X6 的 HTML 节点把内容绑在 **shape** 上（`HTML.shapeMaps[cell.shape]`），
 *    所以必须走 register + `cell.setData()`，直接给 addNode 传 `html` 完全不渲染。
 * 2. 卡片里的按钮 / 可编辑区**必须在生成 DOM 时直接绑监听**。X6 会拦下冒泡阶段的指针事件，
 *    在容器上做事件委托（无论冒泡还是捕获）都收不到。
 */
Shape.HTML.register({
  shape: 'clarify-card',
  width: CARD_WIDTH,
  height: 80,
  html(cell: Cell) {
    const data = cell.getData() as CardData | undefined;
    if (!data?.node) return '';

    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.innerHTML = cardHtml(data);

    // 一律用 pointerdown 而不是 click：
    // 可编辑区失焦会触发一次重绘，click 的 mouseup 落在已移除的元素上就丢了。
    for (const button of wrapper.querySelectorAll<HTMLElement>('[data-action]')) {
      const action = button.dataset.action as CardAction | undefined;
      if (!action) continue;
      button.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        event.preventDefault();
        activeCallbacks?.onCardAction(data.node.id, action);
      });
    }

    for (const button of wrapper.querySelectorAll<HTMLElement>('[data-suggestion-accept]')) {
      button.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        event.preventDefault();
        activeCallbacks?.onSuggestion(button.dataset.suggestionAccept ?? '', true);
      });
    }

    for (const button of wrapper.querySelectorAll<HTMLElement>('[data-suggestion-ignore]')) {
      button.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        event.preventDefault();
        activeCallbacks?.onSuggestion(button.dataset.suggestionIgnore ?? '', false);
      });
    }

    for (const field of wrapper.querySelectorAll<HTMLElement>('[data-field]')) {
      const name = field.dataset.field;
      if (!name) continue;

      // 画布的平移是用 **mousedown** 启动的，只拦 pointerdown 拦不住 ——
      // 表现就是在输入框里拖选文字，整张画布跟着走。
      for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) {
        field.addEventListener(type, (event) => event.stopPropagation());
      }
      field.addEventListener('dblclick', (event) => event.stopPropagation());

      field.addEventListener('focus', () => {
        if (field.isContentEditable) activeCallbacks?.onEditFocus(data.node.id);
      });

      field.addEventListener('blur', () => {
        activeCallbacks?.onEditBlur(data.node.id);
      });

      field.addEventListener('keydown', (event) => {
        // 输入法组合中的按键不能当命令处理（中文输入时尤其重要）
        if (event.isComposing) return;
        // Enter / Tab 由画布统一处理成「新增节点」，这里不放行换行
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.stopPropagation();
        }
      });

      // 输入法组合期间不写回：拼音中间态会被当成正文塞进 store，
      // 再触发重绘，用户看到的就是「打着打着字没了」。
      let composing = false;

      field.addEventListener('compositionstart', () => {
        composing = true;
      });

      field.addEventListener('compositionend', () => {
        composing = false;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });

      field.addEventListener('input', () => {
        if (composing) return;

        if (name === 'title') {
          activeCallbacks?.onFieldChange(data.node.id, { title: readText(field) });
          return;
        }
        if (name === 'detail') {
          activeCallbacks?.onFieldChange(data.node.id, { detail: readText(field) });
        }
      });
    }

    if (data.focusTitle) focusTitleOf(wrapper);

    // 高度估算必然会错：字号、换行、建议条数任意一项变了都可能溢出。
    // 渲染完量一次真实内容高度，交给控制器回填并重排。
    requestAnimationFrame(() => {
      if (!wrapper.isConnected) return;
      const card = wrapper.firstElementChild as HTMLElement | null;
      if (!card) return;
      activeController?.requestHeight(cell.id, naturalHeight(card) + 2);
    });

    return wrapper;
  },
});

export interface RenderOptions {
  nodes: readonly RequirementNode[];
  suggestions: readonly NodeSuggestion[];
  rootId: string | null;
  selectedId: string | null;
  editingId: string | null;
  editable: boolean;
  /** 正在逐条审阅的建议；画布会主动移过去并高亮它 */
  activeSuggestionId: string | null;
}

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
  /** nodeId → 渲染后实测的内容高度。只增不减，保证内容永远不会被裁 */
  private readonly measured = new Map<string, number>();
  /**
   * nodeId → 该节点上的建议集合指纹。
   * 建议增删时直接重建节点：X6 复用 cell 时不一定重跑 html()，
   * 表现就是「已经采纳了，灰色建议块还挂在卡片里」。
   */
  private readonly suggestionKeyById = new Map<string, string>();
  private layoutKey = '';
  private lastOptions: RenderOptions | null = null;
  /** 上一次聚焦过的建议，避免每帧都把视口拉回去 */
  private lastActiveSuggestion: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: CanvasCallbacks,
  ) {
    activeCallbacks = callbacks;
    activeController = this;

    this.graph = new Graph({
      container,
      autoResize: true,
      background: { color: 'transparent' },
      grid: { visible: true, type: 'dot', size: 18, args: { color: '#dfe3ea', thickness: 1 } },
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
        // 节点位置由布局算法决定，拖动只会让图和树对不上；
        // 更重要的是，禁掉拖动之后卡片内的文字才能正常选中与编辑。
        nodeMovable: false,
        edgeMovable: false,
        edgeLabelMovable: false,
        arrowheadMovable: false,
        vertexMovable: false,
        vertexAddable: false,
        vertexDeletable: false,
      },
    });

    // 点击节点的非文字区域 = 结束编辑。否则「先点标题、再点同一张卡片」会让
    // 节点一直停在冻结态，选中态需要的那几十像素高度永远补不上，底部被裁。
    this.graph.on('node:click', ({ node }) => {
      this.callbacks.onEditBlur();
      // 幽灵节点不是真实需求，点了不选中，只能通过采纳变成正式节点
      if (node.id.startsWith('sug:')) return;
      this.callbacks.onSelect(node.id);
    });
    this.graph.on('blank:click', () => {
      this.callbacks.onEditBlur();
      this.callbacks.onSelect(null);
    });
  }

  render(options: RenderOptions): void {
    this.lastOptions = options;
    const {
      nodes,
      suggestions,
      rootId,
      selectedId,
      editingId,
      editable,
      activeSuggestionId,
    } = options;

    // AI 建议「新增子节点」时，把它渲染成灰色幽灵节点参与布局：
    // 用户能直接看到它会落在树的哪个位置，点采纳才变成真节点。
    const ghosts = suggestions
      .filter((item) => item.action === 'expand' && item.status === 'pending')
      .map((item, index) => {
        const parent = nodes.find((n) => n.id === item.nodeId);
        const node: RequirementNode = {
          id: `sug:${item.id}`,
          sessionId: '',
          parentId: item.nodeId,
          title: item.title,
          detail: item.detail,
          kind: 'functional',
          acceptance: [...item.acceptance],
          status: 'confirmed',
          origin: 'ai',
          userNote: '',
          dependsOn: [],
          depth: (parent?.depth ?? 0) + 1,
          order: 100_000 + index,
          createdAt: 0,
          updatedAt: 0,
        };
        return { node, suggestion: item };
      });

    const ghostById = new Map(ghosts.map(({ node, suggestion }) => [node.id, suggestion]));
    const renderNodes: RequirementNode[] = [...nodes, ...ghosts.map(({ node }) => node)];

    const suggestionCount = new Map<string, number>();
    for (const suggestion of suggestions) {
      // 新增节点的建议已经变成独立幽灵节点，不再占用父卡片的位置
      if (suggestion.status !== 'pending' || suggestion.action === 'expand') continue;
      suggestionCount.set(suggestion.nodeId, (suggestionCount.get(suggestion.nodeId) ?? 0) + 1);
    }

    const heightOf = (node: RequirementNode): number => {
      if (ghostById.has(node.id)) {
        // 幽灵节点比普通卡片多一行「采纳 / 忽略」
        const estimate =
          cardHeight(node, {
            isRoot: false,
            selected: false,
            editable: false,
            suggestionCount: 0,
          }) + 34;
        return Math.max(72, estimate, this.measured.get(node.id) ?? 0);
      }

      return Math.max(
        cardHeight(node, {
          isRoot: node.id === rootId,
          selected: node.id === selectedId,
          editable,
          suggestionCount: suggestionCount.get(node.id) ?? 0,
        }),
        this.measured.get(node.id) ?? 0,
      );
    };

    const layout = layoutTree(renderNodes, heightOf);
    const nextKey = layout
      .map(({ node, x, y }) => `${node.id}:${node.parentId ?? ''}:${node.order}:${x}:${y}:${heightOf(node)}`)
      .join('|');
    const layoutChanged = nextKey !== this.layoutKey;

    const alive = new Set<string>();
    /**
     * 有节点被冻结（正在编辑）时，这次布局并没有真正落地。
     * 此时不能把 layoutKey 记为最新 —— 否则退出编辑后系统认为位置尺寸都对，
     * 卡片会永远停在旧高度，底部内容被裁掉。
     */
    let layoutApplied = true;

    for (const { node, x, y } of layout) {
      alive.add(node.id);

      const ghost = ghostById.get(node.id);
      const selected = !ghost && selectedId === node.id;
      const isRoot = node.id === rootId;
      const nodeSuggestions: CardSuggestion[] = ghost
        ? []
        : suggestions
            .filter(
              (item) =>
                item.nodeId === node.id && item.status === 'pending' && item.action !== 'expand',
            )
            .map((item) =>
              item.action === 'move'
                ? {
                    ...item,
                    moveTargetTitle:
                      nodes.find((candidate) => candidate.id === item.targetParentId)?.title ?? '根节点',
                  }
                : item,
            );
      const focusTitle = !ghost && editingId === node.id;

      const view = {
        node,
        isRoot,
        selected,
        editable: ghost ? false : editable,
        suggestions: nodeSuggestions,
        activeSuggestionId,
        ghost: ghost ? { suggestionId: ghost.id, note: ghost.note } : undefined,
      };
      const html = cardHtml(view);
      const height = heightOf(node);

      // 建议集合变了就重建节点：X6 复用 cell 时不保证重跑 html()，
      // 表现就是「已经采纳了，灰色建议块还挂在卡片里」。
      const suggestionKey = nodeSuggestions.map((item) => `${item.id}:${item.status}`).join('|');
      const previousKey = this.suggestionKeyById.get(node.id);
      this.suggestionKeyById.set(node.id, suggestionKey);

      let existing: Cell | null = this.graph.getCellById(node.id);
      if (existing && existing.isNode() && previousKey !== undefined && previousKey !== suggestionKey) {
        this.graph.removeCell(existing);
        this.htmlById.delete(node.id);
        this.measured.delete(node.id);
        existing = null;
      }

      if (existing && existing.isNode()) {
        // 正在编辑的节点整体冻结：位置、尺寸、内容一概不动。
        // 改尺寸同样会让 X6 重排 HTML 节点，输入到一半的字会被旧内容顶掉。
        if (editingId === node.id) {
          layoutApplied = false;
          continue;
        }

        if (layoutChanged) {
          existing.setPosition(x, y);
          existing.setSize(CARD_WIDTH, height);
        }

        if (this.htmlById.get(node.id) === html) continue;

        existing.setData({
          node,
          isRoot,
          selected,
          editable,
          suggestions: nodeSuggestions,
          focusTitle,
          activeSuggestionId,
          ghost: view.ghost,
        } satisfies CardData);
      } else {
        this.graph.addNode({
          id: node.id,
          shape: 'clarify-card',
          x,
          y,
          width: CARD_WIDTH,
          height,
          zIndex: 10,
          data: {
            node,
            isRoot,
            selected,
            editable,
            suggestions: nodeSuggestions,
            focusTitle,
            activeSuggestionId,
            ghost: view.ghost,
          } satisfies CardData,
        });
      }

      this.htmlById.set(node.id, html);
    }

    for (const cell of [...this.graph.getCells()]) {
      if (cell.isNode() && !alive.has(cell.id)) {
        this.graph.removeCell(cell);
        this.htmlById.delete(cell.id);
        this.measured.delete(cell.id);
        this.suggestionKeyById.delete(cell.id);
      }
    }

    if (layoutApplied) this.layoutKey = nextKey;

    this.syncEdges(renderNodes, alive);

    // 逐条审阅：当前建议换了一条，就把视口移过去，让人不用自己找
    if (activeSuggestionId !== this.lastActiveSuggestion) {
      this.lastActiveSuggestion = activeSuggestionId;
      const target = activeSuggestionId
        ? suggestions.find((item) => item.id === activeSuggestionId)
        : undefined;

      if (target) {
        const cellId = target.action === 'expand' ? `sug:${target.id}` : target.nodeId;
        requestAnimationFrame(() => this.focusNode(cellId));
      }
    }
  }

  /**
   * 实测高度回填。只增不减 —— 宁可多留一点白，也不能再把内容裁掉。
   * 调整后立刻重排一次；因为只增，不会来回抖动。
   */
  requestHeight(nodeId: string, needed: number): void {
    const previous = this.measured.get(nodeId) ?? 0;
    if (needed <= previous + 1) return;

    this.measured.set(nodeId, Math.ceil(needed));
    this.layoutKey = '';
    if (this.lastOptions && this.htmlById.has(nodeId)) this.render(this.lastOptions);
  }

  private syncEdges(nodes: readonly RequirementNode[], alive: Set<string>): void {
    const expected = new Set<string>();

    for (const node of nodes) {
      if (node.parentId && alive.has(node.parentId)) {
        const id = `tree:${node.parentId}__${node.id}`;
        expected.add(id);
        this.ensureEdge(id, node.parentId, node.id, node.id.startsWith('sug:'));
      }
    }

    for (const cell of [...this.graph.getCells()]) {
      if (cell.isEdge() && !expected.has(cell.id)) this.graph.removeCell(cell);
    }
  }

  private ensureEdge(id: string, source: string, target: string, isGhost = false): void {
    if (this.graph.getCellById(id)) return;

    this.graph.addEdge({
      id,
      // 父节点右侧出发、接到子节点左侧，配合横向思维导图的方向
      source: { cell: source, anchor: { name: 'right' } },
      target: { cell: target, anchor: { name: 'left' } },
      zIndex: 0,
      connector: { name: 'smooth' },
      attrs: {
        line: {
          stroke: '#cbd1de',
          strokeWidth: 1.3,
          // 建议节点用虚线接过去：它还没进需求树
          strokeDasharray: isGhost ? '4 4' : null,
          targetMarker: null,
        },
      },
    });
  }

  fit(): void {
    // 内容比视口高时不要无限缩小硬塞，缩到 0.5 就停，剩下的交给滚动
    this.graph.zoomToFit({ padding: 56, maxScale: 1, minScale: 0.5 });
  }

  resetZoom(): void {
    this.graph.zoomTo(1);
    this.graph.centerContent();
  }

  focusNode(nodeId: string): void {
    const cell = this.graph.getCellById(nodeId);
    if (!cell?.isNode()) return;
    this.graph.centerCell(cell);
  }

  dispose(): void {
    if (activeCallbacks === this.callbacks) activeCallbacks = null;
    if (activeController === this) activeController = null;
    this.graph.dispose();
  }
}
