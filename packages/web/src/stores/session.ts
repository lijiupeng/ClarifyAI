import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { NodeKind, RequirementNode, Session } from '@clarifyai/shared';
import { fetchSession, patchNodes, submitFeedback as apiSubmitFeedback } from '../api/client';
import { connectRealtime } from '../api/realtime';

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KIND_ORDER: NodeKind[] = ['functional', 'non-functional', 'constraint', 'assumption', 'out-of-scope'];

export const useSessionStore = defineStore('session', () => {
  const session = ref<Session | null>(null);
  const selectedId = ref<string | null>(null);
  /** 「修改」按钮按下时置位，右侧面板据此把焦点移到标题输入框 */
  const editingId = ref<string | null>(null);
  const agentBusy = ref(false);
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

  const pendingAssumptions = computed(() =>
    nodes.value.filter((n) => n.kind === 'assumption' && n.status === 'draft'),
  );

  const draftCount = computed(() => nodes.value.filter((n) => n.status === 'draft').length);
  const confirmedCount = computed(() => nodes.value.filter((n) => n.status === 'confirmed').length);

  /** 会话只有在「等用户」且 AI 不忙时才允许编辑 */
  const editable = computed(() => status.value === 'awaiting-user' && !agentBusy.value);

  const groupedCounts = computed(() => {
    const counts = new Map<NodeKind, number>();
    for (const kind of KIND_ORDER) counts.set(kind, 0);
    for (const node of nodes.value) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return counts;
  });

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
      },
      onAgentBusy: (payload) => {
        agentBusy.value = payload.busy;
        if (payload.message) agentNote.value = payload.message;
      },
      onClosed: (payload) => {
        if (session.value) session.value.status = payload.status;
        agentBusy.value = false;
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

  /** 卡片上的「修改」：选中并把光标送进标题输入框 */
  function requestEdit(id: string): void {
    selectedId.value = id;
    editingId.value = id;
  }

  function updateNode(id: string, patch: Partial<RequirementNode>): void {
    if (!editable.value || !session.value) return;
    const node = session.value.nodes.find((n) => n.id === id);
    if (!node) return;
    Object.assign(node, patch, { updatedAt: Date.now() });
    dirtyIds.add(id);
    schedulePersist();
  }

  function setStatus(id: string, next: RequirementNode['status']): void {
    updateNode(id, { status: next });
  }

  /** 对 AI 假设的裁决：接受即转为已确认，否决即直接删除 */
  function ruleAssumption(id: string, decision: 'accept' | 'reject'): void {
    if (decision === 'accept') {
      updateNode(id, { status: 'confirmed', kind: 'functional' });
    } else {
      removeNode(id);
    }
  }

  /** 批量裁决待处理假设 —— 假设通常成批出现，逐条点太累 */
  async function ruleAllAssumptions(decision: 'accept' | 'reject'): Promise<void> {
    if (!editable.value || !session.value) return;

    const targets = session.value.nodes.filter((n) => n.kind === 'assumption' && n.status === 'draft');
    if (targets.length === 0) return;

    const ids = new Set(targets.map((n) => n.id));
    const now = Date.now();

    if (decision === 'accept') {
      session.value.nodes = session.value.nodes.map((n) =>
        ids.has(n.id) ? { ...n, status: 'confirmed' as const, kind: 'functional' as const, updatedAt: now } : n,
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

  function addChild(parentId: string | null): void {
    if (!editable.value || !session.value) return;
    const parent = parentId ? session.value.nodes.find((n) => n.id === parentId) : null;
    const now = Date.now();

    const node: RequirementNode = {
      id: newId(),
      sessionId: session.value.id,
      parentId,
      title: '新需求',
      detail: '',
      kind: 'functional',
      acceptance: [],
      status: 'draft',
      origin: 'user',
      userNote: '',
      dependsOn: [],
      depth: parent ? parent.depth + 1 : 0,
      order: session.value.nodes.filter((n) => n.parentId === parentId).length,
      createdAt: now,
      updatedAt: now,
    };

    session.value.nodes = [...session.value.nodes, node];
    selectedId.value = node.id;
    dirtyIds.add(node.id);
    schedulePersist();
  }

  function removeNode(id: string): void {
    if (!editable.value || !session.value) return;

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

  /** 用户手动连线 = 声明实现路径上的依赖 */
  function setDependency(fromId: string, toId: string): boolean {
    if (!editable.value || !session.value || fromId === toId) return false;
    const node = session.value.nodes.find((n) => n.id === fromId);
    if (!node || node.dependsOn.includes(toId)) return false;
    updateNode(fromId, { dependsOn: [...node.dependsOn, toId] });
    return true;
  }

  function removeDependency(fromId: string, toId: string): void {
    if (!session.value) return;
    const node = session.value.nodes.find((n) => n.id === fromId);
    if (!node) return;
    updateNode(fromId, { dependsOn: node.dependsOn.filter((id) => id !== toId) });
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

    const upserted = session.value.nodes.filter((n) => dirtyIds.has(n.id));
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
    options: { freeText?: string; expand?: string[] } = {},
  ): Promise<void> {
    if (!session.value) return;
    await flush();

    try {
      await apiSubmitFeedback(session.value.id, {
        action,
        userFreeText: options.freeText ?? '',
        expandRequests: options.expand ?? [],
      });
      if (session.value) session.value.status = action === 'abort' ? 'aborted' : 'awaiting-agent';
      agentBusy.value = action !== 'abort';
    } catch (error) {
      errorMessage.value = toMessage(error);
    }
  }

  /**
   * 把当前所有待确认条目统一置为已确认。
   *
   * 「确认本轮」按钮的前置动作 —— 用户的心智模型是「我把不要的删了，剩下的都要」，
   * 而不是「提交一次但什么都没确认」。缺了这一步，用户点完确认、规格里却少了几条。
   */
  function confirmAllDrafts(): void {
    if (!session.value || !editable.value) return;
    const now = Date.now();
    for (const node of session.value.nodes) {
      if (node.status !== 'draft') continue;
      node.status = 'confirmed';
      node.updatedAt = now;
      dirtyIds.add(node.id);
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
    pendingAssumptions,
    draftCount,
    confirmedCount,
    editable,
    groupedCounts,
    agentBusy,
    agentNote,
    connection,
    errorMessage,
    loading,
    load,
    dispose,
    select,
    requestEdit,
    requestExpand,
    confirmAllDrafts,
    editingId,
    updateNode,
    setStatus,
    ruleAssumption,
    ruleAllAssumptions,
    addChild,
    removeNode,
    setDependency,
    removeDependency,
    flush,
    submit,
    clearError,
  };
});
