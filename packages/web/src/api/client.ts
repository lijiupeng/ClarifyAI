import type { Feedback, NodeSuggestion, RequirementNode, Session } from '@clarifyai/shared';

/** 开发态经 Vite 代理同源；生产态由后端静态托管，同样是同源 */
const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败（${response.status}）`);
  }

  return (await response.json()) as T;
}

export type SessionSummary = Pick<
  Session,
  'id' | 'rawRequirement' | 'status' | 'round' | 'createdAt' | 'updatedAt'
>;

export function fetchSessions(): Promise<{ sessions: SessionSummary[] }> {
  return request('/sessions');
}

export function fetchSession(id: string): Promise<{ session: Session }> {
  return request(`/sessions/${encodeURIComponent(id)}`);
}

/** 删除一次澄清记录（会话文件会被直接删除，不可恢复） */
export function deleteSession(id: string): Promise<{ ok: boolean }> {
  return request(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 画布上的即时编辑。不推进轮次，因此不会唤醒主 Agent */
export function patchNodes(
  id: string,
  upserted: RequirementNode[],
  removedIds: string[],
): Promise<{ session: Session }> {
  return request(`/sessions/${encodeURIComponent(id)}/nodes`, {
    method: 'PATCH',
    body: JSON.stringify({ upserted, removedIds }),
  });
}

/** 用户点击「确认本轮 / 继续拆 / 放弃」—— 这一步才真正把结果回灌给主 Agent */
export function submitFeedback(
  id: string,
  body: {
    action: 'confirmed' | 'need-more' | 'abort';
    userFreeText?: string;
    expandRequests?: string[];
    suggestRequests?: string[];
  },
): Promise<{ feedback: Feedback }> {
  return request(`/sessions/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** 裁决一条 AI 建议：采纳才写入需求树 */
export function resolveSuggestion(
  id: string,
  suggestionId: string,
  accept: boolean,
): Promise<{
  suggestion: NodeSuggestion;
  upserted: RequirementNode[];
  removedIds: string[];
  session: Session;
}> {
  return request(`/sessions/${encodeURIComponent(id)}/suggestions/${encodeURIComponent(suggestionId)}`, {
    method: 'POST',
    body: JSON.stringify({ accept }),
  });
}
