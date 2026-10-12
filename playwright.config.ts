import { defineConfig } from '@playwright/test';
import { E2E_PORT as PORT, E2E_TOKEN } from './e2e/ddv-auth.ts';

const STORAGE_STATE = 'test-results/.auth/ddv.json';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 960 } },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    { name: 'e2e', dependencies: ['setup'], testIgnore: /auth\.setup\.ts$/, use: { storageState: STORAGE_STATE } },
  ],
  webServer: {
    command: `npx tsx e2e/seed-history.ts && npx vite build apps/web && npx tsx apps/server/src/cli.ts serve --repo examples/sample-app --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    // The sample app lives in a repository with a GitHub origin: keep the Actions status off github.com.
    env: { DDV_TOKEN: E2E_TOKEN, DDV_HOME: 'test-results/ddv-home', DDV_GITHUB_API: 'http://127.0.0.1:9', DDV_GITHUB_NO_GH: '1' },
    timeout: 120_000,
    reuseExistingServer: false,
  },
});