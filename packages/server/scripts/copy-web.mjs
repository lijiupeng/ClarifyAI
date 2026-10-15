import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把前端构建产物拷进服务端包里。
 *
 * 后端本来就会托管前端（见 http/routes.ts 的静态托管），打包时要让它随包分发，
 * 否则用户装完只拿到一个 API，打开 4317 是空白的。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../../web/dist');
const target = path.resolve(here, '../dist/web');

try {
  await fs.access(path.join(source, 'index.html'));
} catch {
  process.stderr.write(
    `[copy-web] 找不到前端产物：${source}\n` + '请先执行 npm run build -w @clarifyai/web\n',
  );
  process.exit(1);
}

await fs.rm(target, { recursive: true, force: true });
await fs.cp(source, target, { recursive: true });

process.stdout.write(`[copy-web] 前端产物已随包分发：${path.relative(process.cwd(), target)}\n`);
