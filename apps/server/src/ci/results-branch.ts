import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResultsIndexData } from '@ddv/core';
import { redact } from '@ddv/github';
import { BOT_ENV, CiGit, gitReason, isPushRejected, type CiGitLike, type GitOutput } from './ci-git.ts';
import { readIndex, writeIndex } from './results-index.ts';

/** States of `ResultsBranch.update` (DD-ACTWF-PUSH). `Idle` = before start / [*]. */
export type PushState = 'Idle' | 'Fetching' | 'Editing' | 'Pushing' | 'Done' | 'Failed';

export type PushEvent =
  | { type: 'start' }
  | { type: 'fetched'; exists: boolean }
  | { type: 'fetch-failed' }
  | { type: 'written' }
  | { type: 'edit-failed' }
  | { type: 'pushed' }
  | { type: 'rejected'; retries: number; maxRetries: number }
  | { type: 'push-failed' };

/** Transition table; null = the event is invalid in the state (ignored). */
export function nextPushState(state: PushState, ev: PushEvent): PushState | null {
  switch (state) {
    case 'Idle':
      return ev.type === 'start' ? 'Fetching' : null;
    case 'Fetching':
      if (ev.type === 'fetched') return 'Editing';
      if (ev.type === 'fetch-failed') return 'Failed';
      return null;
    case 'Editing':
      if (ev.type === 'written') return 'Pushing';
      if (ev.type === 'edit-failed') return 'Failed';
      return null;
    case 'Pushing':
      if (ev.type === 'pushed') return 'Done';
      if (ev.type === 'rejected') return ev.retries < ev.maxRetries ? 'Fetching' : 'Failed';
      if (ev.type === 'push-failed') return 'Failed';
      return null;
    case 'Done':
    case 'Failed':
      return null;
  }
}

export type ResultsBranchErrorCode = 'fetch-failed' | 'push-failed' | 'edit-failed' | 'conflict';

export class ResultsBranchError extends Error {
  constructor(
    readonly code: ResultsBranchErrorCode,
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'ResultsBranchError';
  }
}

/** Edits a checked-out results branch: gets the directory and the current index, returns the new index (or mutates it). */
export type ResultsEdit = (dir: string, index: ResultsIndexData) => Promise<ResultsIndexData | void>;

export interface UpdateOutcome {
  commit: string;
  attempts: number;
  /** The branch did not exist (orphan commit). */
  created: boolean;
}

export interface ResultsBranchOptions {
  repoRoot: string;
  branch: string;
  git?: CiGitLike;
  /** Re-tries after a rejected push (default 3 = 4 attempts). */
  retries?: number;
  /** Where the temporary worktrees are made (default os.tmpdir()). */
  tmpRoot?: string;
  log?: (line: string) => void;
  /** Secrets masked in error messages. */
  tokens?: (string | undefined)[];
}

/** The results branch (ddv-results): one parentless commit, force-pushed with a lease; retried when another run pushed first. */
export class ResultsBranch {
  readonly branch: string;
  state: PushState = 'Idle';
  /** States passed through by the last `update` (for diagnostics and tests). */
  trace: PushState[] = [];
  private git: CiGitLike;
  private retries: number;

  constructor(private opts: ResultsBranchOptions) {
    this.branch = opts.branch;
    this.git = opts.git ?? new CiGit();
    this.retries = opts.retries ?? 3;
  }

  private fire(ev: PushEvent): PushState {
    const next = nextPushState(this.state, ev);
    if (!next) throw new Error(`invalid transition: ${this.state} ${ev.type}`);
    this.state = next;
    this.trace.push(next);
    return next;
  }

  private run(args: string[], cwd = this.opts.repoRoot, env?: Record<string, string>): Promise<GitOutput> {
    return this.git.run(args, { cwd, env });
  }

  private reason(out: GitOutput): string {
    return redact(gitReason(out.stderr || out.stdout), this.opts.tokens ?? []);
  }

  private fail(ev: PushEvent, code: ResultsBranchErrorCode, message: string, attempts: number): never {
    this.fire(ev);
    throw new ResultsBranchError(code, message, attempts);
  }

  async update(edit: ResultsEdit, message: string): Promise<UpdateOutcome> {
    if (this.state !== 'Idle' && this.state !== 'Done' && this.state !== 'Failed') throw new Error('結果ブランチの更新が進行中です');
    this.state = 'Idle';
    this.trace = [];
    this.fire({ type: 'start' });
    const ref = `refs/heads/${this.branch}`;
    let retries = 0;
    for (;;) {
      const attempts = retries + 1;
      const ls = await this.run(['ls-remote', '--exit-code', '--heads', 'origin', this.branch]);
      let base: string | null = null;
      if (ls.code !== 2) {
        if (ls.code !== 0) this.fail({ type: 'fetch-failed' }, 'fetch-failed', this.reason(ls), attempts);
        const f = await this.run(['fetch', '--no-tags', '--depth', '1', 'origin', ref]);
        if (f.code !== 0) this.fail({ type: 'fetch-failed' }, 'fetch-failed', this.reason(f), attempts);
        const h = await this.run(['rev-parse', 'FETCH_HEAD']);
        if (h.code !== 0) this.fail({ type: 'fetch-failed' }, 'fetch-failed', this.reason(h), attempts);
        base = h.stdout.trim();
      }
      this.fire({ type: 'fetched', exists: base !== null });
      const dir = await fs.mkdtemp(path.join(this.opts.tmpRoot ?? os.tmpdir(), 'ddv-results-'));
      try {
        let commit: string;
        try {
          commit = await this.commitOnce(dir, base, edit, message);
        } catch (e) {
          this.fail({ type: 'edit-failed' }, 'edit-failed', redact(e instanceof Error ? e.message : String(e), this.opts.tokens ?? []), attempts);
        }
        this.fire({ type: 'written' });
        const push = await this.run(['push', '--porcelain', `--force-with-lease=${ref}:${base ?? ''}`, 'origin', `${commit}:${ref}`]);
        if (push.code === 0) {
          this.fire({ type: 'pushed' });
          return { commit, attempts, created: base === null };
        }
        if (!isPushRejected(push.stderr + push.stdout)) this.fail({ type: 'push-failed' }, 'push-failed', this.reason(push), attempts);
        if (this.fire({ type: 'rejected', retries, maxRetries: this.retries }) === 'Failed') {
          throw new ResultsBranchError('conflict', `結果ブランチへの保存が競合しました（${attempts} 回試行）`, attempts);
        }
        retries++;
        this.opts.log?.(`! 結果ブランチへの push が競合しました。取り直してやり直します（${retries} 回目）`);
      } finally {
        await this.run(['worktree', 'remove', '--force', dir]);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await this.run(['worktree', 'prune']);
      }
    }
  }

  /** Checks out `base` (or an empty orphan tree), applies the edit and makes one parentless commit. */
  private async commitOnce(dir: string, base: string | null, edit: ResultsEdit, message: string): Promise<string> {
    const check = (out: GitOutput) => {
      if (out.code !== 0) throw new Error(this.reason(out));
      return out.stdout.trim();
    };
    if (base) check(await this.run(['worktree', 'add', '--detach', dir, base]));
    else {
      check(await this.run(['worktree', 'add', '--detach', '--no-checkout', dir, 'HEAD']));
      check(await this.run(['read-tree', '--empty'], dir));
    }
    let index = await readIndex(dir, this.opts.log);
    index = (await edit(dir, index)) ?? index;
    await writeIndex(dir, index);
    check(await this.run(['add', '-A', '.'], dir));
    const tree = check(await this.run(['write-tree'], dir));
    return check(await this.run(['commit-tree', tree, '-m', message], dir, BOT_ENV));
  }
}
