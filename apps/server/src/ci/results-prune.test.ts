import { describe, expect, it } from 'vitest';
import type { ResultsIndexData, ResultsIndexEntry } from '@ddv/core';
import { planResults } from './results-prune.ts';

const NOW = new Date('2024-06-30T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(id: string, daysAgo: number): ResultsIndexEntry {
  return {
    id,
    actionsRunId: id.split('-')[0],
    commit: 'a'.repeat(40),
    ref: 'main',
    startedAt: day(daysAgo),
    status: 'passed',
    counts: { passed: 1, failed: 0, error: 0, skipped: 0 },
    traces: true,
    trimmed: false,
    warnings: [],
    approvals: [],
  };
}

const index = (...rows: ResultsIndexEntry[]): ResultsIndexData => ({ version: 1, updatedAt: NOW.toISOString(), runs: rows });
const sorted = (a: string[]) => [...a].sort();

describe('planResults', () => {
  it('[DD-ACTWF-PRUNE-P001][DD-ACTWF-PRUNE-T001][DD-ACTWF-PRUNE-T002][DD-ACTWF-PRUNE-T003][DD-ACTWF-PRUNE-T005][DD-ACTWF-PRUNE-T006][DD-ACTWF-PRUNE-T008] 保持日数を超えた実行と orphan を runs に加え、trim から除く', () => {
    const idx = index(row('3-1', 1), row('2-1', 2), row('1-1', 100));
    const p = planResults(idx, ['3-1', '2-1', '1-1'], ['9-1'], { maxRuns: 0, maxDays: 90, maxTraceRuns: 1 }, NOW);
    expect(sorted(p.runs)).toEqual(['1-1', '9-1']);
    expect(p.trim).toEqual(['2-1']);
  });

  it('[DD-ACTWF-PRUNE-P002] 保持日数を超えた実行があり orphan がない', () => {
    const idx = index(row('3-1', 1), row('2-1', 2), row('1-1', 100));
    const p = planResults(idx, ['3-1', '2-1', '1-1'], [], { maxRuns: 200, maxDays: 90, maxTraceRuns: 1 }, NOW);
    expect(p.runs).toEqual(['1-1']);
    expect(p.trim).toEqual(['2-1']);
  });

  it('[DD-ACTWF-PRUNE-P003][DD-ACTWF-PRUNE-T004] 保持日数を超えた実行がなく orphan がある（maxDays 0 は無制限）', () => {
    const idx = index(row('2-1', 2), row('1-1', 1000));
    const p = planResults(idx, [], ['9-1'], { maxRuns: 0, maxDays: 0, maxTraceRuns: 0 }, NOW);
    expect(p.runs).toEqual(['9-1']);
    expect(p.trim).toEqual([]);
  });

  it('[DD-ACTWF-PRUNE-P004][DD-ACTWF-PRUNE-T007] どちらもない: Pruner.plan の結果（件数超過・行のない重いディレクトリ）だけを返す', () => {
    const idx = index(row('3-1', 1), row('2-1', 2), row('1-1', 3));
    const p = planResults(idx, ['3-1', '1-1', '8-1'], [], { maxRuns: 2, maxDays: 90, maxTraceRuns: 5 }, NOW);
    expect(sorted(p.runs)).toEqual(['1-1', '8-1']);
    expect(p.trim).toEqual([]);
  });
});
