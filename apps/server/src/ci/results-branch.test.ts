import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextPushState, ResultsBranch, ResultsBranchError, type PushEvent, type PushState } from './results-branch.ts';
import { bareGit, createRemote, deleteRemoteBranch, git, HookGit, pushOrphan, remoteHas, type TestRemote } from './test-git.ts';

const B = 'ddv-results';
const SECRET = 'ghs_secretTOKEN123';

let root: string;
let tmp: string;
let r: TestRemote;
let seeds = 0;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-push-'));
  tmp = path.join(root, 'tmp');
  await fs.mkdir(tmp);
  r = await createRemote(root);
  seeds = 0;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

type Fetch = 'exists' | 'missing' | 'fail';
type Push = 'ok' | 'reject' | 'fail';
interface Attempt {
  fetch: Fetch;
  edit?: 'ok' | 'fail';
  push?: Push;
}

const seed = () => pushOrphan(r.other, B, { 'seed.txt': `seed ${++seeds}\n` });

/** Runs `update` with the remote prepared / failures injected per attempt. */
async function play(attempts: Attempt[], retries?: number) {
  let n = -1;
  const hook = new HookGit(async (args) => {
    if (args[0] === 'ls-remote' && args.includes(B)) {
      n++;
      const a = attempts[n];
      if (!a) throw new Error(`unexpected attempt ${n + 1}`);
      if (a.fetch === 'fail') return { code: 128, stdout: '', stderr: `fatal: unable to access 'https://x-access-token:${SECRET}@github.com/o/r/': Could not resolve host` };
      if (a.fetch === 'exists') seed();
      else if (remoteHas(r.remote, B)) deleteRemoteBranch(r.other, B);
    }
    if (args[0] === 'push' && args.includes('--porcelain')) {
      const a = attempts[n];
      if (a.push === 'fail') return { code: 128, stdout: '', stderr: `remote: Permission to o/r.git denied.\nfatal: unable to access 'https://x-access-token:${SECRET}@github.com/o/r/': The requested URL returned error: 403` };
      // Another run pushes first: a different commit, or the branch appears.
      if (a.push === 'reject') seed();
    }
  });
  const logs: string[] = [];
  const branch = new ResultsBranch({ repoRoot: r.work, branch: B, git: hook, retries, tmpRoot: tmp, log: (l) => logs.push(l), tokens: [SECRET] });
  let k = 0;
  const outcome = await branch
    .update(async (dir, index) => {
      const a = attempts[k++];
      if (a.edit === 'fail') throw new Error(`書けません ${SECRET}`);
      await fs.writeFile(path.join(dir, 'note.txt'), `attempt ${k}\n`);
      expect(existsSync(path.join(dir, 'seed.txt'))).toBe(attempts[k - 1].fetch === 'exists');
      return index;
    }, 'ddv results: 1-1')
    .catch((e) => e);
  // The temporary worktrees are always removed.
  expect(await fs.readdir(tmp)).toEqual([]);
  expect(git(r.work, ['worktree', 'list']).split('\n')).toHaveLength(1);
  expect(n + 1).toBe(attempts.length);
  return { branch, outcome, logs, hook };
}

const S = (...s: PushState[]) => s;
const ok: Attempt[] = [];
const rejected = (fetch: Fetch): Attempt => ({ fetch, edit: 'ok', push: 'reject' });

async function expectDone(attempts: Attempt[], trace: PushState[]) {
  const { branch, outcome, logs } = await play(attempts);
  expect(branch.trace).toEqual(trace);
  expect(branch.state).toBe('Done');
  expect(outcome).toMatchObject({ attempts: attempts.length, created: attempts.at(-1)!.fetch === 'missing' });
  // One parentless commit by the bot that holds the edit and index.json.
  const head = bareGit(r.remote, ['rev-parse', `refs/heads/${B}`]);
  expect(head).toBe(outcome.commit);
  expect(bareGit(r.remote, ['rev-list', '--parents', '-n', '1', head])).toBe(head);
  expect(bareGit(r.remote, ['log', '-1', '--format=%an|%s', head])).toBe('github-actions[bot]|ddv results: 1-1');
  expect(bareGit(r.remote, ['show', `${head}:note.txt`])).toBe(`attempt ${attempts.length}`);
  expect(JSON.parse(bareGit(r.remote, ['show', `${head}:index.json`]))).toMatchObject({ version: 1, runs: [] });
  return logs;
}

async function expectFailed(attempts: Attempt[], trace: PushState[], code: string, retries?: number) {
  const { branch, outcome } = await play(attempts, retries);
  expect(outcome.message ?? outcome, 'error').toBeTruthy();
  expect([branch.trace, outcome.code], String(outcome.message)).toEqual([trace, code]);
  expect(branch.state).toBe('Failed');
  expect(outcome).toBeInstanceOf(ResultsBranchError);
  expect(outcome.code).toBe(code);
  expect(outcome.attempts).toBe(attempts.length);
  expect(outcome.message).not.toContain(SECRET);
  if (code === 'conflict') expect(outcome.message).toBe(`結果ブランチへの保存が競合しました（${attempts.length} 回試行）`);
  // Our commit never reached the remote.
  if (remoteHas(r.remote, B)) expect(bareGit(r.remote, ['ls-tree', '--name-only', `refs/heads/${B}`])).not.toContain('note.txt');
  return outcome as ResultsBranchError;
}

const F = 'Fetching' as const;
const E = 'Editing' as const;
const P = 'Pushing' as const;

describe('ResultsBranch.update', { timeout: 60_000 }, () => {
  it('[DD-ACTWF-PUSH-P001][DD-ACTWF-PUSH-T001][DD-ACTWF-PUSH-T002][DD-ACTWF-PUSH-T005][DD-ACTWF-PUSH-T007][DD-ACTWF-PUSH-T011] ブランチあり → 書き込み → push 成功', async () => {
    await expectDone([{ fetch: 'exists' }], S(F, E, P, 'Done'));
  });

  it('[DD-ACTWF-PUSH-P002][DD-ACTWF-PUSH-T008] 拒否 → 取り直して（ブランチあり）push 成功', async () => {
    const logs = await expectDone([rejected('exists'), { fetch: 'exists' }], S(F, E, P, F, E, P, 'Done'));
    expect(logs).toContain('! 結果ブランチへの push が競合しました。取り直してやり直します（1 回目）');
  });

  it('[DD-ACTWF-PUSH-P003][DD-ACTWF-PUSH-T009][DD-ACTWF-PUSH-T012] 拒否 → ブランチあり → 拒否（やり直しの上限）で失敗', async () => {
    await expectFailed([rejected('exists'), rejected('exists')], S(F, E, P, F, E, P, 'Failed'), 'conflict', 1);
  });

  it('[DD-ACTWF-PUSH-P004][DD-ACTWF-PUSH-T010] 拒否 → ブランチあり → push 失敗（認証など）', async () => {
    const e = await expectFailed([rejected('exists'), { fetch: 'exists', push: 'fail' }], S(F, E, P, F, E, P, 'Failed'), 'push-failed');
    expect(e.message).toContain('The requested URL returned error: 403');
  });

  it('[DD-ACTWF-PUSH-P005][DD-ACTWF-PUSH-T006] 拒否 → ブランチあり → 編集失敗', async () => {
    const e = await expectFailed([rejected('exists'), { fetch: 'exists', edit: 'fail' }], S(F, E, P, F, E, 'Failed'), 'edit-failed');
    expect(e.message).toBe('書けません ***');
  });

  it('[DD-ACTWF-PUSH-P006][DD-ACTWF-PUSH-T003] 拒否 → ブランチなし（削除された）→ push 成功', async () => {
    await expectDone([rejected('exists'), { fetch: 'missing' }], S(F, E, P, F, E, P, 'Done'));
  });

  it('[DD-ACTWF-PUSH-P007] 拒否 → ブランチなし → 拒否（上限）', async () => {
    await expectFailed([rejected('exists'), rejected('missing')], S(F, E, P, F, E, P, 'Failed'), 'conflict', 1);
  });

  it('[DD-ACTWF-PUSH-P008] 拒否 → ブランチなし → push 失敗', async () => {
    await expectFailed([rejected('exists'), { fetch: 'missing', push: 'fail' }], S(F, E, P, F, E, P, 'Failed'), 'push-failed');
  });

  it('[DD-ACTWF-PUSH-P009] 拒否 → ブランチなし → 編集失敗', async () => {
    await expectFailed([rejected('exists'), { fetch: 'missing', edit: 'fail' }], S(F, E, P, F, E, 'Failed'), 'edit-failed');
  });

  it('[DD-ACTWF-PUSH-P010][DD-ACTWF-PUSH-T004] 拒否 → 取得失敗', async () => {
    const e = await expectFailed([rejected('exists'), { fetch: 'fail' }], S(F, E, P, F, 'Failed'), 'fetch-failed');
    expect(e.message).toContain('Could not resolve host');
    expect(e.message).toContain('***');
  });

  it('[DD-ACTWF-PUSH-P011] ブランチあり → 拒否が上限（既定 3 回のやり直し = 4 回試行）', async () => {
    await expectFailed([rejected('exists')], S(F, E, P, 'Failed'), 'conflict', 0);
    await fs.rm(path.join(root, 'tmp'), { recursive: true, force: true });
    await fs.mkdir(tmp);
    const four = [rejected('exists'), rejected('exists'), rejected('exists'), rejected('exists')];
    await expectFailed(four, S(F, E, P, F, E, P, F, E, P, F, E, P, 'Failed'), 'conflict');
  });

  it('[DD-ACTWF-PUSH-P012] ブランチあり → push 失敗', async () => {
    await expectFailed([{ fetch: 'exists', push: 'fail' }], S(F, E, P, 'Failed'), 'push-failed');
  });

  it('[DD-ACTWF-PUSH-P013] ブランチあり → 編集失敗', async () => {
    await expectFailed([{ fetch: 'exists', edit: 'fail' }], S(F, E, 'Failed'), 'edit-failed');
  });

  it('[DD-ACTWF-PUSH-P014] ブランチなし → 親のないコミットを作って push 成功', async () => {
    await expectDone([{ fetch: 'missing' }], S(F, E, P, 'Done'));
  });

  it('[DD-ACTWF-PUSH-P015] ブランチなし → 拒否（先に作られた）→ ブランチあり → push 成功', async () => {
    await expectDone([rejected('missing'), { fetch: 'exists' }], S(F, E, P, F, E, P, 'Done'));
  });

  it('[DD-ACTWF-PUSH-P016] ブランチなし → 拒否 → ブランチあり → 拒否（上限）', async () => {
    await expectFailed([rejected('missing'), rejected('exists')], S(F, E, P, F, E, P, 'Failed'), 'conflict', 1);
  });

  it('[DD-ACTWF-PUSH-P017] ブランチなし → 拒否 → ブランチあり → push 失敗', async () => {
    await expectFailed([rejected('missing'), { fetch: 'exists', push: 'fail' }], S(F, E, P, F, E, P, 'Failed'), 'push-failed');
  });

  it('[DD-ACTWF-PUSH-P018] ブランチなし → 拒否 → ブランチあり → 編集失敗', async () => {
    await expectFailed([rejected('missing'), { fetch: 'exists', edit: 'fail' }], S(F, E, P, F, E, 'Failed'), 'edit-failed');
  });

  it('[DD-ACTWF-PUSH-P019] ブランチなし → 拒否 → ブランチなし → push 成功', async () => {
    await expectDone([rejected('missing'), { fetch: 'missing' }], S(F, E, P, F, E, P, 'Done'));
  });

  it('[DD-ACTWF-PUSH-P020] ブランチなし → 拒否 → ブランチなし → 拒否（上限）', async () => {
    await expectFailed([rejected('missing'), rejected('missing')], S(F, E, P, F, E, P, 'Failed'), 'conflict', 1);
  });

  it('[DD-ACTWF-PUSH-P021] ブランチなし → 拒否 → ブランチなし → push 失敗', async () => {
    await expectFailed([rejected('missing'), { fetch: 'missing', push: 'fail' }], S(F, E, P, F, E, P, 'Failed'), 'push-failed');
  });

  it('[DD-ACTWF-PUSH-P022] ブランチなし → 拒否 → ブランチなし → 編集失敗', async () => {
    await expectFailed([rejected('missing'), { fetch: 'missing', edit: 'fail' }], S(F, E, P, F, E, 'Failed'), 'edit-failed');
  });

  it('[DD-ACTWF-PUSH-P023] ブランチなし → 拒否 → 取得失敗', async () => {
    await expectFailed([rejected('missing'), { fetch: 'fail' }], S(F, E, P, F, 'Failed'), 'fetch-failed');
  });

  it('[DD-ACTWF-PUSH-P024] ブランチなし → 拒否が上限', async () => {
    await expectFailed([rejected('missing')], S(F, E, P, 'Failed'), 'conflict', 0);
  });

  it('[DD-ACTWF-PUSH-P025] ブランチなし → push 失敗', async () => {
    await expectFailed([{ fetch: 'missing', push: 'fail' }], S(F, E, P, 'Failed'), 'push-failed');
  });

  it('[DD-ACTWF-PUSH-P026] ブランチなし → 編集失敗', async () => {
    await expectFailed([{ fetch: 'missing', edit: 'fail' }], S(F, E, 'Failed'), 'edit-failed');
  });

  it('[DD-ACTWF-PUSH-P027] 取得失敗', async () => {
    await expectFailed([{ fetch: 'fail' }], S(F, 'Failed'), 'fetch-failed');
  });

  it('[DD-ACTWF-PUSH-T011][DD-ACTWF-PUSH-T012] 完了・失敗の後は次の update を受け付け、更新中の update は拒む', async () => {
    const hook = new HookGit();
    const branch = new ResultsBranch({ repoRoot: r.work, branch: B, git: hook, tmpRoot: tmp });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const first = branch.update(async () => {
      await gate;
    }, 'one');
    await expect.poll(() => branch.state).toBe('Editing');
    await expect(branch.update(async () => {}, 'two')).rejects.toThrow('結果ブランチの更新が進行中です');
    release();
    await first;
    expect(branch.state).toBe('Done');
    await branch.update(async () => {}, 'three');
    expect(bareGit(r.remote, ['log', '-1', '--format=%s', `refs/heads/${B}`])).toBe('three');
    void ok;
  });
});

describe('nextPushState', () => {
  const events: Record<string, PushEvent> = {
    取得: { type: 'fetched', exists: true },
    取得失敗: { type: 'fetch-failed' },
    書き込み完了: { type: 'written' },
    編集失敗: { type: 'edit-failed' },
    'push 成功': { type: 'pushed' },
    拒否: { type: 'rejected', retries: 0, maxRetries: 3 },
    'push 失敗': { type: 'push-failed' },
  };
  const invalid = (state: PushState, names: string[]) => {
    for (const n of names) expect(nextPushState(state, events[n]), `${state} ${n}`).toBeNull();
  };

  it('[DD-ACTWF-PUSH-T002][DD-ACTWF-PUSH-T003][DD-ACTWF-PUSH-T008][DD-ACTWF-PUSH-T009] 有効な遷移', () => {
    expect(nextPushState('Idle', { type: 'start' })).toBe('Fetching');
    expect(nextPushState('Fetching', { type: 'fetched', exists: false })).toBe('Editing');
    expect(nextPushState('Pushing', { type: 'rejected', retries: 2, maxRetries: 3 })).toBe('Fetching');
    expect(nextPushState('Pushing', { type: 'rejected', retries: 3, maxRetries: 3 })).toBe('Failed');
  });

  it('[DD-ACTWF-PUSH-X001][DD-ACTWF-PUSH-X002][DD-ACTWF-PUSH-X003][DD-ACTWF-PUSH-X004][DD-ACTWF-PUSH-X005] 取得中では書き込み・push の出来事を無視する', () => {
    invalid('Fetching', ['書き込み完了', '編集失敗', 'push 成功', '拒否', 'push 失敗']);
  });

  it('[DD-ACTWF-PUSH-X006][DD-ACTWF-PUSH-X007][DD-ACTWF-PUSH-X008][DD-ACTWF-PUSH-X009][DD-ACTWF-PUSH-X010] 編集中では取得・push の出来事を無視する', () => {
    invalid('Editing', ['取得', '取得失敗', 'push 成功', '拒否', 'push 失敗']);
  });

  it('[DD-ACTWF-PUSH-X011][DD-ACTWF-PUSH-X012][DD-ACTWF-PUSH-X013][DD-ACTWF-PUSH-X014] push 中では取得・書き込みの出来事を無視する', () => {
    invalid('Pushing', ['取得', '取得失敗', '書き込み完了', '編集失敗']);
  });

  it('[DD-ACTWF-PUSH-X015][DD-ACTWF-PUSH-X016][DD-ACTWF-PUSH-X017][DD-ACTWF-PUSH-X018][DD-ACTWF-PUSH-X019][DD-ACTWF-PUSH-X020][DD-ACTWF-PUSH-X021] 完了ではどの出来事も無視する', () => {
    invalid('Done', Object.keys(events));
  });

  it('[DD-ACTWF-PUSH-X022][DD-ACTWF-PUSH-X023][DD-ACTWF-PUSH-X024][DD-ACTWF-PUSH-X025][DD-ACTWF-PUSH-X026][DD-ACTWF-PUSH-X027][DD-ACTWF-PUSH-X028] 失敗ではどの出来事も無視する', () => {
    invalid('Failed', Object.keys(events));
  });
});
