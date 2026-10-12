import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@ddv/core/node';
import { generateAll } from '@ddv/testid';
import { createApp, createContext, type ServerContext } from './app.ts';
import { changedRows, classify, elementClasses, entriesOf, firstFailure, flakyCommits, recentMarks, type HistoryEntry } from './history.ts';
import { RUNS_DIR, type RunRecord } from './runs.ts';
import { TRACES_DIR } from './prune.ts';

type S = HistoryEntry['status'];
const e = (runId: string, status: S, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ runId, at: runId, status, durationMs: 1, trace: false, ...extra });
const rows = (...statuses: S[]) => statuses.map((s, i) => e(`r${i}`, s));

describe('失敗し始めた実行（DD-HIST-FIRSTFAIL）', () => {
  it('[DD-HIST-FIRSTFAIL-P001] [DD-HIST-FIRSTFAIL-T001] [DD-HIST-FIRSTFAIL-T002] 先頭が失敗でなければなし', () => {
    expect(firstFailure(rows('passed', 'failed'))).toBeUndefined();
    expect(firstFailure(rows('skipped', 'failed'))).toBeUndefined();
    expect(firstFailure([])).toBeUndefined();
  });

  it('[DD-HIST-FIRSTFAIL-P002] [DD-HIST-FIRSTFAIL-T003] [DD-HIST-FIRSTFAIL-T004] [DD-HIST-FIRSTFAIL-T005] 失敗が 1 行だけなら先頭', () => {
    expect(firstFailure(rows('error'))?.runId).toBe('r0');
  });

  it('[DD-HIST-FIRSTFAIL-P003] [DD-HIST-FIRSTFAIL-T006] [DD-HIST-FIRSTFAIL-T007] [DD-HIST-FIRSTFAIL-T010] 失敗が続いて終わるなら最も古い失敗', () => {
    expect(firstFailure(rows('failed', 'error'))?.runId).toBe('r1');
  });

  it('[DD-HIST-FIRSTFAIL-P004] [DD-HIST-FIRSTFAIL-T009] 失敗が続いた後に成功があればその手前', () => {
    expect(firstFailure(rows('failed', 'failed', 'passed', 'failed'))?.runId).toBe('r1');
  });

  it('[DD-HIST-FIRSTFAIL-P005] [DD-HIST-FIRSTFAIL-T008] [DD-HIST-FIRSTFAIL-T011] スキップは飛ばす（候補は変えない）', () => {
    expect(firstFailure(rows('failed', 'skipped'))?.runId).toBe('r0');
  });

  it('[DD-HIST-FIRSTFAIL-P006] スキップを飛ばした後に成功があれば候補', () => {
    expect(firstFailure(rows('failed', 'skipped', 'passed'))?.runId).toBe('r0');
    expect(firstFailure(rows('failed', 'skipped', 'error', 'passed'))?.runId).toBe('r2');
  });

  it('[DD-HIST-FIRSTFAIL-P007] 先頭の次が成功なら先頭', () => {
    expect(firstFailure(rows('error', 'passed'))?.runId).toBe('r0');
  });
});

describe('フレーキーの判定（DD-HIST-FLAKY）', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  it('[DD-HIST-FLAKY-P001] [DD-HIST-FLAKY-T001] [DD-HIST-FLAKY-T002] [DD-HIST-FLAKY-T003] [DD-HIST-FLAKY-T004] [DD-HIST-FLAKY-T005] 変更あり・不明・スキップ・error を除くと両方そろわなければ安定', () => {
    const entries = [
      e('1', 'passed', { commit: A, dirty: false }),
      e('2', 'failed', { commit: A, dirty: true }),
      e('3', 'failed', { commit: A }),
      e('4', 'error', { commit: A, dirty: false }),
      e('5', 'skipped', { commit: A, dirty: false }),
      e('6', 'failed', { dirty: false }),
      e('7', 'failed', { commit: B, dirty: false }),
    ];
    expect(flakyCommits(entries)).toEqual([]);
    expect(flakyCommits([])).toEqual([]);
  });

  it('[DD-HIST-FLAKY-P002] [DD-HIST-FLAKY-T006] 同じコミットで成功と失敗があればそのコミットを新しい順に返す（再実行も数える）', () => {
    const entries = [
      e('1', 'passed', { commit: B, dirty: false, rerunOf: '3', attempt: 2 }),
      e('2', 'failed', { commit: B, dirty: false, rerunOf: '3', attempt: 1 }),
      e('3', 'failed', { commit: A, dirty: false }),
      e('4', 'passed', { commit: A, dirty: false }),
    ];
    expect(flakyCommits(entries)).toEqual([B, A]);
  });
});

describe('カバレッジの分類（DD-HIST-CLASSIFY）', () => {
  const ID = ['DD', 'A', 'B', 'T001'].join('-');
  it('[DD-HIST-CLASSIFY-P001] [DD-HIST-CLASSIFY-T001] [DD-HIST-CLASSIFY-T002] 紐づいていなければ（結果があっても）unlinked', () => {
    expect(classify(ID, false, undefined)).toBe('unlinked');
    expect(classify(ID, false, { status: 'passed' })).toBe('unlinked');
  });
  it('[DD-HIST-CLASSIFY-P002] [DD-HIST-CLASSIFY-T003] [DD-HIST-CLASSIFY-T004] 結果が無ければ unexecuted', () => {
    expect(classify(ID, true, undefined)).toBe('unexecuted');
  });
  it('[DD-HIST-CLASSIFY-P003] [DD-HIST-CLASSIFY-T005] [DD-HIST-CLASSIFY-T006] passed', () => {
    expect(classify(ID, true, { status: 'passed' })).toBe('passed');
  });
  it('[DD-HIST-CLASSIFY-P004] [DD-HIST-CLASSIFY-T007] failed と error は failed', () => {
    expect(classify(ID, true, { status: 'failed' })).toBe('failed');
    expect(classify(ID, true, { status: 'error' })).toBe('failed');
  });
  it('[DD-HIST-CLASSIFY-P005] [DD-HIST-CLASSIFY-T008] skipped', () => {
    expect(classify(ID, true, { status: 'skipped' })).toBe('skipped');
  });
});

describe('図の色分け（DD-HIST-ELEMENT）', () => {
  const graph = { nodes: ['S', 'A', 'B', 'C', 'Z'].map((id) => ({ id })), edges: [0, 1, 2, 3].map((index) => ({ index })) } as never;
  // S -0-> A -1-> B -2-> C ; A -3-> C. Z has no case.
  const matrix = {
    graph,
    cases: [
      { id: 'p1', kind: 'P', edges: [0, 1, 2], nodes: ['S', 'A', 'B', 'C'] },
      { id: 't1', kind: 'T', edges: [0, 1], nodes: ['S', 'A', 'B'] },
      { id: 't2', kind: 'T', edges: [0, 3], nodes: ['S', 'A', 'C'] },
      { id: 's1', kind: 'S', edges: [0, 1, 2], nodes: ['S', 'A', 'B', 'C'] },
    ],
  };

  it('[DD-HIST-ELEMENT-P001] [DD-HIST-ELEMENT-T001] [DD-HIST-ELEMENT-T002] [DD-HIST-ELEMENT-T003] 要素を含む T・P のケースが無ければ分類なし', () => {
    const out = elementClasses(matrix, { t1: 'failed', s1: 'passed' });
    // T is one transition and its two ends: the prefix edge 0 / node S are not coloured. S cases are not used.
    expect(out).toEqual({ edges: { 1: 'failed' }, nodes: { A: 'failed', B: 'failed' } });
    expect(out.nodes.Z).toBeUndefined();
  });

  it('[DD-HIST-ELEMENT-P002] [DD-HIST-ELEMENT-T004] 複数のケースなら順位の最も高い分類（passed > failed > skipped > unexecuted > unlinked）', () => {
    const out = elementClasses(matrix, { p1: 'unlinked', t1: 'skipped', t2: 'unexecuted' });
    expect(out.edges).toEqual({ 0: 'unlinked', 1: 'skipped', 2: 'unlinked', 3: 'unexecuted' });
    expect(out.nodes).toEqual({ S: 'unlinked', A: 'skipped', B: 'skipped', C: 'unexecuted' });
    expect(elementClasses(matrix, { p1: 'failed', t1: 'passed' }).nodes).toMatchObject({ A: 'passed', B: 'passed', C: 'failed' });
  });
});

describe('推移の計算', () => {
  it('結果が変わった行（最も古い行は含めない）と直近 10 回', () => {
    const entries = rows('failed', 'failed', 'passed', 'skipped');
    expect(changedRows(entries)).toEqual(['r1', 'r2']);
    expect(changedRows(rows('passed'))).toEqual([]);
    expect(recentMarks(entries, 6)).toEqual(['failed', 'failed', 'passed', 'skipped', 'none', 'none']);
    expect(recentMarks(rows(...Array<S>(12).fill('passed')))).toHaveLength(10);
  });

  it('entriesOf は結果のある実行だけを、トレースの有無と再実行の項目つきで返す', () => {
    const run = (id: string, results: RunRecord['results'], extra: Partial<RunRecord> = {}): RunRecord => ({ id, kind: 'test', startedAt: `${id}s`, status: 'passed', request: {}, runners: [], results, log: [], ...extra });
    const res = { status: 'failed' as const, durationMs: 5, message: 'boom', runner: 'u', test: 't' };
    const runs = [run('b', { X: res }, { finishedAt: 'bf', commit: 'c', dirty: false, rerunOf: 'a', attempt: 1, times: 2, traces: ['X'] }), run('n', {}), run('a', { X: { ...res, message: undefined, status: 'passed' } })];
    expect(entriesOf(runs, 'X', (r) => r === 'b')).toEqual([
      { runId: 'b', at: 'bf', commit: 'c', dirty: false, rerunOf: 'a', attempt: 1, times: 2, status: 'failed', durationMs: 5, message: 'boom', trace: true },
      { runId: 'a', at: 'as', status: 'passed', durationMs: 5, trace: false },
    ]);
    // A trace listed in the record but already pruned is reported as absent.
    expect(entriesOf(runs, 'X', () => false)[0].trace).toBe(false);
  });
});

describe('履歴・フレーキー・カバレッジ・再実行の API', () => {
  const ctxs: ServerContext[] = [];
  const tmps: string[] = [];
  afterEach(async () => {
    for (const c of ctxs.splice(0)) c.close();
    for (const t of tmps.splice(0)) await fs.rm(t, { recursive: true, force: true });
  });

  const DOC = [
    '---',
    'id: CALC',
    'kind: detailed',
    'title: 計算',
    '---',
    '',
    '# 計算',
    '',
    '```mermaid id=flow code=FLOW matrix nswitch=0',
    'flowchart TD',
    '  A[入力] --> B{正しい}',
    '  B -->|はい| C[計算]',
    '  B -->|いいえ| D[エラー]',
    '```',
    '',
  ].join('\n');

  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-hist-'));
    tmps.push(root);
    await fs.mkdir(path.join(root, 'docs/detailed'), { recursive: true });
    await fs.writeFile(path.join(root, 'ddv.config.yaml'), 'docsRoot: docs\nrunners:\n  - name: unit\n    type: vitest\n');
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x","version":"1.0.0","private":true,"devDependencies":{"vitest":"*"}}');
    await fs.writeFile(path.join(root, 'docs/detailed/calc.md'), DOC);
    await generateAll(root, await loadConfig(root), { write: true });
    const id = (k: string) => ['DD', 'CALC', 'FLOW', k].join('-');
    // P001/P002/T001..T003 exist; link P001, T001, T002 and T003 (P002 stays unlinked).
    const linked = [id('P001'), id('T001'), id('T002'), id('T003')];
    await fs.writeFile(path.join(root, 'calc.test.ts'), linked.map((x) => `it('[${x}] x', () => {});`).join('\n') + '\n');
    return { root, id };
  }

  async function writeRuns(root: string, runs: Array<Partial<RunRecord> & { id: string; results: RunRecord['results'] }>) {
    await fs.mkdir(path.join(root, RUNS_DIR), { recursive: true });
    for (const r of runs) await fs.writeFile(path.join(root, RUNS_DIR, `${r.id}.json`), JSON.stringify({ kind: 'test', status: 'failed', request: {}, runners: [], log: [], ...r }));
  }

  async function open(root: string) {
    const ctx = await createContext(root, { watch: false });
    ctxs.push(ctx);
    const app = createApp(ctx);
    const json = async (p: string, init?: RequestInit) => {
      const res = await app.request(p, init);
      return { status: res.status, body: (await res.json()) as any };
    };
    const post = (p: string, body: unknown) => json(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ctx, json, post };
  }

  const res = (status: S, message?: string) => ({ status, durationMs: 1200, runner: 'unit', test: 't', ...(message ? { message } : {}) });
  const C1 = '1'.repeat(40);

  it('summary・tests/{id}・flaky・coverage を返す', async () => {
    const { root, id } = await setup();
    const T1 = id('T001');
    const T2 = id('T002');
    const T3 = id('T003');
    const P1 = id('P001');
    const at = (m: number) => new Date(Date.UTC(2025, 0, 1, 0, m)).toISOString();
    await writeRuns(root, [
      { id: 'r1', startedAt: at(1), finishedAt: at(2), commit: C1, dirty: false, results: { [T1]: res('passed'), [T2]: res('passed') } },
      { id: 'r2', startedAt: at(3), finishedAt: at(4), commit: C1, dirty: false, results: { [T1]: res('failed', 'expected 1\nstack'), [T2]: res('passed'), [P1]: res('skipped') } },
      { id: 'r3', startedAt: at(5), results: { [T1]: res('error', 'boom'), [T3]: res('failed') }, traces: [T1] },
    ]);
    await fs.mkdir(path.join(root, TRACES_DIR, 'r3'), { recursive: true });
    await fs.writeFile(path.join(root, TRACES_DIR, 'r3', `${T1}.json`), '{}');
    const { json } = await open(root);

    const summary = (await json('/api/history/summary')).body;
    expect(summary.flakyCount).toBe(1);
    expect(summary.rerunnable).toBe(2);
    expect(summary.tests[T1]).toMatchObject({ flaky: true, flakyCommits: [C1] });
    expect(summary.tests[T1].recent).toEqual(['error', 'failed', 'passed', 'none', 'none', 'none', 'none', 'none', 'none', 'none']);
    expect(summary.tests[T2].flaky).toBe(false);

    const h = await json(`/api/history/tests/${T1}`);
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ id: T1, known: true, doc: 'docs/detailed/calc.md', diagram: 'flow', changed: ['r3', 'r2'], flakyCommits: [C1] });
    expect(h.body.entries.map((x: HistoryEntry) => [x.runId, x.status, x.trace])).toEqual([
      ['r3', 'error', true],
      ['r2', 'failed', false],
      ['r1', 'passed', false],
    ]);
    expect(h.body.firstFailure.runId).toBe('r2');
    expect((await json(`/api/history/tests/${id('T009')}`)).body).toMatchObject({ code: 'unknown-id' });
    expect((await json(`/api/history/tests/${id('T009')}`)).status).toBe(404);

    const flaky = (await json('/api/history/flaky')).body;
    expect(flaky).toEqual([{ id: T1, doc: 'docs/detailed/calc.md', commits: [{ commit: C1, passed: 1, failed: 1 }], lastFailedAt: at(5), lastFailedRun: 'r3' }]);

    const cov = (await json('/api/coverage?path=docs/detailed/calc.md')).body;
    expect(cov.cases).toMatchObject({ [P1]: 'skipped', [id('P002')]: 'unlinked', [T1]: 'failed', [T2]: 'passed', [T3]: 'failed' });
    expect(cov.total).toEqual({ ids: 5, linked: 4, executed: 4, passed: 1 });
    expect(cov.diagrams.flow).toEqual(cov.total);
    expect(Object.keys(cov.elements.flow.edges).length).toBeGreaterThan(0);
    expect((await json('/api/coverage?path=docs/detailed/none.md')).status).toBe(404);

    const runs = (await json('/api/runs')).body;
    expect(runs[0]).toMatchObject({ id: 'r3', total: 2 });
    expect(runs[0].traces).toBeUndefined();
    expect(runs.find((r: RunRecord) => r.id === 'r1')).toMatchObject({ commit: C1, dirty: false });
    expect((await json('/api/runs/r3')).body.traces).toEqual([T1]);
  });

  it('POST /api/tests/rerun：400 times-invalid・409 no-failures / 実行中 / deps-missing・202 と SSE run', async () => {
    const { root, id } = await setup();
    const { ctx, post } = await open(root);
    expect(await post('/api/tests/rerun', { times: 0 })).toMatchObject({ status: 400, body: { code: 'times-invalid', error: 'times は 1〜5 の整数です' } });
    expect(await post('/api/tests/rerun', { times: '2' })).toMatchObject({ status: 400, body: { code: 'times-invalid' } });
    expect(await post('/api/tests/rerun', { times: 2 })).toMatchObject({ status: 409, body: { code: 'no-failures', error: '直近の実行に失敗したテストはありません' } });

    // A failure to re-run: an id that the runner cannot run here (vitest is not installed in the temp repo).
    const ended = new Promise<void>((resolve) => ctx.runs.once('end', () => resolve()));
    expect((await post('/api/tests/run', { ids: [id('P002')] })).status).toBe(202);
    await ended;

    ctx.checkDeps = true;
    expect(await post('/api/tests/rerun', { times: 1 })).toMatchObject({ status: 409, body: { code: 'deps-missing' } });
    ctx.checkDeps = false;

    const events: unknown[] = [];
    ctx.runs.on('run', (_id: string, r: RunRecord) => events.push({ attempt: r.attempt, times: r.times }));
    const all = new Promise<void>((resolve) => ctx.runs.on('end', () => !ctx.runs.rerunSession && !ctx.runs.active && resolve()));
    const r = await post('/api/tests/rerun', { times: 2 });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'running', attempt: 1, times: 2, rerunOf: expect.any(String) });
    expect(await post('/api/tests/rerun', { times: 2 })).toMatchObject({ status: 409, body: { error: '別のテスト実行が進行中です' } });
    expect(await post('/api/tests/run', {})).toMatchObject({ status: 409 });
    await all;
    expect(events).toEqual([{ attempt: 2, times: 2 }]);
    const list = ctx.runs.list();
    expect(list.slice(0, 2).map((x) => x.attempt)).toEqual([2, 1]);
  });
});

describe('基本設計：設計カバレッジ（BD-TMON-COV）', () => {
  // T001 = 入力→種類, T002..T006 = the five branches, P001..P005 = the paths. Removing the branch 「五」 retires one T and one P.
  const doc = (branches: number) =>
    ['---', 'id: KIND', 'kind: detailed', 'title: 種類', '---', '', '# 種類', '', '```mermaid id=kind code=KIND matrix nswitch=0', 'flowchart TD', '  A[入力] --> B{種類}']
      .concat(['一', '二', '三', '四', '五'].slice(0, branches).map((n, i) => `  B -->|${i + 1}| N${i}[${n}]`))
      .concat(['```', ''])
      .join('\n');
  const id = (k: string) => ['DD', 'KIND', 'KIND', k].join('-');
  const at = (m: number) => new Date(Date.UTC(2025, 0, 1, 0, m)).toISOString();
  const res = (status: S) => ({ status, durationMs: 1, runner: 'unit', test: 't' });

  let root: string;
  let ctx: ServerContext;
  let cov: any;
  let retired: string[];

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-cov-'));
    await fs.mkdir(path.join(root, 'docs/detailed'), { recursive: true });
    await fs.writeFile(path.join(root, 'ddv.config.yaml'), 'docsRoot: docs\nrunners:\n  - name: unit\n    type: vitest\n');
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x","version":"1.0.0","private":true,"devDependencies":{"vitest":"*"}}');
    const file = path.join(root, 'docs/detailed/kind.md');
    await fs.writeFile(file, doc(5));
    const before = new Set((await generateAll(root, await loadConfig(root), { write: true })).matrices[0].cases.map((c) => c.id));
    await fs.writeFile(file, doc(4));
    const after = new Set((await generateAll(root, await loadConfig(root), { write: true })).matrices[0].cases.map((c) => c.id));
    retired = [...before].filter((x) => !after.has(x));
    // Linked: T001..T005 and the retired ids. P001..P004 stay unlinked.
    const linked = ['T001', 'T002', 'T003', 'T004', 'T005'].map(id).concat(retired);
    await fs.writeFile(path.join(root, 'kind.test.ts'), linked.map((x) => `it('[${x}] x', () => {});`).join('\n') + '\n');
    await fs.mkdir(path.join(root, RUNS_DIR), { recursive: true });
    const runs = [
      // Older results are superseded by the newest one of each id.
      { id: 'r1', startedAt: at(1), results: { [id('T001')]: res('failed'), [id('T002')]: res('passed'), [id('T004')]: res('passed') } },
      { id: 'r2', startedAt: at(2), results: { [id('T001')]: res('passed'), [id('T002')]: res('failed'), [id('T003')]: res('error'), [id('T004')]: res('skipped'), ...Object.fromEntries(retired.map((x) => [x, res('passed')])) } },
    ];
    for (const r of runs) await fs.writeFile(path.join(root, RUNS_DIR, `${r.id}.json`), JSON.stringify({ kind: 'test', status: 'failed', request: {}, runners: [], log: [], ...r }));
    ctx = await createContext(root, { watch: false });
    cov = await (await createApp(ctx).request('/api/coverage?path=docs/detailed/kind.md')).json();
  });

  afterAll(async () => {
    ctx?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('[BD-TMON-COV-P001] [BD-TMON-COV-T001] [BD-TMON-COV-T002] [BD-TMON-COV-S001] ロックで欠番のIDは、紐づけ・結果があっても集計しない', () => {
    expect(retired.sort()).toEqual([id('P005'), id('T006')]);
    for (const x of retired) expect(cov.cases[x]).toBeUndefined();
    // 9 active ids: T001..T005 and P001..P004.
    expect(Object.keys(cov.cases)).toHaveLength(9);
    expect(cov.total).toEqual({ ids: 9, linked: 5, executed: 4, passed: 1 });
    expect(cov.diagrams.kind).toEqual(cov.total);
  });

  it('[BD-TMON-COV-P002] [BD-TMON-COV-T003] [BD-TMON-COV-T004] [BD-TMON-COV-S002] [BD-TMON-COV-S003] 有効でテストに紐づいていなければ未紐づけ', () => {
    for (const k of ['P001', 'P002', 'P003', 'P004']) expect(cov.cases[id(k)]).toBe('unlinked');
  });

  it('[BD-TMON-COV-P003] [BD-TMON-COV-T005] [BD-TMON-COV-T006] [BD-TMON-COV-S004] [BD-TMON-COV-S005] 紐づいていて結果が履歴に無ければ未実行', () => {
    expect(cov.cases[id('T005')]).toBe('unexecuted');
  });

  it('[BD-TMON-COV-P004] [BD-TMON-COV-T007] [BD-TMON-COV-T008] [BD-TMON-COV-S006] [BD-TMON-COV-S007] 最新の結果が passed なら成功（古い失敗は見ない）', () => {
    expect(cov.cases[id('T001')]).toBe('passed');
  });

  it('[BD-TMON-COV-P005] [BD-TMON-COV-T009] [BD-TMON-COV-S008] 最新の結果が failed または error なら失敗（古い成功は見ない）', () => {
    expect(cov.cases[id('T002')]).toBe('failed');
    expect(cov.cases[id('T003')]).toBe('failed');
  });

  it('[BD-TMON-COV-P006] [BD-TMON-COV-T010] [BD-TMON-COV-S009] 最新の結果が skipped ならスキップ', () => {
    expect(cov.cases[id('T004')]).toBe('skipped');
  });
});

describe('基本設計：フレーキーの判定（BD-TMON-FLAKY）', () => {
  const ID = ['DD', 'A', 'B', 'T001'].join('-');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const roots: string[] = [];
  const ctxs: ServerContext[] = [];
  afterAll(async () => {
    for (const c of ctxs) c.close();
    for (const r of roots) await fs.rm(r, { recursive: true, force: true });
  });

  /** Summary, history and flaky list of `ID` computed from the given runs (oldest first). */
  async function judge(runs: Array<{ status: S; commit?: string; dirty?: boolean }>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-flaky-'));
    roots.push(root);
    await fs.mkdir(path.join(root, RUNS_DIR), { recursive: true });
    await fs.writeFile(path.join(root, 'ddv.config.yaml'), 'docsRoot: docs\nrunners: []\n');
    for (const [i, r] of runs.entries()) {
      const rec = { id: `r${i}`, kind: 'test', startedAt: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(), status: r.status, request: {}, runners: [], log: [], results: { [ID]: { status: r.status, durationMs: 1, runner: 'unit', test: 't' } } };
      if (r.commit !== undefined) Object.assign(rec, { commit: r.commit });
      if (r.dirty !== undefined) Object.assign(rec, { dirty: r.dirty });
      await fs.writeFile(path.join(root, RUNS_DIR, `${rec.id}.json`), JSON.stringify(rec));
    }
    const ctx = await createContext(root, { watch: false });
    ctxs.push(ctx);
    const app = createApp(ctx);
    const get = async (p: string) => (await app.request(p)).json() as Promise<any>;
    const summary = await get('/api/history/summary');
    return { test: summary.tests[ID], flakyCount: summary.flakyCount, history: await get(`/api/history/tests/${ID}`), flaky: await get('/api/history/flaky') };
  }

  it('[BD-TMON-FLAKY-P001] [BD-TMON-FLAKY-T001] [BD-TMON-FLAKY-T002] [BD-TMON-FLAKY-S001] コミットが分かり変更の無い実行が無ければ判定しない（不明・変更ありの成否が割れていても）', async () => {
    const r = await judge([
      { status: 'passed' },
      { status: 'failed' },
      { status: 'passed', commit: A, dirty: true },
      { status: 'failed', commit: A, dirty: true },
    ]);
    expect(r.history.entries).toHaveLength(4);
    expect(r.test).toMatchObject({ flaky: false, flakyCommits: [] });
    expect(r.history.flakyCommits).toEqual([]);
    expect(r.flakyCount).toBe(0);
    expect(r.flaky).toEqual([]);
  });

  it('[BD-TMON-FLAKY-P002] [BD-TMON-FLAKY-T003] [BD-TMON-FLAKY-T004] [BD-TMON-FLAKY-S002] [BD-TMON-FLAKY-S003] 同じコミット（変更なし）に passed と failed の両方があればフレーキー', async () => {
    const r = await judge([
      { status: 'failed', commit: A, dirty: false },
      { status: 'passed', commit: A, dirty: false },
      { status: 'passed', commit: B, dirty: false },
    ]);
    expect(r.test).toMatchObject({ flaky: true, flakyCommits: [A] });
    expect(r.history.flakyCommits).toEqual([A]);
    expect(r.flakyCount).toBe(1);
    expect(r.flaky).toMatchObject([{ id: ID, commits: [{ commit: A, passed: 1, failed: 1 }], lastFailedRun: 'r0' }]);
  });

  it('[BD-TMON-FLAKY-P003] [BD-TMON-FLAKY-T005] [BD-TMON-FLAKY-S004] コミットが変わって成否が変わっただけなら安定', async () => {
    const r = await judge([
      { status: 'passed', commit: A, dirty: false },
      { status: 'failed', commit: B, dirty: false },
      { status: 'failed', commit: B, dirty: false },
      { status: 'error', commit: A, dirty: false },
      { status: 'skipped', commit: B, dirty: false },
    ]);
    expect(r.test).toMatchObject({ flaky: false, flakyCommits: [] });
    expect(r.history.flakyCommits).toEqual([]);
    expect(r.flakyCount).toBe(0);
    expect(r.flaky).toEqual([]);
  });
});
