import type { ResultsIndexData } from '@ddv/core';
import { Pruner } from '../prune.ts';

export interface ResultsLimits {
  /** 0 = unlimited. */
  maxRuns: number;
  maxDays: number;
  maxTraceRuns: number;
}

export interface ResultsPrunePlan {
  /** `runs/<id>/` deleted and the row removed. */
  runs: string[];
  /** `runs/<id>/traces/` and `snapshots/` deleted; the row becomes `traces: false, trimmed: true`. */
  trim: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention of the results branch (DD-ACTWF-PRUNE). Pure: counts and trace runs reuse `Pruner.plan`. */
export function planResults(index: ResultsIndexData, heavyDirs: string[], orphanDirs: string[], limits: ResultsLimits, now: Date): ResultsPrunePlan {
  const rows = index.runs.map((r) => ({ id: r.id, kind: 'test', startedAt: r.startedAt, status: r.status }));
  const p = Pruner.plan(rows, heavyDirs, { maxRuns: limits.maxRuns, maxTraceRuns: limits.maxTraceRuns });
  const known = new Set(index.runs.map((r) => r.id));
  const runs = new Set(p.runs);
  // A heavy directory without a row has neither run.json in the index: delete it whole.
  for (const id of p.traces) if (!known.has(id)) runs.add(id);
  if (limits.maxDays !== 0) {
    for (const r of index.runs) {
      const t = Date.parse(r.startedAt);
      if (Number.isFinite(t) && now.getTime() - t > limits.maxDays * DAY_MS) runs.add(r.id);
    }
  }
  for (const id of orphanDirs) runs.add(id);
  const trim = p.traces.filter((id) => known.has(id) && !runs.has(id));
  return { runs: [...runs], trim };
}
