import { defineConfig } from '@playwright/test';
import { PAGES_BASE, PAGES_PORT } from './e2e-pages/env.ts';

/**
 * E2E of the Pages edition (pages-viewer.md / hosted-viewer.md): the static build (`DDV_EDITION=pages`, base
 * `/design-document/`) served by `vite preview`; GitHub is stubbed per page (e2e-pages/github-stub.ts). No ddv server.
 */
export default defineConfig({
  testDir: 'e2e-pages',
  outputDir: 'test-results/e2e-pages',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PAGES_PORT}${PAGES_BASE}`, viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' },
  webServer: {
    command: `npm run build -w @ddv/mock-runtime && npx vite build apps/web --outDir dist-pages && npx tsx apps/web/scripts/check-pages-dist.ts apps/web/dist-pages && npx vite preview apps/web --outDir dist-pages --host 127.0.0.1 --port ${PAGES_PORT} --strictPort`,
    url: `http://127.0.0.1:${PAGES_PORT}${PAGES_BASE}`,
    env: { DDV_EDITION: 'pages', DDV_BASE: PAGES_BASE },
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
