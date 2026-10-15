import fs from 'node:fs/promises';
import path from 'node:path';
import { Session } from '@clarifyai/shared';

const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * 会话持久化。
 *
 * 刻意选择纯 JSON 文件而非数据库：
 * - 数据量极小（一次澄清通常几十个节点），文件足够
 * - 零原生依赖，跨平台无编译烦恼
 * - 数据是透明的，用户可以直接打开看 / 做 diff / 丢进版本库，
 *   这与「数据流统一使用 JSON」的整体设计保持一致
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private fileOf(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`非法的会话 id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** 原子写入：先写临时文件再 rename，避免进程崩溃时留下半个文件 */
  async save(session: Session): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.fileOf(session.id);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  async load(id: string): Promise<Session | null> {
    try {
      const raw = await fs.readFile(this.fileOf(id), 'utf8');
      return Session.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** 列出所有会话的摘要，按最近更新倒序 —— 供画布首页选择历史会话 */
  async list(): Promise<Array<Pick<Session, 'id' | 'rawRequirement' | 'status' | 'round' | 'createdAt' | 'updatedAt'>>> {
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    const sessions: Session[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const session = await this.load(entry.slice(0, -'.json'.length)).catch(() => null);
      if (session) sessions.push(session);
    }

    return sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, rawRequirement, status, round, createdAt, updatedAt }) => ({
        id,
        rawRequirement,
        status,
        round,
        createdAt,
        updatedAt,
      }));
  }
}
