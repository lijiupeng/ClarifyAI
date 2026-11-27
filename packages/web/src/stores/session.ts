import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { NodeSuggestion, RequirementNode, Session } from '@clarifyai/shared';
import {
  fetchSession,
  patchNodes,
  resolveSuggestion as apiResolveSuggestion,
  submitFeedback as apiSubmitFeedback,
} from '../api/client';
import { connectRealtime } from '../api/realtime';

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useSessionStore = defineStore('session', () => {
  const session = ref<Session | null>(null);
  const selectedId = ref<string | null>(null);
  /** 「修改」按钮按下时置位，右侧面板据此把焦点移到标题输入框 */
  const editingId = ref<string | null>(null);
  const agentNote = ref('');
  const connection = ref<'connecting' | 'online' | 'offline'>('connecting');
  const errorMessage = ref('');
  const loading = ref(true);

  /**
   * 本地正在编辑的节点 id。
   * 服务端会把我们自己的写入通过 WebSocket 回声广播回来，
   * 若不屏蔽，用户打字打到一半就会被回声覆盖 —— 这是实时协作里的经典坑。
   */
  const dirtyIds = new Set<string>();
  const removedIds = new Set<string>();

  let disposeRealtime: (() => void) | null = null;
  let persistTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let reconnectDelay = 1000;

  /* ------------------------------ 派生状态 ------------------------------ */

  const nodes = computed<RequirementNode[]>(() => session.value?.nodes ?? []);
  const status = computed(() => session.value?.status ?? 'awaiting-user');
  const round = computed(() => session.value?.round ?? 0);
  const selected = computed(() => nodes.value.find((n) => n.id === selectedId.value) ?? null);

  /** 画布唯一的根节点：它是需求书标题，不是一条待裁决的需求 */
  const rootId = computed(() => session.value?.rootId ?? null);
  const root = computed(() => nodes.value.find((node) => node.id === rootId.value) ?? null);

  const suggestions = computed<NodeSuggestion[]>(() => session.value?.suggestions ?? []);
  const pendingSuggestions = computed(() => suggestions.value.filter((s) => s.status === 'pending'));

  /**
   * 逐条审阅：AI 一次给一批建议，画布带用户按顺序过。
   * 采纳 / 忽略当前这条后自动跳到下一条，队列空了就结束。
   */
  const activeSuggestionId = ref<string | null>(null);

  const reviewQueue = computed(() =>
    suggestions.value
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt),
  );

  watch(
    () => reviewQueue.value.length,
    (length) => {
      if (length === 0) {
        activeSuggestionId.value = null;
        return;
      }
      // 新一批建议到达（或当前这条已处理完）时，自动指向队首
      if (!activeSuggestionId.value) activeSuggestionId.value = reviewQueue.value[0]!.id;
    },
  );

  /** 画布上没有「待确认」档位：仍未裁决的只有假设 */
  const pendingAssumptions = computed(() => nodes.value.filter((n) => n.kind === 'assumption'));

  /**
   * 「AI 正在处理」必须从会话状态派生，不能单独存一个开关。
   *
   * 之前用独立 ref 记 busy，一旦那条 busy=false 的推送丢了（重连、事件窗口），
   * 画布就会永远停在只读 —— 服务端明明已是 awaiting-user，页面却点不动。
   */
  const agentBusy = computed(() => status.value === 'awaiting-agent');

  /**
   * 除了「AI 正在处理」和「已终止」，画布一直可编辑。
   * 不再有「收口封板」这回事：出过规格的会话照样能继续改。
   */
  const editable = computed(() => status.value !== 'awaiting-agent' && status.value !== 'aborted');

  /* ------------------------------ 加载与实时 ------------------------------ */

  async function load(id: string): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      const { session: incoming } = await fetchSession(id);
      session.value = incoming;
      selectedId.value = incoming.nodes[0]?.id ?? null;
      subscribe(id);
    } catch (error) {
      errorMessage.value = toMessage(error);
    } finally {
      loading.value = false;
    }
  }

  function subscribe(id: string): void {
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }

    disposeRealtime?.();
    disposeRealtime = connectRealtime(id, {
      onSnapshot: (incoming) => {
        session.value = incoming;
      },
      onPatched: (payload) => {
        if (payload.agentNote) agentNote.value = payload.agentNote;
        upsertRemote(payload.upserted);
        removeRemote(payload.removedIds);
        mergeSuggestions(payload.suggestions ?? []);
        dropSuggestions(payload.removedSuggestionIds ?? []);
        // 状态必须一并同步：节点变了 ≠「球交回自己了」。
        // 漏掉这行，AI 提交完新拆解后画布看得到新分支、按钮却一直灰着。
        if (session.value) session.value.status = payload.status;
      },
      onAgentBusy: (payload) => {
        if (payload.message) agentNote.value = payload.message;
        // busy 不再单独存：状态一变，agentBusy / editable 自动跟着变
        if (session.value) session.value.status = payload.status;
      },
      onClosed: (payload) => {
        if (session.value) session.value.status = payload.status;
        agentNote.value = payload.message;
      },
      onStatusChange: (value) => {
        connection.value = value;
        if (value === 'online') resetReconnect();
        else if (value === 'offline') scheduleReconnect(id);
      },
    });
  }

  /**
   * 断线自动重连（指数退避）。
   * 这个工具的使用节奏是「AI 慢慢想、用户慢慢改」，期间服务重启或系统休眠都会断链，
   * 没有重连的话画布会静默失联 —— 用户还在改，但改动再也推不上去了。
   */
  function scheduleReconnect(id: string): void {
    if (reconnectTimer !== undefined) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      reconnectDelay = Math.min(reconnectDelay * 1.8, 15_000);
      subscribe(id);
    }, reconnectDelay);
  }

  function resetReconnect(): void {
    reconnectDelay = 1000;
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function dispose(): void {
    resetReconnect();
    disposeRealtime?.();
    disposeRealtime = null;
  }

  function upsertRemote(list: RequirementNode[]): void {
    if (!session.value || list.length === 0) return;
    const map = new Map(session.value.nodes.map((n) => [n.id, n]));
    let touched = false;
    for (const incoming of list) {
      if (dirtyIds.has(incoming.id)) continue;
      map.set(incoming.id, incoming);
      touched = true;
    }
    if (touched) session.value.nodes = [...map.values()];
  }

  function mergeSuggestions(list: NodeSuggestion[]): void {
    if (!session.value || list.length === 0) return;
    const map = new Map(session.value.suggestions.map((s) => [s.id, s]));
    for (const incoming of list) map.set(incoming.id, incoming);
    session.value.suggestions = [...map.values()];
  }

  function dropSuggestions(ids: string[]): void {
    if (!session.value || ids.length === 0) return;
    const removing = new Set(ids);
    session.value.suggestions = session.value.suggestions.filter((s) => !removing.has(s.id));
  }

  function removeRemote(ids: string[]): void {
    if (!session.value || ids.length === 0) return;
    const removing = new Set(ids.filter((id) => !dirtyIds.has(id)));
    if (removing.size === 0) return;
    session.value.nodes = session.value.nodes.filter((n) => !removing.has(n.id));
  }

  /* ------------------------------ 本地编辑 ------------------------------ */

  function select(id: string | null): void {
    selectedId.value = id;
  }

  /** 卡片内联编辑：谁在用键盘输入，画布就不重绘谁的 DOM */
  function beginEdit(id: string): void {
    selectedId.value = id;
    editingId.value = id;
  }

  /**
   * 结束编辑。带上 id 是为了躲开「新增节点时旧输入框失焦」：
   * 那时 editingId 已经指向新节点，旧节点的 blur 不能把它清掉。
   */
  function endEdit(id?: string): void {
    if (id && editingId.value !== id) return;
    editingId.value = null;
  }

  function updateNode(id: string, patch: Partial<RequirementNode>): void {
    if (!editable.value || !session.value) return;
    const node = session.value.nodes.find((n) => n.id === id);
    if (!node) return;
    Object.assign(node, patch, { updatedAt: Date.now() });
    dirtyIds.add(id);
    schedulePersist();
  }

  /** 对 AI 假设的裁决：接受即转为普通需求，否决即直接删除 */
  function ruleAssumption(id: string, decision: 'accept' | 'reject'): void {
    if (decision === 'accept') {
      updateNode(id, { kind: 'functional' });
    } else {
      removeNode(id);
    }
  }

  /** 批量裁决待处理假设 —— 假设通常成批出现，逐条点太累 */
  async function ruleAllAssumptions(decision: 'accept' | 'reject'): Promise<void> {
    if (!editable.value || !session.value) return;

    const targets = session.value.nodes.filter((n) => n.kind === 'assumption');
    if (targets.length === 0) return;

    const ids = new Set(targets.map((n) => n.id));
    const now = Date.now();

    if (decision === 'accept') {
      session.value.nodes = session.value.nodes.map((n) =>
        ids.has(n.id) ? { ...n, kind: 'functional' as const, updatedAt: now } : n,
      );
      for (const id of ids) dirtyIds.add(id);
    } else {
      session.value.nodes = session.value.nodes.filter((n) => !ids.has(n.id));
      for (const id of ids) {
        dirtyIds.delete(id);
        removedIds.add(id);
      }
      if (selectedId.value && ids.has(selectedId.value)) selectedId.value = null;
    }

    await flush();
  }

  /**
   * 新增节点。parentId 为 null 时表示新增根 —— 只有画布还没有根时才会发生。
   * 返回新节点 id，调用方据此把光标送进它的标题。
   */
  function addChild(parentId: string | null): string | null {
    if (!editable.value || !session.value) return null;
    if (parentId === null && rootId.value) return null;

    const parent = parentId ? session.value.nodes.find((n) => n.id === parentId) : null;
    const now = Date.now();
    const siblings = session.value.nodes.filter((n) => n.parentId === parentId);
    const order = siblings.reduce((max, item) => Math.max(max, item.order), -1) + 1;

    const node: RequirementNode = {
      id: newId(),
      sessionId: session.value.id,
      parentId,
      title: '新需求',
      detail: '',
      kind: 'functional',
      acceptance: [],
      status: 'confirmed',
      origin: 'user',
      userNote: '',
      dependsOn: [],
      depth: parent ? parent.depth + 1 : 0,
      order,
      createdAt: now,
      updatedAt: now,
    };

    session.value.nodes = [...session.value.nodes, node];
    if (parentId === null) session.value.rootId = node.id;
    selectedId.value = node.id;
    editingId.value = node.id;
    dirtyIds.add(node.id);
    schedulePersist();
    return node.id;
  }

  function removeNode(id: string): void {
    if (!editable.value || !session.value) return;
    if (id === rootId.value) {
      errorMessage.value = '根节点是需求书标题，不能删除';
      return;
    }

    // 级联删除子孙，与服务端保持一致，避免出现孤儿节点
    const removing = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of session.value.nodes) {
        if (node.parentId && removing.has(node.parentId) && !removing.has(node.id)) {
          removing.add(node.id);
          grew = true;
        }
      }
    }

    session.value.nodes = session.value.nodes.filter((n) => !removing.has(n.id));
    for (const removed of removing) {
      dirtyIds.delete(removed);
      removedIds.add(removed);
    }
    if (selectedId.value && removing.has(selectedId.value)) selectedId.value = null;
    schedulePersist(0);
  }

  /* ------------------------------ 持久化 ------------------------------ */

  function schedulePersist(delay = 400): void {
    if (persistTimer !== undefined) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      void flush();
    }, delay);
  }

  async function flush(): Promise<void> {
    if (!session.value) return;
    if (persistTimer !== undefined) {
      window.clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    if (dirtyIds.size === 0 && removedIds.size === 0) return;

    // 契约要求标题非空、验收标准非空串；内联编辑时这两种中间态很常见，
    // 落盘前统一兜底，避免整个补丁被服务端校验打回。
    const upserted = session.value.nodes
      .filter((n) => dirtyIds.has(n.id))
      .map((node) => {
        if (!node.title.trim()) node.title = '未命名需求';
        node.acceptance = node.acceptance.map((item) => item.trim()).filter(Boolean);
        return node;
      });
    const removed = [...removedIds];
    dirtyIds.clear();
    removedIds.clear();

    try {
      await patchNodes(session.value.id, upserted, removed);
    } catch (error) {
      errorMessage.value = toMessage(error);
    }
  }

  /* ------------------------------ 提交给 AI ------------------------------ */

  async function submit(
    action: 'confirmed' | 'need-more' | 'abort',
    options: { freeText?: string; expand?: string[]; suggest?: string[] } = {},
  ): Promise<void> {
    if (!session.value) return;
    await flush();

    try {
      await apiSubmitFeedback(session.value.id, {
        action,
        userFreeText: options.freeText ?? '',
        expandRequests: options.expand ?? [],
        suggestRequests: options.suggest ?? [],
      });
      if (session.value) session.value.status = action === 'abort' ? 'aborted' : 'awaiting-agent';
    } catch (error) {
      errorMessage.value = toMessage(error);
    }
  }

  /**
   * 卡片上的「推断分支」：让 AI 沿这个节点再推断出一个子需求分支。
   * 立即提交，不攒着 —— 用户点它的意图就是「我现在就要看 AI 给什么」。
   */
  async function requestExpand(nodeId: string): Promise<void> {
    if (!session.value || !editable.value) return;
    await submit('need-more', { expand: [nodeId] });
  }

  /**
   * 让 AI 补全 / 优化。
   * 传 null 表示整棵树（以根节点为目标）—— 用户没有选中任何节点时的心智就是「都看看」。
   */
  async function requestSuggest(nodeId: string | null): Promise<void> {
    if (!session.value || !editable.value) return;
    const target = nodeId ?? rootId.value;
    if (!target) return;
    await submit('need-more', { suggest: [target] });
  }

  /** 裁决一条建议：采纳才落地，忽略只是撤掉灰字 */
  async function resolveSuggestion(suggestionId: string, accept: boolean): Promise<void> {
    if (!session.value || !editable.value) return;
    await flush();

    try {
      const result = await apiResolveSuggestion(session.value.id, suggestionId, accept);

      // 本地直接移除，而不是留一条 accepted 记录：
      // 画布上不该再出现它，少一个「已处理却还在」的可能。
      session.value.suggestions = session.value.suggestions.filter(
        (item) => item.id !== suggestionId,
      );

      for (const node of result.upserted) dirtyIds.delete(node.id);
      upsertRemote(result.upserted);

      // 处理完当前这条就跳到下一条；队列空了自然结束
      if (activeSuggestionId.value === suggestionId) {
        activeSuggestionId.value = reviewQueue.value[0]?.id ?? null;
      }

      // 采纳删除建议：本地先落地，不等 WebSocket 回声（否则卡片会闪一下才消失）
      if (result.removedIds.length > 0) {
        const removing = new Set(result.removedIds);
        session.value.nodes = session.value.nodes.filter((node) => !removing.has(node.id));
        session.value.suggestions = session.value.suggestions.filter(
          (item) => item.id === result.suggestion.id || !removing.has(item.nodeId),
        );
        if (selectedId.value && removing.has(selectedId.value)) selectedId.value = null;
      }
    } catch (error) {
      errorMessage.value = toMessage(error);
    }
  }

  function clearError(): void {
    errorMessage.value = '';
  }

  return {
    session,
    nodes,
    status,
    round,
    selected,
    selectedId,
    rootId,
    root,
    suggestions,
    pendingSuggestions,
    activeSuggestionId,
    reviewQueue,
    pendingAssumptions,
    editable,
    agentBusy,
    agentNote,
    connection,
    errorMessage,
    loading,
    load,
    dispose,
    select,
    beginEdit,
    endEdit,
    requestExpand,
    requestSuggest,
    resolveSuggestion,
    editingId,
    updateNode,
    ruleAssumption,
    ruleAllAssumptions,
    addChild,
    removeNode,
    flush,
    submit,
    clearError,
  };
});
