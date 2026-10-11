import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '@ddv/core';
import { generateAll, readLock } from '@ddv/testid';
import { scaffoldMock, type Scenario } from '@ddv/mock';
import { createApp, createContext, type ServerContext } from './app.ts';
import type { RunRecord } from './runs.ts';
import { PLAYS_FILE, recordPlay, scenarioStatus } from './scenarios.ts';
import { SnapshotService } from './snapshots.ts';

const DOC = `---
id: DEMO
kind: basic
status: approved
title: デモ
---

# デモ

::mock[demo/index.html]

\`\`\`mermaid id=screen matrix nswitch=0
stateDiagram-v2
  state "一覧" as List
  state "入力" as Input
  state "確認" as Confirm
  [*] --> List
  List --> Input : 新規
  Input --> Confirm : 次へ
\`\`\`
`;

/** Tiny mock with a stub runtime (window.__ddv). `variant` changes the rendering of the Confirm screen. */
const html = (variant: 'a' | 'b' = 'a') => `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font-family: sans-serif; background: #fff; } section { padding: 16px; }
${variant === 'b' ? '[data-screen=Confirm] { background: #c00; color: #fff; height: 200px; }' : ''}
</style></head><body>
<section data-screen="List"><button data-testid="new" data-event="新規">新規</button><ul><li data-testid="row">a</li><li data-testid="row">b</li></ul></section>
<section data-screen="Input" hidden><input data-testid="customer" required data-sample="山田"><button data-testid="next" data-event="次へ" data-submit="POST /orders">次へ</button><p data-testid="error" hidden>必須です</p></section>
<section data-screen="Confirm" hidden><span data-testid="confirm-customer"></span></section>
<script>
const show = (id) => document.querySelectorAll('[data-screen]').forEach((s) => (s.hidden = s.dataset.screen !== id));
const $ = (k) => document.querySelector('[data-testid="' + k + '"]');
$('new').onclick = () => show('Input');
$('next').onclick = () => { const v = $('customer').value; if (!v) { $('error').hidden = false; return; } $('confirm-customer').textContent = v; show('Confirm'); };
window.__ddv = { ready: Promise.resolve(), async reset(fixtures, start) { show(start || 'List'); return { screen: start || 'List' }; } };
</script></body></html>`;

const CONFIG = `docsRoot: docs
mocksRoot: docs/mocks
runners:
  - name: e2e
    type: playwright
    cwd: .
    level: integration
    scenarios: true
mock:
  snapshot:
    viewport: { width: 320, height: 240 }
`;

async function write(repo: string, rel: string, text: string) {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), text, 'utf8');
}

const scenarioYaml = (id: string, o: { customer?: string; badScreen?: boolean } = {}) => `id: ${id}
title: 一覧 → 入力 → 確認
fixtures: []
start: List
steps:
  - event: 新規
    click: new
    expect: { screen: Input, count: { row: 0 } }
  - event: 次へ
    input: { customer: ${o.customer ?? '山田'} }
    click: next
    expect: { screen: ${o.badScreen ? 'List' : 'Confirm'}, text: { confirm-customer: ${o.customer ?? '山田'} } }
`;

let base = '';
let n = 0;
let P1 = '';

async function makeRepo(): Promise<string> {
  const repo = path.join(base, `r${++n}`);
  await write(repo, 'ddv.config.yaml', CONFIG);
  await write(repo, 'docs/basic/demo.md', DOC);
  await write(repo, 'docs/mocks/demo/index.html', html());
  await generateAll(repo, parseConfig({ docsRoot: 'docs', mocksRoot: 'docs/mocks' }), { write: true });
  return repo;
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-mockapi-'));
  const repo = await makeRepo();
  const lock = await readLock(repo);
  P1 = Object.values(lock.diagrams)[0] ? Object.values(Object.values(lock.diagrams)[0].cases).find((c) => /-P\d{3}$/.test(c.id))!.id : '';
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function api(ctx: ServerContext) {
  const app = createApp(ctx);
  const req = async (p: string, body?: unknown) => {
    const res = await app.request(p, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: (type.includes('json') ? await res.json() : await res.text()) as any };
  };
  return req;
}

const past = (sec: number) => new Date(Date.now() - sec * 1000);

async function statusOf(req: Awaited<ReturnType<typeof api>>, id: string): Promise<string | undefined> {
  const { body } = await req('/api/mocks/scenarios');
  return body.scenarios.find((s: any) => s.id === id)?.status;
}

describe('シナリオの状態（BD-MOCK-SCEN）', () => {
  it('[BD-MOCK-SCEN-T001] 骨組み生成したシナリオは未確認で、一覧と詳細を返す', async () => {
    const repo = await makeRepo();
    const ctx = await createContext(repo, { watch: false });
    const r = await scaffoldMock(repo, ctx.config);
    expect(r.added).toBe(1);
    const req = await api(ctx);
    const { body } = await req('/api/mocks/scenarios');
    expect(body.scenarios).toEqual([expect.objectContaining({ id: P1, mock: 'demo', file: `docs/mocks/demo/scenarios/${P1}.yaml`, status: 'Unverified', issues: [] })]);
    const d = await req(`/api/mocks/scenario?id=${P1}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ id: P1, mock: 'demo', mockPath: 'demo/index.html', doc: 'docs/basic/demo.md', diagram: 'screen', issues: [] });
    expect(d.body.scenario.steps.map((s: any) => s.event)).toEqual(['新規', '次へ']);
    expect(d.body.transitions.map((t: any) => [t.from, t.to, t.event, typeof t.edge])).toEqual([
      ['List', 'Input', '新規', 'number'],
      ['Input', 'Confirm', '次へ', 'number'],
    ]);
    expect(d.body.edges.length).toBeGreaterThanOrEqual(2);
    expect((await req('/api/mocks/scenario?id=BD-NONE-X-P001')).status).toBe(404);
  });

  it('[BD-MOCK-SCEN-T002] [BD-MOCK-SCEN-T004] [BD-MOCK-SCEN-T005] 再生の結果で再生OK / 再生NG を切り替える', async () => {
    const repo = await makeRepo();
    await write(repo, `docs/mocks/demo/scenarios/${P1}.yaml`, scenarioYaml(P1));
    await fs.utimes(path.join(repo, `docs/mocks/demo/scenarios/${P1}.yaml`), past(60), past(60));
    const req = await api(await createContext(repo, { watch: false }));
    expect(await statusOf(req, P1)).toBe('Unverified');
    expect((await req('/api/mocks/played', { id: P1, ok: true })).status).toBe(200);
    expect(await statusOf(req, P1)).toBe('Passed');
    await req('/api/mocks/played', { id: P1, ok: false, failures: [{ key: 'screen', expected: 'Confirm', actual: 'Input' }] });
    expect(await statusOf(req, P1)).toBe('Failed');
    const plays = JSON.parse(await fs.readFile(path.join(repo, PLAYS_FILE), 'utf8'));
    expect(plays[P1]).toMatchObject({ ok: false, failures: [{ key: 'screen' }] });
    await req('/api/mocks/played', { id: P1, ok: true });
    expect(await statusOf(req, P1)).toBe('Passed');
    expect((await req('/api/mocks/played', { id: P1 })).status).toBe(400);
  });

  it('[BD-MOCK-SCEN-T003] E2E の結果（scenarios: true の playwright ランナー）でも判定する', async () => {
    const repo = await makeRepo();
    await write(repo, `docs/mocks/demo/scenarios/${P1}.yaml`, scenarioYaml(P1));
    await fs.utimes(path.join(repo, `docs/mocks/demo/scenarios/${P1}.yaml`), past(60), past(60));
    const ctx = await createContext(repo, { watch: false });
    const req = await api(ctx);
    const at = new Date().toISOString();
    const run: RunRecord = { id: 'r1', kind: 'test', startedAt: at, finishedAt: at, status: 'failed', request: {}, runners: [], log: [], results: { [P1]: { status: 'failed', durationMs: 1, runner: 'e2e', test: `[${P1}] x` } } };
    ctx.runs.runs.set(run.id, run);
    expect(await statusOf(req, P1)).toBe('Failed');
    // A result from another runner is not a scenario replay.
    ctx.runs.runs.set('r2', { ...run, id: 'r2', startedAt: new Date(Date.now() + 1000).toISOString(), finishedAt: new Date(Date.now() + 1000).toISOString(), results: { [P1]: { status: 'passed', durationMs: 1, runner: 'web', test: 'x' } } });
    expect(await statusOf(req, P1)).toBe('Failed');
  });

  it('[BD-MOCK-SCEN-T006] [BD-MOCK-SCEN-T007] [BD-MOCK-SCEN-T008] [BD-MOCK-SCEN-T009] [BD-MOCK-SCEN-X001] 値の編集・再生成で更新日時が結果より新しければ未確認', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const t = Date.parse(at);
    // edit / regeneration after Passed or Failed
    expect(scenarioStatus({ retired: false, mtimeMs: t - 1000, results: [{ ok: true, at }] })).toBe('Passed');
    expect(scenarioStatus({ retired: false, mtimeMs: t + 1000, results: [{ ok: true, at }] })).toBe('Unverified');
    expect(scenarioStatus({ retired: false, mtimeMs: t - 1000, results: [{ ok: false, at }] })).toBe('Failed');
    expect(scenarioStatus({ retired: false, mtimeMs: t + 1000, results: [{ ok: false, at }] })).toBe('Unverified');
    // edit while Unverified stays Unverified
    expect(scenarioStatus({ retired: false, mtimeMs: t + 1000, results: [] })).toBe('Unverified');
    // latest of player / E2E wins
    expect(scenarioStatus({ retired: false, mtimeMs: t - 1000, results: [{ ok: false, at }, { ok: true, at: '2026-01-02T00:00:00.000Z' }] })).toBe('Passed');
  });

  it('[BD-MOCK-SCEN-T006] [BD-MOCK-SCEN-T008] ファイルの更新（編集・再生成）で API の状態が未確認に戻る', async () => {
    const repo = await makeRepo();
    const file = path.join(repo, `docs/mocks/demo/scenarios/${P1}.yaml`);
    await write(repo, `docs/mocks/demo/scenarios/${P1}.yaml`, scenarioYaml(P1));
    await fs.utimes(file, past(60), past(60));
    await recordPlay(repo, P1, true, undefined, past(30).toISOString());
    const req = await api(await createContext(repo, { watch: false }));
    expect(await statusOf(req, P1)).toBe('Passed');
    await write(repo, `docs/mocks/demo/scenarios/${P1}.yaml`, scenarioYaml(P1, { customer: '佐藤' }));
    expect(await statusOf(req, P1)).toBe('Unverified');
  });

  it('[BD-MOCK-SCEN-T010] [BD-MOCK-SCEN-T011] [BD-MOCK-SCEN-T012] [BD-MOCK-SCEN-T013] [BD-MOCK-SCEN-X002] [BD-MOCK-SCEN-X003] 欠番は _retired/ のファイルで、経路が戻れば未確認', async () => {
    for (const before of ['none', 'ok', 'ng'] as const) {
      const repo = await makeRepo();
      const rel = `docs/mocks/demo/scenarios/${P1}.yaml`;
      const retiredRel = `docs/mocks/demo/scenarios/_retired/${P1}.yaml`;
      await write(repo, rel, scenarioYaml(P1));
      await fs.utimes(path.join(repo, rel), past(60), past(60));
      if (before !== 'none') await recordPlay(repo, P1, before === 'ok', undefined, past(30).toISOString());
      const req = await api(await createContext(repo, { watch: false }));
      expect(await statusOf(req, P1)).toBe(before === 'none' ? 'Unverified' : before === 'ok' ? 'Passed' : 'Failed');
      // regeneration without the path moves the file to _retired/
      await fs.mkdir(path.join(repo, 'docs/mocks/demo/scenarios/_retired'), { recursive: true });
      await fs.rename(path.join(repo, rel), path.join(repo, retiredRel));
      const listed = (await req('/api/mocks/scenarios')).body.scenarios;
      expect(listed).toEqual([expect.objectContaining({ id: P1, file: retiredRel, status: 'Retired' })]);
      // play / edit while retired keeps Retired
      await req('/api/mocks/played', { id: P1, ok: true });
      expect(await statusOf(req, P1)).toBe('Retired');
      await write(repo, retiredRel, scenarioYaml(P1, { customer: '佐藤' }));
      expect(await statusOf(req, P1)).toBe('Retired');
      if (before !== 'none') continue;
      // regeneration with the path back writes the file again → Unverified (newer than any result)
      await fs.rm(path.join(repo, retiredRel));
      await new Promise((r) => setTimeout(r, 20));
      await write(repo, rel, scenarioYaml(P1));
      expect(await statusOf(req, P1)).toBe('Unverified');
    }
  });

  it('形式が不正なシナリオは issues に行番号付きで返す', async () => {
    const repo = await makeRepo();
    await write(repo, 'docs/mocks/demo/scenarios/BD-DEMO-SCREEN-P009.yaml', 'id: BD-DEMO-SCREEN-P009\nstart: List\nsteps:\n  - event: x\n');
    const req = await api(await createContext(repo, { watch: false }));
    const s = (await req('/api/mocks/scenarios')).body.scenarios.find((x: any) => x.id === 'BD-DEMO-SCREEN-P009');
    expect(s.status).toBe('Unverified');
    expect(s.issues[0]).toMatch(/行目: steps\.0\.expect/);
  });
});

describe('スナップショット（BD-MOCK-SNAP）', () => {
  let repo = '';
  let svc: SnapshotService;
  let req: Awaited<ReturnType<typeof api>>;
  let ctx: ServerContext;
  const file = () => path.join(repo, `docs/mocks/demo/scenarios/${P1}.yaml`);
  const capture = () => svc.capture([P1], { log: () => {}, event: () => {} });
  const states = async () => ((await req(`/api/snapshots?id=${P1}`)).body.steps as any[]).map((s) => s.status);

  beforeAll(async () => {
    repo = await makeRepo();
    await write(repo, `docs/mocks/demo/scenarios/${P1}.yaml`, scenarioYaml(P1));
    ctx = await createContext(repo, { watch: false });
    svc = ctx.snapshots;
    req = await api(ctx);
  });

  it('[BD-MOCK-SNAP-T001] [BD-MOCK-SNAP-X001] 撮影前は未撮影で、承認できない', async () => {
    const { status, body } = await req(`/api/snapshots?id=${P1}`);
    expect(status).toBe(200);
    expect(body).toEqual({ id: P1, steps: [1, 2].map((step) => ({ step, status: 'None', warnings: [], images: {} })) });
    const r = await req('/api/snapshots/approve', { id: P1 });
    expect(r.status).toBe(400);
    expect((await req('/api/snapshots?id=BD-NONE-X-P001')).status).toBe(404);
  });

  it('[BD-MOCK-SNAP-T002] [BD-MOCK-SNAP-X002] 基準がなければ基準なし（再撮影しても基準なし）。API 経由の実行は SSE で進捗を返す', async () => {
    const start = await req('/api/snapshots/run', { ids: [P1] });
    expect(start.status).toBe(202);
    const runId = start.body.runId as string;
    const ended = await new Promise<RunRecord>((resolve) => {
      const onEnd = (id: string, r: RunRecord) => id === runId && (ctx.runs.off('end', onEnd), resolve(r));
      ctx.runs.on('end', onEnd);
    });
    expect(ended).toMatchObject({ kind: 'snapshot', status: 'passed' });
    const sse = await req(`/api/runs/${runId}/events`);
    expect(sse.body).toContain('event: step');
    expect(sse.body).toContain(`data: {"id":"${P1}","step":2,"status":"NoBase"}`);
    expect(sse.body).toContain('event: scenario');
    expect(sse.body).toMatch(/event: end\ndata: \{"status":"passed"\}/);
    expect((await req('/api/runs')).body.some((r: any) => r.id === runId)).toBe(false);
    expect(await states()).toEqual(['NoBase', 'NoBase']);
    const list = (await req(`/api/snapshots?id=${P1}`)).body;
    expect(list.browser).toBe('chromium');
    expect(list.steps[0].images.current).toMatch(/^\/api\/snapshots\/image\?id=.+&step=1&kind=current/);
    const img = await req(list.steps[0].images.current);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toBe('no-store');
    expect(existsSync(path.join(repo, `.ddv/snapshots/current/${P1}/001.png`))).toBe(true);
    const meta = JSON.parse(await fs.readFile(path.join(repo, `.ddv/snapshots/current/${P1}/meta.json`), 'utf8'));
    expect(meta).toMatchObject({ browser: 'chromium', viewport: { width: 320, height: 240 }, steps: 2 });
    await capture();
    expect(await states()).toEqual(['NoBase', 'NoBase']);
  });

  it('[BD-MOCK-SNAP-T005] [BD-MOCK-SNAP-X003] 承認で基準なしは一致になり、一致の承認は一致のまま', async () => {
    const r = await req('/api/snapshots/approve', { id: P1 });
    expect(r.status).toBe(200);
    expect(r.body.approved).toEqual([1, 2]);
    expect(r.body.steps.map((s: any) => s.status)).toEqual(['Match', 'Match']);
    expect(existsSync(path.join(repo, `.ddv/snapshots/baseline/${P1}/002.png`))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(repo, `.ddv/snapshots/baseline/${P1}/meta.json`), 'utf8'))).toMatchObject({ browser: 'chromium', steps: 2 });
    const again = await req('/api/snapshots/approve', { id: P1, steps: [2] });
    expect(again.body.steps.map((s: any) => s.status)).toEqual(['Match', 'Match']);
  });

  it('[BD-MOCK-SNAP-T003] [BD-MOCK-SNAP-T007] 基準と同じ画面なら一致', async () => {
    await capture();
    expect(await states()).toEqual(['Match', 'Match']);
    const list = (await req(`/api/snapshots?id=${P1}`)).body;
    expect(list.steps[1].diffRatio).toBe(0);
    expect(list.steps[1].images).toEqual({ baseline: expect.any(String), current: expect.any(String), diff: expect.any(String) });
  });

  it('[BD-MOCK-SNAP-T004] [BD-MOCK-SNAP-T008] [BD-MOCK-SNAP-T009] 差分が閾値を超えると差分あり', async () => {
    await write(repo, 'docs/mocks/demo/index.html', html('b'));
    await capture();
    expect(await states()).toEqual(['Match', 'Diff']);
    const s2 = (await req(`/api/snapshots?id=${P1}`)).body.steps[1];
    expect(s2.diffRatio).toBeGreaterThan(0.001);
    await capture();
    expect(await states()).toEqual(['Match', 'Diff']);
  });

  it('[BD-MOCK-SNAP-T006] 差分ありを承認すると一致', async () => {
    const bad = await req('/api/snapshots/approve', { id: P1, steps: [3] });
    expect(bad.status).toBe(400);
    const r = await req('/api/snapshots/approve', { id: P1, steps: [2] });
    expect(r.body.steps.map((s: any) => s.status)).toEqual(['Match', 'Match']);
    expect(r.body.steps[1].images.diff).toBeUndefined();
  });

  it('[BD-MOCK-SNAP-T010] 差分ありの後に基準と同じ画面に戻れば一致', async () => {
    await write(repo, 'docs/mocks/demo/index.html', html('a'));
    await capture();
    expect(await states()).toEqual(['Match', 'Diff']);
    await write(repo, 'docs/mocks/demo/index.html', html('b'));
    await capture();
    expect(await states()).toEqual(['Match', 'Match']);
  });

  it('撮影環境が基準と違えば warning を付ける', async () => {
    const p = path.join(repo, `.ddv/snapshots/baseline/${P1}/meta.json`);
    const meta = JSON.parse(await fs.readFile(p, 'utf8'));
    await fs.writeFile(p, JSON.stringify({ ...meta, browser: 'msedge' }));
    const steps = (await req(`/api/snapshots?id=${P1}`)).body.steps;
    expect(steps[0].warnings[0]).toMatch(/^撮影環境が基準と異なります（基準: msedge 320×240、今回: chromium 320×240）/);
  });

  it('ステップが失敗するとそのシナリオの撮影を打ち切り、以降は未撮影', async () => {
    await write(repo, `docs/mocks/demo/scenarios/${P1}.yaml`, scenarioYaml(P1, { badScreen: true }));
    const events: Array<[string, any]> = [];
    const svc2 = new SnapshotService(repo, () => ctx.config, { stepTimeout: 300 });
    const sum = await svc2.capture([P1], { log: () => {}, event: (n, d) => events.push([n, d]) });
    expect(sum.status).toBe('failed');
    expect(events.map((e) => e[0])).toEqual(['step', 'scenario']);
    expect(events[1][1]).toMatchObject({ id: P1, status: 'failed', captured: 1, message: expect.stringContaining('ステップ 2') });
    expect(await states()).toEqual(['Match', 'None']);
    expect((await req('/api/snapshots/approve', { id: P1 })).status).toBe(400);
    // all-approve after the scenario got shorter removes the extra baseline files
    const short: Scenario = { id: P1, title: 't', fixtures: [], start: 'List', steps: [{ event: '新規', click: 'new', expect: { screen: 'Input' } }] };
    await fs.writeFile(file(), `id: ${short.id}\ntitle: t\nstart: List\nsteps:\n  - event: 新規\n    click: new\n    expect: { screen: Input }\n`);
    await capture();
    const r = await req('/api/snapshots/approve', { id: P1 });
    expect(r.body.approved).toEqual([1]);
    expect(existsSync(path.join(repo, `.ddv/snapshots/baseline/${P1}/002.png`))).toBe(false);
  });
});
