import type { LatestResults, RunRecord, RunSource } from '../history.ts';

/**
 * Local records and the records read from the results branch, as one list (actions-run.md「統合の規則」).
 * Newest first by `startedAt`, then by id.
 */
export function mergeRunRecords(local: RunRecord[], actions: RunRecord[]): RunRecord[] {
  const kept = new Map<string, RunRecord>();
  const visit = (r: RunRecord, fromBranch: boolean) => {
    let key: string;
    let rec = r;
    if (r.source === 'actions') {
      if ((r.kind !== undefined && r.kind !== 'test') || r.status === 'running') return;
      rec = { ...r, dirty: false };
      key = `actions:${r.id}`;
    } else {
      key = `local:${r.id}`;
    }
    if (kept.has(key) && !fromBranch) return;
    kept.set(key, rec);
  };
  for (const r of local) visit(r, false);
  for (const r of actions) visit(r, true);
  return [...kept.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const sourceOf = (r: Pick<RunRecord, 'source'>): RunSource => (r.source === 'actions' ? 'actions' : 'local');

/** Latest result per test id (`source` / `actionsRunId` only on Actions results: local results keep the former shape, REQ-610) of merged runs (newest first): older runs are overwritten by newer ones (= `RunManager.latest()`). */
export function latestOf(runs: RunRecord[]): LatestResults {
  const out: LatestResults = {};
  for (const r of [...runs].reverse())
    for (const [id, res] of Object.entries(r.results)) {
      out[id] = { ...res, runId: r.id, at: r.finishedAt ?? r.startedAt };
      if (sourceOf(r) === 'actions') {
        out[id].source = 'actions';
        if (r.actionsRunId !== undefined) out[id].actionsRunId = r.actionsRunId;
      }
    }
  return out;
}
