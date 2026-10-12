import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type DdvConfig } from '@ddv/core';
import { RepoStateReader, type RepoState } from './repo-state.ts';
import { BUSY_MESSAGE, RerunError, RunManager, RUNS_DIR, type RunRecord } from './runs.ts';
import { TRACES_DIR } from './prune.ts';

const ID1 = ['DD', 'A', 'B', 'T001'].join('-');
const ID2 = ['DD', 'A', 'B', 'T002'].join('-');
const SHA = 'b'.repeat(40);

class FixedState extends RepoStateReader {
  gate: Promise<void> | null = null;
  constructor(private state: RepoState | null) {
    super(async () => '');
  }
  override async read() {
    if (this.gate) await this.gate;
    return this.state;
  }
}

let repo: string;
beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-rerun-'));
});
afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

function manager(config: DdvConfig = parseConfig({}), state: RepoState | null = { commit: SHA, dirty: false }, reader = new FixedState(state)) {
  const runs = new RunManager(repo, () => config, { repoState: reader });
  runs.setMaxListeners(50);
  return runs;
}

const nextEnd = (runs: RunManager) => new Promise<RunRecord>((resolve) => runs.once('end', (_id: string, r: RunRecord) => resolve(r)));

/** Waits until `n` test runs have ended (re-run attempts end one by one). */
function ends(runs: RunManager, n: number) {
  const out: RunRecord[] = [];
  return new Promise<RunRecord[]>((resolve) => {
    const on = (_id: string, r: RunRecord) => {
      if ((r.kind ?? 'test') !== 'test') return;
      out.push(r);
      if (out.length === n) {
        runs.off('end', on);
        resolve(out);
      }
    };
    runs.on('end', on);
  });
}

/** A finished run whose ids are unlinked: every requested id ends as `error` (a failure to re-run). */
async function failedRun(runs: RunManager, ids = [ID1, ID2]) {
  const done = nextEnd(runs);
  runs.start({ ids });
  return done;
}

const slow = () => parseConfig({ runners: [{ name: 'slow', type: 'command', cwd: '.', level: 'unit', command: 'node -e "setTimeout(()=>{},600)"' }] });

describe('失敗の再実行（DD-RUNREC-RERUN）', () => {
  it('[DD-RUNREC-RERUN-T001] [DD-RUNREC-RERUN-T002] [DD-RUNREC-RERUN-T003] 待機 → start → 実行終了で待機に戻り、開始時のコミットを記録する', async () => {
    const runs = manager();
    expect(runs.active).toBeNull();
    const r = await failedRun(runs);
    expect(runs.active).toBeNull();
    expect(runs.rerunSession).toBeNull();
    expect(r).toMatchObject({ commit: SHA, dirty: false, status: 'error' });
    expect(r.rerunOf).toBeUndefined();
    const saved = JSON.parse(await fs.readFile(path.join(repo, RUNS_DIR, `${r.id}.json`), 'utf8'));
    expect(saved).toMatchObject({ commit: SHA, dirty: false });
  });

  it('[DD-RUNREC-RERUN-T004] [DD-RUNREC-RERUN-T006] [DD-RUNREC-RERUN-T007] 失敗ありの rerun は同じ ids を times 回続け、各回の間も active を空けずに待機へ戻る', async () => {
    const runs = manager(parseConfig({}), { commit: SHA, dirty: true });
    const origin = await failedRun(runs);
    const started: RunRecord[] = [];
    runs.on('run', (_id: string, r: RunRecord) => started.push(r));
    const between: Array<{ active: string | undefined; session: boolean }> = [];
    runs.on('end', (id: string) => between.push({ active: runs.active?.id, session: !!runs.rerunSession }));
    const all = ends(runs, 3);
    const first = runs.rerun(3);
    expect(first).toMatchObject({ rerunOf: origin.id, attempt: 1, times: 3, status: 'running' });
    expect(runs.rerunSession).toMatchObject({ originId: origin.id, times: 3, attempt: 1 });
    expect(runs.rerunSession!.ids.sort()).toEqual([ID1, ID2]);
    const done = await all;
    expect(done.map((r) => [r.rerunOf, r.attempt, r.times])).toEqual([
      [origin.id, 1, 3],
      [origin.id, 2, 3],
      [origin.id, 3, 3],
    ]);
    // Same ids every attempt; each attempt reads the repository state.
    for (const r of done) {
      expect(Object.keys(r.results).sort()).toEqual([ID1, ID2]);
      expect(r).toMatchObject({ commit: SHA, dirty: true });
    }
    expect(started.map((r) => r.attempt)).toEqual([2, 3]);
    expect(between[0]).toEqual({ active: done[1].id, session: true });
    expect(between[1]).toEqual({ active: done[2].id, session: true });
    expect(between[2]).toEqual({ active: undefined, session: false });
    expect(runs.active).toBeNull();
    expect(runs.rerunSession).toBeNull();
    // The latest record is a re-run: its origin is used again.
    expect(runs.failedIdsOfLatest().sort()).toEqual([ID1, ID2]);
    expect(runs.list()[0].id).toBe(done[2].id);
  });

  it('[DD-RUNREC-RERUN-T005] 失敗なしの rerun は no-failures で状態を変えない', async () => {
    const runs = manager();
    expect(() => runs.rerun(2)).toThrow(RerunError);
    try {
      runs.rerun(2);
    } catch (e) {
      expect(e).toMatchObject({ code: 'no-failures', message: '直近の実行に失敗したテストはありません' });
    }
    expect(runs.active).toBeNull();
    expect(runs.rerunSession).toBeNull();
    expect(() => runs.rerun(0)).toThrow('times は 1〜5 の整数です');
    expect(() => runs.rerun(6)).toThrow(RerunError);
    expect(() => runs.rerun(1.5)).toThrow(RerunError);
  });

  it('[DD-RUNREC-RERUN-X001] 待機で「実行終了」が来ても待機のまま', async () => {
    const runs = manager();
    const done = nextEnd(runs);
    runs.startTask('snapshot', {}, async () => 'passed');
    await done;
    expect(runs.active).toBeNull();
    expect(runs.rerunSession).toBeNull();
  });

  it('[DD-RUNREC-RERUN-X002] 待機で「1 回終了」が来ても次の回を始めない', async () => {
    const runs = manager();
    const origin = await failedRun(runs);
    const stray: RunRecord = { id: 'stray', kind: 'test', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'failed', request: { ids: [ID1] }, runners: [], results: {}, log: [], rerunOf: origin.id, attempt: 1, times: 3 };
    let started = 0;
    runs.on('run', () => started++);
    await (runs as unknown as { finish(r: RunRecord): Promise<void> }).finish(stray);
    expect(started).toBe(0);
    expect(runs.active).toBeNull();
    expect(runs.rerunSession).toBeNull();
  });

  it('[DD-RUNREC-RERUN-X003] [DD-RUNREC-RERUN-X004] [DD-RUNREC-RERUN-X005] 実行中の start・rerun は拒否し、「1 回終了」では実行中を解放しない', async () => {
    const runs = manager(slow());
    await failedRun(runs, [ID1]);
    const active = runs.start({});
    const done = new Promise<void>((resolve) => runs.on('end', (id: string) => id === active.id && resolve()));
    expect(() => runs.start({})).toThrow(BUSY_MESSAGE);
    expect(() => runs.rerun(2)).toThrow(BUSY_MESSAGE);
    const stray: RunRecord = { ...active, id: 'stray', rerunOf: 'x', attempt: 1, times: 2, results: {}, log: [] };
    await (runs as unknown as { finish(r: RunRecord): Promise<void> }).finish(stray);
    expect(runs.active?.id).toBe(active.id);
    expect(runs.rerunSession).toBeNull();
    await done;
    expect(runs.active).toBeNull();
  });

  it('[DD-RUNREC-RERUN-X006] [DD-RUNREC-RERUN-X007] [DD-RUNREC-RERUN-X008] 再実行中の start・rerun は拒否し、他の「実行終了」では待機に戻らない', async () => {
    const runs = manager();
    await failedRun(runs);
    const all = ends(runs, 2);
    runs.rerun(2);
    expect(() => runs.start({})).toThrow(BUSY_MESSAGE);
    expect(() => runs.rerun(1)).toThrow(BUSY_MESSAGE);
    const task = new Promise<void>((resolve) => runs.on('end', (_id: string, r: RunRecord) => r.kind === 'snapshot' && resolve()));
    runs.startTask('snapshot', {}, async () => 'passed');
    await task;
    expect(runs.rerunSession).not.toBeNull();
    const done = await all;
    expect(done.map((r) => r.attempt)).toEqual([1, 2]);
    // Between the attempts too (start is refused while the session exists even if `active` were empty).
    expect(runs.rerunSession).toBeNull();
    expect(runs.active).toBeNull();
  });

  it('各回が error で終わっても残りの回を続ける', async () => {
    const runs = manager();
    await failedRun(runs);
    const all = ends(runs, 2);
    runs.rerun(2);
    const done = await all;
    expect(done.map((r) => r.status)).toEqual(['error', 'error']);
  });
});

describe('実行の終了（finish）と剪定', () => {
  it('トレースの一覧を記録し、保存の後に history の上限を超えた記録とトレースを消す', async () => {
    const config = parseConfig({ history: { maxRuns: 2, maxTraceRuns: 1 } });
    const reader = new FixedState(null);
    const runs = manager(config, null, reader);
    const a = await failedRun(runs);
    await fs.mkdir(path.join(repo, TRACES_DIR, a.id), { recursive: true });
    const b = await failedRun(runs);
    expect(b.commit).toBeUndefined();
    expect(b.dirty).toBeUndefined();
    // c writes a trace before it finishes.
    let open!: () => void;
    reader.gate = new Promise((resolve) => (open = resolve));
    const done = nextEnd(runs);
    const c = runs.start({ ids: [ID1] });
    await fs.mkdir(path.join(repo, TRACES_DIR, c.id), { recursive: true });
    await fs.writeFile(path.join(repo, TRACES_DIR, c.id, `${ID1}.json`), '{}');
    open();
    await done;
    expect(c.traces).toEqual([ID1]);
    expect(runs.list().map((r) => r.id)).toEqual([c.id, b.id]);
    expect(existsSync(path.join(repo, RUNS_DIR, `${a.id}.json`))).toBe(false);
    expect(existsSync(path.join(repo, TRACES_DIR, a.id))).toBe(false);
    expect(existsSync(path.join(repo, TRACES_DIR, c.id))).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(repo, RUNS_DIR, `${c.id}.json`), 'utf8'));
    expect(saved.traces).toEqual([ID1]);
  });

  it('起動時（load の後）にも剪定する', async () => {
    await fs.mkdir(path.join(repo, RUNS_DIR), { recursive: true });
    for (let i = 0; i < 3; i++) {
      const r = { id: `r${i}`, kind: 'test', startedAt: new Date(Date.UTC(2025, 0, 1, i)).toISOString(), status: 'passed', request: {}, runners: [], results: {}, log: [] };
      await fs.writeFile(path.join(repo, RUNS_DIR, `${r.id}.json`), JSON.stringify(r));
    }
    await fs.mkdir(path.join(repo, TRACES_DIR, 'orphan'), { recursive: true });
    const runs = manager(parseConfig({ history: { maxRuns: 2 } }));
    await runs.load();
    const p = await runs.prune();
    expect(p).toEqual({ runs: ['r0'], traces: ['orphan'] });
    expect(runs.list().map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(existsSync(path.join(repo, RUNS_DIR, 'r0.json'))).toBe(false);
  });

  it('history の設定：既定値と不正な値', () => {
    expect(parseConfig({}).history).toEqual({ maxRuns: 200, maxTraceRuns: 20 });
    expect(() => parseConfig({ history: { maxRuns: -1 } })).toThrow();
    expect(() => parseConfig({ history: { maxTraceRuns: 1.5 } })).toThrow();
  });
});

describe('実行記録の読み込み（DD-RUNREC-LOAD）', () => {
  async function write(name: string, body: string) {
    await fs.mkdir(path.join(repo, RUNS_DIR), { recursive: true });
    await fs.writeFile(path.join(repo, RUNS_DIR, name), body);
  }
  const rec = (id: string, status: string, extra: object = {}) => JSON.stringify({ id, kind: 'test', startedAt: '2025-01-01T00:00:00.000Z', status, request: {}, runners: [], results: {}, log: [], ...extra });

  it('[DD-RUNREC-LOAD-P001] [DD-RUNREC-LOAD-T001] [DD-RUNREC-LOAD-T002] JSON として読めない記録は無視して次へ', async () => {
    await write('broken.json', '{ not json');
    await write('ok.json', rec('ok', 'passed'));
    const runs = manager();
    await runs.load();
    expect([...runs.runs.keys()]).toEqual(['ok']);
  });

  it('[DD-RUNREC-LOAD-P002] [DD-RUNREC-LOAD-T003] [DD-RUNREC-LOAD-T004] [DD-RUNREC-LOAD-T006] [DD-RUNREC-LOAD-T007] 実行中のまま残った古い記録は error にしてコミット不明で登録（書き戻さない）', async () => {
    const body = rec('old', 'running');
    await write('old.json', body);
    const runs = manager();
    await runs.load();
    expect(runs.runs.get('old')).toMatchObject({ status: 'error' });
    expect(runs.runs.get('old')!.commit).toBeUndefined();
    expect(await fs.readFile(path.join(repo, RUNS_DIR, 'old.json'), 'utf8')).toBe(body);
  });

  it('[DD-RUNREC-LOAD-P003] [DD-RUNREC-LOAD-T008] 実行中のまま残った新しい記録は error にしてそのまま登録', async () => {
    await write('new.json', rec('new', 'running', { commit: SHA, dirty: true }));
    const runs = manager();
    await runs.load();
    expect(runs.runs.get('new')).toMatchObject({ status: 'error', commit: SHA, dirty: true });
  });

  it('[DD-RUNREC-LOAD-P004] [DD-RUNREC-LOAD-T005] 終わった古い記録（commit なし・項目の欠け）はコミット不明として登録', async () => {
    await write('legacy.json', JSON.stringify({ id: 'legacy', startedAt: '2024-01-01T00:00:00.000Z', status: 'failed', results: { [ID1]: { status: 'failed', durationMs: 1, runner: 'r', test: 't' } } }));
    const runs = manager();
    await runs.load();
    const r = runs.runs.get('legacy')!;
    expect(r).toMatchObject({ status: 'failed', log: [], runners: [], request: {} });
    expect(r.commit).toBeUndefined();
    expect(runs.failedIdsOfLatest()).toEqual([ID1]);
  });

  it('[DD-RUNREC-LOAD-P005] 終わった新しい記録はそのまま登録', async () => {
    await write('cur.json', rec('cur', 'passed', { commit: SHA, dirty: false, rerunOf: 'o', attempt: 2, times: 3, traces: [ID1] }));
    const runs = manager();
    await runs.load();
    expect(runs.runs.get('cur')).toMatchObject({ status: 'passed', commit: SHA, dirty: false, rerunOf: 'o', attempt: 2, times: 3, traces: [ID1] });
  });
});

describe('基本設計：保持件数（BD-TMON-PRUNE）', () => {
  /** Old runs r0 (oldest) .. r2, each with a trace; then one new run is saved (no trace) and pruned with the given limits. */
  async function saveAfter(history: { maxRuns: number; maxTraceRuns: number }) {
    await fs.mkdir(path.join(repo, RUNS_DIR), { recursive: true });
    for (let i = 0; i < 3; i++) {
      const r = { id: `r${i}`, kind: 'test', startedAt: new Date(Date.UTC(2025, 0, 1, i)).toISOString(), status: 'failed', request: {}, runners: [], results: {}, log: [], traces: [ID1] };
      await fs.writeFile(path.join(repo, RUNS_DIR, `${r.id}.json`), JSON.stringify(r));
      await fs.mkdir(path.join(repo, TRACES_DIR, r.id), { recursive: true });
      await fs.writeFile(path.join(repo, TRACES_DIR, r.id, `${ID1}.json`), '{}');
    }
    const runs = manager(parseConfig({ history }));
    await runs.load();
    const added = await failedRun(runs);
    const record = (id: string) => existsSync(path.join(repo, RUNS_DIR, `${id}.json`));
    const trace = (id: string) => existsSync(path.join(repo, TRACES_DIR, id));
    return {
      runs: runs.list().map((r) => r.id),
      records: ['r0', 'r1', 'r2', added.id].filter(record),
      traces: ['r0', 'r1', 'r2'].filter(trace),
      added,
    };
  }

  it('[BD-TMON-PRUNE-P001] [BD-TMON-PRUNE-T001] [BD-TMON-PRUNE-T002] [BD-TMON-PRUNE-T004] [BD-TMON-PRUNE-T005] [BD-TMON-PRUNE-T007] [BD-TMON-PRUNE-S001] [BD-TMON-PRUNE-S003] [BD-TMON-PRUNE-S006] [BD-TMON-PRUNE-S008] 実行記録が上限を超えたら古い記録とそのトレースを消し、残りのトレースも上限を超えたら古い実行のトレースだけ消す', async () => {
    const r = await saveAfter({ maxRuns: 3, maxTraceRuns: 1 });
    expect(r.runs).toEqual([r.added.id, 'r2', 'r1']);
    expect(r.records).toEqual(['r1', 'r2', r.added.id]);
    // r0 went with its record; r1 keeps its record but loses its trace.
    expect(r.traces).toEqual(['r2']);
  });

  it('[BD-TMON-PRUNE-P002] [BD-TMON-PRUNE-T006] [BD-TMON-PRUNE-S007] 実行記録が上限を超えたら古い記録とそのトレースを消し、トレースが上限以内なら終わる', async () => {
    const r = await saveAfter({ maxRuns: 3, maxTraceRuns: 5 });
    expect(r.records).toEqual(['r1', 'r2', r.added.id]);
    expect(r.traces).toEqual(['r1', 'r2']);
  });

  it('[BD-TMON-PRUNE-P003] [BD-TMON-PRUNE-T003] [BD-TMON-PRUNE-S002] [BD-TMON-PRUNE-S004] [BD-TMON-PRUNE-S008] 実行記録が上限以内でもトレースのある実行が上限を超えたら、古い実行のトレースだけ消して記録は残す', async () => {
    const r = await saveAfter({ maxRuns: 10, maxTraceRuns: 1 });
    expect(r.runs).toEqual([r.added.id, 'r2', 'r1', 'r0']);
    expect(r.records).toEqual(['r0', 'r1', 'r2', r.added.id]);
    expect(r.traces).toEqual(['r2']);
  });

  it('[BD-TMON-PRUNE-P004] [BD-TMON-PRUNE-S005] どちらも上限以内なら何も消さない', async () => {
    const r = await saveAfter({ maxRuns: 10, maxTraceRuns: 5 });
    expect(r.records).toEqual(['r0', 'r1', 'r2', r.added.id]);
    expect(r.traces).toEqual(['r0', 'r1', 'r2']);
  });
});
