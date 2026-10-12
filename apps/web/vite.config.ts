import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ddvPagesHtml, loadPagesConfig, normalizeBase } from './scripts/pages-build.ts';

const root = path.resolve(import.meta.dirname, '../..');
const target = `http://127.0.0.1:${process.env.DDV_PORT ?? 5178}`;
const edition = process.env.DDV_EDITION === 'pages' ? 'pages' : 'local';
// pat.md「pages.config.json」: read at build time only, embedded as import.meta.env.DDV_PAGES_CONFIG
const pagesConfig = edition === 'pages' ? loadPagesConfig(process.env.DDV_PAGES_CONFIG ?? path.join(import.meta.dirname, 'pages.config.json')) : null;

/** The runtime bundled for the Pages edition (DD-MOCKSB). The local edition does not use it, so a missing build is an empty stub there. */
function mockRuntimeRaw(): Plugin {
  const id = '@ddv/mock-runtime/dist/mock-runtime.js?raw';
  const file = path.join(root, 'packages/mock-runtime/dist/mock-runtime.js');
  const stub = '\0ddv-mock-runtime-stub';
  return {
    name: 'ddv-mock-runtime-raw',
    enforce: 'pre',
    resolveId(source) {
      if (source !== id) return null;
      if (existsSync(file)) return `${file}?raw`;
      if (edition === 'pages') this.error(`${file} がありません。先に npm run build -w @ddv/mock-runtime を実行してください`);
      return stub;
    },
    load(loaded) {
      return loaded === stub ? 'export default "";' : null;
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  base: edition === 'pages' ? normalizeBase(process.env.DDV_BASE) : '/',
  plugins: [mockRuntimeRaw(), react(), ...(pagesConfig ? [ddvPagesHtml(pagesConfig)] : [])],
  define: { 'import.meta.env.DDV_EDITION': JSON.stringify(edition), 'import.meta.env.DDV_PAGES_CONFIG': JSON.stringify(pagesConfig) },
  resolve: {
    alias: {
      '@ddv/core': path.join(root, 'packages/core/src/index.ts'),
      '@ddv/graph': path.join(root, 'packages/graph/src/index.ts'),
      // Browser entry: without the token resolver (node:child_process). pat.md
      '@ddv/github': path.join(root, 'packages/github/src/browser.ts'),
      '@ddv/mock/frame-protocol': path.join(root, 'packages/mock/src/frame-protocol.ts'),
      '@ddv/mock/tune-patch': path.join(root, 'packages/mock/src/tune-patch.ts'),
      '@ddv/mock/trace-format': path.join(root, 'packages/mock/src/trace-format.ts'),
      // Only one backend (and screen root) per bundle: the Pages edition has no `/api` client. services.md「ビルド時の選択」
      '#backend-impl': path.join(import.meta.dirname, edition === 'pages' ? 'src/backend/pages.ts' : 'src/backend/http.ts'),
      '#app-impl': path.join(import.meta.dirname, edition === 'pages' ? 'src/components/PagesApp.tsx' : 'src/App.tsx'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target, changeOrigin: false }, '/raw': { target }, '/w/': { target } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});