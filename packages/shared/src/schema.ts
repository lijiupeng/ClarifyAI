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

/** 条目的裁决状态。只有 confirmed 的条目才会进入最终规格。 */
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
 *   completed       → 已产出最终规格
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
  /** 允许的最大拆解深度，防止无限递归 */
  maxDepth: z.number().int().min(1).max(6).default(3),
  nodes: z.array(RequirementNode).default([]),
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
  /** 用户操作后的全量节点快照（权威版本，主 Agent 应以此为准） */
  nodes: z.array(RequirementNode),
  /** 相对上一轮的差异，便于主 Agent 快速定位变化 */
  diff: z.array(NodeChange),
  /** 用户在自由输入框里补充的话，例如「还要支持移动端」 */
  userFreeText: z.string().default(''),
  /** 用户明确要求继续向下拆解的节点 id */
  expandRequests: z.array(Id).default([]),
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
