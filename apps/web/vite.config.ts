import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const target = `http://127.0.0.1:${process.env.DDV_PORT ?? 5178}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@ddv/core': path.join(root, 'packages/core/src/index.ts'),
      '@ddv/graph': path.join(root, 'packages/graph/src/index.ts'),
      // Browser entry: without the token resolver (node:child_process). pat.md
      '@ddv/github': path.join(root, 'packages/github/src/browser.ts'),
      '@ddv/mock/tune-patch': path.join(root, 'packages/mock/src/tune-patch.ts'),
      '@ddv/mock/trace-format': path.join(root, 'packages/mock/src/trace-format.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target, changeOrigin: false }, '/raw': { target }, '/w/': { target } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
