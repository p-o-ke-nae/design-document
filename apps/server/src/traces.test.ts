import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@ddv/core';
import { createApp, createContext, type ServerContext } from './app.ts';
import { TRACES_DIR } from './prune.ts';
import { buildInvocation } from './runner.ts';
import { RUNS_DIR, type RunRecord } from './runs.ts';

const ID = ['BD', 'ORDER', 'SCREEN', 'P001'].join('-');
const ID2 = ['BD', 'ORDER', 'SCREEN', 'P002'].join('-');
const ROOT = path.resolve(import.meta.dirname, '../../..');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex');

const tmps: string[] = [];
const ctxs: ServerContext[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) c.close();
  for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('記録の有効化（DD-TRREC-ENABLE）', () => {
  const pw = (scenarios: boolean) => parseConfig({ runners: [{ name: 'e2e', type: 'playwright', cwd: '.', level: 'integration', scenarios }] }).runners[0];

  it('[DD-TRREC-ENABLE-P001] [DD-TRREC-ENABLE-T001] [DD-TRREC-ENABLE-T002] playwright で scenarios: true でなければ DDV_TRACE_DIR を渡さない', () => {
    expect(buildInvocation(ROOT, pw(false), null, '/r', [], 'run-1').env?.DDV_TRACE_DIR).toBeUndefined();
    const vitest = parseConfig({ runners: [{ name: 'unit', type: 'vitest', cwd: '.', level: 'unit' }] }).runners[0];
    expect(buildInvocation(ROOT, vitest, null, '/r', [], 'run-1').env?.DDV_TRACE_DIR).toBeUndefined();
  });

  it('[DD-TRREC-ENABLE-T003] playwright で scenarios: true なら DDV_TRACE_DIR = repoRoot/.ddv/traces/実行ID', () => {
    const inv = buildInvocation(ROOT, pw(true), null, '/r', [], 'run-1');
    expect(inv.env?.DDV_TRACE_DIR).toBe(path.join(ROOT, '.ddv', 'traces', 'run-1'));
    expect(inv.env?.PLAYWRIGHT_JUNIT_OUTPUT_FILE).toBeTruthy();
    expect(buildInvocation(ROOT, pw(true), null, '/r').env?.DDV_TRACE_DIR).toBeUndefined();
  });
});

describe('トレースの読み込み（DD-TRVIEW-READ）と API', () => {
  const res = (status: string) => ({ status, durationMs: 10, runner: 'e2e', test: 't' });
  const trace = (runId: string, testId: string, version = 1) => ({ version, runId, testId, title: 't', mock: 'order', target: 'mock', startedAt: '2025-01-01T00:00:00.000Z', durationMs: 1, status: 'passed', steps: [] });

  async function setup(runs: Array<Omit<Partial<RunRecord>, 'results'> & { id: string; results: Record<string, unknown> }>, files: Record<string, string | Buffer> = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-traces-'));
    tmps.push(root);
    await fs.writeFile(path.join(root, 'ddv.config.yaml'), 'docsRoot: docs\n');
    await fs.mkdir(path.join(root, RUNS_DIR), { recursive: true });
    for (const [i, r] of runs.entries()) {
      const at = new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString();
      await fs.writeFile(path.join(root, RUNS_DIR, `${r.id}.json`), JSON.stringify({ kind: 'test', status: 'passed', request: {}, runners: [], log: [], startedAt: at, finishedAt: at, ...r }));
    }
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(root, TRACES_DIR, rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, body);
    }
    const ctx = await createContext(root, { watch: false });
    ctxs.push(ctx);
    const app = createApp(ctx);
    const get = async (p: string) => {
      const r = await app.request(p);
      return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? ((await r.json()) as any) : Buffer.from(await r.arrayBuffer()) };
    };
    return { ctx, get };
  }

  it('[DD-TRVIEW-READ-P001] [DD-TRVIEW-READ-T001] [DD-TRVIEW-READ-T002] runId・testId の形式が合わなければ 400', async () => {
    const { get } = await setup([{ id: 'r1', results: {} }]);
    expect((await get(`/api/traces/r_1/${ID}`)).status).toBe(400);
    expect((await get(`/api/traces/${'a'.repeat(65)}/${ID}`)).status).toBe(400);
    expect((await get('/api/traces/r1/not-an-id')).status).toBe(400);
    expect((await get(`/api/traces/r1/${encodeURIComponent(`../${ID}`)}`)).status).toBe(400);
    expect((await get(`/api/traces/r1/${ID}/steps/1.png`.replace('r1', 'r.1'))).status).toBe(400);
  });

  it('[DD-TRVIEW-READ-P002] [DD-TRVIEW-READ-T003] [DD-TRVIEW-READ-T004] 実行記録が無ければ unknownRun', async () => {
    const { get } = await setup([]);
    expect(await get(`/api/traces/gone/${ID}`)).toMatchObject({ status: 404, body: { code: 'unknownRun', error: 'この実行の記録はありません（保持件数を超えて削除されました）' } });
  });

  it('[DD-TRVIEW-READ-P003] [DD-TRVIEW-READ-T005] [DD-TRVIEW-READ-T006] results に testId が無ければ notInRun', async () => {
    const { get } = await setup([{ id: 'r1', results: { [ID2]: res('passed') }, traces: [ID2] }], { [`r1/${ID2}.json`]: JSON.stringify(trace('r1', ID2)) });
    expect((await get(`/api/traces/r1/${ID}`)).body).toEqual({ code: 'notInRun', error: 'この実行ではこのテストを実行していません' });
  });

  it('[DD-TRVIEW-READ-P004] [DD-TRVIEW-READ-T007] [DD-TRVIEW-READ-T008] 記録に traces が無ければ beforeTrace', async () => {
    const { get } = await setup([{ id: 'r1', results: { [ID]: res('failed') } }]);
    expect((await get(`/api/traces/r1/${ID}`)).body).toEqual({ code: 'beforeTrace', error: 'トレースの導入前の実行です' });
  });

  it('[DD-TRVIEW-READ-P005] [DD-TRVIEW-READ-T009] [DD-TRVIEW-READ-T010] [DD-TRVIEW-READ-T011] traces に testId が無く結果が error なら aborted', async () => {
    const { get } = await setup([{ id: 'r1', results: { [ID]: res('error') }, traces: [] }]);
    expect((await get(`/api/traces/r1/${ID}`)).body).toEqual({ code: 'aborted', error: '実行が途中で止まったため、トレースはありません（ランナーの起動失敗など）' });
  });

  it('[DD-TRVIEW-READ-P006] [DD-TRVIEW-READ-T012] traces に testId が無く結果が error 以外なら notRecorded', async () => {
    const { get } = await setup([{ id: 'r1', results: { [ID]: res('passed') }, traces: [] }]);
    expect((await get(`/api/traces/r1/${ID}`)).body).toEqual({ code: 'notRecorded', error: 'このテストのトレースは記録されていません（シナリオの E2E ではないか、記録を有効にせずに実行しました）' });
  });

  it('[DD-TRVIEW-READ-P007] [DD-TRVIEW-READ-T013] [DD-TRVIEW-READ-T014] traces にあるがファイルを読めなければ pruned。traceOf は false', async () => {
    const { get } = await setup([{ id: 'r1', results: { [ID]: res('failed') }, traces: [ID] }]);
    expect((await get(`/api/traces/r1/${ID}`)).body).toEqual({ code: 'pruned', error: 'トレースは保持件数を超えたため削除されました' });
    expect((await get('/api/runs/r1')).body.traceOf).toEqual({ [ID]: false });
    expect((await get('/api/results/latest')).body[ID].trace).toBe(false);
  });

  it('[DD-TRVIEW-READ-P008] [DD-TRVIEW-READ-T015] 読めたら TraceFile ＋ commit・dirty。png・traceOf・latest の trace も返す', async () => {
    const C = 'c'.repeat(40);
    const { get } = await setup(
      [
        { id: 'r1', results: { [ID]: res('failed'), [ID2]: res('passed') }, traces: [ID], commit: C, dirty: true },
        { id: 'r2', results: { [ID2]: res('passed') }, traces: [ID2] },
      ],
      { [`r1/${ID}.json`]: JSON.stringify(trace('r1', ID)), [`r1/${ID}/1.png`]: PNG, [`r2/${ID2}.json`]: JSON.stringify(trace('r2', ID2, 2)) },
    );
    const t = await get(`/api/traces/r1/${ID}`);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ version: 1, runId: 'r1', testId: ID, commit: C, dirty: true });

    const png = await get(`/api/traces/r1/${ID}/steps/1.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(Buffer.compare(png.body as Buffer, PNG)).toBe(0);
    expect((await get(`/api/traces/r1/${ID}/steps/2.png`)).status).toBe(404);
    expect((await get(`/api/traces/r1/${ID}/steps/x.png`)).status).toBe(404);

    expect((await get('/api/runs/r1')).body).toMatchObject({ traces: [ID], traceOf: { [ID]: true } });
    const latest = (await get('/api/results/latest')).body;
    expect(latest[ID]).toMatchObject({ runId: 'r1', trace: true });
    expect(latest[ID2]).toMatchObject({ runId: 'r2', trace: true });

    expect(await get(`/api/traces/r2/${ID2}`)).toMatchObject({ status: 500, body: { error: 'トレースの形式が古いか新しすぎます' } });
  });
});
