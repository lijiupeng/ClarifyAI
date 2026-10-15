import type { Feedback, RequirementNode, Session } from '@clarifyai/shared';

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
  body: { action: 'confirmed' | 'need-more' | 'abort'; userFreeText?: string; expandRequests?: string[] },
): Promise<{ feedback: Feedback }> {
  return request(`/sessions/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function fetchSpec(id: string): Promise<{ markdown: string }> {
  return request(`/sessions/${encodeURIComponent(id)}/spec`);
}
