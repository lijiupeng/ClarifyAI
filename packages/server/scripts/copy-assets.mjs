import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把「发布时该在包里、但不在包目录里」的东西收进来。
 *
 * 1. 前端构建产物 —— 后端负责托管画布，产物必须随包分发，
 *    否则用户装完只拿到一个 API，打开 4317 是空白页。
 * 2. README 与 LICENSE —— npm 只从包目录读取这两个文件，而它们放在仓库根。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoRoot = path.resolve(serverDir, '../..');

async function copyWeb() {
  const source = path.resolve(serverDir, '../web/dist');
  const target = path.resolve(serverDir, 'dist/web');

  try {
    await fs.access(path.join(source, 'index.html'));
  } catch {
    throw new Error(`找不到前端产物：${source}\n请先执行 npm run build -w @clarifyai/web`);
  }

  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
  process.stdout.write('[copy-assets] 前端产物 → dist/web\n');
}

async function copyDocs() {
  for (const file of ['README.md', 'LICENSE']) {
    await fs.copyFile(path.join(repoRoot, file), path.join(serverDir, file));
    process.stdout.write(`[copy-assets] ${file} → packages/server/\n`);
  }
}

await copyWeb();
await copyDocs();
