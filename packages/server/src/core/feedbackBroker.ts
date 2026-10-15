import type { Feedback } from '@clarifyai/shared';

interface Waiter {
  sinceRound: number;
  settle: (feedback: Feedback | null) => void;
}

/**
 * 用户反馈的中转站 —— 解决 MCP「服务端无法主动唤醒主 Agent」的根本限制。
 *
 * 核心机制是 **round 游标**：
 * - 每次用户在画布上提交（确认 / 追加 / 否决），会话 round 自增并产生一条 Feedback
 * - 主 Agent 用 `sinceRound` 拉取，凡 round 大于该值的反馈都算新事件
 * - 因此即便 await 超时返回 pending，下次调用依然能拿到这期间发生的**全部**操作，
 *   不会因为超时而丢失用户的任何一次点击
 *
 * 这样主 Agent 侧就退化成一个简单的循环：await → 处理 → submit → await ...
 */
export class FeedbackBroker {
  /** sessionId → 历史反馈（充当 replay 日志，支撑超时重连） */
  private readonly history = new Map<string, Feedback[]>();
  /** sessionId → 正在阻塞等待的主 Agent 调用 */
  private readonly waiters = new Map<string, Set<Waiter>>();

  /** 发布一条用户反馈，唤醒所有在等的调用方 */
  publish(feedback: Feedback): void {
    const list = this.history.get(feedback.sessionId) ?? [];
    list.push(feedback);
    this.history.set(feedback.sessionId, list);

    const pending = this.waiters.get(feedback.sessionId);
    if (!pending) return;

    // settle 内部会把自己从集合里摘掉，这里先拷贝一份避免边遍历边改
    for (const waiter of [...pending]) {
      if (feedback.round > waiter.sinceRound) waiter.settle(feedback);
    }
  }

  /** 回放：取出第一条 round 大于游标的反馈 */
  private replay(sessionId: string, sinceRound: number): Feedback | null {
    const list = this.history.get(sessionId);
    if (!list) return null;
    return list.find((f) => f.round > sinceRound) ?? null;
  }

  /**
   * 等待用户操作。
   * @returns 拿到反馈则返回 Feedback；超时返回 null（调用方应再次调用，带着已有 round 作游标）
   */
  waitFor(sessionId: string, sinceRound: number, timeoutMs: number): Promise<Feedback | null> {
    // 先尝试回放：用户可能在主 Agent 还没开始等之前就已经点了确认
    const replayed = this.replay(sessionId, sinceRound);
    if (replayed) return Promise.resolve(replayed);

    return new Promise<Feedback | null>((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set<Waiter>();
      this.waiters.set(sessionId, set);

      let timer: NodeJS.Timeout | undefined;

      const settle = (feedback: Feedback | null): void => {
        if (timer) clearTimeout(timer);
        set.delete(waiter);
        // 只有当这个集合已经没人等，且它仍然是当前注册的那个时才清理，
        // 否则会误删后续新注册的等待集合
        if (set.size === 0 && this.waiters.get(sessionId) === set) {
          this.waiters.delete(sessionId);
        }
        resolve(feedback);
      };

      const waiter: Waiter = { sinceRound, settle };
      set.add(waiter);
      timer = setTimeout(() => settle(null), timeoutMs);
    });
  }

  /** 会话结束（完成 / 放弃）时释放历史，避免内存无限增长 */
  dispose(sessionId: string): void {
    this.history.delete(sessionId);
    const pending = this.waiters.get(sessionId);
    if (!pending) return;
    for (const waiter of [...pending]) waiter.settle(null);
  }

  /** 当前是否有主 Agent 正在阻塞等待该会话 */
  isWaiting(sessionId: string): boolean {
    return (this.waiters.get(sessionId)?.size ?? 0) > 0;
  }
}
