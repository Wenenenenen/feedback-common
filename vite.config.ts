import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vite 配置：本地开发与构建；单元测试用 vitest 的 node 环境跑纯逻辑
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5199 },
  preview: { host: '127.0.0.1', port: 5199 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
