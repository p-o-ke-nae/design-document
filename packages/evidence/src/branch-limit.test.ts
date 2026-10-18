import { existsSync, mkdtempSync, promises as fs, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceEvidence, TraceFile } from '@ddv/mock/trace-format';
import { branchLimitWarning, limitEvidenceForBranch } from './branch-limit.ts';
import { evidenceCounts, evidenceResultFields } from './counts.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ddv-brlimit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (seq: number, files: Array<{ name: string; bytes: number; omitted?: 'too-large' }>, status: TraceEvidence['status'] = 'ok'): TraceEvidence => ({
  seq,
  label: `e${seq}`,
  use: 'screenshot',
  at: 'after',
  provider: 'builtin',
  status,
  durationMs: 1,
  files: files.map((f) => ({ path: `KEY/evidence/${f.name}`, kind: 'file', mime: 'application/octet-stream', bytes: f.bytes, ...(f.omitted ? { omitted: f.omitted } : {}) })),
});

const trace = (key: string, steps: TraceEvidence[][]): TraceFile => ({
  version: 1,
  runId: 'r1',
  testId: key,
  title: '',
  mock: 'm',
  target: 'mock',
  startedAt: '2025-01-01T00:00:00Z',
  durationMs: 1,
  status: 'passed',
  steps: steps.map((evidence, i) => ({ index: i + 1, event: 'e', screenBefore: null, screenAfter: null, expects: [], ok: true, durationMs: 1, calls: [], db: [], ...(evidence.length ? { evidence } : {}) })),
});

/** Writes `<dir>/<key>.json` and the bodies (`KEY` in the paths is replaced by the key). */
async function put(key: string, steps: TraceEvidence[][]) {
  const t = trace(key, steps);
  for (const s of t.steps) for (const e of s.evidence ?? []) for (const f of e.files) f.path = f.path.replace('KEY', key);
  await fs.mkdir(path.join(dir, key, 'evidence'), { recursive: true });
  for (const s of t.steps) for (const e of s.evidence ?? []) for (const f of e.files) if (!f.omitted) await fs.writeFile(path.join(dir, ...f.path.split('/')), Buffer.alloc(f.bytes));
  await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(t));
}
const load = (key: string) => JSON.parse(readFileSync(path.join(dir, `${key}.json`), 'utf8')) as TraceFile;
const files = (key: string) => load(key).steps.flatMap((s) => s.evidence ?? []).flatMap((e) => e.files);
const body = (key: string, name: string) => existsSync(path.join(dir, key, 'evidence', name));

describe('証跡の件数', () => {
  it('skipped 以外を数え、warn・failed を警告に数える（全ステップの合計）', () => {
    const t = trace('A', [[rec(1, []), rec(2, [], 'warn')], [], [rec(1, [], 'failed'), rec(2, [], 'skipped')]]);
    expect(evidenceCounts(t)).toEqual({ evidence: 3, evidenceWarnings: 2 });
    expect(evidenceResultFields(t)).toEqual({ evidence: 3, evidenceWarnings: 2 });
    expect(evidenceResultFields(trace('B', [[rec(1, [])]]))).toEqual({ evidence: 1 });
    expect(evidenceResultFields(trace('C', [[rec(1, [], 'skipped')], []]))).toEqual({});
  });
});

describe('結果ブランチの大きさの上限（BRLIMIT）', () => {
  it('[DD-EVTRACE-BRLIMIT-P001][DD-EVTRACE-BRLIMIT-T001][DD-EVTRACE-BRLIMIT-T002] omitted がすでにある証跡は飛ばし、合計にも数えない', async () => {
    await put('A', [[rec(1, [{ name: 'big.bin', bytes: 50, omitted: 'too-large' }, { name: 'b.bin', bytes: 10 }])]]);
    const r = await limitEvidenceForBranch(dir, { maxBytes: 20, maxTotal: 10 });
    expect(r).toEqual({ removed: 0, removedBytes: 0, keptBytes: 10 });
    expect(files('A').map((f) => f.omitted)).toEqual(['too-large', undefined]);
    expect(body('A', 'b.bin')).toBe(true);
  });

  it('[DD-EVTRACE-BRLIMIT-P002][DD-EVTRACE-BRLIMIT-T003][DD-EVTRACE-BRLIMIT-T004][DD-EVTRACE-BRLIMIT-T008][DD-EVTRACE-BRLIMIT-T010] 1 つが maxBytes を超えると本体を消し omitted=branch-limit でトレースを書き直す', async () => {
    await put('A', [[rec(1, [{ name: 'big.bin', bytes: 30 }]), rec(2, [{ name: 'ok.bin', bytes: 5 }])]]);
    const r = await limitEvidenceForBranch(dir, { maxBytes: 20, maxTotal: 100 });
    expect(r).toEqual({ removed: 1, removedBytes: 30, keptBytes: 5 });
    expect(files('A').map((f) => [f.path, f.omitted])).toEqual([
      ['A/evidence/big.bin', 'branch-limit'],
      ['A/evidence/ok.bin', undefined],
    ]);
    expect(body('A', 'big.bin')).toBe(false);
    expect(body('A', 'ok.bin')).toBe(true);
  });

  it('[DD-EVTRACE-BRLIMIT-P003][DD-EVTRACE-BRLIMIT-P004][DD-EVTRACE-BRLIMIT-T005][DD-EVTRACE-BRLIMIT-T006][DD-EVTRACE-BRLIMIT-T007][DD-EVTRACE-BRLIMIT-T009] キーの昇順・ステップ・seq・ファイルの順に合計し、maxTotal を超える分から消す', async () => {
    await put('B', [[rec(1, [{ name: 'b1.bin', bytes: 6 }])]]);
    await put('A', [[rec(2, [{ name: 'a2.bin', bytes: 3 }]), rec(1, [{ name: 'a1.bin', bytes: 4 }])], [rec(1, [{ name: 's2.bin', bytes: 2 }])]]);
    const r = await limitEvidenceForBranch(dir, { maxBytes: 100, maxTotal: 10 });
    // A: a1 (4) → a2 (3) → s2 (2) = 9; B: b1 (6) is over the total.
    expect(r).toEqual({ removed: 1, removedBytes: 6, keptBytes: 9 });
    expect(files('A').every((f) => !f.omitted)).toBe(true);
    expect(files('B')[0].omitted).toBe('branch-limit');
    expect(body('B', 'b1.bin')).toBe(false);
    expect(branchLimitWarning(r)).toBe('大きさの上限のため証跡 1 件（0.0 MB）を結果ブランチに置いていません');
    expect(branchLimitWarning({ removed: 0, removedBytes: 0, keptBytes: 9 })).toBeUndefined();
  });

  it('トレースの無いフォルダ・読めないトレースは飛ばす', async () => {
    expect(await limitEvidenceForBranch(path.join(dir, 'none'))).toEqual({ removed: 0, removedBytes: 0, keptBytes: 0 });
    await fs.writeFile(path.join(dir, 'X.json'), '{');
    expect(await limitEvidenceForBranch(dir)).toEqual({ removed: 0, removedBytes: 0, keptBytes: 0 });
  });
});
