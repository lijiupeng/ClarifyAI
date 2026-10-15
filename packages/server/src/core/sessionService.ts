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
  RequirementNode,
  RequirementSpec,
  StartInput,
  StartOutput,
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
}

export type SessionEmitter = (sessionId: string, event: string, payload: unknown) => void;

export interface SessionServiceDeps {
  store: SessionStore;
  broker: FeedbackBroker;
  /** 画布基地址，用于生成 uiUrl */
  webOrigin: string;
  /** 创建会话时是否顺带在浏览器打开画布 */
  autoOpen?: boolean;
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

  constructor(deps: SessionServiceDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.webOrigin = deps.webOrigin.replace(/\/+$/, '');
    this.autoOpen = deps.autoOpen ?? false;
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
      maxDepth: input.maxDepth,
      nodes: [],
      baselineNodes: [],
      createdAt: now,
      updatedAt: now,
    };

    const created = this.materialize(session, null, input.decomposition, 'ai');
    session.nodes = created;
    session.baselineNodes = structuredClone(created);

    await this.store.save(session);
    this.emit(sessionId, ServerEvent.SNAPSHOT, { session });

    const warnings = this.validateBatch(input.decomposition, 0, session.maxDepth);
    const uiUrl = this.uiUrl(sessionId);

    const notes = [
      `已创建会话 ${sessionId}：${created.length} 条初稿已渲染到画布。`,
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

    const parentDepth = input.parentId
      ? (session.nodes.find((n) => n.id === input.parentId)?.depth ?? -1)
      : -1;
    const nextDepth = parentDepth + 1;

    const created = this.materialize(session, input.parentId, input.items, 'ai');

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
      warnings: this.validateBatch(input.items, nextDepth, session.maxDepth),
    };
  }

  async awaitFeedback(sessionId: string, sinceRound: number, timeoutMs: number): Promise<AwaitOutput> {
    const startedAt = Date.now();
    const initial = await this.mustLoad(sessionId);

    if (initial.status === 'completed') {
      return {
        status: 'completed',
        sessionId,
        round: initial.round,
        waitedMs: 0,
        feedback: null,
        hint: '会话已产出规格，无需继续等待。可直接使用 clarify_finalize 的返回值。',
      };
    }
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

    const feedback = await this.broker.waitFor(sessionId, sinceRound, timeoutMs);
    const waitedMs = Date.now() - startedAt;

    if (!feedback) {
      // 等待期间可能被 finalize / abort 关掉
      const latest = await this.store.load(sessionId);
      if (latest && latest.status === 'completed') {
        return { status: 'completed', sessionId, round: latest.round, waitedMs, feedback: null, hint: '会话已产出规格。' };
      }
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
      nodes: session.nodes,
      diff,
      // 自由输入与展开请求没有落盘，重算时只能留空；
      // 但节点数据是完整的，主 Agent 据此就能继续推进
      userFreeText: '',
      expandRequests: [],
      pendingAssumptions: session.nodes
        .filter((n) => n.kind === 'assumption' && n.status === 'draft')
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
      nodes: session.nodes,
      pendingAssumptions: session.nodes.filter((n) => n.kind === 'assumption' && n.status === 'draft'),
    };
  }

  async finalize(input: FinalizeInput): Promise<FinalizeOutput> {
    const session = await this.mustLoad(input.sessionId);

    const confirmed = session.nodes.filter((n) => n.status === 'confirmed' && n.kind !== 'out-of-scope');
    const markdown = renderSpecMarkdown(session, confirmed, input.implementationPlan);

    const warnings: string[] = [];

    // 待确认的条目会被排除在规格之外，必须显式报出来 ——
    // 否则用户以为「都确认完了」，规格看上去完整无缺，实际却丢了他还没裁决的关键条目。
    // （实测踩过：两条最重要的需求就这么静默消失了）
    const undecided = session.nodes.filter(
      (n) => n.status === 'draft' && n.kind !== 'out-of-scope' && n.kind !== 'assumption',
    );
    if (undecided.length > 0) {
      warnings.push(
        `有 ${undecided.length} 条处于「待确认」状态、未纳入规格：「${undecided
          .slice(0, 3)
          .map((n) => n.title)
          .join('」「')}」—— 若它们仍然需要，请回到画布逐条确认后再收口`,
      );
    }

    const pending = session.nodes.filter((n) => n.kind === 'assumption' && n.status === 'draft');
    if (pending.length > 0) {
      warnings.push(`仍有 ${pending.length} 条 AI 假设未被用户裁决，规格中可能包含未经确认的推断`);
    }

    const missing = confirmed.filter((n) => n.acceptance.length === 0 && n.kind === 'functional');
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

    session.status = 'completed';
    session.updatedAt = Date.now();
    await this.store.save(session);

    this.broker.dispose(session.id);
    this.emit(session.id, ServerEvent.CLOSED, {
      sessionId: session.id,
      status: 'completed',
      message: '需求规格已生成',
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
      if (node.kind === 'assumption' && node.status === 'draft') {
        issues.push({ level: 'warning', nodeId: node.id, message: `AI 假设未经裁决：「${node.title}」` });
      }
      if (node.kind === 'functional' && node.status === 'confirmed' && node.acceptance.length === 0) {
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
      confirmed: session.nodes.filter((n) => n.status === 'confirmed').length,
      draftAssumptions: session.nodes.filter((n) => n.kind === 'assumption' && n.status === 'draft').length,
      missingAcceptance: session.nodes.filter(
        (n) => n.kind === 'functional' && n.acceptance.length === 0,
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
    session.updatedAt = now;
    await this.store.save(session);

    const feedback: Feedback = {
      sessionId,
      round: session.round,
      action: request.action,
      nodes: session.nodes,
      diff,
      userFreeText: request.userFreeText ?? '',
      expandRequests: request.expandRequests ?? [],
      pendingAssumptions: session.nodes
        .filter((n) => n.kind === 'assumption' && n.status === 'draft')
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
    return session;
  }

  private assertActive(session: Session): void {
    if (session.status === 'completed' || session.status === 'aborted') {
      throw new Error(`会话 ${session.id} 已结束（${session.status}），无法继续写入`);
    }
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
        status: 'draft',
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

    if (feedback.action === 'confirmed') {
      parts.push('用户已确认本轮，可继续下一层拆解，或调用 clarify_finalize 收口');
    }

    return parts.length > 0 ? parts.join('；') + '。' : '用户已确认本轮，请继续。';
  }
}
