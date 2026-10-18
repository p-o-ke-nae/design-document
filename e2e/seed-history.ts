// Seeds run records for the test-monitoring e2e (history, flaky) and the trace view e2e into the sample app before the server starts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Trace view e2e: e2e-trace-1 has the trace of a failed P001 (step 2), e2e-trace-0 is a run from before traces (P002).
const TRACE_ID = 'BD-ORDER-SCREEN-P001';
const OLD_ID = 'BD-ORDER-SCREEN-P002';
const TRACE_RUN = 'e2e-trace-1';
const tracesDir = path.resolve('examples/sample-app/.ddv/traces');
rmSync(path.join(tracesDir, TRACE_RUN), { recursive: true, force: true });
mkdirSync(path.join(tracesDir, TRACE_RUN, TRACE_ID), { recursive: true });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex');
for (const n of [1, 2]) writeFileSync(path.join(tracesDir, TRACE_RUN, TRACE_ID, `${n}.png`), PNG);
const traceAt = new Date(now - 60_000).toISOString();
const trace = {
  version: 1,
  runId: TRACE_RUN,
  testId: TRACE_ID,
  title: `[${TRACE_ID}] 注文の流れ`,
  mock: 'order',
  target: 'mock',
  startedAt: traceAt,
  durationMs: 4100,
  status: 'failed',
  failedStep: 2,
  error: 'ステップ 2「次へ [入力OK]」: 画面が Confirm ではなく Input です',
  steps: [
    {
      index: 1,
      event: '新規',
      click: 'new',
      screenBefore: 'List',
      screenAfter: 'Input',
      expects: [
        { kind: 'screen', key: '', expected: 'Input', actual: 'Input', ok: true },
        { kind: 'hidden', key: 'error', expected: true, actual: true, ok: true },
      ],
      ok: true,
      durationMs: 600,
      calls: [],
      db: [],
      screenshot: `${TRACE_ID}/1.png`,
    },
    {
      index: 2,
      event: '次へ [入力OK]',
      input: { customer: '山田 太郎', sku: 'A-100', quantity: 1 },
      click: 'next',
      screenBefore: 'Input',
      screenAfter: 'Input',
      expects: [
        { kind: 'screen', key: '', expected: 'Confirm', actual: 'Input', ok: false },
        { kind: 'text', key: 'confirm-customer', expected: '山田 太郎', actual: null, ok: false },
      ],
      ok: false,
      error: '画面が Confirm ではなく Input です',
      durationMs: 1200,
      calls: [{ method: 'POST', path: '/orders', status: 409, requestBody: '{"customer":"山田 太郎","sku":"A-100","quantity":1}', responseBody: '{"message":"在庫が不足しています"}', durationMs: 12 }],
      db: [{ table: 'orders', kind: 'changed', key: '1', before: { id: 1, status: 'new', qty: 1 }, after: { id: 1, status: 'held', qty: 1 } }],
      screenshot: `${TRACE_ID}/2.png`,
    },
  ],
};
writeFileSync(path.join(tracesDir, TRACE_RUN, `${TRACE_ID}.json`), JSON.stringify(trace, null, 2), 'utf8');

const traceRun = (id: string, minutesAgo: number, testId: string, traces?: string[]) => {
  const startedAt = new Date(now - minutesAgo * 60_000).toISOString();
  return {
    id,
    kind: 'test',
    startedAt,
    finishedAt: startedAt,
    status: 'failed',
    request: { ids: [testId] },
    runners: [{ name: 'e2e', command: 'seed', exitCode: 1 }],
    results: { [testId]: { status: 'failed', durationMs: 4100, runner: 'e2e', test: `[${testId}] seeded`, message: 'seeded failure' } },
    log: [],
    commit: COMMIT,
    dirty: false,
    ...(traces ? { traces } : {}),
  };
};
for (const r of [traceRun('e2e-trace-0', 2, OLD_ID), traceRun(TRACE_RUN, 1, TRACE_ID, [TRACE_ID])]) writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r, null, 2), 'utf8');

// Desktop run e2e: e2e-desk-1 has the wpf result (with its trace) of P005 (desktop-run.md「結果の表示」).
const DESK_ID = 'BD-ORDER-SCREEN-P005';
const DESK_RUN = 'e2e-desk-1';
const DESK_KEY = `${DESK_ID}@wpf`;
rmSync(path.join(tracesDir, DESK_RUN), { recursive: true, force: true });
mkdirSync(path.join(tracesDir, DESK_RUN, DESK_KEY), { recursive: true });
writeFileSync(path.join(tracesDir, DESK_RUN, DESK_KEY, '1.png'), PNG);
const deskStep = (index: number, event: string, before: string, after: string, extra: Record<string, unknown> = {}) => ({
  index,
  event,
  screenBefore: before,
  screenAfter: after,
  expects: [{ kind: 'screen', key: '', expected: after, actual: after, ok: true }],
  ok: true,
  durationMs: 500,
  calls: [],
  db: null,
  ...extra,
});
const deskTrace = {
  version: 1,
  runId: DESK_RUN,
  testId: DESK_ID,
  title: `[${DESK_ID}] 注文の流れ（WPF）`,
  mock: 'order',
  target: 'app',
  platform: 'wpf',
  startedAt: traceAt,
  durationMs: 2100,
  status: 'passed',
  steps: [deskStep(1, '新規', 'List', 'Input', { click: 'new', screenshot: `${DESK_KEY}/1.png` }), deskStep(2, '', 'Input', 'Input', { only: ['web'], skipped: true, expects: [], durationMs: 0 })],
};
writeFileSync(path.join(tracesDir, DESK_RUN, `${DESK_KEY}.json`), JSON.stringify(deskTrace, null, 2), 'utf8');
const deskAt = new Date(now - 30_000).toISOString();
const deskRun = {
  id: DESK_RUN,
  kind: 'test',
  startedAt: deskAt,
  finishedAt: deskAt,
  status: 'passed',
  request: { ids: [DESK_ID], runners: ['wpf'] },
  runners: [{ name: 'wpf', command: 'seed', exitCode: 0 }],
  results: { [DESK_KEY]: { status: 'passed', durationMs: 2100, runner: 'wpf', test: `[${DESK_ID}] seeded`, platform: 'wpf' } },
  log: [],
  commit: COMMIT,
  dirty: false,
  traces: [DESK_KEY],
};
writeFileSync(path.join(dir, `${DESK_RUN}.json`), JSON.stringify(deskRun, null, 2), 'utf8');

// Evidence view e2e: e2e-evidence-1 is a passed P004 whose steps have evidence (evidence-trace.md「画面」).
const EV_ID = 'BD-ORDER-SCREEN-P004';
const EV_RUN = 'e2e-evidence-1';
const evDir = path.join(tracesDir, EV_RUN, EV_ID, 'evidence');
rmSync(path.join(tracesDir, EV_RUN), { recursive: true, force: true });
mkdirSync(evDir, { recursive: true });
const ORDERS = JSON.stringify({ columns: ['id', 'customer', 'card_no', 'note'], rows: [[1, '山田 太郎', '****', 'a,"b"']] });
writeFileSync(path.join(evDir, '1-after-1-screen.png'), PNG);
writeFileSync(path.join(evDir, '1-after-2-orders.table.json'), ORDERS, 'utf8');
const evFile = (name: string, kind: string, mime: string, bytes: number) => ({ path: `${EV_ID}/evidence/${name}`, kind, mime, bytes });
const evidenceTrace = {
  version: 1,
  runId: EV_RUN,
  testId: EV_ID,
  title: `[${EV_ID}] 注文の確定（証跡）`,
  mock: 'order',
  target: 'mock',
  startedAt: traceAt,
  durationMs: 3000,
  status: 'passed',
  steps: [
    {
      ...deskStep(1, '新規', 'List', 'Input', { click: 'new', calls: [], db: [] }),
      evidence: [
        { seq: 1, label: '入力画面', use: 'screenshot', at: 'after', provider: 'builtin', status: 'ok', durationMs: 40, files: [evFile('1-after-1-screen.png', 'image', 'image/png', PNG.length)] },
        {
          seq: 2,
          label: '注文表',
          use: 'db',
          at: 'after',
          provider: 'builtin',
          status: 'ok',
          durationMs: 25,
          db: { name: 'main', type: 'sqlite' },
          totalRows: 1,
          masked: ['card_no'],
          files: [evFile('1-after-2-orders.table.json', 'table', 'application/json', Buffer.byteLength(ORDERS))],
        },
      ],
    },
    {
      ...deskStep(2, '次へ [入力OK]', 'Input', 'Confirm', { click: 'next', calls: [], db: [] }),
      evidence: [{ seq: 1, label: '監査ログ', use: 'audit', at: 'after', provider: 'hooks', status: 'failed', reason: 'connect ECONNREFUSED', durationMs: 5, files: [] }],
    },
  ],
};
writeFileSync(path.join(tracesDir, EV_RUN, `${EV_ID}.json`), JSON.stringify(evidenceTrace, null, 2), 'utf8');
const evAt = new Date(now - 20_000).toISOString();
const evRun = {
  id: EV_RUN,
  kind: 'test',
  startedAt: evAt,
  finishedAt: evAt,
  status: 'passed',
  request: { ids: [EV_ID] },
  runners: [{ name: 'e2e', command: 'seed', exitCode: 0 }],
  results: { [EV_ID]: { status: 'passed', durationMs: 3000, runner: 'e2e', test: `[${EV_ID}] seeded`, evidence: 3, evidenceWarnings: 1 } },
  log: [],
  commit: COMMIT,
  dirty: false,
  traces: [EV_ID],
};
writeFileSync(path.join(dir, `${EV_RUN}.json`), JSON.stringify(evRun, null, 2), 'utf8');
