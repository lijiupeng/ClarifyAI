import { nanoid } from 'nanoid';
import open from 'open';
import { ServerEvent, Session } from '@clarifyai/shared';
import type {
  AbortInput,
  AbortOutput,
  AwaitOutput,
  DecompositionItem,
  Feedback,
  FinalizeInput,
  FinalizeOutput,
  GetSessionOutput,
  NodeOrigin,
  NodeSuggestion,
  RequirementNode,
  RequirementSpec,
  StartInput,
  StartOutput,
  SuggestInput,
  SuggestOutput,
  SubmitDecompositionInput,
  SubmitDecompositionOutput,
  ValidateOutput,
} from '@clarifyai/shared';
import type { SessionStore } from '../store/sessionStore.js';
import type { FeedbackBroker } from './feedbackBroker.js';
import { diffNodes } from './nodeDiff.js';
import { renderSpecMarkdown } from './specRender.js';

/** 画布上用户直接编辑产生的增量 */
export interface CanvasPatch {
  upserted: RequirementNode[];
  removedIds: string[];
}

/** 画布上用户点击「确认 / 还要拆 / 放弃」 */
export interface CanvasFeedbackRequest {
  action: 'confirmed' | 'need-more' | 'abort';
  userFreeText?: string;
  expandRequests?: string[];
  suggestRequests?: string[];
}

export type SessionEmitter = (sessionId: string, event: string, payload: unknown) => void;

export interface SessionServiceDeps {
  store: SessionStore;
  broker: FeedbackBroker;
  /** 画布基地址，用于生成 uiUrl */
  webOrigin: string;
  /** 创建会话时是否顺带在浏览器打开画布 */
  autoOpen?: boolean;
  /**
   * 单次 clarify_await 允许阻塞的上限（毫秒）。
   * 宿主的工具调用硬超时是外部约束，服务端必须自己封顶，见 awaitFeedback 里的说明。
   */
  maxBlockMs?: number;
  emit?: SessionEmitter;
}

/**
 * 会话状态机的唯一写入方。
 *
 * 两条写入路径泾渭分明：
 * - **主 Agent 路径**（submitDecomposition）：写入 AI 拆解结果，不推进 round
 * - **用户路径**（applyCanvasPatch / submitCanvasFeedback）：画布编辑推进 round 并唤醒主 Agent
 *
 * round 只在用户路径自增，这正是「超时不丢事件」得以成立的前提。
 */
export class SessionService {
  private readonly store: SessionStore;
  private readonly broker: FeedbackBroker;
  private readonly webOrigin: string;
  private readonly autoOpen: boolean;
  private readonly emit: SessionEmitter;
  private readonly maxBlockMs: number;

  constructor(deps: SessionServiceDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.webOrigin = deps.webOrigin.replace(/\/+$/, '');
    this.autoOpen = deps.autoOpen ?? false;
    this.maxBlockMs = deps.maxBlockMs ?? 600_000;
    this.emit = deps.emit ?? ((): void => {});
  }

  /* ---------------------------------------------------------------- */
  /* 主 Agent 路径                                                     */
  /* ---------------------------------------------------------------- */

  async start(input: StartInput): Promise<StartOutput> {
    const now = Date.now();
    const sessionId = nanoid(12);

    const session: Session = {
      id: sessionId,
      rawRequirement: input.rawRequirement,
      projectContext: input.projectContext,
      status: 'awaiting-user',
      round: 0,
      // 初始拆解是用户主动开启会话换来的，不需要额外授权；
      // 之后的每一次新增都必须由用户点按钮重新授权
      expandTargets: [],
      suggestTargets: [],
      maxDepth: input.maxDepth,
      rootId: null,
      nodes: [],
      suggestions: [],
      baselineNodes: [],
      createdAt: now,
      updatedAt: now,
    };

    // 画布只有一个根：它就是这份需求书的标题。
    // 所有拆解条目都是根的子孙，不存在并列的「顶层需求」。
    const root = this.createRoot(session, input.rootTitle);
    // 先把根放进 nodes：materialize 要靠它解析父节点与兄弟顺序
    session.rootId = root.id;
    session.nodes = [root];
    const created = this.materialize(session, root.id, input.decomposition, 'ai');
    session.nodes = [root, ...created];
    session.baselineNodes = structuredClone(session.nodes);

    await this.store.save(session);
    this.emit(sessionId, ServerEvent.SNAPSHOT, { session });

    const warnings = this.validateBatch(input.decomposition, 1, session.maxDepth);
    const uiUrl = this.uiUrl(sessionId);

    const notes = [
      `已创建会话 ${sessionId}：根节点「${root.title}」下 ${created.length} 条初稿已渲染到画布。`,
      `请引导用户在 ${uiUrl} 上逐条裁决，然后调用 clarify_await 阻塞等待结果。`,
      ...warnings,
    ];

    if (input.interactionMode === 'auto') {
      notes.push('interactionMode=auto 的 elicitation 轻量通道尚未启用，本次仍走画布。');
    }

    if (input.openUi && this.autoOpen) {
      // openUi 早先只是个摆设参数。打开失败不影响会话创建，用户仍可手动访问 uiUrl
      void open(uiUrl).catch(() => undefined);
    }

    return {
      sessionId,
      uiUrl,
      round: session.round,
      status: session.status,
      message: notes.join(' '),
    };
  }

  async submitDecomposition(input: SubmitDecompositionInput): Promise<SubmitDecompositionOutput> {
    const session = await this.mustLoad(input.sessionId);
    this.assertActive(session);

    // 单根语义：parentId=null 等同于挂到根节点下，不存在「补充顶层需求」
    const parentId = input.parentId ?? session.rootId;
    if (!parentId) throw new Error('会话缺少根节点，无法挂载新增条目');
    const parent = session.nodes.find((n) => n.id === parentId);
    if (!parent) throw new Error(`父节点不存在: ${parentId}`);

    this.assertExpandAuthorized(session, parentId, input.items.length);

    const created = this.materialize(session, parentId, input.items, 'ai');

    // 用户的每一条批注都必须得到回应，挂到对应节点上供用户核对
    for (const reply of input.replies) {
      const target = session.nodes.find((n) => n.id === reply.nodeId);
      if (!target) continue;
      target.detail = target.detail
        ? `${target.detail}\n\n[回应批注] ${reply.reply}`
        : `[回应批注] ${reply.reply}`;
      target.updatedAt = Date.now();
    }

    session.nodes.push(...created);
    // 更新基线：下一轮用户提交时，diff 以「你这次提交的内容」为参照
    session.baselineNodes = structuredClone(session.nodes);
    // 球交回用户：新一轮拆解已渲染，等待他们继续裁决
    session.status = 'awaiting-user';
    session.updatedAt = Date.now();
    await this.store.save(session);

    // 批注被回应的节点也要推给画布，否则用户看不到 AI 的答复
    const repliedNodes = input.replies
      .map((r) => session.nodes.find((n) => n.id === r.nodeId))
      .filter((n): n is RequirementNode => Boolean(n));

    this.emit(session.id, ServerEvent.PATCHED, {
      sessionId: session.id,
      round: session.round,
      status: session.status,
      upserted: [...created, ...repliedNodes],
      removedIds: [],
      suggestions: [],
      removedSuggestionIds: [],
      agentNote: input.agentNote,
    });

    this.emit(session.id, ServerEvent.AGENT_BUSY, {
      sessionId: session.id,
      busy: false,
      status: session.status,
      message: input.agentNote || 'AI 已提交新一轮拆解，请继续裁决',
    });

    return {
      sessionId: session.id,
      round: session.round,
      created,
      warnings: this.validateBatch(input.items, parent.depth + 1, session.maxDepth),
    };
  }

  /**
   * 提交补全 / 优化建议。
   *
   * 建议不写 nodes —— 它只是画布上的一层灰字，用户点了「采纳」才落到需求树。
   * 一次最多 3 条由契约层卡死：整棵树重写一遍对用户没有意义，他要的是逐条判断。
   */
  async suggest(input: SuggestInput): Promise<SuggestOutput> {
    const session = await this.mustLoad(input.sessionId);
    this.assertActive(session);

    // 条数不在代码里硬卡：给多少由 AI 按内容判断，规则写在 skill 里。
    // 契约层仍有一个上限（30），只用来挡明显失控的批量。
    const now = Date.now();
    const created: NodeSuggestion[] = [];
    const warnings: string[] = [];

    for (const item of input.items) {
      const target = session.nodes.find((n) => n.id === item.nodeId);
      if (!target) throw new Error(`节点不存在: ${item.nodeId}`);

      const duplicate = session.suggestions.some(
        (s) => s.nodeId === item.nodeId && s.action === item.action && s.status === 'pending',
      );
      if (duplicate) {
        warnings.push(`「${target.title}」已有一条待处理的同类建议，本次跳过`);
        continue;
      }

      const title = item.title.trim();
      if (item.action === 'expand' && !title) {
        throw new Error(`expand 建议必须给出新子需求的标题（目标节点「${target.title}」）`);
      }
      if (item.action === 'refine' && !title && !item.detail.trim() && item.acceptance.length === 0) {
        warnings.push(`「${target.title}」的 refine 建议没有任何内容，已跳过`);
        continue;
      }
      if (item.action === 'remove' && target.id === session.rootId) {
        warnings.push('根节点是需求书标题，不能删除，已跳过');
        continue;
      }
      if (item.action === 'move') {
        const nextParentId = item.targetParentId ?? session.rootId;
        if (!nextParentId) throw new Error('没有可用的父节点');
        if (!session.nodes.some((n) => n.id === nextParentId)) {
          throw new Error(`move 建议的目标父节点不存在: ${nextParentId}`);
        }
        if (nextParentId === target.id || this.isDescendant(session, nextParentId, target.id)) {
          throw new Error(`不能把「${target.title}」移到它自己的子树下`);
        }
      }

      created.push({
        id: nanoid(12),
        nodeId: item.nodeId,
        action: item.action,
        title,
        detail: item.detail,
        acceptance: [...item.acceptance],
        targetParentId: item.targetParentId ?? null,
        position: item.position ?? null,
        note: item.note.trim(),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }

    if (created.length > 0) {
      session.suggestions.push(...created);
      session.updatedAt = now;
      await this.store.save(session);

      this.emit(session.id, ServerEvent.PATCHED, {
        sessionId: session.id,
        round: session.round,
        status: session.status,
        upserted: [],
        removedIds: [],
        suggestions: created,
        removedSuggestionIds: [],
        agentNote: '',
      });
    }

    return { sessionId: session.id, round: session.round, created, warnings };
  }

  /**
   * 用户在画布上裁决一条建议。
   * 采纳才写入需求树 —— 忽略的建议只留一个 ignored 状态，永远不落地。
   */
  async resolveSuggestion(
    sessionId: string,
    suggestionId: string,
    accept: boolean,
  ): Promise<{
    session: Session;
    suggestion: NodeSuggestion;
    upserted: RequirementNode[];
    removedIds: string[];
  }> {
    const session = await this.mustLoad(sessionId);
    this.assertActive(session);

    const suggestion = session.suggestions.find((s) => s.id === suggestionId);
    if (!suggestion) throw new Error(`建议不存在: ${suggestionId}`);
    if (suggestion.status !== 'pending') throw new Error('这条建议已经处理过了');

    const target = session.nodes.find((n) => n.id === suggestion.nodeId);
    if (!target) throw new Error(`建议指向的节点不存在: ${suggestion.nodeId}`);

    const now = Date.now();
    const upserted: RequirementNode[] = [];
    const removedIds: string[] = [];
    const removedSuggestionIds: string[] = [suggestion.id];

    if (accept) {
      switch (suggestion.action) {
        case 'refine': {
          if (suggestion.title) target.title = suggestion.title;
          if (suggestion.detail.trim()) target.detail = suggestion.detail;
          if (suggestion.acceptance.length > 0) target.acceptance = [...suggestion.acceptance];
          target.updatedAt = now;
          upserted.push(target);
          break;
        }

        case 'expand': {
          const created = this.materialize(
            session,
            target.id,
            [
              {
                key: 'suggestion',
                title: suggestion.title,
                detail: suggestion.detail,
                kind: 'functional',
                acceptance: [...suggestion.acceptance],
                dependsOnKeys: [],
                userNoteRef: '',
              },
            ],
            'ai',
          );
          session.nodes.push(...created);
          upserted.push(...created);
          break;
        }

        case 'remove': {
          if (target.id === session.rootId) {
            throw new Error('根节点是需求书标题，不能删除');
          }

          const removing = new Set<string>([target.id]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const node of session.nodes) {
              if (node.parentId && removing.has(node.parentId) && !removing.has(node.id)) {
                removing.add(node.id);
                grew = true;
              }
            }
          }

          session.nodes = session.nodes.filter((n) => !removing.has(n.id));
          for (const node of session.nodes) {
            node.dependsOn = node.dependsOn.filter((id) => !removing.has(id));
          }

          // 挂在这些节点上的其它待处理建议一起作废，否则会指向不存在的节点
          for (const other of session.suggestions) {
            if (other.status !== 'pending' || other.id === suggestion.id) continue;
            if (!removing.has(other.nodeId)) continue;
            other.status = 'ignored';
            other.updatedAt = now;
            removedSuggestionIds.push(other.id);
          }

          removedIds.push(...removing);
          break;
        }

        case 'move': {
          const nextParentId = suggestion.targetParentId ?? session.rootId;
          if (!nextParentId) throw new Error('没有可用的父节点');
          if (nextParentId === target.id || this.isDescendant(session, nextParentId, target.id)) {
            throw new Error('不能把节点移到它自己的子树下');
          }

          const parent = session.nodes.find((n) => n.id === nextParentId);
          if (!parent) throw new Error(`目标父节点不存在: ${nextParentId}`);

          target.parentId = parent.id;

          // 重排新父节点下的全部兄弟，顺序号保持连续
          const siblings = session.nodes
            .filter((n) => n.parentId === parent.id && n.id !== target.id)
            .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
          const position = Math.min(suggestion.position ?? siblings.length, siblings.length);
          siblings.splice(position, 0, target);
          siblings.forEach((node, index) => {
            node.order = index;
          });

          this.recomputeDepths(session);

          for (const node of session.nodes) {
            if (node.id === target.id || this.isDescendant(session, node.id, target.id)) {
              node.updatedAt = now;
              upserted.push(node);
            }
          }
          break;
        }
      }
    }

    suggestion.status = accept ? 'accepted' : 'ignored';
    suggestion.updatedAt = now;
    session.updatedAt = now;
    await this.store.save(session);

    this.emit(session.id, ServerEvent.PATCHED, {
      sessionId: session.id,
      round: session.round,
      status: session.status,
      upserted,
      removedIds,
      suggestions: [],
      removedSuggestionIds,
      agentNote: '',
    });

    return { session, suggestion, upserted, removedIds };
  }

  async awaitFeedback(sessionId: string, sinceRound: number, timeoutMs: number): Promise<AwaitOutput> {
    const startedAt = Date.now();
    // 按配置封顶：默认与契约上限一致（不额外收缩）。
    // 只有宿主自己的工具调用超时比这更小时，才需要用 --max-block-ms 压到宿主上限以内 ——
    // 否则宿主的硬超时会把整次调用掐掉，主 Agent 连 round 游标都拿不到。
    const blockMs = Math.max(0, Math.min(timeoutMs, this.maxBlockMs));
    const initial = await this.mustLoad(sessionId);

    if (initial.status === 'aborted') {
      return {
        status: 'aborted',
        sessionId,
        round: initial.round,
        waitedMs: 0,
        feedback: null,
        hint: '会话已被用户终止。',
      };
    }

    // 服务重启会清空内存里的反馈历史，但数据是落盘的 ——
    // 只要 round 已超过游标，就说明用户在你重启之前提交过，直接重算，
    // 别让这次提交烂在磁盘上（实测踩过：重启后那次「确认」永远等不到）。
    if (initial.round > sinceRound) {
      const rebuilt = this.rebuildFeedback(initial);
      await this.handBack(sessionId);
      return {
        status: 'feedback',
        sessionId,
        round: initial.round,
        waitedMs: Date.now() - startedAt,
        feedback: rebuilt,
        hint: this.buildHint(rebuilt),
      };
    }

    const feedback = await this.broker.waitFor(sessionId, sinceRound, blockMs);
    const waitedMs = Date.now() - startedAt;

    if (!feedback) {
      // 等待期间可能被 finalize / abort 关掉
      const latest = await this.store.load(sessionId);
      if (latest && latest.status === 'aborted') {
        return { status: 'aborted', sessionId, round: latest.round, waitedMs, feedback: null, hint: '会话已被用户终止。' };
      }
      return {
        status: 'pending',
        sessionId,
        round: latest?.round ?? sinceRound,
        waitedMs,
        feedback: null,
        hint: '等待期间用户暂无操作。请用返回的 round 作为 sinceRound 再次调用 clarify_await 继续等待，不要重复提交拆解。',
      };
    }

    if (feedback.action === 'abort') {
      return {
        status: 'aborted',
        sessionId,
        round: feedback.round,
        waitedMs,
        feedback,
        hint: '用户主动终止了本次澄清。',
      };
    }

    // 球已到你手上，立刻把操作权交回用户。
    // 否则画布会一直停在「AI 正在处理」的只读态 —— 而你未必需要提交新拆解，
    // 用户就被卡在「确认本轮点不动」的状态里出不来（实测踩过）。
    await this.handBack(sessionId);

    return {
      status: 'feedback',
      sessionId,
      round: feedback.round,
      waitedMs,
      feedback,
      hint: this.buildHint(feedback),
    };
  }

  /**
   * 启动时清理陈旧状态：把残留的 awaiting-agent 交回用户。
   *
   * 阻塞等待队列活在内存在里，服务一重启就没了 —— 此时盘上的 awaiting-agent
   * 意味着「画布还在等一个永远不会到来的 AI 回复」，用户打开就是一片只读。
   * 没人会为一次重启负责，所以由启动流程统一兜底。
   */
  async recoverStaleSessions(): Promise<number> {
    const listed = await this.store.list();
    let recovered = 0;

    for (const item of listed) {
      if (item.status !== 'awaiting-agent') continue;

      const session = await this.store.load(item.id);
      if (!session) continue;

      session.status = 'awaiting-user';
      session.updatedAt = Date.now();
      await this.store.save(session);
      recovered += 1;
    }

    return recovered;
  }

  /** 把会话交回用户操作：awaiting-agent → awaiting-user */
  private async handBack(sessionId: string): Promise<void> {
    const session = await this.store.load(sessionId);
    if (!session || session.status !== 'awaiting-agent') return;

    session.status = 'awaiting-user';
    session.updatedAt = Date.now();
    await this.store.save(session);

    this.emit(sessionId, ServerEvent.AGENT_BUSY, {
      sessionId,
      busy: false,
      status: session.status,
      message: 'AI 已收到你的裁决',
    });
  }

  /**
   * 从落盘数据重算一次用户反馈。
   *
   * 内存里的反馈历史会随进程重启蒸发，但 `baselineNodes`、`round`、`lastAction`
   * 和用户改完的 `nodes` 全都在磁盘上 —— 有这些就足以把反馈重新算出来，
   * 不必让一次真实的用户提交因为「服务重启过」而石沉大海。
   */
  private rebuildFeedback(session: Session): Feedback {
    const diff = diffNodes(session.baselineNodes, session.nodes);
    const aiIds = new Set(session.baselineNodes.filter((n) => n.origin === 'ai').map((n) => n.id));
    const touched = new Set(diff.filter((c) => aiIds.has(c.id)).map((c) => c.id));

    return {
      sessionId: session.id,
      round: session.round,
      action: session.lastAction ?? 'confirmed',
      rootId: session.rootId,
      nodes: session.nodes,
      diff,
      // 自由输入是纯文本、丢了不致命，重算时只能留空；
      // 但展开请求必须恢复：它已随 expandTargets 落盘，且是服务端放行新增节点的唯一依据，
      // 漏掉它会让主 Agent 以为自己没被授权，而服务端手里却攥着一份授权
      userFreeText: '',
      expandRequests: [...session.expandTargets],
      suggestRequests: [...session.suggestTargets],
      pendingAssumptions: session.nodes
        .filter((n) => n.kind === 'assumption')
        .map((n) => n.id),
      aiDraftCorrectionRate: aiIds.size > 0 ? touched.size / aiIds.size : 0,
    };
  }

  async getSession(sessionId: string): Promise<GetSessionOutput> {
    const session = await this.mustLoad(sessionId);
    return {
      sessionId: session.id,
      status: session.status,
      round: session.round,
      projectContext: session.projectContext,
      rawRequirement: session.rawRequirement,
      rootId: session.rootId,
      nodes: session.nodes,
      suggestions: session.suggestions,
      pendingAssumptions: session.nodes.filter((n) => n.kind === 'assumption'),
    };
  }

  async finalize(input: FinalizeInput): Promise<FinalizeOutput> {
    const session = await this.mustLoad(input.sessionId);

    // 没有「待确认」这一档：画布上的条目都是正式的，只有假设需要先被裁决
    const confirmed = session.nodes.filter((n) => n.kind !== 'out-of-scope');
    const markdown = renderSpecMarkdown(session, confirmed, input.implementationPlan);

    const warnings: string[] = [];

    const pending = session.nodes.filter((n) => n.kind === 'assumption');
    if (pending.length > 0) {
      warnings.push(`仍有 ${pending.length} 条 AI 假设未被用户裁决，规格中可能包含未经确认的推断`);
    }

    // 根节点是标题，不需要验收标准
    const missing = confirmed.filter(
      (n) => n.id !== session.rootId && n.acceptance.length === 0 && n.kind === 'functional',
    );
    if (missing.length > 0) {
      warnings.push(`${missing.length} 条已确认的功能需求没有验收标准，后续无法判定是否达成`);
    }

    const spec: RequirementSpec = {
      sessionId: session.id,
      projectName: session.projectContext.projectName,
      rawRequirement: session.rawRequirement,
      nodes: confirmed,
      outOfScope: session.nodes.filter((n) => n.kind === 'out-of-scope').map((n) => n.title),
      markdown,
      generatedAt: Date.now(),
    };

    // 不再进终态：规格只是「当前快照」，画布随时可以继续改。
    // 用户的心智是「这份需求书一直在」，不是「提交后就封板」。
    session.updatedAt = Date.now();
    await this.store.save(session);

    this.emit(session.id, ServerEvent.AGENT_BUSY, {
      sessionId: session.id,
      busy: false,
      status: session.status,
      message: '规格快照已生成，画布仍可继续编辑',
    });

    return { sessionId: session.id, spec, warnings };
  }

  async abort(input: AbortInput): Promise<AbortOutput> {
    const session = await this.mustLoad(input.sessionId);
    session.status = 'aborted';
    session.updatedAt = Date.now();
    await this.store.save(session);

    this.broker.dispose(session.id);
    this.emit(session.id, ServerEvent.CLOSED, {
      sessionId: session.id,
      status: 'aborted',
      message: input.reason || '已终止',
    });

    return { sessionId: session.id, status: session.status };
  }

  async validate(sessionId: string): Promise<ValidateOutput> {
    const session = await this.mustLoad(sessionId);
    const issues: ValidateOutput['issues'] = [];

    for (const node of session.nodes) {
      if (node.kind === 'assumption') {
        issues.push({ level: 'warning', nodeId: node.id, message: `AI 假设未经裁决：「${node.title}」` });
      }
      if (node.id !== session.rootId && node.kind === 'functional' && node.acceptance.length === 0) {
        issues.push({ level: 'warning', nodeId: node.id, message: `缺少验收标准：「${node.title}」` });
      }
      if (node.dependsOn.some((id) => !session.nodes.some((n) => n.id === id))) {
        issues.push({ level: 'error', nodeId: node.id, message: `依赖了不存在的节点：「${node.title}」` });
      }
    }

    const baselineAiIds = new Set(session.baselineNodes.filter((n) => n.origin === 'ai').map((n) => n.id));
    const diff = diffNodes(session.baselineNodes, session.nodes);
    const touched = diff.filter((c) => baselineAiIds.has(c.id)).length;

    const stats: ValidateOutput['stats'] = {
      total: session.nodes.length,
      // 没有「待确认」档位了：正式条目 = 除明确不做之外的节点
      confirmed: session.nodes.filter((n) => n.kind !== 'out-of-scope').length,
      draftAssumptions: session.nodes.filter((n) => n.kind === 'assumption').length,
      missingAcceptance: session.nodes.filter(
        (n) => n.id !== session.rootId && n.kind === 'functional' && n.acceptance.length === 0,
      ).length,
      aiDraftCorrectionRate: baselineAiIds.size > 0 ? touched / baselineAiIds.size : 0,
    };

    return { sessionId, ok: !issues.some((i) => i.level === 'error'), issues, stats };
  }

  /* ---------------------------------------------------------------- */
  /* 用户（画布）路径                                                  */
  /* ---------------------------------------------------------------- */

  /** 画布上的即时编辑：只改节点，不推进 round，因此不会唤醒主 Agent */
  async applyCanvasPatch(sessionId: string, patch: CanvasPatch): Promise<Session> {
    const session = await this.mustLoad(sessionId);
    this.assertActive(session);
    const now = Date.now();

    if (session.rootId && patch.removedIds.includes(session.rootId)) {
      throw new Error('根节点是这份需求书的标题，不能删除；可以改标题或删掉它下面的分支');
    }
    for (const incoming of patch.upserted) {
      if (incoming.parentId === null && incoming.id !== session.rootId) {
        throw new Error('画布只允许一个根节点；新增需求请挂到根节点或已有节点下');
      }
    }

    if (patch.removedIds.length > 0) {
      const removing = new Set(patch.removedIds);
      // 级联删除子孙，避免用户删掉父节点后留下整片孤儿
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of session.nodes) {
          if (node.parentId && removing.has(node.parentId) && !removing.has(node.id)) {
            removing.add(node.id);
            grew = true;
          }
        }
      }

      session.nodes = session.nodes.filter((n) => !removing.has(n.id));
      for (const node of session.nodes) {
        node.dependsOn = node.dependsOn.filter((id) => !removing.has(id));
      }
    }

    for (const incoming of patch.upserted) {
      const index = session.nodes.findIndex((n) => n.id === incoming.id);
      if (index >= 0) {
        session.nodes[index] = { ...incoming, sessionId, updatedAt: now };
      } else {
        session.nodes.push({ ...incoming, sessionId, createdAt: now, updatedAt: now });
      }
    }

    session.updatedAt = now;
    await this.store.save(session);

    this.emit(sessionId, ServerEvent.PATCHED, {
      sessionId,
      round: session.round,
      status: session.status,
      upserted: patch.upserted,
      removedIds: patch.removedIds,
      suggestions: [],
      removedSuggestionIds: [],
      agentNote: '',
    });

    return session;
  }

  /** 用户点击「确认本轮 / 继续拆 / 放弃」—— 推进 round 并唤醒主 Agent */
  async submitCanvasFeedback(
    sessionId: string,
    request: CanvasFeedbackRequest,
  ): Promise<Feedback> {
    const session = await this.mustLoad(sessionId);
    const now = Date.now();

    const baseline = session.baselineNodes;
    const diff = diffNodes(baseline, session.nodes);

    // 「AI 初稿被纠正了多少」—— 本工具最核心的度量指标
    const aiIdSet = new Set(baseline.filter((n) => n.origin === 'ai').map((n) => n.id));
    const touchedAi = new Set(diff.filter((c) => aiIdSet.has(c.id)).map((c) => c.id));

    session.round += 1;
    session.lastAction = request.action;
    session.status = request.action === 'abort' ? 'aborted' : 'awaiting-agent';
    // 授权整体覆盖而非累加：用户这一轮的意图只在这两个按钮之间的这段时间内有效。
    // 用户没点任何推断按钮时这里就是空的，主 Agent 随即失去新增节点的权限。
    session.expandTargets = [...new Set(request.expandRequests ?? [])].filter((id) =>
      session.nodes.some((n) => n.id === id),
    );
    session.suggestTargets = [...new Set(request.suggestRequests ?? [])].filter((id) =>
      session.nodes.some((n) => n.id === id),
    );
    session.updatedAt = now;
    await this.store.save(session);

    const feedback: Feedback = {
      sessionId,
      round: session.round,
      action: request.action,
      rootId: session.rootId,
      nodes: session.nodes,
      diff,
      userFreeText: request.userFreeText ?? '',
      expandRequests: request.expandRequests ?? [],
      suggestRequests: request.suggestRequests ?? [],
      pendingAssumptions: session.nodes
        .filter((n) => n.kind === 'assumption')
        .map((n) => n.id),
      aiDraftCorrectionRate: aiIdSet.size > 0 ? touchedAi.size / aiIdSet.size : 0,
    };

    this.broker.publish(feedback);

    if (request.action === 'abort') {
      this.broker.dispose(sessionId);
      this.emit(sessionId, ServerEvent.CLOSED, { sessionId, status: 'aborted', message: '用户终止了本次澄清' });
    } else {
      this.emit(sessionId, ServerEvent.AGENT_BUSY, {
        sessionId,
        busy: true,
        status: session.status,
        message: '已提交，等待 AI 处理',
      });
    }

    return feedback;
  }

  /* ---------------------------------------------------------------- */
  /* 内部工具                                                          */
  /* ---------------------------------------------------------------- */

  private uiUrl(sessionId: string): string {
    return `${this.webOrigin}/session/${sessionId}`;
  }

  private async mustLoad(sessionId: string): Promise<Session> {
    const session = await this.store.load(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    // 单根是画布的不变量：旧数据缺 rootId 时在这里补齐，后续逻辑不必再判空
    if (this.ensureSingleRoot(session)) await this.store.save(session);
    return session;
  }

  /** 只有用户主动终止才算结束；生成过规格的会话仍然可以继续编辑 */
  private assertActive(session: Session): void {
    if (session.status === 'aborted') {
      throw new Error(`会话 ${session.id} 已被终止，无法继续写入`);
    }
  }

  /**
   * 新增节点的硬闸门：没有用户授权就直接拒绝，一个节点都不写。
   *
   * 背景：光靠提示词约束不住这件事。用户只是往「补充说明」里写了一句话、或点了
   * 「确认本轮」，主 Agent 照样会把它当成拆解指令，自行长出一整批子节点 ——
   * 而它的每一条推断都可能不是用户要的。所以授权必须由用户点击按钮产生、
   * 由服务端校验，而不是靠 AI 自觉。
   *
   * 授权语义（与画布上的按钮一一对应）：
   * - 「推断分支」「推断下一个分支」「继续拆解选中项」→ 授权展开该节点
   * - 授权每次用户提交都整体覆盖，因此一次点击只授权一轮
   * - `items` 为空表示「本轮不新增」，永远放行 —— 这也是回应批注的唯一合法姿势
   */
  private assertExpandAuthorized(session: Session, parentId: string, itemCount: number): void {
    if (itemCount === 0) return;

    if (session.expandTargets.includes(parentId)) return;

    const granted = session.expandTargets
      .map((id) => session.nodes.find((n) => n.id === id)?.title ?? id)
      .slice(0, 5);

    throw new Error(
      `本轮用户没有请求新增节点，${itemCount} 条新增已被拒绝，未写入任何节点。` +
        '新增节点必须先由用户在画布上点击「推断分支 / 推断下一个分支 / 继续拆解选中项」授权，' +
        '用户点了「确认本轮」或只在补充说明里写了字，都不构成新增授权。' +
        (granted.length > 0
          ? `本轮已授权的展开目标：${granted.join('、')}；新增只能挂到这些节点下。`
          : '本轮没有任何已授权的展开目标，因此新增一律不允许。') +
        '若只是想回应批注或归类用户的补充说明，请改为传 items: []，把回应写进 replies。',
    );
  }

  /** 画布唯一的根 —— 它是需求书的标题，不是一条待裁决的需求 */
  private createRoot(session: Session, title: string | undefined): RequirementNode {
    const now = Date.now();
    const fallback = session.rawRequirement.trim().slice(0, 24) || '未命名需求';

    return {
      id: nanoid(12),
      sessionId: session.id,
      parentId: null,
      // 直接调用服务（脚本、内部测试）时不会经过 zod，default 不生效
      title: title?.trim() || fallback,
      detail: '',
      kind: 'functional',
      acceptance: [],
      status: 'confirmed',
      origin: 'user',
      userNote: '',
      dependsOn: [],
      depth: 0,
      order: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 旧会话可能没有 rootId、甚至有多棵顶层树。
   * 这里把它们收敛成单根：取最早的顶层节点当根，其余顶层节点挂到它下面并重算层级。
   */
  private ensureSingleRoot(session: Session): boolean {
    if (session.rootId && session.nodes.some((n) => n.id === session.rootId)) return false;

    const tops = session.nodes
      .filter((n) => n.parentId === null)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (tops.length === 0) return false;

    const [root, ...extraTops] = tops;
    session.rootId = root!.id;
    if (extraTops.length === 0) return true;

    for (const node of extraTops) node.parentId = root!.id;
    this.recomputeDepths(session);
    return true;
  }

  private recomputeDepths(session: Session): void {
    const childrenOf = new Map<string, RequirementNode[]>();
    for (const node of session.nodes) {
      if (!node.parentId) continue;
      const list = childrenOf.get(node.parentId) ?? [];
      list.push(node);
      childrenOf.set(node.parentId, list);
    }

    const walk = (node: RequirementNode, depth: number): void => {
      node.depth = depth;
      for (const child of childrenOf.get(node.id) ?? []) walk(child, depth + 1);
    };

    const root = session.nodes.find((n) => n.id === session.rootId);
    if (root) walk(root, 0);
  }

  /** nodeId 是否落在 ancestorId 的子树里（阻止把节点移到自己下面） */
  private isDescendant(session: Session, nodeId: string, ancestorId: string): boolean {
    let cursor = session.nodes.find((n) => n.id === nodeId);

    while (cursor?.parentId) {
      const parentId: string = cursor.parentId;
      if (parentId === ancestorId) return true;
      cursor = session.nodes.find((n) => n.id === parentId);
    }

    return false;
  }

  /** 把主 Agent 的拆解条目落成节点：分配 id、算层级、解析同批次依赖引用 */
  private materialize(
    session: Session,
    parentId: string | null,
    items: readonly DecompositionItem[],
    origin: NodeOrigin,
  ): RequirementNode[] {
    const now = Date.now();
    const parent = parentId ? session.nodes.find((n) => n.id === parentId) : undefined;
    if (parentId && !parent) throw new Error(`父节点不存在: ${parentId}`);

    const depth = parent ? parent.depth + 1 : 0;
    const siblingCount = session.nodes.filter((n) => n.parentId === parentId).length;
    const keyToId = new Map<string, string>();

    const created = items.map((item, index) => {
      const id = nanoid(12);
      keyToId.set(item.key, id);
      const node: RequirementNode = {
        id,
        sessionId: session.id,
        parentId,
        title: item.title.trim(),
        detail: item.detail,
        kind: item.kind,
        acceptance: [...item.acceptance],
        // 落到画布上的节点就是正式的：没有「待确认」这一档。
        // AI 的推断在落地前先以建议形式存在，用户采纳才算数。
        status: 'confirmed',
        origin,
        userNote: '',
        dependsOn: [],
        depth,
        order: siblingCount + index,
        createdAt: now,
        updatedAt: now,
      };
      return node;
    });

    // 第二遍：同批次内的 key 引用此刻才能解析成真实 id
    created.forEach((node, index) => {
      const item = items[index];
      if (!item) return;
      node.dependsOn = item.dependsOnKeys
        .map((key) => keyToId.get(key))
        .filter((id): id is string => typeof id === 'string');
    });

    return created;
  }

  private validateBatch(
    items: readonly DecompositionItem[],
    depth: number,
    maxDepth: number,
  ): string[] {
    const warnings: string[] = [];

    const missing = items.filter(
      (i) => i.kind !== 'assumption' && i.kind !== 'out-of-scope' && i.acceptance.length === 0,
    );
    if (missing.length > 0) {
      warnings.push(
        `${missing.length} 条条目缺少验收标准，后续无法判定是否达成：「${missing
          .map((i) => i.title)
          .slice(0, 3)
          .join('」「')}」`,
      );
    }

    const loose = items.filter(
      (i) => i.acceptance.length > 0 && i.acceptance.some((a) => !/\bWHEN\b/i.test(a) || !/\bTHEN\b/i.test(a)),
    );
    if (loose.length > 0) {
      warnings.push(
        `${loose.length} 条条目的验收标准不是 WHEN/THEN 结构，容易留下解读空间，建议改写为「WHEN <前置条件> THEN <可观测结果>」`,
      );
    }

    if (depth >= maxDepth) {
      warnings.push(`已达最大拆解深度 ${maxDepth}，继续下钻前请确认用户确实需要更细的粒度`);
    }

    return warnings;
  }

  /** 把用户的裁决翻译成主 Agent 能直接执行的行动建议 */
  private buildHint(feedback: Feedback): string {
    const parts: string[] = [];

    if (feedback.pendingAssumptions.length > 0) {
      parts.push(
        `仍有 ${feedback.pendingAssumptions.length} 条 AI 假设未获裁决（${feedback.pendingAssumptions
          .slice(0, 5)
          .join(', ')}），请优先回应这些，而不是继续向下拆解`,
      );
    }

    const removed = feedback.diff.filter((c) => c.change === 'removed').length;
    const modified = feedback.diff.filter((c) => c.change === 'modified').length;
    const added = feedback.diff.filter((c) => c.change === 'added').length;
    if (removed > 0 || modified > 0 || added > 0) {
      parts.push(
        `用户在画布上新增 ${added} 条、修改 ${modified} 条、删除 ${removed} 条；` +
          `AI 初稿纠偏率约 ${(feedback.aiDraftCorrectionRate * 100).toFixed(0)}%`,
      );
    }

    if (feedback.userFreeText.trim()) {
      parts.push(`用户补充说明：「${feedback.userFreeText.trim()}」，请把它归类到合适的位置并确认理解是否正确`);
    }

    if (feedback.expandRequests.length > 0) {
      // 带上标题而不是裸 id —— 主 Agent 不必为了认节点再多跑一次 clarify_get_session
      const targets = feedback.expandRequests
        .map((id) => feedback.nodes.find((n) => n.id === id)?.title ?? id)
        .slice(0, 5);
      parts.push(
        `用户明确要求展开 ${feedback.expandRequests.length} 个节点（${targets.join('、')}），` +
          '请针对这些节点调用 clarify_submit_decomposition 推断出新的分支',
      );
    }

    if (feedback.suggestRequests.length > 0) {
      const targets = feedback.suggestRequests
        .map((id) => feedback.nodes.find((n) => n.id === id)?.title ?? id)
        .slice(0, 5);
      const wholeTree = Boolean(feedback.rootId && feedback.suggestRequests.includes(feedback.rootId));

      parts.push(
        wholeTree
          ? '用户要求优化**整棵树**：可以调顺序（move）、删冗余（remove）、补缺口（expand）、改措辞（refine），' +
            '但整体意思不能变 —— 不要新增用户没提过的功能，也不要把已确认的条目删成另一个需求。' +
            '最多 10 条，只挑最值得改的'
          : `用户要求优化 ${feedback.suggestRequests.length} 个节点（${targets.join('、')}），` +
            '请用 clarify_suggest 给出建议，最多 3 条，让用户逐条决定要不要',
      );
    }

    if (feedback.action === 'confirmed') {
      parts.push(
        '用户已提交本轮，可继续下一层拆解，或调用 clarify_finalize 取一份规格快照（不会结束会话）；' +
          '若发现某些条目写得含糊，也可以用 clarify_suggest 给最多 3 条优化建议',
      );
    }

    return parts.length > 0 ? parts.join('；') + '。' : '用户已确认本轮，请继续。';
  }
}
