import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AbortInput,
  AwaitInput,
  FinalizeInput,
  GetSessionInput,
  ListSessionsInput,
  MCP_TOOL_GROUPS,
  StartInput,
  SubmitDecompositionInput,
  ValidateInput,
} from '@clarifyai/shared';
import type { SessionService } from '../core/sessionService.js';
import type { SessionStore } from '../store/sessionStore.js';

export type ToolPreset = 'core' | 'standard' | 'all';

/**
 * 工具分档，参照 claude-task-master 的做法。
 *
 * 工具描述本身会占用主 Agent 的上下文 —— 8 个工具的 schema 加起来是笔不小的开销。
 * 大部分场景只用得上最小闭环，因此默认只加载 standard 档。
 * 通过环境变量 CLARIFY_TOOLS=core|standard|all 切换。
 */
export function resolveToolNames(preset: string): Set<string> {
  const core = MCP_TOOL_GROUPS.core as readonly string[];
  const standard = [...core, ...(MCP_TOOL_GROUPS.standard as readonly string[])];
  const all = [...standard, ...(MCP_TOOL_GROUPS.extra as readonly string[])];

  if (preset === 'core') return new Set(core);
  if (preset === 'all') return new Set(all);
  return new Set(standard);
}

function ok(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `[ERROR] ${message}` }], isError: true };
}

export interface McpDeps {
  service: SessionService;
  store: SessionStore;
  preset: string;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const { service, store } = deps;
  const enabled = resolveToolNames(deps.preset);

  const server = new McpServer({
    name: 'clarifyai',
    version: '0.1.0',
  });

  const has = (name: string): boolean => enabled.has(name);

  /* ---------------------------------------------------------------- */

  if (has('clarify_start')) {
    server.registerTool(
      'clarify_start',
      {
        title: '开启需求澄清会话',
        description:
          '当你拿到一个用户总需求、准备动手前，用本工具把需求显式化。' +
          '传入项目上下文和你对总需求的第一层拆解（1/2/3 条），工具会把结果渲染成可视化画布，' +
          '让用户逐条删改、裁决、补充，从根上避免你脑补出的细节与用户真实意图背道而驰。\n\n' +
          '重要：把你所有「不确定但先这么假设」的条目，kind 标成 assumption —— 用户会专门裁决这些，' +
          '这是本工具最核心的价值。每一条需求都应带 WHEN/THEN 格式的验收标准。\n\n' +
          '调用后请紧接着调用 clarify_await 阻塞等待用户结果。',
        inputSchema: StartInput.shape,
      },
      async (args) => {
        try {
          return ok(await service.start(args));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (has('clarify_await')) {
    server.registerTool(
      'clarify_await',
      {
        title: '阻塞等待用户裁决',
        description:
          '等待用户在画布上删改 / 裁决 / 补充。\n' +
          '返回 status="feedback" → 拿到了用户裁决，按 hint 里的建议行动（通常意味着你要回应批注或继续拆解）。\n' +
          '返回 status="pending" → 等待期间用户没有操作，**用返回的 round 作为 sinceRound 立刻再调一次**继续等。' +
          '重复调用是正常用法而非出错，用户的操作不会因超时丢失。\n' +
          '注意：单次等待受 MCP 宿主的工具调用硬超时限制 —— 默认约 60 秒，' +
          '宿主可以在 mcp.json 里给该 server 配 "timeout" 字段抬高（本次部署已抬到 15 分钟）。' +
          '上限不明确时用 25 秒最保险，超时返回 pending 再调一次即可。',
        inputSchema: AwaitInput.shape,
      },
      async (args) => {
        try {
          return ok(await service.awaitFeedback(args.sessionId, args.sinceRound, args.timeoutMs));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (has('clarify_submit_decomposition')) {
    server.registerTool(
      'clarify_submit_decomposition',
      {
        title: '提交下一层拆解',
        description:
          '把某一层拆解出的子需求提交到画布，交给用户继续裁决。\n\n' +
          'parentId 指定挂载位置：传顶层节点 id 表示向下拆解该节点，传 null 表示补充顶层需求。\n' +
          '如果上一轮返回的 feedback 里有 userNote（用户批注）或 userFreeText（自由补充），' +
          '必须通过 replies 逐条回应，并确保每条批注都得到答复 —— 用户补充的自由文本也要归类到合适位置后回复。\n\n' +
          '返回的 warnings 是软校验提示（缺验收标准、验收标准格式不达标、已达最大深度等），建议逐条处理。\n\n' +
          '粒度提醒：推断子分支时请停在**需求层面**，不要跳到实现细节（例如「用 tsup 打包」「加 bin 字段」）。' +
          '用户要的是「做什么」而不是「怎么实现」—— 实测中这类实现细节会被用户逐条删掉，白占一轮往返。',
        inputSchema: SubmitDecompositionInput.shape,
      },
      async (args) => {
        try {
          return ok(await service.submitDecomposition(args));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (has('clarify_get_session')) {
    server.registerTool(
      'clarify_get_session',
      {
        title: '读取会话当前状态',
        description:
          '非阻塞地读取会话全量节点与状态。用于恢复上下文、或查看用户在你上次提交后改了什么。' +
          '返回里的 pendingAssumptions 是尚未裁决的 AI 假设，应当优先处理。',
        inputSchema: GetSessionInput.shape,
      },
      async (args) => {
        try {
          return ok(await service.getSession(args.sessionId));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (has('clarify_finalize')) {
    server.registerTool(
      'clarify_finalize',
      {
        title: '收口并产出需求规格',
        description:
          '当所有条目都被用户裁决、没有待处理的假设时调用。返回结构化 JSON 规格 + 渲染好的 Markdown，' +
          'markdown 可直接作为你的实现依据写入上下文。\n' +
          '若返回 warnings 非空（例如仍有未裁决的假设），说明还没到收口时机，建议先回到澄清流程。',
        inputSchema: FinalizeInput.shape,
      },
      async (args) => {
        try {
          return ok(await service.finalize(args));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (has('clarify_abort')) {
    server.registerTool(
      'clarify_abort',
      {
        title: '终止澄清会话',
        description: '用户决定不再继续澄清时调用，释放会话资源。',
        inputSchema: AbortInput.shape,
      },
      async (args) => {
        try {
          return ok(await service.abort(args));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (has('clarify_validate')) {
    server.registerTool(
      'clarify_validate',
      {
        title: '需求质量体检',
        description:
          '对当前会话做一次体检：未裁决的假设、缺验收标准的条目、悬空依赖等。' +
          'stats.aiDraftCorrectionRate 是你的初稿被用户改动 / 删除的比例 —— ' +
          '这个数字偏高说明你在脑补，应该把更多条目降级为 assumption 或写得再保守一些。',
        inputSchema: ValidateInput.shape,
      },
      async (args) => {
        try {
          return ok(await service.validate(args.sessionId));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  if (has('clarify_list_sessions')) {
    server.registerTool(
      'clarify_list_sessions',
      {
        title: '列出历史澄清会话',
        description: '找回之前的澄清会话，便于在中断后继续，或参考历史上用户否决过哪些假设。',
        inputSchema: ListSessionsInput.shape,
      },
      async (args) => {
        try {
          const sessions = await store.list();
          return ok({
            sessions: sessions.slice(0, args.limit).map((s) => ({
              sessionId: s.id,
              rawRequirement: s.rawRequirement,
              status: s.status,
              round: s.round,
              updatedAt: s.updatedAt,
            })),
          });
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  return server;
}
