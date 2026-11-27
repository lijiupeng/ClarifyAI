import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/** 运行模式：mcp=仅作为主 Agent 的子进程；http=独立常驻；both=开发时同时提供（推荐） */
export type RunMode = 'mcp' | 'http' | 'both';

export interface ServerConfig {
  mode: RunMode;
  host: string;
  httpPort: number;
  /** 会话持久化目录，存放纯 JSON 文件，便于直接查看与版本对比 */
  dataDir: string;
  /** 前端开发服务器地址；生产模式下回落到静态托管 */
  webOrigin: string;
  /** 前端构建产物目录。存在时由后端直接托管，HTTP 模式下就不必再单独跑 Vite */
  webDistDir: string;
  /**
   * 单次 clarify_await 允许阻塞的上限（毫秒），默认 10 分钟（与契约上限一致）。
   *
   * 默认不额外收缩，让调用方传的 timeoutMs 真正生效；宿主若对工具调用设了更小的硬超时，
   * 用 --max-block-ms 把封顶压到它以下，避免整次调用被掐断。
   */
  maxBlockMs: number;
  autoOpenBrowser: boolean;
  /**
   * 开发态：即使本地存在前端构建产物，也把画布地址指向 Vite（5173）。
   * 否则 build 过一次之后，MCP 返回的 uiUrl 会指向 4317 上的旧快照，
   * 用户改完前端却看到老页面。
   */
  devUi: boolean;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = argv.indexOf(`--${name}`);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

/**
 * 前端产物可能落在这两个位置：
 * - 打包形态：dist/index.js 旁边的 dist/web（随 npm 包一起分发）
 * - 开发形态：packages/server/src → packages/web/dist
 * 不知道自己在哪种形态里，就都探一遍。
 */
function resolveDefaultWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const bundled = path.resolve(here, 'web');
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled;

  return path.resolve(here, '../../web/dist');
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2)): ServerConfig {
  const mode = (readFlag(argv, 'mode') ?? process.env.CLARIFY_MODE ?? 'both') as RunMode;
  const port = Number(readFlag(argv, 'port') ?? process.env.CLARIFY_PORT ?? 4317);
  // 默认与契约上限一致（10 分钟），不额外收缩。
  // 只有宿主自己的工具调用超时比这更小时，才需要压到它以下 ——
  // 让服务端自己提前返回 pending，而不是被宿主把请求掐断。
  const maxBlock = Number(readFlag(argv, 'max-block-ms') ?? process.env.CLARIFY_MAX_BLOCK_MS ?? 600_000);

  const dataDir =
    readFlag(argv, 'data-dir') ??
    process.env.CLARIFY_DATA_DIR ??
    // 放在用户目录而非项目目录：会话是「人与 AI 的沟通过程」，不属于某个代码仓库
    path.join(os.homedir(), '.clarifyai', 'sessions');

  return {
    mode: ['mcp', 'http', 'both'].includes(mode) ? mode : 'both',
    host: readFlag(argv, 'host') ?? process.env.CLARIFY_HOST ?? '127.0.0.1',
    httpPort: Number.isFinite(port) ? port : 4317,
    dataDir,
    webOrigin: readFlag(argv, 'web-origin') ?? process.env.CLARIFY_WEB_ORIGIN ?? 'http://127.0.0.1:5173',
    webDistDir: readFlag(argv, 'web-dist') ?? process.env.CLARIFY_WEB_DIST ?? resolveDefaultWebDist(),
    maxBlockMs: Number.isFinite(maxBlock) && maxBlock >= 1_000 ? maxBlock : 600_000,
    autoOpenBrowser: readFlag(argv, 'open') !== 'false',
    devUi: argv.includes('--dev-ui'),
  };
}
