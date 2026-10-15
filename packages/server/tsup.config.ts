import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // workspace 里的私有包必须一起打进去，否则发布后解析不到 @clarifyai/shared
  noExternal: ['@clarifyai/shared'],
  // 产物要能直接执行，加 shebang 后配合 package.json 的 bin 就能 npx 运行
  banner: { js: '#!/usr/bin/env node' },
});
