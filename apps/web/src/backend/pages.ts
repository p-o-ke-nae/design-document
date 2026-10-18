/**
 * Pages edition backend (services.md「HttpBackend と PagesBackend」「サービスの呼び出し」「イベントの購読」).
 * Calls the service layer in the browser; nothing here talks to the local server.
 * The target (`TargetLoader`), `PatStore` and `OperationGate` of pages-viewer.md / pat.md plug in through `setPagesContext`.
 */
import { checkEvidenceName, createServices, EMPTY_RUNS, EVIDENCE_PRUNED_MESSAGE, findEvidenceFile, mimeOf, NO_TRACE_MESSAGE, TraceError, systemEnv, type ServiceDeps, type PlayRecord, type PlayStore, type PrContext, type RepoReader, type Services, type TestDataWorkspace } from '@ddv/services';
import type { PrInfo } from '../api.ts';
import { PAGES_CAPABILITIES } from './capabilities.ts';
import { GitHubError } from '@ddv/github';
import { toApiError } from './errors.ts';
import { hostedTargets } from '../targets.ts';
import { ApiError, type ActionsEvent, type Availability, type Backend, type BackendListener, type GateResult, type OperationId, type PatView, type Unsubscribe } from './types.ts';

export interface OperationGateLike {
  check(op: OperationId): GateResult;
}

export interface CallDeps {
  capabilities: Readonly<Record<OperationId, Availability>>;
  gate: OperationGateLike;
  pat: PatView;
  /** A write answered 403: `PermissionProbe.recordDenied` (pages-viewer.md「操作の一覧」). */
  onDenied?: (op: OperationId, e: unknown) => void;
}

/**
 * `PagesBackend.call(op, fn)` (diagram `pages-call`). `op` only for the methods with an `OperationId` (reads: none = available).
 * Several ops (Approve with status) must all pass. No side effects besides `fn`.
 */
export async function pagesCall<T>(deps: CallDeps, op: OperationId | readonly OperationId[] | undefined, fn: () => T | Promise<T>): Promise<T> {
  const ops = op === undefined ? [] : typeof op === 'string' ? [op] : op;
  for (const o of ops) {
    const a = deps.capabilities[o];
    if (a.kind === 'unsupported') throw new ApiError(a.reason, 405, 'unsupported', { error: a.reason, code: 'unsupported', message: a.reason });
  }
  for (const o of ops) {
    if (deps.capabilities[o].kind !== 'write') continue;
    const g = deps.gate.check(o);
    if (!g.enabled) {
      const reason = g.reason ?? 'この操作の権限がありません';
      throw new ApiError(reason, 403, 'permission', { error: reason, code: 'permission', message: reason });
    }
  }
  try {
    return await fn();
  } catch (e) {
    if (deps.onDenied && e instanceof GitHubError && e.kind === 'forbidden') for (const o of ops) if (deps.capabilities[o].kind === 'write') deps.onDenied(o, e);
    throw toApiError(e, deps.pat);
  }
}

/** The target's state as `TargetLoader` reports it (pages-viewer.md `LoaderState`). */
export interface TargetUpdate {
  state: string;
  /** The remote head that made the target Stale. */
  headSha?: string;
}

/**
 * Events of the Pages edition: a relay that never calls GitHub itself (`HeadWatcher` / `ActionsRunTracker` own the polling).
 * `TargetLoader` calls `onTarget`, the Actions tracker `onActions`.
 */
export class PagesFeed {
  private readonly listeners = new Set<{ fn: BackendListener }>();
  private staleSha = '';

  get size(): number {
    return this.listeners.size;
  }

  add(fn: BackendListener): Unsubscribe {
    const entry = { fn };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  }

  onTarget(t: TargetUpdate): void {
    if (t.state !== 'Stale' || !t.headSha) {
      if (t.state !== 'Stale') this.staleSha = '';
      return;
    }
    if (t.headSha === this.staleSha) return;
    this.staleSha = t.headSha;
    this.emit({ type: 'stale', headSha: t.headSha });
  }

  /** Pending reviews changed in another tab (BroadcastChannel `reviews-changed`): the screens reload like a local file change. */
  onChange(paths: string[] = []): void {
    this.emit({ type: 'change', paths });
  }

  onActions(ev: ActionsEvent): void {
    this.emit({ type: 'actions', data: ev });
  }

  private emit(ev: Parameters<BackendListener>[0]): void {
    for (const l of [...this.listeners]) {
      try {
        l.fn(ev);
      } catch (e) {
        console.error('[ddv] event listener failed:', e);
      }
    }
  }
}

/** Scenario plays of this tab (`played`): kept in memory, gone when the tab closes. Give the same store to `createServices({ plays })`. */
export class MemoryPlayStore implements PlayStore {
  private readonly plays: Record<string, PlayRecord> = {};
  async read(): Promise<Record<string, PlayRecord>> {
    return { ...this.plays };
  }
  record(id: string, ok: boolean, failures?: unknown[], at = new Date().toISOString()): PlayRecord {
    const rec: PlayRecord = { ok, at, ...(failures?.length ? { failures } : {}) };
    this.plays[id] = rec;
    return rec;
  }
}

/** One opened target (built by the pages-viewer's `TargetLoader` from its `TargetSnapshot`). */
export interface PagesContext {
  services: Services;
  /** The target head's `GitHubRepoReader`. */
  reader: RepoReader;
  pat: PatView;
  gate: OperationGateLike;
  plays?: MemoryPlayStore;
  /** PR targets: the review / test-data target. Absent = a branch or commit (read-only, no review). */
  prContext?: () => Promise<PrContext>;
  /** PR targets: the answer of `pr()`. */
  prInfo?: () => Promise<PrInfo>;
  capabilities?: Readonly<Record<OperationId, Availability>>;
  onDenied?: CallDeps['onDenied'];
}

export interface PagesContextOptions extends Omit<PagesContext, 'services' | 'plays'> {
  getConfig: ServiceDeps['getConfig'];
  /** `owner/repo`. */
  repoRoot: string;
  repoName: string;
  /** PR targets (review・PR diff). */
  pr?: ServiceDeps['pr'];
  /**
   * Actions (actions-run.md): the target's `ActionsService` over `PagesActionsTarget` (pages/target-context.ts `actionsOf`);
   * its run tracker pushes into `pagesFeed(scope).onActions`.
   */
  actions?: ServiceDeps['actions'];
  env?: ServiceDeps['env'];
}

/** Builds the services of one target over its `GitHubRepoReader` (no local runs, no writer; plays stay in the tab). */
export function createPagesContext(o: PagesContextOptions): PagesContext {
  const plays = new MemoryPlayStore();
  const services = createServices({
    env: o.env ?? systemEnv,
    reader: o.reader,
    getConfig: o.getConfig,
    runs: EMPTY_RUNS,
    repoName: o.repoName,
    repoRoot: o.repoRoot,
    plays,
    ...(o.pr ? { pr: o.pr } : {}),
    ...(o.actions ? { actions: o.actions } : {}),
  });
  return {
    services,
    plays,
    reader: o.reader,
    pat: o.pat,
    gate: o.gate,
    ...(o.prContext || o.pr ? { prContext: o.prContext ?? o.pr!.context } : {}),
    ...(o.prInfo ? { prInfo: o.prInfo } : {}),
    ...(o.capabilities ? { capabilities: o.capabilities } : {}),
    ...(o.onDenied ? { onDenied: o.onDenied } : {}),
  };
}

const contexts = new Map<string, PagesContext>();
const feeds = new Map<string, PagesFeed>();
const defaultPlays = new MemoryPlayStore();

/** Called by the target loader when a target is ready (`null` when it is closed). */
export function setPagesContext(scope: string, ctx: PagesContext | null): void {
  if (ctx) contexts.set(scope, ctx);
  else contexts.delete(scope);
}

/** The event relay of a target (`TargetLoader` / the Actions tracker push into it). */
export function pagesFeed(scope: string): PagesFeed {
  let f = feeds.get(scope);
  if (!f) feeds.set(scope, (f = new PagesFeed()));
  return f;
}

const NOT_READY = '対象を読み込んでいません';
const NOT_PR = 'PR ではありません';
/** No Actions service for the target (not wired / not a GitHub target): the Actions tab is not shown. */
const ACTIONS_HIDDEN = { state: 'hidden', reason: '', workflow: null, canInit: false } as const;
const NO_ACTIONS = 'Actions を使えません';

/** Memory kept for evidence bodies (evidence-trace.md「本体の取得」). */
export const EVIDENCE_CACHE_BYTES = 100 * 1024 * 1024;

const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(message, status, code, { error: message, code, message });
};

/** `scope` = the target key (pages-viewer.md `targetKey`). Rebuilt each time the target is opened again. */
export function createPagesBackend(scope: string, getContext: () => PagesContext | undefined = () => contexts.get(scope)): Backend {
  const ctx = (): PagesContext => getContext() ?? fail(503, 'not-ready', NOT_READY);
  const deps = (): CallDeps => {
    const c = ctx();
    return { capabilities: c.capabilities ?? PAGES_CAPABILITIES, gate: c.gate, pat: c.pat, ...(c.onDenied ? { onDenied: c.onDenied } : {}) };
  };
  const svc = () => ctx().services;
  /** Reads (no `OperationId`). The services answer in the same shapes as the local API, so only the static type is adapted. */
  const read = async <T>(fn: (s: Services) => unknown): Promise<T> => pagesCall(deps(), undefined, () => fn(svc()) as T | Promise<T>);
  const call = async <T>(op: OperationId | readonly OperationId[], fn: (s: Services) => unknown): Promise<T> => pagesCall(deps(), op, () => fn(svc()) as T | Promise<T>);
  const unsupported = async <T>(op: OperationId): Promise<T> => pagesCall(deps(), op, () => fail(405, 'unsupported', 'unsupported'));
  const prService = (s: Services) => s.pr ?? fail(404, 'not-found', NOT_PR);
  const actions = (s: Services) => s.actions ?? fail(404, 'not-found', NO_ACTIONS);
  const review = async (s: Services) => {
    const c = ctx();
    if (!s.review || !c.prContext) return fail(404, 'not-found', NOT_PR);
    return { review: s.review, target: await c.prContext() };
  };
  const testDataWs = async (): Promise<TestDataWorkspace<PrContext>> => {
    const c = ctx();
    return c.prContext ? { kind: 'pr', target: await c.prContext() } : { kind: 'branch' };
  };
  const blobUrls = new Map<string, Promise<string>>();
  const blobUrl = (key: string, make: () => Promise<Blob>): Promise<string> => {
    let u = blobUrls.get(key);
    if (!u) {
      u = make().then((b) => URL.createObjectURL(b));
      u.catch(() => blobUrls.delete(key));
      blobUrls.set(key, u);
    }
    return u;
  };
  const bytes = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
  const evidenceCache = new Map<string, Blob>();

  return {
    edition: 'pages',
    get capabilities() {
      return getContext()?.capabilities ?? PAGES_CAPABILITIES;
    },
    subscribe: (listener) => {
      const off = pagesFeed(scope).add(listener);
      // Like the SSE `actions` replay: the latest update of every tracker of the target's ActionsService.
      for (const u of getContext()?.services.actions?.replay() ?? []) listener({ type: 'actions', data: u as unknown as ActionsEvent });
      return off;
    },
    // Pages has no local runs (Actions runs arrive as `actions` events).
    followRun: (_id, handlers) => {
      queueMicrotask(() => handlers.onEnd?.(''));
      return () => {};
    },
    repo: () => getContext()?.reader ?? null,

    config: () => read((s) => s.docs.config()),
    tree: () => read((s) => s.docs.tree()),
    doc: (path) => read((s) => s.docs.doc(path)),
    resolve: (from, ref) => read((s) => s.docs.resolve(from, ref)),
    tests: () => read((s) => s.matrix.tests(s.history.latest())),
    latest: () => read((s) => s.history.latest()),
    runs: async () => [],
    run: (id) => read(() => fail(404, 'not-found', `実行が見つかりません: ${id}`)),
    targets: () => read(async (s) => { const { config } = await s.docs.config(); return { targets: hostedTargets(config.runners, config.mocksRoot) }; }),
    startRun: () => unsupported('runLocal'),
    rerun: () => unsupported('runLocal'),
    historySummary: () => read((s) => s.history.summary()),
    historyTest: (id) => read((s) => s.history.test(id)),
    flaky: () => read((s) => s.history.flaky()),
    trace: (runId, id, platform) =>
      read(async (s) => {
        const r = await s.traces.read(runId, id, platform);
        return r.ok ? r.trace : fail(404, r.reason, NO_TRACE_MESSAGE[r.reason]);
      }),
    traceShot: (runId, id, n, platform) =>
      read((s) =>
        blobUrl(`trace:${runId}/${id}/${n}/${platform ?? 'web'}`, async () => {
          const png = await s.traces.screenshot(runId, id, n, platform);
          return png ? new Blob([bytes(png)], { type: 'image/png' }) : fail(404, 'not-found', 'スクリーンショットはありません');
        }),
      ),
    // Results of Actions runs (the results branch): the same checks as the API (E1・E3・E4), then the file. Kept in memory (100MB, LRU).
    evidence: (runId, id, platform, file) =>
      read(async (s) => {
        const cacheKey = `${runId}/${id}@${platform ?? 'web'}/${file}`;
        const hit = evidenceCache.get(cacheKey);
        if (hit) {
          evidenceCache.delete(cacheKey);
          evidenceCache.set(cacheKey, hit);
          return hit;
        }
        let blob: Blob;
        try {
          const key = s.traces.validate(runId, id, platform);
          checkEvidenceName(file);
          const a = actions(s);
          const trace = JSON.parse(new TextDecoder().decode(await a.file(runId, `traces/${key}.json`)));
          const found = findEvidenceFile(trace, key, file);
          let body: Uint8Array;
          try {
            body = await a.file(runId, `traces/${found.file.path}`);
          } catch (e) {
            if ((e as { status?: number }).status === 404 || (e instanceof GitHubError && e.kind === 'notFound')) return fail(404, 'pruned', EVIDENCE_PRUNED_MESSAGE);
            throw e;
          }
          blob = new Blob([bytes(body)], { type: found.file.mime });
        } catch (e) {
          if (e instanceof TraceError) return fail(e.status, e.code, e.message);
          throw e;
        }
        evidenceCache.set(cacheKey, blob);
        let total = [...evidenceCache.values()].reduce((n, b) => n + b.size, 0);
        for (const [k, b] of evidenceCache) {
          if (total <= EVIDENCE_CACHE_BYTES || k === cacheKey) break;
          evidenceCache.delete(k);
          total -= b.size;
        }
        return blob;
      }),
    rawUrl: (p) =>
      read(() => {
        const rel = decodeURIComponent(p.replace(/^\/raw\//, ''));
        return blobUrl(`raw:${rel}`, async () => new Blob([bytes(await ctx().reader.readBinary(rel))], { type: mimeOf(rel) }));
      }),
    coverage: (path) =>
      read(async (s) => {
        try {
          return await s.history.coverage(path);
        } catch {
          return fail(404, 'not-found', `文書が見つかりません: ${path}`);
        }
      }),
    deps: () => unsupported('installDeps'),
    installDeps: () => unsupported('installDeps'),
    generateIds: () => unsupported('generateTestIds'),
    scenarios: () => read(async (s) => ({ scenarios: await s.mocks.scenarios() })),
    scenario: (id) => read(async (s) => (await s.mocks.scenario(id)) ?? fail(404, 'not-found', `シナリオが見つかりません: ${id}`)),
    played: (body) =>
      read(() => {
        if (typeof body?.id !== 'string' || !body.id || typeof body.ok !== 'boolean') return fail(400, 'bad-request', 'id（文字列）と ok（真偽値）が必要です');
        const rec = (ctx().plays ?? defaultPlays).record(body.id, body.ok, body.failures);
        return { id: body.id, ...rec };
      }),
    testData: (scenario) => read(async (s) => s.testData.load(scenario, await testDataWs())),
    validateTestData: (draft) => read(async (s) => s.testData.validate(draft as never, await testDataWs())),
    saveTestData: async (draft) => call(ctx().prContext ? 'suggestTestData' : 'saveFile', async (s) => s.testData.save(draft as never, await testDataWs())),
    scaffold: () => unsupported('scaffold'),
    mockSource: (body) => read((s) => s.mocks.source(body as never)),
    runSnapshots: () => unsupported('snapshotLocal'),
    // Baselines are read from the target, current / diff images from the result branch (ActionsService; actions-run.md).
    snapshots: (id) => read(() => ({ id, steps: [] })),
    approveSnapshots: () => unsupported('snapshotLocal'),
    pr: () => read(() => ctx().prInfo?.() ?? fail(404, 'not-found', NOT_PR)),
    prFiles: () => read((s) => prService(s).files()),
    prDiff: (path) => read((s) => prService(s).docDiff(path)),
    prThreads: (path) => read((s) => prService(s).threads(path)),
    reviews: () => read((s) => prService(s).reviews()),
    review: () => read(async (s) => {
      const r = await review(s);
      return r.review.get(r.target);
    }),
    addComment: (body) =>
      call('comment', async (s) => {
        const r = await review(s);
        return r.review.add(r.target, body as never);
      }),
    updateComment: (id, body) =>
      call('comment', async (s) => {
        const r = await review(s);
        return r.review.update(r.target, id, body as never);
      }),
    deleteComment: (id) =>
      call('comment', async (s) => {
        const r = await review(s);
        await r.review.remove(r.target, id);
        return { ok: true };
      }),
    submitReview: (body) =>
      call(body.event === 'APPROVE' && body.approveDocs?.length ? ['submitReview', 'approveStatus'] : 'submitReview', async (s) => {
        const r = await review(s);
        return r.review.submit(r.target, body.event, body.body, body.approveDocs);
      }),
    replyThread: (id, body) => call('reply', (s) => prService(s).replyThread(id, body)),
    resolveThread: (id, resolved) => call('resolveThread', (s) => prService(s).resolveThread(id, resolved)),
    // Actions (actions-run.md): the ActionsService of the target when the loader wired one (PagesActionsTarget), otherwise hidden.
    actionsStatus: (refresh) => read((s) => (s.actions ? s.actions.status(refresh) : ACTIONS_HIDDEN)),
    actionsRuns: () => read((s) => actions(s).runs()),
    actionsDispatch: (body) => call('actionsDispatch', async (s) => ({ request: await actions(s).dispatch(body) })),
    actionsRun: (id) => read((s) => actions(s).run(id)),
    actionsApprove: (id, ids) => call('snapshotApprove', async (s) => ({ request: await actions(s).approve(id, ids) })),
    // Placing the workflow writes a file of the local folder.
    actionsInit: () => unsupported('scaffold'),
    actionsFile: (id, p) => read((s) => blobUrl(`actions:${id}/${p}`, async () => new Blob([bytes(await actions(s).file(id, p))], { type: mimeOf(p) }))),
  };
}

export function createBackend(scope: string): Backend {
  return createPagesBackend(scope);
}
