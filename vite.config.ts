import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
