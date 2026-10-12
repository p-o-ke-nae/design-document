/**
 * The `e2e-pages` runner of ddv.config.yaml: `npx tsx e2e-pages/run.ts <junit path> <grep pattern>`.
 * Runs the Pages edition E2E (playwright.pages.config.ts) and writes the JUnit report where ddv reads it.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const [junit, pattern] = process.argv.slice(2);
if (!junit) {
  console.error('usage: tsx e2e-pages/run.ts <junit> [pattern]');
  process.exit(2);
}
const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')), 'cli.js');
const args = [cli, 'test', '-c', 'playwright.pages.config.ts', '--reporter=line,junit'];
if (pattern && pattern !== '.*') args.push('--grep', pattern);
const r = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_JUNIT_OUTPUT_FILE: junit, PLAYWRIGHT_JUNIT_OUTPUT_NAME: junit },
});
process.exit(r.status ?? 1);
