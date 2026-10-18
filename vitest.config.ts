import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ddv/core/node': r('./packages/core/src/node-index.ts'),
      '@ddv/core': r('./packages/core/src/index.ts'),
      '@ddv/graph': r('./packages/graph/src/index.ts'),
      '@ddv/github': r('./packages/github/src/index.ts'),
      '@ddv/testid/core': r('./packages/testid/src/core.ts'),
      '@ddv/testid': r('./packages/testid/src/index.ts'),
      '@ddv/services': r('./packages/services/src/index.ts'),
      '@ddv/mock/step': r('./packages/mock/src/step.ts'),
      '@ddv/mock/platform': r('./packages/mock/src/platform.ts'),
      '@ddv/mock/browser': r('./packages/mock/src/browser-safe.ts'),
      '@ddv/mock/frame-protocol': r('./packages/mock/src/frame-protocol.ts'),
      '@ddv/mock/playwright': r('./packages/mock/src/playwright.ts'),
      '@ddv/mock/tune': r('./packages/mock/src/tune.ts'),
      '@ddv/mock/tune-patch': r('./packages/mock/src/tune-patch.ts'),
      '@ddv/mock/yaml-patch': r('./packages/mock/src/yaml-patch.ts'),
      '@ddv/mock/trace-format': r('./packages/mock/src/trace-format.ts'),
      '@ddv/mock/trace': r('./packages/mock/src/trace.ts'),
      '@ddv/mock-runtime': r('./packages/mock-runtime/src/index.ts'),
      '@ddv/desktop': r('./packages/desktop/src/index.ts'),
      '@ddv/tokens/node': r('./packages/tokens/src/node.ts'),
      '@ddv/tokens': r('./packages/tokens/src/index.ts'),
      '@ddv/mock': r('./packages/mock/src/index.ts'),
      '@ddv/evidence/spec': r('./packages/evidence/src/spec.ts'),
      '@ddv/evidence/with': r('./packages/evidence/src/with.ts'),
      '@ddv/evidence/config': r('./packages/evidence/src/config.ts'),
      '@ddv/evidence/sql-guard': r('./packages/evidence/src/sql-guard.ts'),
      '@ddv/evidence/registry': r('./packages/evidence/src/registry.ts'),
      '@ddv/evidence/hooks-scan': r('./packages/evidence/src/hooks-scan.ts'),
      '@ddv/evidence/check': r('./packages/evidence/src/check.ts'),
      '@ddv/evidence/cli': r('./packages/evidence/src/cli.ts'),
      '@ddv/evidence/store': r('./packages/evidence/src/store.ts'),
      '@ddv/evidence/redact': r('./packages/evidence/src/redact.ts'),
      '@ddv/evidence/runner': r('./packages/evidence/src/runner.ts'),
      '@ddv/evidence/run': r('./packages/evidence/src/run.ts'),
      '@ddv/evidence/counts': r('./packages/evidence/src/counts.ts'),
      '@ddv/evidence/branch-limit': r('./packages/evidence/src/branch-limit.ts'),
      '@ddv/evidence': r('./packages/evidence/src/index.ts'),
      '#backend-impl': r('./apps/web/src/backend/http.ts'),
      '#app-impl': r('./apps/web/src/App.tsx'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'apps/web/scripts/**/*.test.ts'],
    testTimeout: 120_000,
  },
});

