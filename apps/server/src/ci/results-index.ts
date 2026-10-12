import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { ResultsIndexSchema, type ResultsIndexData, type ResultsIndexEntry } from '@ddv/core';
import type { RunRecord } from '../runs.ts';

export { ApprovalSchema, ResultsIndexEntrySchema, ResultsIndexSchema, type Approval, type ResultsIndexData, type ResultsIndexEntry } from '@ddv/core';

/** `run.json` written by `ddv ci run`. */
export type CiRunRecord = RunRecord & {
  source: 'actions';
  actionsRunId: string;
  ref: string;
  commit: string;
  dirty: false;
  warnings: string[];
};

export const INDEX_FILE = 'index.json';
export const RESULTS_RUNS_DIR = 'runs';

/** Same character set as the local run ids (`prune.ts`); keeps deletions inside `runs/`. */
export function isRunId(id: unknown): id is string {
  return typeof id === 'string' && /^[\w.-]+$/.test(id) && !/^\.+$/.test(id);
}

export function runDir(root: string, id: string): string {
  if (!isRunId(id)) throw new Error(`不正な実行IDです: ${id}`);
  return path.join(root, RESULTS_RUNS_DIR, id);
}

export function emptyIndex(): ResultsIndexData {
  return { version: 1, updatedAt: new Date().toISOString(), runs: [] };
}

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** Run ids under `runs/` (directories only). */
export async function runDirs(root: string): Promise<string[]> {
  const dir = path.join(root, RESULTS_RUNS_DIR);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && isRunId(e.name)).map((e) => e.name).sort();
}

/** `runs/<id>/` that has `traces/` or `snapshots/`. */
export async function isHeavy(root: string, id: string): Promise<boolean> {
  const dir = runDir(root, id);
  return (await hasEntries(path.join(dir, 'traces'))) || (await hasEntries(path.join(dir, 'snapshots')));
}

export async function readRunRecord(file: string): Promise<CiRunRecord | null> {
  try {
    const r = JSON.parse(await fs.readFile(file, 'utf8')) as CiRunRecord;
    if (!r || typeof r !== 'object' || !isRunId(r.id) || typeof r.startedAt !== 'string') return null;
    return r;
  } catch {
    return null;
  }
}

export interface EntryExtras {
  traces: boolean;
  trimmed?: boolean;
  pr?: number;
  actor?: string;
}

/** The index row of a run record. */
export function entryFromRecord(rec: CiRunRecord, extras: EntryExtras): ResultsIndexEntry {
  const counts = { passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const r of Object.values(rec.results ?? {})) if (r && r.status in counts) counts[r.status]++;
  const status = rec.status === 'passed' || rec.status === 'failed' ? rec.status : 'error';
  const entry: ResultsIndexEntry = {
    id: rec.id,
    actionsRunId: rec.actionsRunId ?? rec.id.split('-')[0],
    ...(rec.actionsRequest ? { request: rec.actionsRequest } : {}),
    commit: rec.commit ?? '',
    ref: rec.ref ?? '',
    ...(extras.pr ? { pr: extras.pr } : {}),
    ...(extras.actor ? { actor: extras.actor } : {}),
    startedAt: rec.startedAt,
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    status,
    counts,
    traces: extras.traces,
    trimmed: extras.trimmed ?? false,
    warnings: rec.warnings ?? [],
    approvals: [],
  };
  if (rec.snapshots) {
    entry.snapshots = {
      diff: rec.snapshots.filter((s) => s.steps.some((x) => x.status === 'Diff')).length,
      noBase: rec.snapshots.filter((s) => s.steps.some((x) => x.status === 'NoBase')).length,
    };
  }
  return entry;
}

export function sortIndex(index: ResultsIndexData): ResultsIndexData {
  index.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return index;
}

/** Rebuilds the index from `runs/*\/run.json` (approvals are lost). */
export async function rebuildIndex(root: string): Promise<ResultsIndexData> {
  const index = emptyIndex();
  for (const id of await runDirs(root)) {
    const rec = await readRunRecord(path.join(runDir(root, id), 'run.json'));
    if (!rec || rec.id !== id) continue;
    const traces = await hasEntries(path.join(runDir(root, id), 'traces'));
    const heavy = await isHeavy(root, id);
    const trimmed = !heavy && ((rec.traces?.length ?? 0) > 0 || (rec.snapshots?.length ?? 0) > 0);
    index.runs.push(entryFromRecord(rec, { traces, trimmed }));
  }
  return sortIndex(index);
}

/** Reads `index.json` of a checked-out results branch; rebuilds it when missing, not JSON or not matching the schema. */
export async function readIndex(root: string, log: (line: string) => void = () => {}): Promise<ResultsIndexData> {
  const file = path.join(root, INDEX_FILE);
  const exists = existsSync(file);
  if (exists) {
    try {
      const r = ResultsIndexSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (r.success) return r.data;
    } catch {
      /* rebuilt below */
    }
  }
  const index = await rebuildIndex(root);
  if (exists || index.runs.length || (await runDirs(root)).length) log('! index.json を作り直しました');
  return index;
}

export async function writeIndex(root: string, index: ResultsIndexData): Promise<void> {
  sortIndex(index);
  index.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, INDEX_FILE), JSON.stringify(index, null, 2) + '\n', 'utf8');
}
