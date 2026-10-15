/**
 * WebSocket 事件协议。
 *
 * 画布与后端之间需要双向实时同步，因为会话可能被两个方向同时改写：
 * - 主 Agent 通过 MCP 提交新一轮拆解 → 服务端推给画布
 * - 用户在画布上编辑 / 裁决     → 服务端广播并唤醒阻塞中的主 Agent
 */
import { z } from 'zod';
import { RequirementNode, Session, SessionStatus } from './schema.js';

/* ---------------------------- 服务端 → 客户端 ---------------------------- */

export const ServerEvent = {
  /** 全量快照：首次连接、或发生结构性变化时下发 */
  SNAPSHOT: 'session.snapshot',
  /** 增量补丁：节点被增删改，画布局部更新 */
  PATCHED: 'session.patched',
  /** 主 Agent 正在处理，画布进入只读态并显示进度 */
  AGENT_BUSY: 'agent.busy',
  /** 主 Agent 提交了新一轮拆解，画布需要刷新并提示用户 */
  AGENT_SUBMITTED: 'agent.submitted',
  /** 会话结束 */
  CLOSED: 'session.closed',
  /** 错误 */
  ERROR: 'error',
} as const;

export type ServerEventName = (typeof ServerEvent)[keyof typeof ServerEvent];

export const SessionSnapshotPayload = z.object({
  session: Session,
});
export type SessionSnapshotPayload = z.infer<typeof SessionSnapshotPayload>;

export const SessionPatchedPayload = z.object({
  sessionId: z.string(),
  round: z.number().int(),
  /**
   * 变更后的会话状态。
   *
   * 必须带上：AI 提交新一轮拆解时状态会从 awaiting-agent 变回 awaiting-user，
   * 而节点增删和状态变化是两件事 —— 只推节点的话，画布会「看得到新分支、
   * 但按钮一直灰着」，因为 editable 判定的是状态而不是节点。
   */
  status: SessionStatus,
  upserted: z.array(RequirementNode).default([]),
  removedIds: z.array(z.string()).default([]),
  /** 本轮拆解思路说明 */
  agentNote: z.string().default(''),
});
export type SessionPatchedPayload = z.infer<typeof SessionPatchedPayload>;

export const AgentBusyPayload = z.object({
  sessionId: z.string(),
  busy: z.boolean(),
  /** 同 SessionPatchedPayload.status：交回控制权时会只改状态、不动节点，必须一并同步 */
  status: SessionStatus,
  message: z.string().default(''),
});
export type AgentBusyPayload = z.infer<typeof AgentBusyPayload>;

export const ClosedPayload = z.object({
  sessionId: z.string(),
  status: z.enum(['completed', 'aborted']),
  message: z.string().default(''),
});
export type ClosedPayload = z.infer<typeof ClosedPayload>;

/* ---------------------------- 客户端 → 服务端 ---------------------------- */

export const ClientEvent = {
  /** 订阅某个会话，立即收到一次 SNAPSHOT */
  SUBSCRIBE: 'session.subscribe',
  UNSUBSCRIBE: 'session.unsubscribe',
  /** 心跳 */
  PING: 'ping',
} as const;

export type ClientEventName = (typeof ClientEvent)[keyof typeof ClientEvent];

export const SubscribePayload = z.object({
  sessionId: z.string().min(1),
});
export type SubscribePayload = z.infer<typeof SubscribePayload>;

/** 统一的事件信封，便于扩展与调试 */
export const WsEnvelope = z.object({
  event: z.string(),
  payload: z.unknown(),
  ts: z.number().int(),
});
export type WsEnvelope = z.infer<typeof WsEnvelope>;
