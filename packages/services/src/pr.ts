import { normalizePath, type DdvConfig } from '@ddv/core';
import type { GitHubClient } from '@ddv/github';
import { DiffService, type ChangedFiles, type ChangeSourceOf, type DocDiff, type PrContext } from './pr-diff.ts';
import { ThreadService, type Thread, type ThreadComment } from './threads.ts';

export interface ResolveResult {
  id: string;
  resolved: boolean;
}

export type { PrContext, PrTarget } from './pr-diff.ts';

export interface PullInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  htmlUrl: string;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  headRepo: string;
  canPush: boolean;
}

export interface RawPull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  html_url: string;
  user?: { login?: string };
  head: { sha: string; ref: string; repo?: { full_name?: string; permissions?: { push?: boolean } } | null };
  base: { ref: string };
  maintainer_can_modify?: boolean;
}

export function toPullInfo(p: RawPull): PullInfo {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    merged: Boolean(p.merged ?? p.merged_at),
    htmlUrl: p.html_url,
    author: p.user?.login ?? '',
    baseRef: p.base.ref,
    headRef: p.head.ref,
    headSha: p.head.sha,
    headRepo: p.head.repo?.full_name ?? '',
    canPush: Boolean(p.head.repo?.permissions?.push || p.maintainer_can_modify),
  };
}

export interface RawReview {
  user: { login: string } | null;
  state: string;
  submitted_at?: string;
}

export interface ReviewerState {
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  submittedAt?: string;
}

/** Latest review state per reviewer; a later COMMENTED keeps an earlier APPROVED / CHANGES_REQUESTED (as on GitHub). */
export function latestReviews(list: RawReview[]): ReviewerState[] {
  const out = new Map<string, ReviewerState>();
  for (const r of list) {
    const login = r.user?.login;
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(r.state)) continue;
    const prev = out.get(login);
    if (r.state === 'DISMISSED') {
      out.set(login, { login, state: 'COMMENTED', submittedAt: r.submitted_at });
      continue;
    }
    if (r.state === 'COMMENTED' && prev && prev.state !== 'COMMENTED') continue;
    out.set(login, { login, state: r.state as ReviewerState['state'], submittedAt: r.submitted_at });
  }
  return [...out.values()];
}

export interface PrServiceOptions {
  context: () => Promise<PrContext>;
  github: GitHubClient;
  changes: ChangeSourceOf;
  getConfig: () => DdvConfig;
  /** PR information (server: `WorkspaceManager.pull`); default: `GET /repos/{o}/{r}/pulls/{n}`. */
  pull?: () => Promise<PullInfo | undefined>;
  /** Shared instances (the server keeps one per process so the caches outlive a request). */
  diffs?: DiffService;
  threads?: ThreadService;
}

/** `/api/w/:ws/pr`・`reviews`・`pr/files`・`pr/diff`・`pr/threads*` of one PR context. */
export class PrService {
  readonly diffs: DiffService;
  readonly threadService: ThreadService;

  constructor(private readonly opts: PrServiceOptions) {
    this.diffs = opts.diffs ?? new DiffService(opts.changes);
    this.threadService = opts.threads ?? new ThreadService(opts.github);
  }

  async pull(): Promise<PullInfo | null> {
    const ctx = await this.opts.context();
    if (this.opts.pull) return (await this.opts.pull().catch(() => ctx.pr as PullInfo | undefined)) ?? null;
    const { owner, repo, pr } = ctx.target;
    if (!pr) return null;
    return toPullInfo(await this.opts.github.rest<RawPull>('GET', `/repos/${owner}/${repo}/pulls/${pr}`));
  }

  async reviews(): Promise<ReviewerState[]> {
    const { target } = await this.opts.context();
    if (!target.pr) return [];
    return this.opts.github
      .paginate<RawReview>(`/repos/${target.owner}/${target.repo}/pulls/${target.pr}/reviews?per_page=100`)
      .then(latestReviews)
      .catch(() => [] as ReviewerState[]);
  }

  async files(): Promise<ChangedFiles> {
    return this.diffs.files(await this.opts.context(), this.opts.getConfig());
  }

  async docDiff(path: string): Promise<DocDiff> {
    return this.diffs.docDiff(await this.opts.context(), this.opts.getConfig(), normalizePath(path));
  }

  async threads(path?: string): Promise<Thread[]> {
    return this.threadService.list(await this.opts.context(), path ? normalizePath(path) : undefined);
  }

  async replyThread(id: string, body: unknown): Promise<ThreadComment> {
    return this.threadService.reply(await this.opts.context(), id, body);
  }

  async resolveThread(id: string, resolved: boolean): Promise<ResolveResult> {
    return this.threadService.resolve(await this.opts.context(), id, resolved);
  }
}

