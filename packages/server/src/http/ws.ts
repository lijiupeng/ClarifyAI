import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientEvent, ServerEvent, WsEnvelope } from '@clarifyai/shared';
import type { SessionStore } from '../store/sessionStore.js';

/**
 * 画布与后端之间的实时通道。
 *
 * 存在的理由：会话会被两个方向同时改写 ——
 * 主 Agent 通过 MCP 提交新拆解时，画布必须立刻刷新；
 * 用户在画布上编辑时，服务端要广播给其他标签页。
 * 纯 HTTP 轮询做不到「主 Agent 提交后画布立即反应」。
 */
export class RealtimeHub {
  private readonly subscriptions = new Map<string, Set<WebSocket>>();

  constructor(private readonly store: SessionStore) {}

  attach(server: HttpServer): void {
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        void this.handleMessage(socket, raw.toString());
      });

      socket.on('close', () => {
        for (const [sessionId, sockets] of this.subscriptions) {
          sockets.delete(socket);
          if (sockets.size === 0) this.subscriptions.delete(sessionId);
        }
      });
    });
  }

  /** 作为 SessionService 的 emit 回调接入 */
  emit(sessionId: string, event: string, payload: unknown): void {
    const sockets = this.subscriptions.get(sessionId);
    if (!sockets || sockets.size === 0) return;

    const data = JSON.stringify({ event, payload, ts: Date.now() } satisfies WsEnvelope);

    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: { event?: string; payload?: unknown };
    try {
      parsed = JSON.parse(raw) as { event?: string; payload?: unknown };
    } catch {
      return;
    }

    const sessionId = (parsed.payload as { sessionId?: string } | undefined)?.sessionId;

    if (parsed.event === ClientEvent.PING) {
      this.send(socket, 'pong', {});
      return;
    }

    if (parsed.event === ClientEvent.SUBSCRIBE) {
      if (typeof sessionId !== 'string' || !sessionId) return;

      const set = this.subscriptions.get(sessionId) ?? new Set<WebSocket>();
      set.add(socket);
      this.subscriptions.set(sessionId, set);

      // 订阅即回灌一次完整快照，画布不必再发一次 HTTP 请求
      try {
        const session = await this.store.load(sessionId);
        if (!session) throw new Error(`会话不存在: ${sessionId}`);
        this.send(socket, ServerEvent.SNAPSHOT, { session });
      } catch (error) {
        this.send(socket, ServerEvent.ERROR, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (parsed.event === ClientEvent.UNSUBSCRIBE) {
      if (typeof sessionId !== 'string') return;
      const set = this.subscriptions.get(sessionId);
      if (!set) return;
      set.delete(socket);
      if (set.size === 0) this.subscriptions.delete(sessionId);
    }
  }

  private send(socket: WebSocket, event: string, payload: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ event, payload, ts: Date.now() } satisfies WsEnvelope));
  }
}
