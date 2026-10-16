import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { FeedbackBroker } from './core/feedbackBroker.js';
import { SessionService } from './core/sessionService.js';
import { SessionStore } from './store/sessionStore.js';
import { createMcpServer } from './mcp/server.js';
import { createApp } from './http/routes.js';
import { RealtimeHub } from './http/ws.js';

/**
 * 启动期的可预期错误（端口占用等）。
 * message 本身就是一段可以直接给用户看的说明，因此顶层不再追加堆栈 ——
 * 「端口被占用」这种事甩一堆 node:events 堆栈出去，用户根本看不出该干什么。
 */
class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

/**
 * 单进程同时承载两条对外通道：
 * - stdio MCP  → 主 Agent（由它拉起本进程作为子进程）
 * - HTTP + WS  → 浏览器画布
 *
 * 注意：stdio 模式下 stdout 归 MCP 协议所有，任何日志都必须走 stderr，
 * 否则会污染协议流导致客户端解析失败。全文件请统一使用 process.stderr。
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const store = new SessionStore(config.dataDir);
  await store.init();

  const broker = new FeedbackBroker();

  // hub 与 service 互相引用：service 需要 hub 来推送，hub 需要 service 的会话。
  // 用闭包延迟求值解开这个环，纯 MCP 模式下 hub 始终为 undefined，推送静默丢弃。
  let hub: RealtimeHub | undefined;

  // 画布地址的优先级：后端自己托管前端产物时指向后端，否则回落到 Vite 开发服务器。
  // 早先无条件用 webOrigin，导致 MCP 返回的 uiUrl 指向没启动的 5173，用户点开是空白页 ——
  // 明明 4317 上就有一模一样的画布。
  const uiBase = fs.existsSync(path.join(config.webDistDir, 'index.html'))
    ? `http://${config.host}:${config.httpPort}`
    : config.webOrigin;

  const service = new SessionService({
    store,
    broker,
    webOrigin: uiBase,
    autoOpen: config.autoOpenBrowser,
    maxBlockMs: config.maxBlockMs,
    emit: (sessionId, event, payload) => hub?.emit(sessionId, event, payload),
  });

  // 重启会丢掉内存里的阻塞等待，先把上一条命留下的 awaiting-agent 交回用户
  const recovered = await service.recoverStaleSessions();
  if (recovered > 0) {
    process.stderr.write(`[clarifyai] 已把 ${recovered} 个因重启而卡住的会话交回用户\n`);
  }

  const preset = process.env.CLARIFY_TOOLS ?? 'standard';

  if (config.mode === 'http' || config.mode === 'both') {
    hub = new RealtimeHub(store);

    // HTTP 模式下同时挂载 MCP over HTTP：服务常驻，主 Agent 与画布共享同一实例
    const app = createApp({ service, store, config, mountMcp: true, toolPreset: preset });
    const server = http.createServer(app);

    // clarify_await 最长可能阻塞 10 分钟，而 Node 的 requestTimeout 默认是 5 分钟。
    // 它一旦把连接掐掉，主 Agent 收到的就是一次「超时失败」而不是 pending ——
    // 这与「宁可提前返回，也不能让请求被杀」的原则直接冲突，所以直接关掉这条超时。
    server.requestTimeout = 0;

    // 先 listen 成功、再挂 WebSocket。反过来的话，端口被占用会同时触发
    // http server 与 WebSocketServer 两处 error，后者无人监听会直接崩成未捕获异常 ——
    // 用户看到的就是一坨 node:events 堆栈。
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(
            new StartupError(
              `端口 ${config.httpPort} 已被占用，服务无法启动。\n` +
                `  最可能的原因：上一个 ClarifyAI 实例还在后台运行。\n` +
                `  · 查占用者：netstat -ano | findstr :${config.httpPort}\n` +
                `  · 或换端口：clarifyai --mode=http --port 4318`,
            ),
          );
          return;
        }
        reject(error);
      });
      server.listen(config.httpPort, config.host, resolve);
    });

    hub.attach(server);

    process.stderr.write(
      `[clarifyai] 画布服务      http://${config.host}:${config.httpPort}\n` +
        `[clarifyai] MCP over HTTP  http://${config.host}:${config.httpPort}/mcp\n` +
        `[clarifyai] 前端开发地址  ${config.webOrigin}\n`,
    );
  }

  if (config.mode === 'mcp' || config.mode === 'both') {
    const mcp = createMcpServer({ service, store, preset });
    await mcp.connect(new StdioServerTransport());
    process.stderr.write(`[clarifyai] MCP stdio 已就绪（工具档位：${preset}）\n`);
  } else {
    process.stderr.write('[clarifyai] 未启用 stdio 传输（HTTP 模式下 /mcp 依然可用）\n');
  }
}

main().catch((error: unknown) => {
  // 可预期的启动失败只给结论，不给堆栈
  if (error instanceof StartupError) {
    process.stderr.write(`[clarifyai] ${error.message}\n`);
    process.exit(1);
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[clarifyai] 启动失败：${detail}\n`);
  process.exit(1);
});
