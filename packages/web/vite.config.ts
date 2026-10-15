import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // shared 包的 exports 直接指向 TS 源码，交给 Vite 编译而不是预构建
  optimizeDeps: {
    exclude: ['@clarifyai/shared'],
  },
  server: {
    port: 5173,
    // 代理到后端，前端全程同源，省掉跨域配置
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
});
