import type { ChangeSource, NameStatus, PrContext, PrTarget, RepoReader } from '@ddv/services';
import { FsRepoReader } from './fs-reader.ts';
import { GitRevReader, type GitRevSource } from './git-reader.ts';
import type { GitCache } from './git.ts';

/** `git diff` / `git diff --name-status` of the bare clone (server ChangeSource). */
export class GitChangeSource implements ChangeSource {
  constructor(
    private readonly git: Partial<Pick<GitCache, 'diff' | 'nameStatus'>>,
    readonly owner: string,
    readonly repo: string,
  ) {}

  nameStatus(base: string, head: string): Promise<NameStatus[]> {
    if (!this.git.nameStatus) return Promise.reject(new Error('nameStatus is not available'));
    return this.git.nameStatus(this.owner, this.repo, base, head);
  }

  diff(base: string, head: string, paths: string[]): Promise<string> {
    if (!this.git.diff) return Promise.reject(new Error('diff is not available'));
    return this.git.diff(this.owner, this.repo, base, head, paths);
  }
}

/** One GitChangeSource per repository of the given PR context. */
export function gitChanges(git: Partial<Pick<GitCache, 'diff' | 'nameStatus'>>): (ctx: Pick<PrContext, 'target'>) => ChangeSource {
  const cache = new Map<string, GitChangeSource>();
  return (ctx) => {
    const key = `${ctx.target.owner}/${ctx.target.repo}`;
    let s = cache.get(key);
    if (!s) cache.set(key, (s = new GitChangeSource(git, ctx.target.owner, ctx.target.repo)));
    return s;
  };
}

/** A workspace as the server keeps it (head checked out in `dir`). */
export interface DirTarget {
  id: string;
  target: PrTarget;
  headSha: string;
  mergeBase?: string;
  dir: string;
  pr?: PrContext['pr'];
}

const views = new WeakMap<object, PrContext>();

/**
 * A PrContext that follows a mutable `DirTarget` (its head SHA / merge base can change after a refresh):
 * `head` = FsRepoReader(dir), `base` = GitRevReader(mergeBase) or null.
 */
export function liveContext(t: DirTarget, git?: GitRevSource): PrContext {
  const known = views.get(t);
  if (known) return known;
  let head: { dir: string; reader: FsRepoReader } | null = null;
  let base: { sha: string; reader: GitRevReader } | null = null;
  const view: PrContext = {
    get id() {
      return t.id;
    },
    get target() {
      return t.target;
    },
    get headSha() {
      return t.headSha;
    },
    get mergeBase() {
      return t.mergeBase;
    },
    get pr() {
      return t.pr;
    },
    get head(): RepoReader {
      if (!head || head.dir !== t.dir) head = { dir: t.dir, reader: new FsRepoReader(t.dir) };
      return head.reader;
    },
    get base(): RepoReader | null {
      if (!t.mergeBase || !git) return null;
      if (!base || base.sha !== t.mergeBase) base = { sha: t.mergeBase, reader: new GitRevReader(git, t.target.owner, t.target.repo, t.mergeBase) };
      return base.reader;
    },
  };
  views.set(t, view);
  return view;
}
