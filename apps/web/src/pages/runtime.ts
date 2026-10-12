/**
 * The singletons of the Pages edition (one per tab): PAT, GitHub client, permission, gate, caches and the target loader.
 * Browser only (localStorage / IndexedDB / BroadcastChannel); PagesApp creates it once.
 */
import type { PagesConfig } from '@ddv/core';
import { GitHubClient, GitHubError } from '@ddv/github';
import { PAGES_CAPABILITIES } from '../backend/capabilities.ts';
import { pagesFeed, setPagesContext } from '../backend/pages.ts';
import type { ActionsEvent as BackendActionsEvent, OperationId } from '../backend/types.ts';
import { resetActionsStatus } from '../actionsApi.ts';
import { notifyGate, setGate } from '../gate.tsx';
import { BlobCache } from './blob-cache.ts';
import { HeadWatcher } from './head-watcher.ts';
import { hostedDb, idbBlobDb, idbReviewDb } from './hosted-db.ts';
import { OperationGate } from './operation-gate.ts';
import { IdbPendingStore, PAGES_CHANNEL, reviewKey, type ReviewsChanged } from './pending-store.ts';
import { createPatStore, type PatStore } from './pat-store.ts';
import { PermissionProbe } from './permission.ts';
import { RecentTargets } from './recent-targets.ts';
import { buildTarget, type BuiltTarget } from './target-context.ts';
import { RateMeter, TargetLoader, type TargetSnapshot } from './target-loader.ts';
import { targetWs } from './hash-route.ts';

const DEFAULT_CONFIG: PagesConfig = { title: 'ddv', recentTargets: [] };

export class PagesRuntime {
  readonly config: PagesConfig;
  readonly pat: PatStore;
  readonly rate = new RateMeter();
  readonly client: GitHubClient;
  readonly probe: PermissionProbe;
  readonly gate: OperationGate;
  readonly blobs: BlobCache;
  readonly recent: RecentTargets;
  readonly pending: Promise<IdbPendingStore>;
  readonly loader: TargetLoader;
  private readonly channel: BroadcastChannel | null;
  /** The built target whose Actions runs are followed. */
  private current: BuiltTarget | null = null;

  constructor(config: PagesConfig | null | undefined = import.meta.env.DDV_PAGES_CONFIG) {
    this.config = config ?? DEFAULT_CONFIG;
    this.pat = createPatStore();
    this.client = new GitHubClient(this.pat, { anonymous: true, onResponse: (h) => this.rate.update(h) });
    this.probe = new PermissionProbe(this.client, this.pat);
    this.gate = new OperationGate('pages', PAGES_CAPABILITIES, this.probe);
    const db = hostedDb();
    this.blobs = new BlobCache(db.then((d) => (d ? idbBlobDb(d) : null)));
    this.recent = new RecentTargets(safeLocalStorage(), this.config.allowedOwners);
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(PAGES_CHANNEL);
    this.pending = db.then((d) => new IdbPendingStore(d ? idbReviewDb(d) : null, this.channel));
    this.loader = new TargetLoader({
      client: this.client,
      pat: this.pat,
      probe: this.probe,
      store: this.blobs,
      recent: this.recent,
      watcher: (snap) => this.watcherOf(snap),
      build: (snap) => this.build(snap),
    });
    setGate(this.gate);
    this.pat.subscribe(() => {
      this.probe.reset();
      notifyGate();
      this.loader.onPatChanged();
    });
    this.loader.subscribe(() => {
      notifyGate();
      const t = this.loader.target;
      if (t) pagesFeed(targetWs(t)).onTarget({ state: this.loader.state, ...(this.loader.staleSha ? { headSha: this.loader.staleSha } : {}) });
    });
    this.channel?.addEventListener('message', (ev: MessageEvent<ReviewsChanged>) => {
      const s = this.loader.snapshot;
      if (ev.data?.type !== 'reviews-changed' || !s || s.target.kind !== 'pr' || !s.target.pr) return;
      if (ev.data.key === reviewKey(s.target.owner, s.target.repo, s.target.pr)) pagesFeed(targetWs(s.target)).onChange([]);
    });
    // actions-run.md「実行の追跡」: Pages stops following the runs when the page closes.
    globalThis.addEventListener?.('pagehide', () => {
      this.current?.dispose();
      this.current = null;
    });
  }

  /** The `build` result of the current snapshot. */
  built(): BuiltTarget | null {
    return (this.loader.snapshot?.built as BuiltTarget | undefined) ?? null;
  }

  private async build(snap: TargetSnapshot): Promise<BuiltTarget> {
    const scope = targetWs(snap.target);
    const built = await buildTarget(snap, {
      github: this.client,
      pat: this.pat,
      gate: this.gate,
      pending: await this.pending,
      refresh: async () => this.loader.reload(),
      onDenied: (op: OperationId, e: unknown) => {
        const a = PAGES_CAPABILITIES[op];
        if (a.kind === 'write' && e instanceof GitHubError) {
          this.probe.recordDenied(a.gitHubOp, e);
          notifyGate();
        }
      },
      onActions: (e) => pagesFeed(scope).onActions(e as unknown as BackendActionsEvent),
    });
    this.current?.dispose();
    this.current = built;
    resetActionsStatus();
    setPagesContext(built.scope, built.context);
    return built;
  }

  private watcherOf(snap: TargetSnapshot): HeadWatcher | null {
    const { target, pr } = snap;
    if (target.kind !== 'pr' || !pr) return null;
    const path = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.pr}`;
    return new HeadWatcher({
      fetchHead: async () => (await this.client.rest<{ head: { sha: string } }>('GET', path)).head.sha,
      headSha: () => pr.headSha,
      onChanged: (sha) => this.loader.onHeadChanged(sha),
      hasToken: () => this.pat.state !== 'none',
    });
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
