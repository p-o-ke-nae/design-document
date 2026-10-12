import { defineConfig } from '@playwright/test';

const PORT = 5179;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 960 } },
  webServer: {
    command: `npx tsx e2e/seed-history.ts && npx vite build apps/web && npx tsx apps/server/src/cli.ts serve --repo examples/sample-app --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/config`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
