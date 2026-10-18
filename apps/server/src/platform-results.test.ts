import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type RunnerConfig } from '@ddv/core';
import { DesktopGate, type GateResult, type RunnerGate } from '@ddv/desktop';
import { createApp, createContext, type ServerContext } from './app.ts';
import { TRACES_DIR } from './prune.ts';
import type { ExecOutcome } from './runner.ts';
import { RUNS_DIR, type ExecuteRunner, type RunRecord } from './runs.ts';
import { gateFromEnv, listTargets, validateRunRequest, type Target } from './targets.ts';

const ID = ['BD', 'ORDER', 'SCREEN', 'P001'].join('-');
const ID2 = ['BD', 'ORDER', 'SCREEN', 'P002'].join('-');
const UNIT = ['DD', 'ORDER', 'CALC', 'T001'].join('-');

const CONFIG = [
  'docsRoot: docs',
  'runners:',
  '  - { name: unit, type: command, command: "echo", level: unit }',
  '  - { name: e2e, type: playwright, scenarios: true, level: integration }',
  '  - { name: wpf, type: flaui, platform: wpf, app: { path: apps/Order.Wpf.exe }, source: apps/wpf }',
  '  - { name: winforms, type: flaui, platform: winforms, app: { path: apps/Order.WinForms.exe }, source: apps/wf }',
  '',
].join('\n');

const tmps: string[] = [];
const ctxs: ServerContext[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) c.close();
  for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const fixedGate = (map: Record<string, GateResult> = {}): RunnerGate => ({ evaluate: async (r) => map[r.name] ?? { available: true } });

interface Setup {
  gate?: RunnerGate;
  execute?: ExecuteRunner;
  runs?: Array<Partial<RunRecord> & { id: string; results: RunRecord['results'] }>;
  files?: Record<string, string>;
  config?: string;
}

async function setup(o: Setup = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-platres-'));
  tmps.push(root);
  const files: Record<string, string> = {
    'ddv.config.yaml': o.config ?? CONFIG,
    'docs/mocks/order/scenarios/order.yaml': `id: ${ID}\ntitle: 注文する\nsteps: []\n`,
    'docs/mocks/order/scenarios/cancel.yaml': `id: ${ID2}\ntitle: 取り消す\nsteps: []\n`,
    '.ddv/testids.lock.json': JSON.stringify({
      version: 1,
      diagrams: {
        'BD-ORDER-SCREEN': {
          doc: 'docs/basic/order.md',
          diagram: 'screen',
          next: { P: 3 },
          cases: { 'P:1': { id: ID, status: 'active', title: '注文する' }, 'P:2': { id: ID2, status: 'active', title: '取り消す' } },
        },
      },
    }),
    ...o.files,
  };
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }
  await fs.mkdir(path.join(root, RUNS_DIR), { recursive: true });
  for (const [i, r] of (o.runs ?? []).entries()) {
    const at = new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString();
    await fs.writeFile(path.join(root, RUNS_DIR, `${r.id}.json`), JSON.stringify({ kind: 'test', status: 'passed', request: {}, runners: [], log: [], startedAt: at, finishedAt: at, ...r }));
  }
  const ctx = await createContext(root, { watch: false, gate: o.gate ?? fixedGate(), execute: o.execute });
  ctxs.push(ctx);
  const app = createApp(ctx);
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await app.request(p, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { root, ctx, get: (p: string) => call('GET', p), post: (p: string, body: unknown) => call('POST', p, body) };
}

const ended = (ctx: ServerContext) => new Promise<RunRecord>((resolve) => ctx.runs.once('end', (_id: string, r: RunRecord) => resolve(r)));

/** A fake runner process: every requested (or linked) id passes, except on `failOn` runners; flaui / playwright write a trace. */
function fakeExecute(calls: Array<{ runner: string; ids: string[] | null }>, failOn: string[] = []): ExecuteRunner {
  return async (repoRoot, r, ids, links, _re, log, runId): Promise<ExecOutcome> => {
    calls.push({ runner: r.name, ids });
    log(`${r.name} を実行`);
    const list = ids ?? [...new Set(links.filter((l) => l.runner === r.name).map((l) => l.id))];
    const results: ExecOutcome['results'] = {};
    for (const id of list) {
      results[id] = { status: failOn.includes(r.name) ? 'failed' : 'passed', durationMs: 5, runner: r.name, test: id, ...(failOn.includes(r.name) ? { message: `${r.name} で失敗` } : {}) };
      if (r.type !== 'command' && runId) {
        const key = r.platform && r.platform !== 'web' ? `${id}@${r.platform}` : id;
        const file = path.join(repoRoot, TRACES_DIR, runId, `${key}.json`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const trace = { version: 1, runId, testId: id, title: 't', mock: 'order', target: 'app', startedAt: '2025-01-01T00:00:00.000Z', durationMs: 1, status: 'passed', steps: [] };
        await fs.writeFile(file, JSON.stringify(r.platform && r.platform !== 'web' ? { ...trace, platform: r.platform } : trace));
      }
    }
    return { exitCode: 0, results, command: `fake ${r.name}` };
  };
}

const T = (name: string, platform: Target['platform'], available = true, reason?: string): Target => ({ name, platform, target: name, available, ...(reason ? { code: 'x', reason } : {}) });
const TARGETS = [T('e2e', 'web'), T('wpf', 'wpf'), T('winforms', 'winforms', false, 'アプリの実行ファイルが見つかりません（ビルドしてください）'), T('e2e-stg', 'web')];
const targets = async () => TARGETS;

describe('開始の要求の検査（DD-PLATRES-RUNREQ）', () => {
  it('[DD-PLATRES-RUNREQ-P001] [DD-PLATRES-RUNREQ-T001] [DD-PLATRES-RUNREQ-T002] runner と runners が両方あれば 400', async () => {
    expect(await validateRunRequest({ runner: 'e2e', runners: ['e2e'] }, targets)).toEqual({ status: 400, code: 'bad-request', error: 'runner と runners は同時に指定できません' });
    const { post } = await setup();
    expect(await post('/api/tests/run', { runner: 'e2e', runners: ['e2e'] })).toEqual({ status: 400, body: { code: 'bad-request', error: 'runner と runners は同時に指定できません' } });
  });

  it('[DD-PLATRES-RUNREQ-P002] [DD-PLATRES-RUNREQ-T003] [DD-PLATRES-RUNREQ-T004] runners が無ければ従来どおり（runner だけ・何も無し）', async () => {
    let listed = 0;
    const counting = async () => (listed++, TARGETS);
    expect(await validateRunRequest({}, counting)).toBeNull();
    expect(await validateRunRequest({ ids: [ID], runner: 'e2e' }, counting)).toBeNull();
    expect(listed).toBe(0);
    const calls: Array<{ runner: string; ids: string[] | null }> = [];
    const { ctx, post } = await setup({ execute: fakeExecute(calls) });
    const done = ended(ctx);
    expect((await post('/api/tests/run', { ids: [ID] })).status).toBe(202);
    const run = await done;
    expect(run.request.runners).toBeUndefined();
    // Without `runners` every linked runner runs (as before).
    expect(calls.map((c) => c.runner)).toEqual(['e2e', 'wpf', 'winforms']);
  });

  it('[DD-PLATRES-RUNREQ-P003] [DD-PLATRES-RUNREQ-T005] [DD-PLATRES-RUNREQ-T006] 空の配列は 400 no-target', async () => {
    expect(await validateRunRequest({ runners: [] }, targets)).toEqual({ status: 400, code: 'no-target', error: '接続先を選んでください' });
    const { post } = await setup();
    expect(await post('/api/tests/run', { ids: [ID], runners: [] })).toEqual({ status: 400, body: { code: 'no-target', error: '接続先を選んでください' } });
  });

  it('[DD-PLATRES-RUNREQ-P004] [DD-PLATRES-RUNREQ-T007] [DD-PLATRES-RUNREQ-T008] 接続先でない名前があれば 400（接続先でないランナーの名前も）', async () => {
    expect(await validateRunRequest({ runners: ['e2e', 'nope'] }, targets)).toEqual({ status: 400, code: 'unknown-target', error: '接続先がありません: nope' });
    const { post } = await setup();
    expect((await post('/api/tests/run', { runners: ['unit'] })).body).toEqual({ code: 'unknown-target', error: '接続先がありません: unit' });
  });

  it('[DD-PLATRES-RUNREQ-P005] [DD-PLATRES-RUNREQ-T009] [DD-PLATRES-RUNREQ-T010] 同じプラットフォームが 2 つ以上なら 400 platform-duplicate', async () => {
    expect(await validateRunRequest({ runners: ['e2e', 'wpf', 'e2e-stg'] }, targets)).toEqual({ status: 400, code: 'platform-duplicate', error: '同じプラットフォームの接続先は 1 回の実行で 1 つまでです' });
    // Checked before availability: the duplicate wins over an unavailable target.
    expect((await validateRunRequest({ runners: ['e2e-stg', 'winforms', 'e2e'] }, targets))?.code).toBe('platform-duplicate');
  });

  it('[DD-PLATRES-RUNREQ-P006] [DD-PLATRES-RUNREQ-T011] [DD-PLATRES-RUNREQ-T012] 使えない接続先があれば 409 target-unavailable（名前と理由）', async () => {
    expect(await validateRunRequest({ runners: ['e2e', 'winforms'] }, targets)).toEqual({ status: 409, code: 'target-unavailable', error: 'winforms は使えません: アプリの実行ファイルが見つかりません（ビルドしてください）' });
    const { ctx, post } = await setup({ gate: fixedGate({ wpf: { available: false, code: 'not-windows', reason: 'デスクトップアプリの実行は Windows でだけ行えます' } }) });
    // Checked before the deps checks (a GitHub workspace without node_modules).
    ctx.checkDeps = true;
    expect(await post('/api/tests/run', { ids: [ID], runners: ['wpf'] })).toEqual({ status: 409, body: { code: 'target-unavailable', error: 'wpf は使えません: デスクトップアプリの実行は Windows でだけ行えます' } });
  });

  it('[DD-PLATRES-RUNREQ-P007] [DD-PLATRES-RUNREQ-T013] すべて使えれば開始し、接続先でないランナーと選んだ接続先を設定の順に実行して runners を保存する', async () => {
    expect(await validateRunRequest({ runners: ['wpf', 'e2e'] }, targets)).toBeNull();
    const calls: Array<{ runner: string; ids: string[] | null }> = [];
    const { ctx, post } = await setup({ execute: fakeExecute(calls) });
    const done = ended(ctx);
    const res = await post('/api/tests/run', { runners: ['wpf', 'e2e'] });
    expect(res.status).toBe(202);
    const run = await done;
    expect(calls.map((c) => c.runner)).toEqual(['unit', 'e2e', 'wpf']);
    expect(run.request.runners).toEqual(['wpf', 'e2e']);
    expect(run.log).toContain('[wpf] wpf を実行');
    expect(run.log).toContain('[e2e] e2e を実行');
  });
});

describe('接続先の一覧（GET /api/tests/targets）', () => {
  it('scenarios: true の playwright と flaui を設定の順に、対象と可否を付けて返す', async () => {
    const { get } = await setup({ gate: fixedGate({ winforms: { available: false, code: 'app-missing', reason: 'アプリの実行ファイルが見つかりません（ビルドしてください）' } }) });
    expect(await get('/api/tests/targets')).toEqual({
      status: 200,
      body: {
        targets: [
          { name: 'e2e', platform: 'web', target: 'モック（docs/mocks）', available: true },
          { name: 'wpf', platform: 'wpf', target: 'apps/Order.Wpf.exe', available: true },
          { name: 'winforms', platform: 'winforms', target: 'apps/Order.WinForms.exe', available: false, code: 'app-missing', reason: 'アプリの実行ファイルが見つかりません（ビルドしてください）' },
        ],
      },
    });
  });

  it('playwright の対象は DDV_BASE_URL があればその URL', async () => {
    const config = parseConfig({ runners: [{ name: 'e2e', type: 'playwright', scenarios: true }] });
    expect((await listTargets(config, fixedGate(), { DDV_BASE_URL: 'http://localhost:3000' }))[0].target).toBe('http://localhost:3000');
  });

  it('DDV_DESKTOP_GATE は書いたランナーの判定だけを差し替える', async () => {
    const gate = gateFromEnv(JSON.stringify({ wpf: { available: false, code: 'no-dotnet', reason: 'r' } }), fixedGate({ e2e: { available: true } }));
    expect(await gate.evaluate({ name: 'wpf', type: 'flaui', platform: 'wpf', app: undefined })).toEqual({ available: false, code: 'no-dotnet', reason: 'r' });
    expect(await gate.evaluate({ name: 'e2e', type: 'playwright', platform: undefined, app: undefined })).toEqual({ available: true });
    expect(gateFromEnv('{oops', fixedGate())).toBeTruthy();
  });
});

describe('実行の可否の表示（BD-DESKRUN-GATE、ローカル版）', () => {
  const config = parseConfig({
    runners: [
      { name: 'e2e', type: 'playwright', scenarios: true },
      { name: 'wpf', type: 'flaui', platform: 'wpf', app: { path: 'apps/Order.exe' }, source: 'apps/Order' },
    ],
  });
  const list = (o: { platform?: NodeJS.Platform; sdks?: string; exists?: boolean }) =>
    listTargets(config, new DesktopGate({ repoRoot: '/repo', platform: o.platform ?? 'win32', listSdks: async () => o.sdks ?? '8.0.100 [x]', exists: () => o.exists ?? true }), {});
  const wpf = async (o: Parameters<typeof list>[0]) => (await list(o)).find((t) => t.name === 'wpf')!;

  it('[BD-DESKRUN-GATE-P001] [BD-DESKRUN-GATE-T001] [BD-DESKRUN-GATE-T002] [BD-DESKRUN-GATE-S001] web の接続先はいつでも選べる', async () => {
    for (const platform of ['win32', 'linux'] as const) expect((await list({ platform, sdks: '' }))[0]).toMatchObject({ name: 'e2e', platform: 'web', available: true });
  });

  it('[BD-DESKRUN-GATE-P003] [BD-DESKRUN-GATE-T003] [BD-DESKRUN-GATE-T005] [BD-DESKRUN-GATE-T006] [BD-DESKRUN-GATE-S002] [BD-DESKRUN-GATE-S004] [BD-DESKRUN-GATE-S005] サーバが Windows でなければ無効', async () => {
    expect(await wpf({ platform: 'linux' })).toMatchObject({ available: false, reason: 'デスクトップアプリの実行は Windows でだけ行えます' });
  });

  it('[BD-DESKRUN-GATE-P004] [BD-DESKRUN-GATE-T007] [BD-DESKRUN-GATE-T008] [BD-DESKRUN-GATE-S006] [BD-DESKRUN-GATE-S007] .NET SDK が無ければ無効', async () => {
    expect(await wpf({ sdks: '' })).toMatchObject({ available: false, reason: '.NET SDK が見つかりません（導入の案内）' });
  });

  it('[BD-DESKRUN-GATE-P005] [BD-DESKRUN-GATE-T009] [BD-DESKRUN-GATE-T010] [BD-DESKRUN-GATE-S008] [BD-DESKRUN-GATE-S009] 設定の実行ファイルが無ければ無効', async () => {
    expect(await wpf({ exists: false })).toMatchObject({ available: false, reason: 'アプリの実行ファイルが見つかりません（ビルドしてください）' });
  });

  it('[BD-DESKRUN-GATE-P006] [BD-DESKRUN-GATE-T011] [BD-DESKRUN-GATE-S010] Windows・SDK・実行ファイルがそろえば選べる', async () => {
    expect(await wpf({})).toEqual({ name: 'wpf', platform: 'wpf', target: 'apps/Order.exe', available: true });
  });
});

describe('トレースのパス（DD-PLATRES-TRPATH）', () => {
  const res = { status: 'passed', durationMs: 1, runner: 'e2e', test: 't' } as const;
  const trace = (platform?: string) => JSON.stringify({ version: 1, runId: 'r1', testId: ID, title: 't', mock: 'order', target: 'app', startedAt: '2025-01-01T00:00:00.000Z', durationMs: 1, status: 'passed', steps: [], ...(platform ? { platform } : {}) });
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('latin1');
  const seeded = () =>
    setup({
      runs: [{ id: 'r1', results: { [ID]: res, [`${ID}@wpf`]: { ...res, runner: 'wpf', platform: 'wpf' } }, traces: [ID, `${ID}@wpf`] }],
      files: { [`${TRACES_DIR}/r1/${ID}.json`]: trace(), [`${TRACES_DIR}/r1/${ID}@wpf.json`]: trace('wpf'), [`${TRACES_DIR}/r1/${ID}@wpf/1.png`]: PNG },
    });

  it('[DD-PLATRES-TRPATH-P001] [DD-PLATRES-TRPATH-T001] [DD-PLATRES-TRPATH-T002] [DD-PLATRES-TRPATH-T005] [DD-PLATRES-TRPATH-T007] platform なし・web でテストIDに @ や / があれば既存の 400', async () => {
    const { get } = await seeded();
    for (const q of ['', '?platform=web']) {
      expect(await get(`/api/traces/r1/${encodeURIComponent(`${ID}@wpf`)}${q}`)).toMatchObject({ status: 400, body: { code: 'invalid-id' } });
      expect((await get(`/api/traces/r1/${encodeURIComponent(`x/${ID}`)}${q}`)).status).toBe(400);
    }
  });

  it('[DD-PLATRES-TRPATH-P002] [DD-PLATRES-TRPATH-T008] platform なし・web はキー = テストIDで既存どおり読む（既存のリンク）', async () => {
    const { ctx, get } = await seeded();
    for (const q of ['', '?platform=web']) {
      const r = await get(`/api/traces/r1/${ID}${q}`);
      expect(r.status).toBe(200);
      expect(r.body.platform).toBeUndefined();
    }
    expect(ctx.traces.validate('r1', ID)).toBe(ID);
    expect(ctx.traces.validate('r1', ID, 'web')).toBe(ID);
  });

  it('[DD-PLATRES-TRPATH-P003] [DD-PLATRES-TRPATH-T003] [DD-PLATRES-TRPATH-T006] wpf・winforms でもテストIDに @ や / があれば 400', async () => {
    const { get } = await seeded();
    expect(await get(`/api/traces/r1/${encodeURIComponent(`${ID}@wpf`)}?platform=wpf`)).toMatchObject({ status: 400, body: { code: 'invalid-id' } });
    expect((await get(`/api/traces/r1/${encodeURIComponent(`a/${ID}`)}?platform=winforms`)).status).toBe(400);
  });

  it('[DD-PLATRES-TRPATH-P004] wpf・winforms はキー = テストID@platform で読み、スクリーンショットも同じ', async () => {
    const { ctx, get } = await seeded();
    const r = await get(`/api/traces/r1/${ID}?platform=wpf`);
    expect(r).toMatchObject({ status: 200, body: { testId: ID, platform: 'wpf' } });
    expect(ctx.traces.validate('r1', ID, 'winforms')).toBe(`${ID}@winforms`);
    expect((await get(`/api/traces/r1/${ID}?platform=winforms`))).toMatchObject({ status: 404, body: { code: 'notInRun' } });
    expect(Buffer.from(await ctx.traces.screenshot('r1', ID, 1, 'wpf') ?? []).length).toBeGreaterThan(0);
    expect(await ctx.traces.screenshot('r1', ID, 1)).toBeNull();
  });

  it('[DD-PLATRES-TRPATH-P005] [DD-PLATRES-TRPATH-T004] その他の platform は 400 bad-platform（スクリーンショットも）', async () => {
    const { get } = await seeded();
    for (const p of ['desktop', 'WPF', 'mac']) expect(await get(`/api/traces/r1/${ID}?platform=${p}`)).toEqual({ status: 400, body: { code: 'bad-platform', error: '不明なプラットフォームです' } });
    expect(await get(`/api/traces/r1/${ID}/steps/1.png?platform=x`)).toEqual({ status: 400, body: { code: 'bad-platform', error: '不明なプラットフォームです' } });
  });
});

describe('プラットフォーム別の結果（結合）', () => {
  it('Web と WPF（偽のランナー）の結果は別のキーで残り、トレース・最新・テスト一覧・カバレッジ・履歴で分けて読める', async () => {
    const calls: Array<{ runner: string; ids: string[] | null }> = [];
    const { ctx, get, post } = await setup({ execute: fakeExecute(calls, ['wpf']) });
    const done = ended(ctx);
    expect((await post('/api/tests/run', { ids: [ID], runners: ['e2e', 'wpf'] })).status).toBe(202);
    const run = await done;
    expect(Object.keys(run.results).sort()).toEqual([ID, `${ID}@wpf`]);
    expect(run.results[ID].platform).toBeUndefined();
    expect(run.results[`${ID}@wpf`]).toMatchObject({ status: 'failed', platform: 'wpf', runner: 'wpf' });
    expect(run.traces).toEqual([ID, `${ID}@wpf`]);
    const saved = JSON.parse(await fs.readFile(path.join(ctx.repoRoot, RUNS_DIR, `${run.id}.json`), 'utf8')) as RunRecord;
    expect(saved.request.runners).toEqual(['e2e', 'wpf']);

    const latest = (await get('/api/results/latest')).body;
    expect(latest[ID]).toMatchObject({ status: 'passed' });
    expect(latest[`${ID}@wpf`]).toMatchObject({ status: 'failed', platform: 'wpf' });

    const row = (await get('/api/tests')).body.cases.find((c: { id: string }) => c.id === ID);
    expect(row.latest).toMatchObject({ status: 'passed', runId: run.id });
    expect(row.latestByPlatform.web).toMatchObject({ status: 'passed' });
    expect(row.latestByPlatform.wpf).toMatchObject({ status: 'failed', platform: 'wpf' });

    expect((await get(`/api/traces/${run.id}/${ID}?platform=wpf`)).body).toMatchObject({ platform: 'wpf' });

    const summary = (await get('/api/history/summary')).body;
    expect(summary.tests[`${ID}@wpf`]).toMatchObject({ testId: ID, platform: 'wpf', recent: expect.arrayContaining(['failed']) });
    expect(summary.tests[ID]).toMatchObject({ testId: ID, platform: 'web' });
    const hw = (await get(`/api/history/tests/${ID}?platform=wpf`)).body;
    expect(hw).toMatchObject({ id: ID, platform: 'wpf' });
    expect(hw.entries).toHaveLength(1);
    expect(hw.entries[0]).toMatchObject({ status: 'failed', trace: true });
    expect((await get(`/api/history/tests/${ID}`)).body.entries[0]).toMatchObject({ status: 'passed', trace: true });
    expect((await get(`/api/history/tests/${ID}?platform=x`)).status).toBe(400);

    // Re-run: the failed key, with the same targets; only the wpf runner runs it.
    calls.length = 0;
    const again = ended(ctx);
    expect((await post('/api/tests/rerun', { times: 1 })).status).toBe(202);
    const re = await again;
    expect(re.request).toEqual({ ids: [`${ID}@wpf`], runners: ['e2e', 'wpf'] });
    expect(calls).toEqual([{ runner: 'wpf', ids: [ID] }]);
    expect(Object.keys(re.results)).toEqual([`${ID}@wpf`]);
  });

  it('@ の無い既存の実行記録は web として読め、紐づかない要求は @ の無いキーでエラーにする', async () => {
    const old = { status: 'failed', durationMs: 3, message: '古い失敗', runner: 'e2e', test: 'x' } as const;
    const calls: Array<{ runner: string; ids: string[] | null }> = [];
    const { ctx, get, post } = await setup({ runs: [{ id: 'old1', results: { [ID]: old } }], execute: fakeExecute(calls) });
    const row = (await get('/api/tests')).body.cases.find((c: { id: string }) => c.id === ID);
    expect(Object.keys(row.latestByPlatform)).toEqual(['web']);
    expect(row.latest).toMatchObject({ status: 'failed', runId: 'old1' });
    expect((await get(`/api/history/tests/${ID}?platform=web`)).body.entries[0]).toMatchObject({ runId: 'old1', status: 'failed' });
    expect((await get(`/api/history/tests/${ID}?platform=wpf`)).body.entries).toEqual([]);

    const done = ended(ctx);
    await post('/api/tests/run', { ids: [UNIT], runners: ['wpf'] });
    const run = await done;
    expect(run.results).toEqual({ [UNIT]: { status: 'error', durationMs: 0, message: '紐づくテストが無いか、結果が見つかりませんでした', runner: '', test: '' } });
  });
});

describe('flaui のランナーの起動', () => {
  it('サーバ自身の CLI で desktop run を起動し、DDV_TRACE_DIR を渡す', async () => {
    const { buildInvocation } = await import('./runner.ts');
    const r = parseConfig({ runners: [{ name: 'wpf', type: 'flaui', platform: 'wpf', app: { path: 'a.exe' }, source: 'a' }] }).runners[0] as RunnerConfig;
    const inv = buildInvocation('/repo', r, [ID, ID2], '/rep', [], 'run-1');
    expect(inv.command).toBe(process.execPath);
    expect(inv.args.slice(-8)).toEqual(['desktop', 'run', '--runner', 'wpf', '--junit', path.join('/rep', 'wpf.xml'), '--ids', `${ID},${ID2}`]);
    expect(inv.args.some((a) => a.endsWith('cli.ts'))).toBe(true);
    expect(inv.env?.DDV_TRACE_DIR).toBe(path.join('/repo', TRACES_DIR, 'run-1'));
  });
});
