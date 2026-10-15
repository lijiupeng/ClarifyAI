import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { NodeKind, NodeStatus } from '@clarifyai/shared';
import type { RequirementNode } from '@clarifyai/shared';
import type { SessionService } from '../core/sessionService.js';
import type { SessionStore } from '../store/sessionStore.js';
import type { ServerConfig } from '../config.js';
import { renderSpecMarkdown } from '../core/specRender.js';
import { mountMcpHttp } from '../mcp/httpTransport.js';

/**
 * 画布传来的节点是「用户视角」的：只有内容字段，没有服务端维护的元数据。
 * 因此这里用宽松 schema，由 SessionService 补齐 sessionId / 时间戳。
 */
const CanvasNodeInput = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable().default(null),
  title: z.string().min(1),
  detail: z.string().default(''),
  kind: NodeKind.default('functional'),
  acceptance: z.array(z.string()).default([]),
  status: NodeStatus.default('draft'),
  origin: z.enum(['ai', 'user']).default('user'),
  userNote: z.string().default(''),
  dependsOn: z.array(z.string()).default([]),
  depth: z.number().int().min(0).default(0),
  order: z.number().int().default(0),
});

const PatchBody = z.object({
  upserted: z.array(CanvasNodeInput).default([]),
  removedIds: z.array(z.string()).default([]),
});

const FeedbackBody = z.object({
  action: z.enum(['confirmed', 'need-more', 'abort']),
  userFreeText: z.string().default(''),
  expandRequests: z.array(z.string()).default([]),
});

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Express 4 不会捕获 async handler 抛出的异常，统一包一层 */
function wrap(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

export interface AppDeps {
  service: SessionService;
  store: SessionStore;
  config: ServerConfig;
  /** 是否把 MCP 也挂到 HTTP 上（两种传输可同时存在） */
  mountMcp?: boolean;
  /** MCP 工具档位，透传给工具注册 */
  toolPreset?: string;
}

export function createApp(deps: AppDeps): express.Express {
  const { service, store, config } = deps;
  const app = express();

  app.use(express.json({ limit: '8mb' }));

  // 开发态前端跑在 Vite（5173）、后端在 4317，需要放行跨域。
  // 手写这几行是为了不引入 cors 依赖，且只放行已知来源。
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.webOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    // MCP over HTTP 会带自定义头，一并放行，否则浏览器型客户端会被预检拦下
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: config.mode, dataDir: config.dataDir });
  });

  app.get(
    '/api/sessions',
    wrap(async (_req, res) => {
      res.json({ sessions: await store.list() });
    }),
  );

  app.get(
    '/api/sessions/:id',
    wrap(async (req, res) => {
      const session = await store.load(req.params.id ?? '');
      if (!session) {
        res.status(404).json({ error: '会话不存在' });
        return;
      }
      res.json({ session });
    }),
  );

  /** 规格预览：随时可看当前确认结果长什么样，不改动会话状态 */
  app.get(
    '/api/sessions/:id/spec',
    wrap(async (req, res) => {
      const session = await store.load(req.params.id ?? '');
      if (!session) {
        res.status(404).json({ error: '会话不存在' });
        return;
      }
      const confirmed = session.nodes.filter((n) => n.status === 'confirmed' && n.kind !== 'out-of-scope');
      res.json({ markdown: renderSpecMarkdown(session, confirmed, '') });
    }),
  );

  /** 画布上的即时编辑：不推进轮次，不会唤醒主 Agent */
  app.patch(
    '/api/sessions/:id/nodes',
    wrap(async (req, res) => {
      const sessionId = req.params.id ?? '';
      const body = PatchBody.parse(req.body);
      const now = Date.now();

      const upserted: RequirementNode[] = body.upserted.map((node) => ({
        ...node,
        sessionId,
        createdAt: now,
        updatedAt: now,
      }));

      const session = await service.applyCanvasPatch(sessionId, {
        upserted,
        removedIds: body.removedIds,
      });
      res.json({ session });
    }),
  );

  /** 用户点击「确认本轮 / 继续拆 / 放弃」—— 这一步才真正回灌主 Agent */
  app.post(
    '/api/sessions/:id/feedback',
    wrap(async (req, res) => {
      const sessionId = req.params.id ?? '';
      const body = FeedbackBody.parse(req.body);
      const feedback = await service.submitCanvasFeedback(sessionId, body);
      res.json({ feedback });
    }),
  );

  // 单进程模式：前端构建产物存在就地托管，HTTP 模式下不必再单独跑 Vite。
  // 注意 SPA fallback 要避开 /api 与 /mcp，否则它们的 404 会被吞成 index.html。
  const indexHtml = path.join(config.webDistDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.webDistDir));
    app.get(/^(?!\/(api|mcp)\b).*/, (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  // MCP over HTTP 挂在这个位置是有讲究的：
  // 必须在 express.json() 之后（需要已解析的 body），且在错误处理中间件之前
  // （否则它内部抛出的异常没有兜底）。
  if (deps.mountMcp) {
    mountMcpHttp(app, {
      service,
      store,
      preset: deps.toolPreset ?? 'standard',
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: '参数校验失败', issues: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const notFound = message.includes('不存在');
    res.status(notFound ? 404 : 500).json({ error: message });
  });

  return app;
}
