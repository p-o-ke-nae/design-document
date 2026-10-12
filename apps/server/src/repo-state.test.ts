import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { porcelainPath, RepoStateReader, REPO_STATE_TIMEOUT_MS, type GitRunner } from './repo-state.ts';

const SHA = 'a'.repeat(40);

/** Fake git: answers rev-parse / status, or throws when the answer is an Error. */
function fakeGit(revParse: string | Error, status: string | Error): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (args: string[], timeoutMs: number) => {
    calls.push(args);
    expect(timeoutMs).toBe(REPO_STATE_TIMEOUT_MS);
    const out = args.includes('rev-parse') ? revParse : status;
    if (out instanceof Error) throw out;
    return out;
  }) as GitRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe('RepoStateReader（DD-RUNREC-REPOSTATE）', () => {
  it('[DD-RUNREC-REPOSTATE-P001] [DD-RUNREC-REPOSTATE-T001] [DD-RUNREC-REPOSTATE-T002] rev-parse が失敗したら不明（null）', async () => {
    const git = fakeGit(new Error('not a git repository'), '');
    expect(await new RepoStateReader(git).read('/repo')).toBeNull();
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0].slice(0, 2)).toEqual(['-C', '/repo']);
  });

  it('[DD-RUNREC-REPOSTATE-P002] [DD-RUNREC-REPOSTATE-T003] [DD-RUNREC-REPOSTATE-T004] status が失敗（タイムアウト等）したら不明（null）', async () => {
    const git = fakeGit(`\n${SHA}\n`, new Error('timeout'));
    expect(await new RepoStateReader(git).read('/repo')).toBeNull();
    expect(git.calls[1]).toEqual(['-C', '/repo', 'status', '--porcelain=v1', '--untracked-files=normal']);
  });

  it('[DD-RUNREC-REPOSTATE-P003] [DD-RUNREC-REPOSTATE-T005] [DD-RUNREC-REPOSTATE-T006] .ddv/ 配下以外の変更があれば dirty: true', async () => {
    const st = ' M .ddv/testids.lock.json\n?? .ddv/snapshots/baseline/a.png\nR  old.md -> docs/new.md\n';
    expect(await new RepoStateReader(fakeGit(`\n${SHA}\n`, st)).read('/repo')).toEqual({ commit: SHA, dirty: true });
  });

  it('[DD-RUNREC-REPOSTATE-P004] [DD-RUNREC-REPOSTATE-T007] .ddv/ 配下だけの変更（rename の移動先・サブディレクトリのリポジトリも）なら dirty: false', async () => {
    const st = ' M .ddv/testids.lock.json\nR  docs/x.md -> .ddv/x.md\n?? "app/.ddv/runs/a b.json"\n';
    expect(await new RepoStateReader(fakeGit(`app/\n${SHA}\n`, st)).read('/repo/app')).toEqual({ commit: SHA, dirty: false });
    expect(await new RepoStateReader(fakeGit(`\n${SHA}\n`, '')).read('/repo')).toEqual({ commit: SHA, dirty: false });
  });

  it('porcelain の行からパスを取り出す', () => {
    expect(porcelainPath(' M a.md')).toBe('a.md');
    expect(porcelainPath('R  a.md -> b.md')).toBe('b.md');
    expect(porcelainPath('?? "a b.md"')).toBe('a b.md');
  });

  it('実際の git リポジトリ：コミット・.gitignore・.ddv/ を区別する', async () => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      return;
    }
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    try {
      expect(await new RepoStateReader().read(repo)).toBeNull();
      git('init', '-q');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      git('config', 'commit.gpgsign', 'false');
      await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
      await fs.writeFile(path.join(repo, 'a.md'), 'a');
      await fs.mkdir(path.join(repo, 'sub'));
      await fs.writeFile(path.join(repo, 'sub/b.md'), 'b');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      const head = git('rev-parse', 'HEAD').trim();
      await fs.writeFile(path.join(repo, 'ignored.txt'), 'x');
      await fs.mkdir(path.join(repo, '.ddv/runs'), { recursive: true });
      await fs.writeFile(path.join(repo, '.ddv/runs/r.json'), '{}');
      expect(await new RepoStateReader().read(repo)).toEqual({ commit: head, dirty: false });
      await fs.mkdir(path.join(repo, 'sub/.ddv'));
      await fs.writeFile(path.join(repo, 'sub/.ddv/x.json'), '{}');
      expect(await new RepoStateReader().read(path.join(repo, 'sub'))).toEqual({ commit: head, dirty: false });
      await fs.writeFile(path.join(repo, 'a.md'), 'changed');
      expect(await new RepoStateReader().read(repo)).toEqual({ commit: head, dirty: true });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
