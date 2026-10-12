// Seeds run records for the test-monitoring e2e (history, flaky) into the sample app before the server starts.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('examples/sample-app/.ddv/runs');
mkdirSync(dir, { recursive: true });

const ID = 'BD-ORDER-SCREEN-T002';
const COMMIT = 'e2e5eed000000000000000000000000000000000';
const now = Date.now();

const record = (n: number, status: 'passed' | 'failed', minutesAgo: number) => {
  const startedAt = new Date(now - minutesAgo * 60_000).toISOString();
  return {
    id: `e2e-seed-${n}`,
    kind: 'test',
    startedAt,
    finishedAt: startedAt,
    status,
    request: { ids: [ID] },
    runners: [{ name: 'web', command: 'seed', exitCode: status === 'passed' ? 0 : 1 }],
    results: {
      [ID]: { status, durationMs: 1234, runner: 'web', test: `[${ID}] seeded`, ...(status === 'failed' ? { message: 'expected Confirm but got Input\nstack' } : {}) },
    },
    log: [],
    commit: COMMIT,
    dirty: false,
  };
};

for (const r of [record(1, 'failed', 120), record(2, 'passed', 110)]) writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r, null, 2), 'utf8');
