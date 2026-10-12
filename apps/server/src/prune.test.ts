import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, plan, traceDirs, TRACES_DIR } from './prune.ts';

const run = (id: string, minute: number, extra: { kind?: string; status?: string } = {}) => ({
  id,
  startedAt: new Date(Date.UTC(2025, 0, 1, 0, minute)).toISOString(),
  status: 'passed',
  ...extra,
});

/** r1 (newest) .. r4 (oldest). */
const RUNS = [run('r3', 3), run('r1', 5), run('r4', 1), run('r2', 4)];

describe('Pruner.plan（DD-RUNREC-PRUNE）', () => {
  it('[DD-RUNREC-PRUNE-P001] [DD-RUNREC-PRUNE-T001] [DD-RUNREC-PRUNE-T002] [DD-RUNREC-PRUNE-T003] [DD-RUNREC-PRUNE-T005] [DD-RUNREC-PRUNE-T006] [DD-RUNREC-PRUNE-T007] [DD-RUNREC-PRUNE-T009] [DD-RUNREC-PRUNE-T010] [DD-RUNREC-PRUNE-T012] 件数超過・トレース超過・孤立トレースを全部消す', () => {
    const p = plan(RUNS, ['r1', 'r2', 'r3', 'r4', 'orphan'], { maxRuns: 3, maxTraceRuns: 2 });
    expect(p.runs).toEqual(['r4']);
    expect(p.traces.sort()).toEqual(['orphan', 'r3', 'r4']);
  });

  it('[DD-RUNREC-PRUNE-P002] [DD-RUNREC-PRUNE-T011] 件数超過・トレース超過で孤立トレースが無い', () => {
    const p = plan(RUNS, ['r1', 'r2', 'r3'], { maxRuns: 3, maxTraceRuns: 2 });
    expect(p).toEqual({ runs: ['r4'], traces: ['r3'] });
  });

  it('[DD-RUNREC-PRUNE-P003] [DD-RUNREC-PRUNE-T008] 件数超過・トレースは上限以内・孤立トレースあり', () => {
    const p = plan(RUNS, ['r1', 'orphan'], { maxRuns: 2, maxTraceRuns: 20 });
    expect(p.runs.sort()).toEqual(['r3', 'r4']);
    expect(p.traces).toEqual(['orphan']);
  });

  it('[DD-RUNREC-PRUNE-P004] 件数超過・トレースは上限以内・孤立トレースなし（消した実行のトレースは一緒に消す）', () => {
    const p = plan(RUNS, ['r1', 'r4'], { maxRuns: 3, maxTraceRuns: 20 });
    expect(p).toEqual({ runs: ['r4'], traces: ['r4'] });
  });

  it('[DD-RUNREC-PRUNE-P005] [DD-RUNREC-PRUNE-T004] 件数は以内・トレース超過・孤立トレースあり', () => {
    const p = plan(RUNS, ['r1', 'r2', 'r3', 'gone'], { maxRuns: 200, maxTraceRuns: 1 });
    expect(p.runs).toEqual([]);
    expect(p.traces.sort()).toEqual(['gone', 'r2', 'r3']);
  });

  it('[DD-RUNREC-PRUNE-P006] 件数は以内・トレース超過・孤立トレースなし', () => {
    expect(plan(RUNS, ['r2', 'r4'], { maxRuns: 200, maxTraceRuns: 1 })).toEqual({ runs: [], traces: ['r4'] });
  });

  it('[DD-RUNREC-PRUNE-P007] 件数は以内・トレースは以内・孤立トレースあり', () => {
    expect(plan(RUNS, ['r1', 'x'], { maxRuns: 200, maxTraceRuns: 20 })).toEqual({ runs: [], traces: ['x'] });
  });

  it('[DD-RUNREC-PRUNE-P008] 何も消さない。0 は無制限', () => {
    expect(plan(RUNS, ['r1', 'r2', 'r3', 'r4'], { maxRuns: 0, maxTraceRuns: 0 })).toEqual({ runs: [], traces: [] });
    expect(plan(RUNS, [], { maxRuns: 4, maxTraceRuns: 4 })).toEqual({ runs: [], traces: [] });
  });

  it('テスト以外の記録は数えず、実行中の記録は数えるが消さない', () => {
    const runs = [run('t1', 5, { kind: 'snapshot' }), run('r1', 4, { status: 'running' }), run('r2', 3), run('r3', 2, { status: 'running' }), run('r4', 1)];
    const p = plan(runs, ['r1', 'r3', 't1'], { maxRuns: 1, maxTraceRuns: 1 });
    expect(p.runs.sort()).toEqual(['r2', 'r4']);
    // r3 is running: its record and its trace directory (being written) are kept.
    expect(p.traces).toEqual([]);
  });
});

describe('Pruner.apply / traceDirs', () => {
  it('実行記録のファイルとトレースのディレクトリだけを消す', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-prune-'));
    try {
      await fs.mkdir(path.join(repo, '.ddv/runs'), { recursive: true });
      for (const id of ['a', 'b']) await fs.writeFile(path.join(repo, `.ddv/runs/${id}.json`), '{}');
      for (const id of ['a', 'c']) {
        await fs.mkdir(path.join(repo, TRACES_DIR, id), { recursive: true });
        await fs.writeFile(path.join(repo, TRACES_DIR, id, 'X.json'), '{}');
      }
      expect((await traceDirs(repo)).sort()).toEqual(['a', 'c']);
      await apply(repo, { runs: ['a', 'missing'], traces: ['a'] });
      expect(existsSync(path.join(repo, '.ddv/runs/a.json'))).toBe(false);
      expect(existsSync(path.join(repo, '.ddv/runs/b.json'))).toBe(true);
      expect(await traceDirs(repo)).toEqual(['c']);
      await expect(apply(repo, { runs: ['../../escape'], traces: [] })).rejects.toThrow();
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it('トレースのディレクトリが無ければ空', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-prune-'));
    expect(await traceDirs(repo)).toEqual([]);
    await fs.rm(repo, { recursive: true, force: true });
  });
});
