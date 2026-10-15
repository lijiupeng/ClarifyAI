import { ClientEvent, ServerEvent } from '@clarifyai/shared';
import type { Session, SessionPatchedPayload } from '@clarifyai/shared';

export interface RealtimeHandlers {
  onSnapshot: (session: Session) => void;
  onPatched: (payload: SessionPatchedPayload) => void;
  onAgentBusy: (payload: { busy: boolean; message: string }) => void;
  onClosed: (payload: { status: 'completed' | 'aborted'; message: string }) => void;
  onStatusChange: (status: 'connecting' | 'online' | 'offline') => void;
}

/**
 * 订阅会话的实时更新。
 *
 * 没有它，主 Agent 通过 MCP 提交的新拆解就只能靠轮询才出现在画布上 ——
 * 那样「AI 拆完 → 用户立刻看到」的体验就断了。
 *
 * @returns 取消订阅并关闭连接的函数
 */
export function connectRealtime(sessionId: string, handlers: RealtimeHandlers): () => void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  let heartbeat: number | undefined;
  let closedByUs = false;

  socket.addEventListener('open', () => {
    handlers.onStatusChange('online');
    socket.send(JSON.stringify({ event: ClientEvent.SUBSCRIBE, payload: { sessionId } }));
    heartbeat = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: ClientEvent.PING, payload: {} }));
      }
    }, 25_000);
  });

  socket.addEventListener('message', (event) => {
    let envelope: { event?: string; payload?: unknown };
    try {
      envelope = JSON.parse(String(event.data)) as { event?: string; payload?: unknown };
    } catch {
      return;
    }

    switch (envelope.event) {
      case ServerEvent.SNAPSHOT:
        handlers.onSnapshot((envelope.payload as { session: Session }).session);
        break;
      case ServerEvent.PATCHED:
        handlers.onPatched(envelope.payload as SessionPatchedPayload);
        break;
      case ServerEvent.AGENT_BUSY:
        handlers.onAgentBusy(envelope.payload as { busy: boolean; message: string });
        break;
      case ServerEvent.CLOSED:
        handlers.onClosed(envelope.payload as { status: 'completed' | 'aborted'; message: string });
        break;
      default:
        break;
    }
  });

  socket.addEventListener('close', () => {
    if (heartbeat) window.clearInterval(heartbeat);
    handlers.onStatusChange('offline');
  });

  socket.addEventListener('error', () => {
    if (!closedByUs) handlers.onStatusChange('offline');
  });

  return () => {
    closedByUs = true;
    if (heartbeat) window.clearInterval(heartbeat);
    socket.close();
  };
}
