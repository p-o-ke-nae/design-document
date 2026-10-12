/**
 * Builds the backend context of a loaded target (pages-viewer.md「取得中」の `build`): services over the target's
 * `GitHubRepoReader`, the PR's review / diff deps and the lock warning. No DOM / React.
 */
import type { DdvConfig } from '@ddv/core';
import { GitHubChangeSource, StatusCommitter, type PendingReviewStore, type PrContext, type RepoEntry, type RepoReader } from '@ddv/services';
import type { GitHubClient } from '@ddv/github';
import type { PrInfo } from '../api.ts';
import { createPagesContext, type OperationGateLike, type PagesContext } from '../backend/pages.ts';
import type { PatView } from '../backend/types.ts';
import { targetWs } from './hash-route.ts';
import { checkLock, type LockWarning } from './lock-check.ts';
import type { TargetSnapshot } from './target-loader.ts';

/** A reader resolved on first use (the PR base: its tree is only loaded when a diff needs it). */
export class LazyRepoReader implements RepoReader {
  private p: Promise<RepoReader> | null = null;
  constructor(
    readonly revision: string,
    private readonly open: () => Promise<RepoReader>,
  ) {}
  private get r(): Promise<RepoReader> {
    if (!this.p) {
      this.p = this.open();
      this.p.catch(() => (this.p = null));
    }
    return this.p;
  }
  async listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]> {
    return (await this.r).listFiles(dir, filter);
  }
  async stat(path: string): Promise<RepoEntry | null> {
    return (await this.r).stat(path);
  }
  async exists(path: string): Promise<boolean> {
    return (await this.r).exists(path);
  }
  async readText(path: string): Promise<string> {
    return (await this.r).readText(path);
  }
  async tryReadText(path: string): Promise<string | null> {
    return (await this.r).tryReadText(path);
  }
  async readBinary(path: string): Promise<Uint8Array> {
    return (await this.r).readBinary(path);
  }
}

export interface TargetContextDeps {
  github: GitHubClient;
  pat: PatView;
  gate: OperationGateLike;
  pending: PendingReviewStore;
  /** `ReviewService.refresh` (a status commit moved head): reload the target. */
  refresh: () => Promise<void>;
  onDenied?: PagesContext['onDenied'];
}

export interface BuiltTarget {
  /** `setWorkspace` / `setPagesContext` scope. */
  scope: string;
  context: PagesContext;
  lock: LockWarning;
}

/** `PrInfo` of `api.pr()` (the same shape as the local `/api/w/:ws/pr`). */
export function prInfoOf(s: TargetSnapshot): PrInfo {
  const { owner, repo } = s.target;
  const pr = s.pr;
  return {
    id: targetWs(s.target),
    repo: `${owner}/${repo}`,
    kind: s.target.kind,
    ...(s.target.ref ? { ref: s.target.ref } : {}),
    ...(pr ? { title: pr.title } : {}),
    state: 'Ready',
    trusted: false,
    headSha: s.commitSha,
    openedAt: new Date(0).toISOString(),
    ...(pr ? { baseRef: pr.baseRef } : {}),
    ...(s.mergeBase ? { mergeBase: s.mergeBase } : {}),
    pr: pr ? { number: pr.number, title: pr.title, state: pr.state, merged: pr.merged, htmlUrl: pr.htmlUrl, baseRef: pr.baseRef, headRef: pr.headRef, headSha: pr.headSha } : null,
  };
}

/** The `PrContext` of a PR target (head = the loaded reader, base = the merge base read lazily from the same BlobStore). */
export function prContextOf(s: TargetSnapshot): PrContext | null {
  const { target, pr } = s;
  if (target.kind !== 'pr' || !target.pr || !pr) return null;
  const baseSha = s.mergeBase ?? s.baseSha;
  return {
    id: targetWs(target),
    target: { owner: target.owner, repo: target.repo, pr: target.pr },
    headSha: s.commitSha,
    ...(s.mergeBase ? { mergeBase: s.mergeBase } : {}),
    head: s.reader,
    base: baseSha ? new LazyRepoReader(baseSha, () => s.reader.at(baseSha)) : null,
    pr: { headRepo: pr.headRepo, headRef: pr.headRef, canPush: pr.canPush },
  };
}

export async function buildTarget(s: TargetSnapshot, deps: TargetContextDeps): Promise<BuiltTarget> {
  const { owner, repo } = s.target;
  const config: DdvConfig = s.config;
  const prContext = prContextOf(s);
  const info = prInfoOf(s);
  const context = createPagesContext({
    getConfig: () => config,
    repoRoot: `${owner}/${repo}`,
    repoName: repo,
    reader: s.reader,
    pat: deps.pat,
    gate: deps.gate,
    prInfo: async () => info,
    ...(deps.onDenied ? { onDenied: deps.onDenied } : {}),
    ...(prContext
      ? {
          pr: {
            context: async () => prContext,
            github: deps.github,
            changes: new GitHubChangeSource(deps.github, prContext.target as { owner: string; repo: string; pr: number }),
            pending: deps.pending,
            committer: new StatusCommitter(deps.github),
            refresh: () => deps.refresh(),
          },
        }
      : {}),
  });
  const docs = await context.services.docs.loadDocs();
  const lock = checkLock(docs, config, await s.reader.tryReadText('.ddv/testids.lock.json'));
  return { scope: targetWs(s.target), context, lock };
}
