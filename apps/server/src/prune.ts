import { promises as fs, existsSync } from 'node:fs';
import { safeJoin } from '@ddv/core/node';

/** Per-run trace directories: `.ddv/traces/<runId>/<testId>.json`. */
export const TRACES_DIR = '.ddv/traces';

export interface HistoryConfig {
  maxRuns: number;
  maxTraceRuns: number;
}

export interface PrunePlan {
  /** Run ids whose record (`.ddv/runs/<id>.json`) is deleted. */
  runs: string[];
  /** Run ids whose trace directory (`.ddv/traces/<id>/`) is deleted. */
  traces: string[];
}

interface PrunableRun {
  id: string;
  kind?: string;
  startedAt: string;
  status: string;
}

/** Decides what to delete (DD-RUNREC-PRUNE). Pure: does not touch files. */
export function plan(runs: PrunableRun[], traceDirs: string[], config: HistoryConfig): PrunePlan {
  const tests = runs.filter((r) => (r.kind ?? 'test') === 'test').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const hasTrace = new Set(traceDirs);
  const removeRuns: string[] = [];
  const removeTraces = new Set<string>();
  let kept = tests;
  if (config.maxRuns !== 0 && tests.length > config.maxRuns) {
    const old = tests.slice(config.maxRuns).filter((r) => r.status !== 'running');
    for (const r of old) {
      removeRuns.push(r.id);
      if (hasTrace.has(r.id)) removeTraces.add(r.id);
    }
    const gone = new Set(removeRuns);
    kept = tests.filter((r) => !gone.has(r.id));
  }
  const withTrace = kept.filter((r) => hasTrace.has(r.id));
  if (config.maxTraceRuns !== 0 && withTrace.length > config.maxTraceRuns) {
    for (const r of withTrace.slice(config.maxTraceRuns)) if (r.status !== 'running') removeTraces.add(r.id);
  }
  const known = new Set(runs.map((r) => r.id));
  for (const d of traceDirs) if (!known.has(d)) removeTraces.add(d);
  return { runs: removeRuns, traces: [...removeTraces] };
}

function checkRunId(id: string) {
  if (!/^[\w.-]+$/.test(id) || /^\.+$/.test(id)) throw new Error(`invalid run id: ${id}`);
}

/** Deletes `.ddv/runs/<id>.json` and `.ddv/traces/<id>/` of the plan. Throws the first failure after trying all. */
export async function apply(repoRoot: string, p: PrunePlan, runsDir = '.ddv/runs'): Promise<void> {
  let first: unknown = null;
  for (const id of p.runs) {
    try {
      checkRunId(id);
      await fs.rm(safeJoin(repoRoot, `${runsDir}/${id}.json`), { force: true });
    } catch (e) {
      first ??= e;
    }
  }
  for (const id of p.traces) {
    try {
      checkRunId(id);
      await fs.rm(safeJoin(repoRoot, `${TRACES_DIR}/${id}`), { recursive: true, force: true });
    } catch (e) {
      first ??= e;
    }
  }
  if (first) throw first;
}

/** Run ids that have a trace directory. */
export async function traceDirs(repoRoot: string): Promise<string[]> {
  const dir = safeJoin(repoRoot, TRACES_DIR);
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export const Pruner = { plan, apply };
