// Node: drops evidence bodies over the results-branch limits (evidence-trace.md「結果ブランチの大きさの上限」).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TraceFile } from '@ddv/mock/trace-format';

export const BRANCH_MAX_BYTES = 5 * 1024 * 1024;
export const BRANCH_MAX_TOTAL = 50 * 1024 * 1024;

export interface BranchLimits {
  maxBytes?: number;
  maxTotal?: number;
}

export interface BranchLimitResult {
  /** Files whose body was removed. */
  removed: number;
  /** Their recorded size. */
  removedBytes: number;
  /** Size of the evidence bodies left. */
  keptBytes: number;
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Walks the traces of `tracesDir` (keys ascending → steps → seq → files) and removes the bodies over `maxBytes`
 * or past `maxTotal` (only evidence bodies count), marking them `omitted: 'branch-limit'` in the trace JSON.
 */
export async function limitEvidenceForBranch(tracesDir: string, limits: BranchLimits = {}): Promise<BranchLimitResult> {
  const maxBytes = limits.maxBytes ?? BRANCH_MAX_BYTES;
  const maxTotal = limits.maxTotal ?? BRANCH_MAX_TOTAL;
  const out: BranchLimitResult = { removed: 0, removedBytes: 0, keptBytes: 0 };
  let names: string[];
  try {
    names = (await fs.readdir(tracesDir)).filter((f) => f.endsWith('.json')).sort(byKey);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(tracesDir, name);
    let trace: TraceFile;
    try {
      trace = JSON.parse(await fs.readFile(file, 'utf8')) as TraceFile;
    } catch {
      continue;
    }
    let changed = false;
    for (const step of trace.steps ?? []) {
      const records = [...(step.evidence ?? [])].sort((a, b) => a.seq - b.seq);
      for (const rec of records) {
        for (const f of rec.files) {
          if (f.omitted) continue;
          if (f.bytes > maxBytes || out.keptBytes + f.bytes > maxTotal) {
            await fs.rm(path.join(tracesDir, ...f.path.split('/')), { force: true });
            f.omitted = 'branch-limit';
            out.removed++;
            out.removedBytes += f.bytes;
            changed = true;
          } else {
            out.keptBytes += f.bytes;
          }
        }
      }
    }
    if (changed) await fs.writeFile(file, JSON.stringify(trace, null, 2) + '\n', 'utf8');
  }
  return out;
}

/** The `run.json` warning of removed evidence (none when nothing was removed). */
export function branchLimitWarning(r: BranchLimitResult): string | undefined {
  if (!r.removed) return undefined;
  return `大きさの上限のため証跡 ${r.removed} 件（${(r.removedBytes / 1024 / 1024).toFixed(1)} MB）を結果ブランチに置いていません`;
}
