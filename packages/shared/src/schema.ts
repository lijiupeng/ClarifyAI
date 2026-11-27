/**
 * ClarifyAI 核心数据契约 —— 全项目唯一真源。
 *
 * 设计要点：
 * 1. `assumption` 是一等公民。AI 的每一条推断都必须显式落成 assumption 条目交由用户裁决，
 *    而不是隐式写进实现里 —— 这是本工具存在的唯一理由。
 * 2. `acceptance` 强制存在。一条需求若写不出验收标准，说明它还没拆到位，或本身就是模糊的。
 * 3. `dependsOn` 独立于父子层级，用于表达「实现路径」（How），与「需求构成」（What）解耦。
 */
import { z } from 'zod';

const Id = z.string().min(1);
const Timestamp = z.number().int().nonnegative();

/* ------------------------------------------------------------------ */
/* 需求节点                                                            */
/* ------------------------------------------------------------------ */

/**
 * 需求条目的性质。
 * - functional     系统要做什么
 * - non-functional 性能 / 安全 / 可用性等质量属性
 * - constraint     技术栈 / 兼容性 / 合规等硬约束
 * - assumption     AI 的推断，未经用户确认，必须由用户裁决（确认或否决）
 * - out-of-scope   本期明确不做，防止 AI 自行扩范围
 */
export const NodeKind = z.enum([
  'functional',
  'non-functional',
  'constraint',
  'assumption',
  'out-of-scope',
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const NODE_KIND_LABEL: Record<NodeKind, string> = {
  functional: '功能需求',
  'non-functional': '质量属性',
  constraint: '约束条件',
  assumption: 'AI 假设',
  'out-of-scope': '本期不做',
};

/**
 * 条目状态。
 *
 * 画布上已经没有「待确认」这一档：落到图上的节点就是正式的（confirmed），
 * AI 的推断在落地前以建议的形式存在。字段保留只为兼容旧会话数据。
 */
export const NodeStatus = z.enum(['draft', 'confirmed', 'rejected']);
export type NodeStatus = z.infer<typeof NodeStatus>;

/** 条目由谁产生。用于统计「AI 脑补被用户否决的比例」这一核心指标。 */
export const NodeOrigin = z.enum(['ai', 'user']);
export type NodeOrigin = z.infer<typeof NodeOrigin>;

export const RequirementNode = z.object({
  id: Id,
  sessionId: Id,
  /** 父节点；null 表示顶层需求 */
  parentId: Id.nullable(),
  /** 一句话需求，必须能独立看懂 */
  title: z.string().min(1),
  /** 补充说明 */
  detail: z.string().default(''),
  kind: NodeKind,
  /** 验收标准：写不出来说明该条目还没拆到位 */
  acceptance: z.array(z.string().min(1)).default([]),
  status: NodeStatus.default('draft'),
  origin: NodeOrigin,
  /** 用户对该条目的批注，AI 下一轮必须逐条回应，不得忽略 */
  userNote: z.string().default(''),
  /** 实现路径：本条目依赖的其他节点 id（可跨层级） */
  dependsOn: z.array(Id).default([]),
  /** 层级深度，顶层为 0 */
  depth: z.number().int().min(0),
  /** 同层级内的展示顺序 */
  order: z.number().int(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type RequirementNode = z.infer<typeof RequirementNode>;

/* ------------------------------------------------------------------ */
/* AI 建议                                                             */
/* ------------------------------------------------------------------ */

/**
 * 建议的落点：
 * - refine  改写目标节点的内容（标题 / 说明 / 验收标准），用户采纳后才真正写入
 * - expand  在目标节点下新增一个子需求
 * - remove  删掉目标节点（含它的子树），整树优化时用来清理冗余
 * - move    把目标节点挪到另一个父节点下，并落到指定顺序
 *
 * 建议不进入 nodes，只是画布上的一层「灰字」—— 用户逐条决定要不要。
 */
export const SuggestionAction = z.enum(['refine', 'expand', 'remove', 'move']);
export type SuggestionAction = z.infer<typeof SuggestionAction>;

export const SuggestionStatus = z.enum(['pending', 'accepted', 'ignored']);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

export const NodeSuggestion = z.object({
  id: Id,
  /** refine 时是被改写的节点；expand 时是父节点 */
  nodeId: Id,
  action: SuggestionAction,
  title: z.string().default(''),
  detail: z.string().default(''),
  acceptance: z.array(z.string()).default([]),
  /** move 建议的目标父节点；null 表示挪到根节点下 */
  targetParentId: Id.nullable().default(null),
  /** move 建议落在同级里的第几位（0 起）。null / 越界都当末尾 */
  position: z.number().int().min(0).nullable().default(null),
  /** 为什么这么改 / 补的是什么，画布上用灰字显示 */
  note: z.string().default(''),
  status: SuggestionStatus.default('pending'),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type NodeSuggestion = z.infer<typeof NodeSuggestion>;

/* ------------------------------------------------------------------ */
/* 项目上下文                                                          */
/* ------------------------------------------------------------------ */

/**
 * 主 Agent 上报的项目上下文。主 Agent 最了解项目，由它总结后传入，
 * 工具不做任何扫描猜测，避免引入第二个脑补源。
 */
export const ProjectContext = z.object({
  projectRoot: z.string(),
  projectName: z.string().default(''),
  techStack: z.array(z.string()).default([]),
  /** 精简文件树或关键目录说明 */
  fileTree: z.string().default(''),
  /** 项目约定：可从 CLAUDE.md / AGENTS.md 中提炼 */
  conventions: z.string().default(''),
  /** 与本需求相关的文档或源码路径 */
  relatedPaths: z.array(z.string()).default([]),
  /** 主 Agent 的补充说明（当前进展、已知坑点等） */
  notes: z.string().default(''),
});
export type ProjectContext = z.infer<typeof ProjectContext>;

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

/**
 * 会话状态机：
 *   awaiting-user   → 用户正在编辑 / 裁决（主 Agent 可能正阻塞等待）
 *   awaiting-agent  → 用户已提交，球在主 Agent 这边
 *   completed       → 历史状态：表示生成过规格。不再作为终态，画布依旧可编辑
 *   aborted         → 用户放弃
 */
export const SessionStatus = z.enum([
  'awaiting-user',
  'awaiting-agent',
  'completed',
  'aborted',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: Id,
  rawRequirement: z.string().min(1),
  projectContext: ProjectContext,
  status: SessionStatus,
  /**
   * 轮次游标。每次用户提交（确认 / 追加 / 否决）都会 +1。
   * 主 Agent 用 sinceRound 拉取，保证超时重连时不丢任何一次用户操作。
   */
  round: z.number().int().nonnegative().default(0),
  /**
   * 最后一次用户提交的动作。
   * 服务重启会清空内存里的反馈历史，靠它才能把「用户提交过什么」从磁盘上重算出来。
   */
  lastAction: z.enum(['confirmed', 'need-more', 'abort']).nullish(),
  /**
   * 用户本轮明确要求展开的节点 id（点过「推断分支 / 推断下一个分支 / 继续拆解选中项」）。
   *
   * 这是**新增节点的唯一授权凭据**，每次用户提交整体覆盖，因此天然是一次性的：
   * AI 只能为出现在这里的节点添加子节点，用户没点按钮时它是空数组。
   * 之所以落盘而不是只留在内存里，是因为它必须能扛住服务重启 ——
   * 否则重启后「授权」凭空消失，AI 又会退回靠自觉行事。
   */
  expandTargets: z.array(Id).default([]),
  /**
   * 用户本轮明确要求「AI 补全 / 优化」的节点 id。
   * 与 expandTargets 一样每次提交整体覆盖，一次性有效。
   * 空数组表示用户没有点补全按钮。
   */
  suggestTargets: z.array(Id).default([]),
  /** 允许的最大拆解深度，防止无限递归 */
  maxDepth: z.number().int().min(1).max(6).default(3),
  /**
   * 唯一的根节点 id（画布的标题）。
   *
   * 需求树必须单根：一个画布就是一份需求书，标题只能有一个。
   * 允许为 null 只是为了兼容单根之前的旧会话，新会话一定写入。
   */
  rootId: Id.nullable().default(null),
  nodes: z.array(RequirementNode).default([]),
  /** AI 的补全 / 优化建议。用户逐条采纳或忽略，不采纳就永远不进 nodes */
  suggestions: z.array(NodeSuggestion).default([]),
  /**
   * 最近一次「主 Agent 提交后」的节点快照。
   * 用户提交时用它与当前 nodes 做差分，得到 diff —— 既让主 Agent 少读全量，
   * 也让「AI 的条目被用户改掉多少」这个核心指标可度量。
   */
  baselineNodes: z.array(RequirementNode).default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = z.infer<typeof Session>;

/* ------------------------------------------------------------------ */
/* 用户反馈                                                            */
/* ------------------------------------------------------------------ */

export const NodeChange = z.object({
  id: Id,
  change: z.enum(['added', 'removed', 'modified']),
  /** modified 时，具体变化了哪些字段 */
  fields: z.array(z.string()).default([]),
  before: RequirementNode.partial().nullish(),
  after: RequirementNode.partial().nullish(),
});
export type NodeChange = z.infer<typeof NodeChange>;

/**
 * 回灌给主 Agent 的反馈载荷。
 * 注意：这里给的是「用户视角的实际结果」，而不是用户点了什么按钮 ——
 * 主 Agent 只关心最终需求长什么样、有哪些条目待处理。
 */
export const Feedback = z.object({
  sessionId: Id,
  round: z.number().int().nonnegative(),
  action: z.enum(['confirmed', 'need-more', 'abort']),
  /** 画布唯一的根节点 id（需求书标题） */
  rootId: Id.nullable().default(null),
  /** 用户操作后的全量节点快照（权威版本，主 Agent 应以此为准） */
  nodes: z.array(RequirementNode),
  /** 相对上一轮的差异，便于主 Agent 快速定位变化 */
  diff: z.array(NodeChange),
  /** 用户在自由输入框里补充的话，例如「还要支持移动端」 */
  userFreeText: z.string().default(''),
  /** 用户明确要求继续向下拆解的节点 id */
  expandRequests: z.array(Id).default([]),
  /** 用户明确要求 AI 补全 / 优化的节点 id，用 clarify_suggest 回应 */
  suggestRequests: z.array(Id).default([]),
  /** 仍未裁决的 assumption，主 Agent 必须优先处理而不是继续往下拆 */
  pendingAssumptions: z.array(Id).default([]),
  /** AI 的条目被用户改了多少 —— 直接反映「脑补」的严重程度 */
  aiDraftCorrectionRate: z.number().min(0).max(1).default(0),
});
export type Feedback = z.infer<typeof Feedback>;

/* ------------------------------------------------------------------ */
/* 最终规格                                                            */
/* ------------------------------------------------------------------ */

export const RequirementSpec = z.object({
  sessionId: Id,
  projectName: z.string().default(''),
  rawRequirement: z.string(),
  /** 逐层确认后的需求树，只含 confirmed 条目 */
  nodes: z.array(RequirementNode),
  /** 明确排除的范围，可有效防止后续无意识扩需求 */
  outOfScope: z.array(z.string()).default([]),
  /** 渲染好的 Markdown，主 Agent 可直接作为计划写回上下文 */
  markdown: z.string(),
  generatedAt: Timestamp,
});
export type RequirementSpec = z.infer<typeof RequirementSpec>;
