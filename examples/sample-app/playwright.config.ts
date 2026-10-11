import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserChannel, loadConfigSync } from '@ddv/mock/playwright';

// Scenario E2E (e2e/ddv-scenarios.spec.ts). ddv's runner adds `--reporter=line,junit` and `--grep <IDs>`.
// Browser: mock.browser.channel of ddv.config.yaml, overridable with DDV_BROWSER_CHANNEL (chromium = bundled Chromium).
// Set DDV_BASE_URL to run the scenarios against the real application (resolved via scenarios/_map.yaml).
const ddv = loadConfigSync(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  timeout: 60_000,
  reporter: [['list']],
  use: {
    channel: browserChannel(ddv),
    viewport: ddv.mock.snapshot.viewport,
  },
});
