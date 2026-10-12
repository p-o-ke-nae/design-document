import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CiEnv } from './ci-run.ts';
import { CiCommand } from './cli.ts';
import { publish, type PublishOptions } from './publish.ts';
import { entryFromRecord, emptyIndex, writeIndex, type CiRunRecord } from './results-index.ts';
import { bareGit, createRemote, HookGit, pushOrphanDir, type TestRemote } from './test-git.ts';

const B = 'ddv-results';
const NOW = new Date('2024-06-30T00:00:00Z');
const LIMITS = { maxRuns: 3, maxDays: 30, maxTraceRuns: 0 };
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let root: string;
let r: TestRemote;
let out: string;
let seeds = 0;

function record(id: string, startedAt: string, over: Partial<CiRunRecord> = {}): CiRunRecord {
  return {
    id,
    kind: 'test',
    startedAt,
    finishedAt: startedAt,
    status: 'passed',
    request: {},
    runners: [],
    results: { [['DD', 'A', 'B', 'T001'].join('-')]: { status: 'passed' } },
    log: [],
    source: 'actions',
    actionsRunId: id.split('-')[0],
    ref: 'feature/x',
    commit: 'a'.repeat(40),
    dirty: false,
    warnings: [],
    ...over,
  } as CiRunRecord;
}

/** Pushes a results branch with the given runs (all with traces). */
async function seedResults(runs: Array<{ id: string; days: number; traces?: boolean }>): Promise<void> {
  const dir = path.join(root, `seed${++seeds}`);
  await fs.mkdir(dir, { recursive: true });
  const index = emptyIndex();
  for (const run of runs) {
    const rec = record(run.id, daysAgo(run.days));
    const d = path.join(dir, 'runs', run.id);
    await fs.mkdir(path.join(d, 'traces'), { recursive: true });
    await fs.writeFile(path.join(d, 'run.json'), JSON.stringify(rec));
    const traces = run.traces ?? true;
    if (traces) await fs.writeFile(path.join(d, 'traces', 'T.json'), '{}');
    index.runs.push(entryFromRecord(rec, { traces }));
  }
  await writeIndex(dir, index);
  pushOrphanDir(r.other, B, dir);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-publish-'));
  r = await createRemote(root);
  seeds = 0;
  out = path.join(root, 'out');
  await fs.mkdir(path.join(out, 'traces'), { recursive: true });
  await fs.mkdir(path.join(out, 'snapshots', 'current', 'S1'), { recursive: true });
  await fs.writeFile(path.join(out, 'run.json'), JSON.stringify(record('500-1', NOW.toISOString(), { actionsRequest: 'req-9', traces: ['T1'] })));
  await fs.writeFile(path.join(out, 'traces', 'T1.json'), '{"t":1}');
  await fs.writeFile(path.join(out, 'snapshots', 'current', 'S1', 'meta.json'), '{}');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const env = (over: Partial<CiEnv> = {}): CiEnv => ({ runId: '500', runAttempt: '1', sha: 'a'.repeat(40), ref: 'feature/x', refType: 'branch', actor: 'alice', repository: 'o/r', apiUrl: 'https://api.example.test', token: 'ghs_tok', ...over });

const prFetch = (async (url: string, init?: RequestInit) => {
  expect(url).toBe(`https://api.example.test/repos/o/r/commits/${'a'.repeat(40)}/pulls`);
  expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ghs_tok');
  return new Response(JSON.stringify([{ number: 3, state: 'closed', head: { ref: 'feature/x' } }, { number: 7, state: 'open', head: { ref: 'feature/x' } }]));
}) as typeof fetch;

function opts(over: Partial<PublishOptions> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const o: PublishOptions = { repoRoot: r.work, out, branch: B, limits: LIMITS, env: env(), fetch: prFetch, now: () => NOW, tmpRoot: root, log: (l) => logs.push(l), error: (l) => errors.push(l), ...over };
  return { o, logs, errors };
}

const remoteRuns = () => bareGit(r.remote, ['ls-tree', '--name-only', `refs/heads/${B}:runs`]).split('\n').filter(Boolean).sort();
const remoteIndex = () => JSON.parse(bareGit(r.remote, ['show', `refs/heads/${B}:index.json`]));

interface Cond {
  /** More runs than maxRuns after adding this one. */
  over: boolean;
  /** A run older than maxDays. */
  old: boolean;
}

/** Runs of a seed: `p` distinguishes the seeds. Returns the ids expected to remain. */
function runsOf(p: number, c: Cond) {
  const recent = c.over ? [3, 2, 1] : [1];
  const runs = recent.map((k) => ({ id: `${p}${k}-1`, days: 4 - k }));
  if (c.old) runs.push({ id: `${p}0-1`, days: 100 });
  // Newest first, maxRuns 3 (incl. the new run), older than 30 days removed.
  const keep = runs.filter((x) => x.days <= 30).slice(0, 2).map((x) => x.id);
  return { runs, keep, removed: runs.map((x) => x.id).filter((id) => !keep.includes(id)) };
}

/** Publishes against a results branch prepared by `first`; when `second` is given, another run moves the branch before the first push. */
async function prunePath(first: Cond, second?: Cond) {
  await seedResults(runsOf(1, first).runs);
  let pushes = 0;
  const git = new HookGit(async (args) => {
    if (args[0] === 'push' && args.includes('--porcelain') && pushes++ === 0 && second) await seedResults(runsOf(2, second).runs);
  });
  const { o, logs, errors } = opts({ git });
  expect(await publish(o)).toBe(0);
  expect(errors).toEqual([]);
  const final = runsOf(second ? 2 : 1, second ?? first);
  expect(remoteRuns()).toEqual(['500-1', ...final.keep].sort());
  const index = remoteIndex();
  expect(index.runs.map((x: { id: string }) => x.id)).toEqual(['500-1', ...final.keep]);
  expect(index.runs[0]).toMatchObject({ id: '500-1', actionsRunId: '500', request: 'req-9', pr: 7, actor: 'alice', traces: true, trimmed: false, approvals: [] });
  expect(bareGit(r.remote, ['show', `refs/heads/${B}:runs/500-1/traces/T1.json`])).toBe('{"t":1}');
  expect(bareGit(r.remote, ['show', `refs/heads/${B}:runs/500-1/snapshots/current/S1/meta.json`])).toBe('{}');
  const head = bareGit(r.remote, ['rev-parse', `refs/heads/${B}`]);
  expect(bareGit(r.remote, ['rev-list', '--parents', '-n', '1', head])).toBe(head);
  expect(bareGit(r.remote, ['log', '-1', '--format=%s', head])).toBe('ddv results: 500-1');
  expect(logs.filter((l) => l.includes('取り直してやり直します'))).toHaveLength(second ? 1 : 0);
  expect(logs.at(-1)).toBe(`結果ブランチ ddv-results に保存しました: runs/500-1（コミット ${head.slice(0, 7)}、削除 ${final.removed.length} 件、詳細の削除 0 件）`);
  expect(git.calls.filter((a) => a[0] === 'push')).toHaveLength(second ? 2 : 1);
}

const OA = { over: true, old: true };
const ON = { over: true, old: false };
const WA = { over: false, old: true };
const WN = { over: false, old: false };

describe('ddv ci publish（結果の保持）', { timeout: 60_000 }, () => {
  it('[BD-ACTRUN-PRUNE-P001][BD-ACTRUN-PRUNE-S001][BD-ACTRUN-PRUNE-S003][BD-ACTRUN-PRUNE-S006][BD-ACTRUN-PRUNE-S008][BD-ACTRUN-PRUNE-S010][BD-ACTRUN-PRUNE-S011][BD-ACTRUN-PRUNE-S013][BD-ACTRUN-PRUNE-S014][BD-ACTRUN-PRUNE-S012] 件数超過・日数超過 → 競合 → 件数超過・日数超過', async () => {
    await prunePath(OA, OA);
  });
  it('[BD-ACTRUN-PRUNE-P002][BD-ACTRUN-PRUNE-S007][BD-ACTRUN-PRUNE-S009] 件数超過・日数超過 → 競合 → 件数超過・日数内', async () => {
    await prunePath(OA, ON);
  });
  it('[BD-ACTRUN-PRUNE-P003][BD-ACTRUN-PRUNE-S002][BD-ACTRUN-PRUNE-S004] 件数超過・日数超過 → 競合 → 件数内・日数超過', async () => {
    await prunePath(OA, WA);
  });
  it('[BD-ACTRUN-PRUNE-P004][BD-ACTRUN-PRUNE-S005] 件数超過・日数超過 → 競合 → 件数内・日数内', async () => {
    await prunePath(OA, WN);
  });
  it('[BD-ACTRUN-PRUNE-P005][BD-ACTRUN-PRUNE-T001][BD-ACTRUN-PRUNE-T002][BD-ACTRUN-PRUNE-T004][BD-ACTRUN-PRUNE-T005][BD-ACTRUN-PRUNE-T007][BD-ACTRUN-PRUNE-T008][BD-ACTRUN-PRUNE-T010] 件数超過・日数超過 → 競合なし', async () => {
    await prunePath(OA);
  });
  it('[BD-ACTRUN-PRUNE-P006][BD-ACTRUN-PRUNE-T009][BD-ACTRUN-PRUNE-T011] 件数超過・日数内 → 競合 → 件数超過・日数超過', async () => {
    await prunePath(ON, OA);
  });
  it('[BD-ACTRUN-PRUNE-P007][BD-ACTRUN-PRUNE-T006] 件数超過・日数内 → 競合 → 件数超過・日数内', async () => {
    await prunePath(ON, ON);
  });
  it('[BD-ACTRUN-PRUNE-P008] 件数超過・日数内 → 競合 → 件数内・日数超過', async () => {
    await prunePath(ON, WA);
  });
  it('[BD-ACTRUN-PRUNE-P009] 件数超過・日数内 → 競合 → 件数内・日数内', async () => {
    await prunePath(ON, WN);
  });
  it('[BD-ACTRUN-PRUNE-P010] 件数超過・日数内 → 競合なし', async () => {
    await prunePath(ON);
  });
  it('[BD-ACTRUN-PRUNE-P011][BD-ACTRUN-PRUNE-T003] 件数内・日数超過 → 競合 → 件数超過・日数超過', async () => {
    await prunePath(WA, OA);
  });
  it('[BD-ACTRUN-PRUNE-P012] 件数内・日数超過 → 競合 → 件数超過・日数内', async () => {
    await prunePath(WA, ON);
  });
  it('[BD-ACTRUN-PRUNE-P013] 件数内・日数超過 → 競合 → 件数内・日数超過', async () => {
    await prunePath(WA, WA);
  });
  it('[BD-ACTRUN-PRUNE-P014] 件数内・日数超過 → 競合 → 件数内・日数内', async () => {
    await prunePath(WA, WN);
  });
  it('[BD-ACTRUN-PRUNE-P015] 件数内・日数超過 → 競合なし', async () => {
    await prunePath(WA);
  });
  it('[BD-ACTRUN-PRUNE-P016] 件数内・日数内 → 競合 → 件数超過・日数超過', async () => {
    await prunePath(WN, OA);
  });
  it('[BD-ACTRUN-PRUNE-P017] 件数内・日数内 → 競合 → 件数超過・日数内', async () => {
    await prunePath(WN, ON);
  });
  it('[BD-ACTRUN-PRUNE-P018] 件数内・日数内 → 競合 → 件数内・日数超過', async () => {
    await prunePath(WN, WA);
  });
  it('[BD-ACTRUN-PRUNE-P019] 件数内・日数内 → 競合 → 件数内・日数内', async () => {
    await prunePath(WN, WN);
  });
  it('[BD-ACTRUN-PRUNE-P020] 件数内・日数内 → 競合なし', async () => {
    await prunePath(WN);
  });
});

describe('ddv ci publish', { timeout: 60_000 }, () => {
  it('[DD-ACTWF-PUSH-P014][DD-ACTWF-PRUNE-P004] 結果ブランチがなければ親のないコミットで作る。トレースを残す実行の数を超えた分は詳細だけ削除する', async () => {
    const { o, logs } = opts({ limits: { maxRuns: 0, maxDays: 0, maxTraceRuns: 1 } });
    expect(await publish(o)).toBe(0);
    expect(remoteRuns()).toEqual(['500-1']);
    await fs.writeFile(path.join(out, 'run.json'), JSON.stringify(record('501-1', new Date(NOW.getTime() + 1000).toISOString())));
    expect(await publish(opts({ limits: { maxRuns: 0, maxDays: 0, maxTraceRuns: 1 }, env: env({ runId: '501' }) }).o)).toBe(0);
    const index = remoteIndex();
    expect(index.runs.map((x: { id: string; traces: boolean; trimmed: boolean }) => [x.id, x.traces, x.trimmed])).toEqual([
      ['501-1', true, false],
      ['500-1', false, true],
    ]);
    expect(remoteRuns()).toEqual(['500-1', '501-1']);
    expect(bareGit(r.remote, ['ls-tree', '--name-only', `refs/heads/${B}:runs/500-1`])).toBe('run.json');
    expect(logs.at(-1)).toMatch(/削除 0 件、詳細の削除 0 件）$/);
  });

  it('[DD-ACTWF-PUSH-P011] 同じ実行IDは行を置き換え、PR が見つからなければ pr を省く。壊れた index.json は作り直す', async () => {
    await seedResults([{ id: '500-1', days: 1 }, { id: '11-1', days: 2 }]);
    const dir = path.join(root, 'broken');
    await fs.mkdir(path.join(dir, 'runs', '11-1'), { recursive: true });
    await fs.writeFile(path.join(dir, 'runs', '11-1', 'run.json'), JSON.stringify(record('11-1', daysAgo(2))));
    await fs.writeFile(path.join(dir, 'index.json'), '{ broken');
    pushOrphanDir(r.other, B, dir);
    const { o, logs } = opts({ fetch: (async () => new Response('[]')) as typeof fetch });
    expect(await publish(o)).toBe(0);
    expect(logs).toContain('! index.json を作り直しました');
    const index = remoteIndex();
    expect(index.runs.map((x: { id: string }) => x.id)).toEqual(['500-1', '11-1']);
    expect(index.runs[0].pr).toBeUndefined();
  });

  it('[DD-ACTWF-PUSH-P011] 競合がやり直しの上限を超えたら終了コード 1', async () => {
    const git = new HookGit(async (args) => {
      if (args[0] === 'push' && args.includes('--porcelain')) await seedResults([{ id: '11-1', days: 1 }]);
    });
    const { o, errors } = opts({ git, retries: 1 });
    expect(await publish(o)).toBe(1);
    expect(errors).toEqual(['結果ブランチへの保存が競合しました（2 回試行）']);
  });

  it('[DD-ACTWF-PUSH-P025] push の失敗は理由を付けて終了コード 1（トークンは伏せる）', async () => {
    const git = new HookGit(async (args) => {
      if (args[0] === 'push') return { code: 128, stdout: '', stderr: "fatal: unable to access 'https://x-access-token:ghs_tok@github.com/o/r/': 403" };
    });
    const { o, errors } = opts({ git });
    expect(await publish(o)).toBe(1);
    expect(errors[0]).toMatch(/^結果ブランチへ保存できませんでした: fatal: unable to access/);
    expect(errors[0]).not.toContain('ghs_tok');
  });

  it('[DD-ACTWF-PUSH-P027] Actions の外・run.json がない・引数の誤りは保存しない', async () => {
    const a = opts({ env: env({ runId: '' }) });
    expect(await publish(a.o)).toBe(2);
    expect(a.errors).toEqual(['Actions の中で実行してください（GITHUB_RUN_ID がありません）']);
    const b = opts({ out: path.join(root, 'none') });
    expect(await publish(b.o)).toBe(1);
    expect(b.errors).toEqual([`run.json がありません: ${path.join(root, 'none', 'run.json')}`]);
    const errors: string[] = [];
    const cmd = new CiCommand({ env: env(), log: () => {}, error: (l) => errors.push(l) });
    expect(await cmd.main(['ci', 'publish', '--out', out, '--repo', r.work, '--max-runs', '-1'])).toBe(2);
    expect(errors.pop()).toBe('--max-runs は 0 以上の整数です');
    expect(await cmd.main(['ci', 'publish', '--out', out, '--repo', r.work, '--max-days', 'x'])).toBe(2);
    expect(errors.pop()).toBe('--max-days は 0 以上の整数です');
    expect(await cmd.main(['ci', 'publish', '--out', out, '--repo', r.work, '--branch', 'a..b'])).toBe(2);
    expect(errors.pop()).toBe('--branch がブランチ名として正しくありません: a..b');
    expect(await cmd.main(['ci', 'publish', '--repo', r.work])).toBe(2);
    expect(errors.pop()).toBe('--out を指定してください');
    expect(existsSync(path.join(r.remote, 'refs', 'heads', B))).toBe(false);
  });
});
