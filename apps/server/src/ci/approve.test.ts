import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approve, type ApproveOptions } from './approve.ts';
import type { CiEnv } from './ci-run.ts';
import { CiCommand } from './cli.ts';
import { entryFromRecord, emptyIndex, writeIndex, type CiRunRecord } from './results-index.ts';
import { bareGit, createRemote, git, HookGit, pushOrphanDir, type TestRemote } from './test-git.ts';

const B = 'ddv-results';
const REF = 'feature/x';
const RUN = '900-1';
const PNG1 = Buffer.from('89504e470d0a1a0a01', 'hex');
const PNG2 = Buffer.from('89504e470d0a1a0a02', 'hex');

let root: string;
let r: TestRemote;
/** Commit of the run (head of the PR branch). */
let runCommit: string;
let seeds = 0;

const meta = (results: unknown[]) => JSON.stringify({ browser: 'chromium', viewport: { width: 10, height: 10 }, takenAt: '2024-06-01T00:00:00Z', steps: 1, results }, null, 2) + '\n';

function record(over: Partial<CiRunRecord> = {}): CiRunRecord {
  return {
    id: RUN,
    kind: 'test',
    startedAt: '2024-06-01T00:00:00Z',
    status: 'failed',
    request: {},
    runners: [],
    results: {},
    log: [],
    source: 'actions',
    actionsRunId: '900',
    ref: REF,
    commit: runCommit,
    dirty: false,
    warnings: [],
    snapshots: [
      { id: 'S1', status: 'failed', steps: [{ step: 1, status: 'Diff' }] },
      { id: 'S2', status: 'passed', steps: [{ step: 1, status: 'Match' }] },
      { id: 'S3', status: 'failed', steps: [{ step: 1, status: 'NoBase' }] },
    ],
    ...over,
  } as CiRunRecord;
}

interface Seed {
  rec?: CiRunRecord;
  /** Scenarios with current images in the results branch. */
  images?: string[];
  /** Write `snapshots/` (false = trimmed). */
  snapshots?: boolean;
  /** Row in index.json. */
  row?: boolean;
}

async function seedResults(s: Seed = {}): Promise<void> {
  const dir = path.join(root, `seed${++seeds}`);
  const rec = s.rec ?? record();
  const runDir = path.join(dir, 'runs', rec.id);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(rec));
  if (s.snapshots ?? true) {
    for (const id of s.images ?? ['S1', 'S3']) {
      const d = path.join(runDir, 'snapshots', 'current', id);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, '001.png'), PNG2);
      await fs.writeFile(path.join(d, 'meta.json'), meta([{ step: 1, status: id === 'S1' ? 'Diff' : 'NoBase', diffRatio: 0.5 }]));
    }
  }
  const index = emptyIndex();
  if (s.row ?? true) index.runs.push(entryFromRecord(rec, { traces: false }));
  await writeIndex(dir, index);
  pushOrphanDir(r.other, B, dir);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-approve-'));
  r = await createRemote(root);
  await fs.mkdir(path.join(r.work, '.ddv/snapshots/baseline/S1'), { recursive: true });
  await fs.writeFile(path.join(r.work, '.ddv/snapshots/baseline/S1/001.png'), PNG1);
  await fs.writeFile(path.join(r.work, '.ddv/snapshots/baseline/S1/meta.json'), JSON.stringify({ browser: 'chromium', viewport: { width: 10, height: 10 }, takenAt: '2024-05-01T00:00:00Z', steps: 1 }, null, 2) + '\n');
  await fs.writeFile(path.join(r.work, '.gitignore'), '.ddv/snapshots/diff/\n');
  git(r.work, ['add', '-A']);
  git(r.work, ['commit', '-q', '-m', 'baseline']);
  git(r.work, ['push', '-q', 'origin', 'main']);
  git(r.work, ['checkout', '-q', '-b', REF]);
  await fs.writeFile(path.join(r.work, 'app.txt'), 'v1\n');
  git(r.work, ['add', '-A']);
  git(r.work, ['commit', '-q', '-m', 'feature']);
  git(r.work, ['push', '-q', '-u', 'origin', REF]);
  runCommit = git(r.work, ['rev-parse', 'HEAD']);
  git(r.other, ['fetch', '-q', 'origin']);
  seeds = 0;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const env = (over: Partial<CiEnv> = {}): CiEnv => ({ runId: '901', runAttempt: '1', sha: runCommit, ref: REF, refType: 'branch', actor: 'bob', repository: 'o/r', apiUrl: 'https://api.example.test', token: 'ghs_tok', ...over });

function opts(over: Partial<ApproveOptions> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const o: ApproveOptions = { repoRoot: r.work, run: RUN, branch: B, request: 'req-5', env: env(), tmpRoot: root, now: () => new Date('2024-06-02T00:00:00Z'), log: (l) => logs.push(l), error: (l) => errors.push(l), ...over };
  return { o, logs, errors };
}

const remoteHead = () => bareGit(r.remote, ['rev-parse', `refs/heads/${REF}`]);
const approvals = () => JSON.parse(bareGit(r.remote, ['show', `refs/heads/${B}:index.json`])).runs.find((x: { id: string }) => x.id === RUN)?.approvals;

/** Fails with `message` (exit 1) without touching the PR branch. */
async function expectError(o: ApproveOptions, errors: string[], message: string) {
  const before = remoteHead();
  expect(await approve(o)).toBe(1);
  expect(errors).toEqual([message]);
  expect(remoteHead()).toBe(before);
  expect(git(r.work, ['worktree', 'list']).split('\n')).toHaveLength(1);
}

describe('ddv ci approve', { timeout: 60_000 }, () => {
  it('[DD-ACTWF-APPROVE-P001][DD-ACTWF-APPROVE-T001][DD-ACTWF-APPROVE-T002] Actions の外・--run の誤りは終了コード 2', async () => {
    const a = opts({ env: env({ runId: '' }) });
    expect(await approve(a.o)).toBe(2);
    expect(a.errors).toEqual(['Actions の中で実行してください（GITHUB_RUN_ID がありません）']);
    for (const run of ['', '..', 'a/b']) {
      const b = opts({ run });
      expect(await approve(b.o)).toBe(2);
      expect(b.errors[0]).toMatch(/^--run には/);
    }
    const errors: string[] = [];
    const cmd = new CiCommand({ env: env(), log: () => {}, error: (l) => errors.push(l) });
    expect(await cmd.main(['ci', 'approve', '--repo', r.work])).toBe(2);
    expect(errors.pop()).toBe('--run を指定してください');
    expect(await cmd.main(['ci', 'approve', '--repo', r.work, '--run', RUN, '--branch', 'bad..name'])).toBe(2);
  });

  it('[DD-ACTWF-APPROVE-P002][DD-ACTWF-APPROVE-T003][DD-ACTWF-APPROVE-T004] タグに対しては承認しない', async () => {
    const { o, errors } = opts({ env: env({ refType: 'tag', ref: 'v1.0.0' }) });
    await expectError(o, errors, '基準画像の承認はブランチに対してだけ行えます（v1.0.0）');
  });

  it('[DD-ACTWF-APPROVE-P003][DD-ACTWF-APPROVE-T005][DD-ACTWF-APPROVE-T006] 対象リポジトリにブランチが無ければ（fork の PR）承認しない', async () => {
    const { o, errors } = opts({ env: env({ ref: 'fork-branch' }) });
    await expectError(o, errors, 'ブランチ fork-branch が対象リポジトリにありません（fork の PR は承認できません）');
  });

  it('[DD-ACTWF-APPROVE-P004][DD-ACTWF-APPROVE-T007][DD-ACTWF-APPROVE-T008] 結果ブランチに実行の結果が無い（無い・削除済み・trim 済み）', async () => {
    const message = `実行 ${RUN} の結果が結果ブランチにありません（削除済みの可能性）`;
    const a = opts();
    await expectError(a.o, a.errors, message);
    await seedResults({ rec: record({ id: '899-1' }) });
    const b = opts();
    await expectError(b.o, b.errors, message);
    await seedResults({ snapshots: false });
    const c = opts();
    await expectError(c.o, c.errors, message);
  });

  it('[DD-ACTWF-APPROVE-P005][DD-ACTWF-APPROVE-T009][DD-ACTWF-APPROVE-T010] ブランチが実行のコミットを含まない（force push された）', async () => {
    const other = git(r.work, ['rev-parse', 'main']);
    git(r.work, ['checkout', '-q', '--detach', 'main']);
    await fs.writeFile(path.join(r.work, 'x.txt'), 'x\n');
    git(r.work, ['add', '-A']);
    git(r.work, ['commit', '-q', '-m', 'elsewhere']);
    const elsewhere = git(r.work, ['rev-parse', 'HEAD']);
    git(r.work, ['checkout', '-q', REF]);
    expect(elsewhere).not.toBe(other);
    await seedResults({ rec: record({ commit: elsewhere }) });
    const { o, errors } = opts();
    await expectError(o, errors, `ブランチ ${REF} が実行のコミット ${elsewhere.slice(0, 7)} を含みません（force push された可能性）`);
  });

  it('[DD-ACTWF-APPROVE-P006][DD-ACTWF-APPROVE-T011][DD-ACTWF-APPROVE-T012] 対象のどれかに今回の画像が無ければ何も承認しない', async () => {
    await seedResults({ images: ['S1'] });
    const { o, errors } = opts({ ids: ['S1', 'S2', 'S3'] });
    await expectError(o, errors, '今回の画像がありません: S2,S3');
    expect(git(r.work, ['status', '--porcelain', '--', '.ddv/snapshots/baseline'])).toBe('');
    // Without --ids and nothing to approve.
    await seedResults({ rec: record({ snapshots: [{ id: 'S2', status: 'passed', steps: [{ step: 1, status: 'Match' }] }] }) });
    const b = opts();
    await expectError(b.o, b.errors, '承認する画像がありません');
  });

  it('[DD-ACTWF-APPROVE-P009][DD-ACTWF-APPROVE-T013][DD-ACTWF-APPROVE-T014][DD-ACTWF-APPROVE-T016][DD-ACTWF-APPROVE-T017][DD-ACTWF-APPROVE-T019] Diff・NoBase のシナリオを承認してコミット・push し、index に記録する', async () => {
    await seedResults();
    const { o, logs, errors } = opts();
    expect(await approve(o)).toBe(0);
    expect(errors).toEqual([]);
    const head = remoteHead();
    expect(git(r.work, ['rev-parse', 'HEAD'])).toBe(head);
    expect(bareGit(r.remote, ['rev-parse', `${head}^`])).toBe(runCommit);
    expect(bareGit(r.remote, ['log', '-1', '--format=%an%n%B', head])).toBe('github-actions[bot]\nddv: 基準画像を承認（S1,S3）\n\nrun: 900-1\nrequest: req-5');
    expect(bareGit(r.remote, ['show', '--name-only', '--format=', head]).split('\n').sort()).toEqual([
      '.ddv/snapshots/baseline/S1/001.png',
      '.ddv/snapshots/baseline/S1/meta.json',
      '.ddv/snapshots/baseline/S3/001.png',
      '.ddv/snapshots/baseline/S3/meta.json',
    ]);
    const blob = (ref: string) => bareGit(r.remote, ['rev-parse', ref]);
    expect(blob(`${head}:.ddv/snapshots/baseline/S1/001.png`)).toBe(blob(`refs/heads/${B}:runs/${RUN}/snapshots/current/S1/001.png`));
    expect(JSON.parse(bareGit(r.remote, ['show', `${head}:.ddv/snapshots/baseline/S3/meta.json`]))).not.toHaveProperty('results');
    expect(logs).toContain(`基準画像を承認しました（S1,S3）: コミット ${head.slice(0, 7)}`);
    expect(approvals()).toEqual([{ request: 'req-5', actionsRunId: '901', ids: ['S1', 'S3'], commit: head, at: '2024-06-02T00:00:00.000Z', actor: 'bob' }]);
  });

  it('[DD-ACTWF-APPROVE-P007][DD-ACTWF-APPROVE-T015] baseline に変更が無ければコミットせず、変更なしとして index に記録する', async () => {
    await seedResults();
    expect(await approve(opts({ ids: ['S1'] }).o)).toBe(0);
    const head = remoteHead();
    const { o, logs } = opts({ ids: ['S1'], request: undefined });
    expect(await approve(o)).toBe(0);
    expect(remoteHead()).toBe(head);
    expect(logs).toContain('基準画像に変更はありませんでした（S1）');
    expect(approvals().at(-1)).toEqual({ actionsRunId: '901', ids: ['S1'], commit: null, at: '2024-06-02T00:00:00.000Z', actor: 'bob' });
  });

  it('[DD-ACTWF-APPROVE-P008][DD-ACTWF-APPROVE-T018] push できなければ（保護されたブランチなど）エラー', async () => {
    await seedResults();
    const git1 = new HookGit((args) => {
      if (args[0] === 'push' && !args.includes('--porcelain')) return { code: 1, stdout: '', stderr: 'remote: error: GH006: Protected branch update failed for refs/heads/feature/x.\nerror: failed to push some refs' };
    });
    const { o, errors } = opts({ git: git1 });
    await expectError(o, errors, 'PR のブランチに push できませんでした: remote: error: GH006: Protected branch update failed for refs/heads/feature/x. / error: failed to push some refs（保護されたブランチ・権限を確認してください）');
    expect(approvals()).toEqual([]);
  });

  it('[DD-ACTWF-APPROVE-P008] push の拒否がやり直しの上限を超えたら push できない', async () => {
    await seedResults();
    let n = 0;
    const hook = new HookGit(async (args) => {
      if (args[0] === 'push' && !args.includes('--porcelain')) {
        git(r.other, ['fetch', '-q', 'origin']);
        git(r.other, ['checkout', '-q', '-B', REF, `origin/${REF}`]);
        await fs.writeFile(path.join(r.other, `o${++n}.txt`), 'x');
        git(r.other, ['add', '-A']);
        git(r.other, ['commit', '-q', '-m', `other ${n}`]);
        git(r.other, ['push', '-q', 'origin', `HEAD:${REF}`]);
      }
    });
    const { o, errors } = opts({ git: hook, retries: 1 });
    expect(await approve(o)).toBe(1);
    expect(errors[0]).toMatch(/^PR のブランチに push できませんでした: .*（保護されたブランチ・権限を確認してください）$/);
    expect(n).toBe(2);
  });

  it('[DD-ACTWF-APPROVE-P009] 拒否されたら取り直してやり直す。先頭が実行のコミットより進んでいれば本文に書く', async () => {
    await fs.writeFile(path.join(r.work, 'app.txt'), 'v2\n');
    git(r.work, ['commit', '-q', '-am', 'ahead']);
    git(r.work, ['push', '-q', 'origin', REF]);
    await seedResults();
    let n = 0;
    const hook = new HookGit(async (args) => {
      if (args[0] === 'push' && !args.includes('--porcelain') && n++ === 0) {
        git(r.other, ['fetch', '-q', 'origin']);
        git(r.other, ['checkout', '-q', '-B', REF, `origin/${REF}`]);
        await fs.writeFile(path.join(r.other, 'other.txt'), 'x');
        git(r.other, ['add', '-A']);
        git(r.other, ['commit', '-q', '-m', 'other']);
        git(r.other, ['push', '-q', 'origin', `HEAD:${REF}`]);
      }
    });
    const { o, logs } = opts({ git: hook, ids: ['S1'] });
    expect(await approve(o)).toBe(0);
    expect(logs).toContain('! PR のブランチへの push が拒否されました。取り直してやり直します（1 回目）');
    const head = remoteHead();
    expect(bareGit(r.remote, ['log', '-1', '--format=%s', `${head}^`])).toBe('other');
    expect(bareGit(r.remote, ['log', '-1', '--format=%b', head])).toBe(`run: 900-1\nrequest: req-5\n承認した画像はコミット ${runCommit.slice(0, 7)} の実行のものです`);
    expect(approvals()[0].commit).toBe(head);
  });

  it('[DD-ACTWF-APPROVE-P009] 行が剪定で消えていれば記録しない。記録に失敗したらコミットは残して終了コード 1', async () => {
    await seedResults({ row: false });
    const a = opts({ ids: ['S1'] });
    expect(await approve(a.o)).toBe(0);
    expect(a.logs.at(-1)).toBe(`! 実行 ${RUN} は結果ブランチの index にないため、承認を記録しません`);
    expect(approvals()).toBeUndefined();
    await seedResults();
    const hook = new HookGit((args) => {
      if (args[0] === 'push' && args.includes('--porcelain')) return { code: 128, stdout: '', stderr: 'fatal: Authentication failed' };
    });
    const b = opts({ git: hook, ids: ['S3'] });
    expect(await approve(b.o)).toBe(1);
    const head = remoteHead();
    expect(bareGit(r.remote, ['log', '-1', '--format=%s', head])).toBe('ddv: 基準画像を承認（S3）');
    expect(b.errors).toEqual([`基準画像はコミットしました（${head.slice(0, 7)}）が、結果ブランチへの記録に失敗しました: fatal: Authentication failed`]);
  });
});
