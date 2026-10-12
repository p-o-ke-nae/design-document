import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitHubClient } from '@ddv/github';
import {
  ReviewService as ServicesReviewService,
  type Anchor,
  type CommentInput,
  type PendingComment,
  type PendingReview,
  type PendingReviewStore,
  type PrContext,
  type PullInfo,
  type SubmitResult,
} from '@ddv/services';
import type { GitCache } from './git.ts';
import { gitChanges, liveContext, type DirTarget } from './pr-context.ts';
import type { StatusCommitter } from './status-commit.ts';

/** Moved to @ddv/services (review.ts); the pending-review files and the `dir`-based targets stay on the server. */
export {
  composeBody,
  composeReviewBody,
  judgePlacement,
  type Anchor,
  type CommentInput,
  type CommentState,
  type PendingComment,
  type PendingReview,
  type Placement,
  type ReviewEvent,
  type SubmitResult,
} from '@ddv/services';

/** `DDV_HOME/reviews/<owner>/<repo>/pr-<N>.json`; writes go through a temp file + rename. */
export class PendingStore implements PendingReviewStore {
  constructor(private readonly home: string) {}

  file(owner: string, repo: string, pr: number): string {
    return path.join(this.home, 'reviews', owner, repo, `pr-${pr}.json`);
  }

  async read(owner: string, repo: string, pr: number): Promise<PendingReview> {
    try {
      const data = JSON.parse(await fs.readFile(this.file(owner, repo, pr), 'utf8')) as Partial<PendingReview>;
      return { headSha: data.headSha ?? '', ...(data.mergeBase ? { mergeBase: data.mergeBase } : {}), comments: Array.isArray(data.comments) ? data.comments : [] };
    } catch {
      return { headSha: '', comments: [] };
    }
  }

  async write(owner: string, repo: string, pr: number, review: PendingReview): Promise<void> {
    const file = this.file(owner, repo, pr);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(review, null, 2) + '\n');
    await fs.rename(tmp, file);
  }
}

/** The part of a workspace ReviewService needs (head checked out in `dir`). */
export interface ReviewTarget extends DirTarget {
  target: { owner: string; repo: string; pr?: number };
  pr?: Pick<PullInfo, 'headRepo' | 'headRef' | 'canPush'> | null;
}

export interface ReviewServiceOptions {
  store: PendingStore;
  github: GitHubClient;
  git: Pick<GitCache, 'diff' | 'show'> & Partial<Pick<GitCache, 'nameStatus' | 'git' | 'repoDir'>>;
  committer: StatusCommitter;
  /** Re-fetches the workspace (new head); resolves when it is Ready again. */
  refresh: (wsId: string) => Promise<void>;
  /** PR information when the workspace has none yet (after a restore). */
  pull?: (wsId: string) => Promise<PullInfo | undefined>;
  /** Called after the pending review or GitHub threads changed (cache invalidation). */
  onChange?: (wsId: string) => void;
}

/** Adapter: the services ReviewService over `dir`-based workspaces (head = FsRepoReader, merge base = GitRevReader). */
export class ReviewService {
  readonly svc: ServicesReviewService;

  constructor(private readonly opts: ReviewServiceOptions) {
    this.svc = new ServicesReviewService({
      store: opts.store,
      github: opts.github,
      changes: gitChanges(opts.git),
      committer: opts.committer,
      refresh: opts.refresh,
      pull: opts.pull,
      onChange: opts.onChange,
    });
  }

  ctx(ws: ReviewTarget | PrContext): PrContext {
    return 'dir' in ws ? liveContext(ws, this.opts.git) : ws;
  }

  get(ws: ReviewTarget | PrContext): Promise<PendingReview> {
    return this.svc.get(this.ctx(ws));
  }

  toAnchor(ws: ReviewTarget | PrContext, input: unknown): Promise<Anchor> {
    return this.svc.toAnchor(this.ctx(ws), input);
  }

  add(ws: ReviewTarget | PrContext, input: CommentInput): Promise<PendingComment> {
    return this.svc.add(this.ctx(ws), input);
  }

  update(ws: ReviewTarget | PrContext, id: string, patch: CommentInput): Promise<PendingComment> {
    return this.svc.update(this.ctx(ws), id, patch);
  }

  remove(ws: ReviewTarget | PrContext, id: string): Promise<void> {
    return this.svc.remove(this.ctx(ws), id);
  }

  relocate(ws: ReviewTarget | PrContext, newHead?: string): Promise<PendingReview> {
    return this.svc.relocate(this.ctx(ws), newHead);
  }

  submit(ws: ReviewTarget | PrContext, event: unknown, body: unknown = '', approveDocs: unknown = []): Promise<SubmitResult> {
    return this.svc.submit(this.ctx(ws), event, body, approveDocs);
  }
}