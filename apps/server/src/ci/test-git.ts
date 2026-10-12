import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CiGit, type CiGitLike, type GitOutput, type GitRunOptions } from './ci-git.ts';

/** Helpers for tests: real repositories (a bare remote and clones) under a temporary directory. */

export const TEST_GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_TERMINAL_PROMPT: '0' };

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: TEST_GIT_ENV, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export interface TestRemote {
  remote: string;
  /** Clone used by the code under test. */
  work: string;
  /** Another clone, used to move the remote under the code under test. */
  other: string;
}

/** A bare remote with `main` (one commit) and two clones. */
export async function createRemote(root: string, files: Record<string, string> = { 'README.md': '# app\n' }): Promise<TestRemote> {
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(root, ['clone', '-q', remote, work]);
  git(work, ['config', 'core.autocrlf', 'false']);
  git(work, ['checkout', '-q', '-b', 'main']);
  for (const [f, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(work, f)), { recursive: true });
    await fs.writeFile(path.join(work, f), text);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  git(work, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', remote, other]);
  git(other, ['config', 'core.autocrlf', 'false']);
  return { remote, work, other };
}

/** Pushes a parentless commit with `files` to `branch` of the remote of `clone` (forced). Returns the commit. */
export function pushOrphan(clone: string, branch: string, files: Record<string, string>): string {
  const entries = Object.entries(files).map(([name, text]) => {
    if (name.includes('/')) throw new Error('pushOrphan: flat files only');
    return `100644 blob ${git(clone, ['hash-object', '-w', '--stdin'], text)}\t${name}`;
  });
  const tree = git(clone, ['mktree'], entries.join('\n') + (entries.length ? '\n' : ''));
  const commit = git(clone, ['commit-tree', tree, '-m', 'seed']);
  git(clone, ['push', '-q', '--force', 'origin', `${commit}:refs/heads/${branch}`]);
  return commit;
}

/** Pushes the content of directory `dir` as a parentless commit to `branch` (forced). */
export function pushOrphanDir(clone: string, branch: string, dir: string): string {
  const env = { ...TEST_GIT_ENV, GIT_INDEX_FILE: path.join(path.dirname(dir), `.index-${path.basename(dir)}`) };
  const run = (args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '--git-dir', path.join(clone, '.git'), '--work-tree', dir, ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  run(['read-tree', '--empty']);
  run(['add', '-A', '.']);
  const tree = run(['write-tree']);
  const commit = git(clone, ['commit-tree', tree, '-m', 'seed']);
  git(clone, ['push', '-q', '--force', 'origin', `${commit}:refs/heads/${branch}`]);
  return commit;
}

export function deleteRemoteBranch(clone: string, branch: string): void {
  git(clone, ['push', '-q', 'origin', `:refs/heads/${branch}`]);
}

/** git in a bare repository (safe.bareRepository may be 'explicit'). */
export function bareGit(remote: string, args: string[]): string {
  return git(path.dirname(remote), ['--git-dir', remote, ...args]);
}

export function remoteHas(remote: string, branch: string): boolean {
  try {
    bareGit(remote, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export type GitHook = (args: string[], opts: GitRunOptions) => Promise<GitOutput | void> | GitOutput | void;

/** Real git with a hook that runs before each command and may replace its output (failure injection). */
export class HookGit implements CiGitLike {
  readonly calls: string[][] = [];
  private real = new CiGit();
  constructor(public hook: GitHook = () => {}) {}
  async run(args: string[], opts: GitRunOptions): Promise<GitOutput> {
    this.calls.push(args);
    const replaced = await this.hook(args, opts);
    if (replaced) return replaced;
    return this.real.run(['-c', 'core.autocrlf=false', ...args], opts);
  }
}
