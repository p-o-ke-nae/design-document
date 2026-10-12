import { execFileSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs.ts';
import { SnapshotStore, type CaptureSummary } from '../snapshots.ts';
import { CiRun, type CiEnv, type CiRunOptions, type SnapshotCapturer } from './ci-run.ts';
import { CiCommand } from './cli.ts';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

let root: string;
let repo: string;
let head: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-cirun-'));
  repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'README.md'), '# x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const env = (over: Partial<CiEnv> = {}): CiEnv => ({ runId: '77', runAttempt: '2', sha: head, ref: 'feature/x', refType: 'branch', actor: 'alice', repository: 'o/r', apiUrl: 'http://127.0.0.1:1', ...over });

/** runTests replaced: sets the status and writes one trace. */
const fakeTests =
  (status: 'passed' | 'failed' | 'error') =>
  async (repoRoot: string, _c: unknown, run: RunRecord, log: (l: string) => void) => {
    const dir = path.join(repoRoot, '.ddv', 'traces', run.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'T1.json'), '{}');
    log('ran');
    run.status = status;
  };

/** SnapshotService replaced: S1 has a Diff step, S2 matches. */
function fakeSnapshots(over: Partial<SnapshotCapturer> = {}) {
  return (repoRoot: string): SnapshotCapturer => {
    const store = new SnapshotStore(repoRoot);
    return {
      store,
      scenarios: async () => new Map([['S1', {}], ['S2', {}]]) as never,
      capture: async (ids): Promise<CaptureSummary> => {
        const targets = ids ?? ['S1', 'S2'];
        const scenarios: CaptureSummary['scenarios'] = [];
        for (const id of targets) {
          await fs.mkdir(store.dir('current', id), { recursive: true });
          await fs.writeFile(store.current(id, 1), PNG);
          const status = id === 'S1' ? 'Diff' : 'Match';
          await store.writeMeta('current', id, { browser: 'chromium', viewport: { width: 1, height: 1 }, takenAt: 'now', steps: 1, results: [{ step: 1, status }] });
          await store.writeMeta('baseline', id, { browser: 'chromium', viewport: { width: 1, height: 1 }, takenAt: 'old', steps: 1 });
          await fs.writeFile(store.baseline(id, 1), PNG);
          if (status === 'Diff') {
            await fs.mkdir(store.dir('diff', id), { recursive: true });
            await fs.writeFile(store.diff(id, 1), PNG);
          }
          scenarios.push({ id, status: status === 'Diff' ? 'failed' : 'passed', captured: 1, steps: [{ step: 1, status }] });
        }
        return { status: 'failed', scenarios };
      },
      ...over,
    };
  };
}

const noScenarios = fakeSnapshots({ scenarios: async () => new Map() });

interface Case {
  shaDiffers: boolean;
  snapshots: boolean;
  outcome: 'write-fails' | 'passed' | 'failed';
}

async function runCase(c: Case) {
  const out = path.join(root, 'out');
  let blocked = out;
  if (c.outcome === 'write-fails') {
    await fs.writeFile(path.join(root, 'file'), 'x');
    blocked = path.join(root, 'file', 'out');
  }
  const errors: string[] = [];
  const lines: string[] = [];
  const opts: CiRunOptions = {
    repoRoot: repo,
    out: blocked,
    env: env(c.shaDiffers ? { sha: 'b'.repeat(40) } : {}),
    ...(c.shaDiffers ? { sha: head } : {}),
    request: 'req-1',
    runTests: fakeTests(c.outcome === 'failed' ? 'failed' : 'passed'),
    snapshots: c.snapshots ? fakeSnapshots() : noScenarios,
    log: (l) => lines.push(l),
    error: (l) => errors.push(l),
  };
  const r = await new CiRun(opts).run();
  const runJson = path.join(blocked, 'run.json');
  if (c.outcome === 'write-fails') {
    expect(r).toEqual({ status: null, exitCode: 2 });
    expect(existsSync(runJson)).toBe(false);
    expect(errors[0]).toMatch(/^出力先に書き込めませんでした: /);
    return null;
  }
  expect(r.exitCode).toBe(c.outcome === 'passed' ? 0 : 1);
  const rec = JSON.parse(await fs.readFile(runJson, 'utf8'));
  expect(rec).toMatchObject({ id: '77-2', source: 'actions', actionsRunId: '77', actionsRequest: 'req-1', ref: 'feature/x', commit: head, dirty: false, status: c.outcome, traces: ['T1'] });
  expect(await fs.readFile(path.join(out, 'traces', 'T1.json'), 'utf8')).toBe('{}');
  if (c.shaDiffers) expect(rec.warnings).toEqual([`ブランチの先頭（bbbbbbb）ではなく、指定のコミット（${head.slice(0, 7)}）で実行しました`]);
  else expect(rec.warnings).toEqual([]);
  if (c.snapshots) {
    expect(rec.snapshots).toEqual([
      { id: 'S1', status: 'failed', steps: [{ step: 1, status: 'Diff' }] },
      { id: 'S2', status: 'passed', steps: [{ step: 1, status: 'Match' }] },
    ]);
    const snap = path.join(out, 'snapshots');
    for (const f of ['current/S1/meta.json', 'current/S1/001.png', 'diff/S1/001.png', 'baseline/S1/001.png', 'current/S2/meta.json']) expect(existsSync(path.join(snap, f)), f).toBe(true);
    // Matching scenarios keep only meta.json.
    expect(existsSync(path.join(snap, 'current/S2/001.png'))).toBe(false);
    expect(existsSync(path.join(snap, 'baseline/S2'))).toBe(false);
  } else {
    expect(rec.snapshots).toBeUndefined();
    expect(existsSync(path.join(out, 'snapshots'))).toBe(false);
  }
  return rec;
}

describe('ci run', () => {
  it('[DD-ACTWF-CIRUN-P001][DD-ACTWF-CIRUN-T001][DD-ACTWF-CIRUN-T002] GITHUB_RUN_ID がない・引数が不正なら終了コード 2 で何も出力しない', async () => {
    const out = path.join(root, 'out');
    const errors: string[] = [];
    const base = { repoRoot: repo, out, runTests: fakeTests('passed'), snapshots: noScenarios, log: () => {}, error: (l: string) => errors.push(l) };
    expect(await new CiRun({ ...base, env: env({ runId: '' }) }).run()).toEqual({ status: null, exitCode: 2 });
    expect(errors.pop()).toBe('Actions の中で実行してください（GITHUB_RUN_ID がありません）');
    expect((await new CiRun({ ...base, env: env(), sha: 'zz' }).run()).exitCode).toBe(2);
    expect(errors.pop()).toBe('--sha はコミットの SHA です: zz');
    expect((await new CiRun({ ...base, env: env(), repoRoot: path.join(root, 'none') }).run()).exitCode).toBe(2);
    expect(errors.pop()).toMatch(/^リポジトリが見つかりません: /);
    expect((await new CiRun({ ...base, env: env(), runner: 'nope' }).run()).exitCode).toBe(2);
    expect(errors.pop()).toBe('ランナーがありません: nope');
    expect(existsSync(path.join(out, 'run.json'))).toBe(false);
  });

  it('[DD-ACTWF-CIRUN-P002][DD-ACTWF-CIRUN-T003][DD-ACTWF-CIRUN-T004] ddv.config.yaml を読めなければ終了コード 2 で何も出力しない', async () => {
    await fs.writeFile(path.join(repo, 'ddv.config.yaml'), 'runners: [\n');
    const out = path.join(root, 'out');
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, 'run.json'), '{}');
    const errors: string[] = [];
    const r = await new CiRun({ repoRoot: repo, out, env: env(), runTests: fakeTests('passed'), snapshots: noScenarios, log: () => {}, error: (l) => errors.push(l) }).run();
    expect(r.exitCode).toBe(2);
    expect(errors[0]).toMatch(/^ddv.config.yaml を読めません: /);
    expect(existsSync(path.join(out, 'run.json'))).toBe(false);
  });

  it('[DD-ACTWF-CIRUN-P003][DD-ACTWF-CIRUN-T005][DD-ACTWF-CIRUN-T006][DD-ACTWF-CIRUN-T008][DD-ACTWF-CIRUN-T009][DD-ACTWF-CIRUN-T010][DD-ACTWF-CIRUN-T012][DD-ACTWF-CIRUN-T013][DD-ACTWF-CIRUN-T014] sha 違い・撮影あり・書けない → 終了コード 2', async () => {
    await runCase({ shaDiffers: true, snapshots: true, outcome: 'write-fails' });
  });

  it('[DD-ACTWF-CIRUN-P004][DD-ACTWF-CIRUN-T015][DD-ACTWF-CIRUN-T016] sha 違い・撮影あり・passed → 終了コード 0', async () => {
    await runCase({ shaDiffers: true, snapshots: true, outcome: 'passed' });
  });

  it('[DD-ACTWF-CIRUN-P005][DD-ACTWF-CIRUN-T017] sha 違い・撮影あり・failed → 終了コード 1', async () => {
    await runCase({ shaDiffers: true, snapshots: true, outcome: 'failed' });
  });

  it('[DD-ACTWF-CIRUN-P006][DD-ACTWF-CIRUN-T011] sha 違い・撮影なし・書けない → 終了コード 2', async () => {
    await runCase({ shaDiffers: true, snapshots: false, outcome: 'write-fails' });
  });

  it('[DD-ACTWF-CIRUN-P007] sha 違い・撮影なし・passed → 終了コード 0', async () => {
    await runCase({ shaDiffers: true, snapshots: false, outcome: 'passed' });
  });

  it('[DD-ACTWF-CIRUN-P008] sha 違い・撮影なし・failed → 終了コード 1', async () => {
    await runCase({ shaDiffers: true, snapshots: false, outcome: 'failed' });
  });

  it('[DD-ACTWF-CIRUN-P009][DD-ACTWF-CIRUN-T007] sha 同じ・撮影あり・書けない → 終了コード 2', async () => {
    await runCase({ shaDiffers: false, snapshots: true, outcome: 'write-fails' });
  });

  it('[DD-ACTWF-CIRUN-P010] sha 同じ・撮影あり・passed → 終了コード 0', async () => {
    await runCase({ shaDiffers: false, snapshots: true, outcome: 'passed' });
  });

  it('[DD-ACTWF-CIRUN-P011] sha 同じ・撮影あり・failed → 終了コード 1', async () => {
    await runCase({ shaDiffers: false, snapshots: true, outcome: 'failed' });
  });

  it('[DD-ACTWF-CIRUN-P012] sha 同じ・撮影なし・書けない → 終了コード 2', async () => {
    await runCase({ shaDiffers: false, snapshots: false, outcome: 'write-fails' });
  });

  it('[DD-ACTWF-CIRUN-P013] sha 同じ・撮影なし・passed → 終了コード 0', async () => {
    await runCase({ shaDiffers: false, snapshots: false, outcome: 'passed' });
  });

  it('[DD-ACTWF-CIRUN-P014] sha 同じ・撮影なし・failed（error も同じ）→ 終了コード 1', async () => {
    await runCase({ shaDiffers: false, snapshots: false, outcome: 'failed' });
    const r = await new CiRun({ repoRoot: repo, out: path.join(root, 'out2'), env: env(), runTests: fakeTests('error'), snapshots: noScenarios, log: () => {}, error: () => {} }).run();
    expect(r).toMatchObject({ status: 'error', exitCode: 1 });
  });

  it('[DD-ACTWF-CIRUN-P010][DD-ACTWF-CIRUN-T010] --ids は対象のシナリオだけを撮影し、撮影の失敗は警告にして続ける', async () => {
    const out = path.join(root, 'out');
    let asked: string[] | undefined = [];
    const snap = fakeSnapshots();
    const r = await new CiRun({
      repoRoot: repo,
      out,
      ids: ['S2', 'T1'],
      env: env(),
      runTests: fakeTests('passed'),
      snapshots: (root) => {
        const s = snap(root);
        return { ...s, capture: (ids, ev) => ((asked = ids), s.capture(ids, ev)) };
      },
      log: () => {},
      error: () => {},
    }).run();
    expect(asked).toEqual(['S2']);
    expect(r.run?.snapshots?.map((s) => s.id)).toEqual(['S2']);
    const r2 = await new CiRun({
      repoRoot: repo,
      out,
      env: env(),
      runTests: fakeTests('passed'),
      snapshots: fakeSnapshots({
        capture: async (_ids, ev) => {
          ev.log('! ブラウザを起動できませんでした');
          return { status: 'error', scenarios: [] };
        },
      }),
      log: () => {},
      error: () => {},
    }).run();
    expect(r2.exitCode).toBe(0);
    expect(r2.run?.warnings).toEqual(['スナップショットを撮影できませんでした: ブラウザを起動できませんでした']);
  });

  it('[DD-ACTWF-CIRUN-P013] 実際の runTests でコマンドのランナーを実行する（ddv ci run）', async () => {
    await fs.writeFile(path.join(repo, 'ddv.config.yaml'), 'runners:\n  - name: sh\n    type: command\n    cwd: .\n    level: unit\n    command: node -e "process.exit(0)"\n');
    const out = path.join(root, 'out');
    const lines: string[] = [];
    const cmd = new CiCommand({ env: env(), log: (l) => lines.push(l), error: (l) => lines.push(l) });
    const code = await cmd.main(['ci', 'run', '--repo', repo, '--out', out, '--runner', 'sh']);
    const rec = JSON.parse(await fs.readFile(path.join(out, 'run.json'), 'utf8'));
    expect(rec).toMatchObject({ id: '77-2', source: 'actions', request: { runner: 'sh' }, commit: head });
    expect(rec.runners.map((r: { name: string }) => r.name)).toEqual(['sh']);
    expect(code).toBe(rec.status === 'passed' ? 0 : 1);
    expect(lines.at(-1)).toBe(`実行 77-2: ${rec.status}（出力: ${out}）`);
  });
});
