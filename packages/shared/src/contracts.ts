/**
 * MCP 工具契约。
 *
 * 这些 schema 有两个消费者：
 * 1. 后端 MCP server —— 用来向主 Agent 声明工具的 inputSchema
 * 2. 后端核心逻辑 —— 用来校验主 Agent 的入参并推导 TypeScript 类型
 *
 * 设计参照：验收标准采用 OpenSpec 的 WHEN/THEN 句式（消除解读空间），
 * 工具分档加载参照 claude-task-master（避免工具描述本身吃掉大量上下文）。
 */
import { z } from 'zod';
import { Feedback, NodeKind, ProjectContext, RequirementNode, RequirementSpec, SessionStatus } from './schema.js';

const Id = z.string().min(1);

/* ------------------------------------------------------------------ */
/* 拆解条目 —— 主 Agent 产出需求的最小单元                              */
/* ------------------------------------------------------------------ */

export const DecompositionItem = z
  .object({
    key: z.string().min(1).describe('本批次内的临时引用键（如 "a1"），仅用于 dependsOnKeys 内部引用'),
    title: z.string().min(1).describe('一句话需求，需能脱离上下文独立看懂'),
    detail: z.string().default('').describe('补充说明、边界条件、异常分支'),
    kind: NodeKind.default('functional'),
    acceptance: z
      .array(z.string().min(1))
      .default([])
      .describe(
        '验收标准。每条写成「WHEN <前置条件> THEN <可观测结果>」，例如 ' +
          '"WHEN 用户提交空表单 THEN 显示红色错误提示且不发起请求"。' +
          '写不出验收标准说明该条目还没拆到位，或本身就是模糊的；assumption 类型可留空',
      ),
    dependsOnKeys: z.array(z.string()).default([]).describe('依赖本批次内其他条目的 key，用于表达实现顺序'),
    userNoteRef: z
      .string()
      .default('')
      .describe('若本条是在回应用户批注，在此注明对应节点 id，便于用户核对'),
  })
  .describe('一条被拆解出来的需求条目');

export type DecompositionItem = z.infer<typeof DecompositionItem>;

/* ------------------------------------------------------------------ */
/* 1. clarify_start —— 开启一次需求澄清会话                             */
/* ------------------------------------------------------------------ */

export const StartInput = z.object({
  projectContext: ProjectContext.describe('项目上下文。由你（主 Agent）总结后传入，工具不做扫描猜测'),
  rawRequirement: z.string().min(1).describe('用户原始总需求，保留原话，不要改写'),
  decomposition: z
    .array(DecompositionItem)
    .min(1)
    .describe('你对总需求的第一层拆解。工具会把它渲染成可编辑画布交给用户逐条裁决'),
  maxDepth: z.number().int().min(1).max(6).default(3).describe('允许的最大拆解深度，防止无限递归'),
  openUi: z.boolean().default(true).describe('是否自动在浏览器打开画布'),
  interactionMode: z
    .enum(['canvas', 'auto'])
    .default('canvas')
    .describe(
      'canvas=始终打开可视化画布（当前唯一实现）。' +
        'auto=预留：条目少时改走 MCP elicitation 原生对话框，不打开浏览器（依赖客户端支持，暂未启用）',
    ),
});
export type StartInput = z.infer<typeof StartInput>;

export const StartOutput = z.object({
  sessionId: Id,
  uiUrl: z.string().describe('画布地址，可直接引导用户打开'),
  round: z.number().int(),
  status: SessionStatus,
  message: z.string().describe('给主 Agent 看的状态摘要'),
});
export type StartOutput = z.infer<typeof StartOutput>;

/* ------------------------------------------------------------------ */
/* 2. clarify_await —— 阻塞等待用户裁决                                 */
/* ------------------------------------------------------------------ */

export const AwaitInput = z.object({
  sessionId: Id,
  sinceRound: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('只关心大于该轮次的用户操作。超时重连时传上一次返回的 round，保证不丢事件'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(300000)
    .default(25_000)
    .describe(
      '单次阻塞上限（毫秒）。注意：MCP 宿主对工具调用通常有约 60 秒的超时，设太大请求会被宿主直接掐断（实测 120 秒必然被拦）。' +
        '保持默认即可，超时返回 pending 后再调一次，用户操作不会丢失',
    ),
});
export type AwaitInput = z.infer<typeof AwaitInput>;

export const AwaitOutput = z.object({
  status: z
    .enum(['feedback', 'pending', 'completed', 'aborted'])
    .describe('feedback=拿到用户裁决；pending=超时前无操作，请重调；completed=已产出规格；aborted=用户放弃'),
  sessionId: Id,
  round: z.number().int().describe('当前轮次游标，下次调用请原样回传为 sinceRound'),
  waitedMs: z.number().int(),
  feedback: Feedback.nullish().describe('status=feedback 时存在'),
  hint: z.string().describe('针对当前状态的自然语言行动建议，例如「用户否决了 3 条假设，请重新拆解」'),
});
export type AwaitOutput = z.infer<typeof AwaitOutput>;

/* ------------------------------------------------------------------ */
/* 3. clarify_submit_decomposition —— 提交下一层拆解                    */
/* ------------------------------------------------------------------ */

export const SubmitDecompositionInput = z.object({
  sessionId: Id,
  parentId: Id.nullable().describe('拆解结果挂载到哪个节点下；传 null 表示补充顶层需求'),
  items: z.array(DecompositionItem).min(1),
  agentNote: z
    .string()
    .default('')
    .describe('本轮拆解的说明，会显示在画布上让用户理解你的思路（例如「按数据流向拆成三层」）'),
  replies: z
    .array(
      z.object({
        nodeId: Id,
        reply: z.string().min(1),
      }),
    )
    .default([])
    .describe('对用户 userNote 的逐条回应。用户的每一条批注都必须得到回应，不得静默忽略'),
});
export type SubmitDecompositionInput = z.infer<typeof SubmitDecompositionInput>;

export const SubmitDecompositionOutput = z.object({
  sessionId: Id,
  round: z.number().int().describe('提交后的轮次；后续 clarify_await 需用此值作为 sinceRound 起点'),
  created: z.array(RequirementNode).describe('实际创建的节点，含服务端分配的 id'),
  warnings: z.array(z.string()).default([]).describe('软校验提示，例如「3 条功能需求缺少验收标准」'),
});
export type SubmitDecompositionOutput = z.infer<typeof SubmitDecompositionOutput>;

/* ------------------------------------------------------------------ */
/* 4. clarify_get_session —— 非阻塞读取当前状态                         */
/* ------------------------------------------------------------------ */

export const GetSessionInput = z.object({
  sessionId: Id,
});
export type GetSessionInput = z.infer<typeof GetSessionInput>;

export const GetSessionOutput = z.object({
  sessionId: Id,
  status: SessionStatus,
  round: z.number().int(),
  projectContext: ProjectContext,
  rawRequirement: z.string(),
  nodes: z.array(RequirementNode),
  pendingAssumptions: z.array(RequirementNode).describe('尚未裁决的 AI 假设，必须优先处理'),
});
export type GetSessionOutput = z.infer<typeof GetSessionOutput>;

/* ------------------------------------------------------------------ */
/* 5. clarify_finalize —— 收口产出最终规格                              */
/* ------------------------------------------------------------------ */

export const FinalizeInput = z.object({
  sessionId: Id,
  implementationPlan: z.string().default('').describe('可选的实现路径说明，会一并写入规格文档'),
});
export type FinalizeInput = z.infer<typeof FinalizeInput>;

export const FinalizeOutput = z.object({
  sessionId: Id,
  spec: RequirementSpec,
  warnings: z
    .array(z.string())
    .default([])
    .describe('未裁决的 assumption、缺验收标准的条目等。存在 warning 时建议先回到澄清流程'),
});
export type FinalizeOutput = z.infer<typeof FinalizeOutput>;

/* ------------------------------------------------------------------ */
/* 6. clarify_abort                                                     */
/* ------------------------------------------------------------------ */

export const AbortInput = z.object({
  sessionId: Id,
  reason: z.string().default(''),
});
export type AbortInput = z.infer<typeof AbortInput>;

export const AbortOutput = z.object({
  sessionId: Id,
  status: SessionStatus,
});
export type AbortOutput = z.infer<typeof AbortOutput>;

/* ------------------------------------------------------------------ */
/* 7. clarify_validate —— 质量体检（diagnostic 档）                     */
/* ------------------------------------------------------------------ */

export const ValidateInput = z.object({
  sessionId: Id,
});
export type ValidateInput = z.infer<typeof ValidateInput>;

export const ValidateOutput = z.object({
  sessionId: Id,
  ok: z.boolean(),
  issues: z.array(
    z.object({
      level: z.enum(['error', 'warning']),
      nodeId: Id.nullish(),
      message: z.string(),
    }),
  ),
  stats: z.object({
    total: z.number().int(),
    confirmed: z.number().int(),
    draftAssumptions: z.number().int(),
    missingAcceptance: z.number().int(),
    /** AI 初稿被用户改动 / 删除的比例，直接量化「脑补」的严重程度 */
    aiDraftCorrectionRate: z.number(),
  }),
});
export type ValidateOutput = z.infer<typeof ValidateOutput>;

/* ------------------------------------------------------------------ */
/* 8. clarify_list_sessions —— 找回历史会话（diagnostic 档）            */
/* ------------------------------------------------------------------ */

export const ListSessionsInput = z.object({
  limit: z.number().int().min(1).max(50).default(10),
});
export type ListSessionsInput = z.infer<typeof ListSessionsInput>;

export const ListSessionsOutput = z.object({
  sessions: z.array(
    z.object({
      sessionId: Id,
      rawRequirement: z.string(),
      status: SessionStatus,
      round: z.number().int(),
      updatedAt: z.number().int(),
    }),
  ),
});
export type ListSessionsOutput = z.infer<typeof ListSessionsOutput>;

/* ------------------------------------------------------------------ */
/* 工具分档 —— 按需加载，避免工具描述挤占上下文                          */
/* ------------------------------------------------------------------ */

export const MCP_TOOL_GROUPS = {
  /** 最小闭环：开启 → 阻塞等待 → 提交拆解 → 查询状态 */
  core: ['clarify_start', 'clarify_await', 'clarify_submit_decomposition', 'clarify_get_session'],
  /** 完整流程：收口与终止 */
  standard: ['clarify_finalize', 'clarify_abort'],
  /** 诊断工具：体检与找回历史会话 */
  extra: ['clarify_validate', 'clarify_list_sessions'],
} as const;

export type McpToolGroup = keyof typeof MCP_TOOL_GROUPS;
