import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SessionService } from '../core/sessionService.js';
import type { SessionStore } from '../store/sessionStore.js';
import { createMcpServer } from './server.js';

export interface McpHttpDeps {
  service: SessionService;
  store: SessionStore;
  preset: string;
  path?: string;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: null;
}

function rpcError(code: number, message: string): JsonRpcError {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** 只认 initialize 请求才新建会话，避免任意请求都能开出会话 */
function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { method?: unknown }).method === 'initialize'
  );
}

function headerSessionId(req: Request): string | undefined {
  const value = req.headers['mcp-session-id'];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * 把 MCP server 挂到 HTTP 上（Streamable HTTP 传输）。
 *
 * 相比 stdio 传输，这里的服务是常驻的 —— 主 Agent 没连上时，画布照样能访问；
 * 主 Agent 退出后，会话与画布也不受影响。对「MCP 驱动 + 人工在网页上裁决」
 * 这种双出口的工具，这才是更自然的形态。
 *
 * 传输层用有状态模式：每个客户端会话对应一个 transport 实例，
 * 但底下的 SessionService / 存储是共享的，所以主 Agent 与画布看到的是同一份数据。
 */
export function mountMcpHttp(app: Express, deps: McpHttpDeps): void {
  const routePath = deps.path ?? '/mcp';
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post(routePath, async (req: Request, res: Response) => {
    try {
      const sessionId = headerSessionId(req);
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (transport) transports.set(id, transport);
          },
        });

        transport.onclose = () => {
          const id = transport?.sessionId;
          if (id) transports.delete(id);
        };

        // 每条 MCP 连接一个 server 实例，但它们共享同一个 SessionService
        await createMcpServer({ service: deps.service, store: deps.store, preset: deps.preset }).connect(
          transport,
        );
      }

      if (!transport) {
        res.status(400).json(rpcError(-32000, '缺少有效的 mcp-session-id，请先发送 initialize 请求'));
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json(rpcError(-32603, error instanceof Error ? error.message : String(error)));
      }
    }
  });

  // GET（SSE 长连接）与 DELETE（结束会话）都要求带上已初始化的会话 id
  const sessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = headerSessionId(req);
    const transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      res.status(404).json(rpcError(-32001, '会话不存在或已关闭'));
      return;
    }

    await transport.handleRequest(req, res);
  };

  app.get(routePath, sessionRequest);
  app.delete(routePath, sessionRequest);
}
