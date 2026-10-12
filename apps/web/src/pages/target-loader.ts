/**
 * Loading of the opened target (pages-viewer.md「対象の読み込み」「取得の失敗」「ファイルの取得」, DD-PAGESV-LOADER / LOADERR).
 * No DOM / React: the screens subscribe through `useTargetLoader()` (components/PagesApp.tsx).
 */
import { CONFIG_FILES, parseConfig, parseConfigText, type DdvConfig } from '@ddv/core';
import { GitHubError, type GitHubClient } from '@ddv/github';
import { GitHubRepoReader, toPullInfo, TreeIndex, TreeTooLargeError, type BlobStore, type PullInfo, type RawPull, type TreeEntry } from '@ddv/services';
import { runnerFilter } from '@ddv/testid/core';
import type { Unsubscribe } from '../backend/types.ts';
import type { Route } from '../route.ts';
import { targetKey, targetLabel, type HashParseResult, type HostedTarget, type TargetError } from './hash-route.ts';
import type { PatClearReason, PatState } from './pat-store.ts';
import type { PatKind } from './pat-format.ts';
import { RATE_LIMIT_PAT_HINT } from './errors.ts';

export type LoaderState = 'Idle' | 'Loading' | 'NeedToken' | 'Ready' | 'Stale' | 'Failed';
export type LoadErrorKind = 'needToken' | 'invalidToken' | 'notFound' | 'forbidden' | 'rateLimit' | 'tooLarge' | 'network';
export type Permission = 'read' | 'write';

export interface LoadError {
  kind: LoadErrorKind;
  message: string;
  resetAt?: Date;
}

export type LoadStep = 'info' | 'tree' | 'files' | 'build';

export interface LoadProgress {
  step: LoadStep | null;
  done: number;
  total: number;
  /** Of `done`, found in the BlobStore. */
  cached: number;
}

export interface TargetSnapshot {
  target: HostedTarget;
  defaultBranch: string;
  private: boolean;
  permission: Permission;
  commitSha: string;
  pr?: PullInfo;
  baseSha?: string;
  mergeBase?: string;
  reader: GitHubRepoReader;
  config: DdvConfig;
  /** What `build` returned (PagesApp: the backend context and the lock warning). */
  built?: unknown;
}

export const NEED_TOKEN_MESSAGE = '非公開のリポジトリ、または見つからないリポジトリです。PAT を設定すると取得し直します。';
export const INVALID_TOKEN_MESSAGE = 'PAT が無効です（失効・取り消しの可能性があります）。設定し直してください';
export const NOT_FOUND_MESSAGE = '取得できませんでした：リポジトリ・branch・tag・PR が見つからないか、PAT にこのリポジトリの権限がありません';

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Thrown by the loader when `ddv.config.yaml` cannot be parsed (shown as is, kind `network`). */
export class ConfigLoadError extends Error {
  constructor(reason: string) {
    super(`ddv.config.yaml を読めません：${reason}`);
    this.name = 'ConfigLoadError';
  }
}

export interface PatView {
  readonly state: PatState;
  readonly lastClear: PatClearReason | null;
  readonly kind?: PatKind | null;
}

export interface ClassifiedError {
  state: 'NeedToken' | 'Failed';
  error: LoadError;
}

/** pages-viewer.md `load-error` (DD-PAGESV-LOADERR). */
export function classifyLoadError(e: unknown, pat: Pick<PatView, 'state' | 'lastClear'>): ClassifiedError {
  const failed = (kind: LoadErrorKind, message: string, resetAt?: Date): ClassifiedError => ({ state: 'Failed', error: { kind, message, ...(resetAt ? { resetAt } : {}) } });
  const hasPat = pat.state !== 'none';
  if (!(e instanceof GitHubError)) {
    if (e instanceof TreeTooLargeError) return failed('tooLarge', `取得できませんでした：ファイルが多すぎて一覧を取得できません（${e.root}）`);
    if (e instanceof ConfigLoadError) return failed('network', e.message);
    return failed('network', `取得できませんでした：GitHub との通信に失敗しました（${(e as Error)?.message ?? String(e)}）`);
  }
  switch (e.kind) {
    case 'auth':
      return { state: 'NeedToken', error: { kind: 'invalidToken', message: INVALID_TOKEN_MESSAGE } };
    case 'notFound':
      if (hasPat) return failed('notFound', NOT_FOUND_MESSAGE);
      if (pat.lastClear === 'invalid') return { state: 'NeedToken', error: { kind: 'invalidToken', message: INVALID_TOKEN_MESSAGE } };
      return { state: 'NeedToken', error: { kind: 'needToken', message: NEED_TOKEN_MESSAGE } };
    case 'rateLimit': {
      const at = e.resetAt ? `（${hhmm(e.resetAt)} に再開）` : '';
      const base = `取得できませんでした：GitHub API の利用上限に達しました${at}`;
      return failed('rateLimit', hasPat ? base : `${base}。${RATE_LIMIT_PAT_HINT}`, e.resetAt);
    }
    case 'forbidden':
      return failed('forbidden', `取得できませんでした：${e.message}`);
    default:
      return failed('network', `取得できませんでした：GitHub との通信に失敗しました（${e.message}）`);
  }
}

/** `x-ratelimit-*` of the API responses (`rate` / `loading-rate`). */
export class RateMeter {
  limit = 0;
  remaining = 0;
  resetAt: Date | null = null;
  known = false;
  private readonly listeners = new Set<() => void>();

  update(headers: Headers): void {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    if (limit === null || remaining === null) return;
    this.limit = Number(limit);
    this.remaining = Number(remaining);
    const reset = headers.get('x-ratelimit-reset');
    this.resetAt = reset ? new Date(Number(reset) * 1000) : null;
    this.known = true;
    for (const l of [...this.listeners]) l();
  }

  get low(): boolean {
    return this.known && this.remaining < 10;
  }

  subscribe(fn: () => void): Unsubscribe {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

const YAML_RE = /\.ya?ml$/i;
const under = (p: string, dir: string) => {
  const d = dir.replace(/^\.?\/+|\/+$/g, '');
  return d === '' || d === '.' || p === d || p.startsWith(`${d}/`);
};
const rel = (p: string, dir: string) => {
  const d = dir.replace(/^\.?\/+|\/+$/g, '');
  return d === '' || d === '.' ? p : p.slice(d.length + 1);
};

/** Stage 1 files (pages-viewer.md「読むファイル」). */
export function selectPrefetch(tree: Iterable<Pick<TreeEntry, 'path'>>, config: DdvConfig): string[] {
  const filters = config.runners.map((r) => ({ cwd: r.cwd, match: runnerFilter(r) }));
  const out: string[] = [];
  for (const { path: p } of tree) {
    const pick =
      (under(p, config.docsRoot) && p.toLowerCase().endsWith('.md')) ||
      p === '.ddv/testids.lock.json' ||
      (under(p, config.mocksRoot) && YAML_RE.test(p)) ||
      filters.some((f) => under(p, f.cwd) && f.match(rel(p, f.cwd)));
    if (pick) out.push(p);
  }
  return out.sort();
}

/** Roots for `TreeIndex.load` when the tree is truncated. */
export function treeRoots(config: DdvConfig): string[] {
  return [...new Set([config.docsRoot, config.mocksRoot, '.ddv', ...config.runners.map((r) => r.cwd)])];
}

/** Counts BlobStore hits of the `files` step (`cached`). */
class CountingStore implements BlobStore {
  hits = new Set<string>();
  constructor(private readonly inner: BlobStore) {}
  async get(sha: string) {
    const b = await this.inner.get(sha);
    if (b) this.hits.add(sha);
    return b;
  }
  put(sha: string, bytes: Uint8Array) {
    return this.inner.put(sha, bytes);
  }
}

export interface Watcher {
  start(): void;
  stop(): void;
}

export interface TargetLoaderDeps {
  client: Pick<GitHubClient, 'rest' | 'restWithHeaders'>;
  pat: PatView;
  probe?: { fromRepo(json: unknown, headers: Headers, kind: PatKind | null): unknown; reset(): void };
  store: BlobStore;
  recent?: { add(target: HostedTarget, label: string): void };
  /** `HeadWatcher` of a Ready PR target. */
  watcher?: (snapshot: TargetSnapshot, loader: TargetLoader) => Watcher | null;
  /** The `build` step (documents, lock warning, backend context). Its result goes to `snapshot.built`. */
  build?: (snapshot: TargetSnapshot) => Promise<unknown>;
  fetch?: typeof fetch;
  rawBase?: string;
}

interface RawRepo {
  default_branch: string;
  private?: boolean;
  permissions?: { push?: boolean };
}

const EMPTY_PROGRESS: LoadProgress = { step: null, done: 0, total: 0, cached: 0 };
const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

class Aborted extends Error {}

export class TargetLoader {
  state: LoaderState = 'Idle';
  target: HostedTarget | null = null;
  snapshot: TargetSnapshot | null = null;
  error: LoadError | null = null;
  /** `open-error` (validation / URL). */
  openError: TargetError | null = null;
  route: Route | null = null;
  progress: LoadProgress = EMPTY_PROGRESS;
  /** The remote head that made the target Stale. */
  staleSha: string | null = null;
  private generation = 0;
  private abort = new AbortController();
  private watcher: Watcher | null = null;
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly deps: TargetLoaderDeps) {}

  /** The current generation (`loaded` / `failed` of an older one are ignored). */
  get gen(): number {
    return this.generation;
  }

  /** Bumps on every change (`useSyncExternalStore`). */
  get revision(): number {
    return this.version;
  }

  subscribe(fn: () => void): Unsubscribe {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  private setState(next: LoaderState): void {
    const was = this.state;
    this.state = next;
    if (was === 'Ready' && next !== 'Ready') {
      this.watcher?.stop();
      this.watcher = null;
    }
    if (next === 'Ready' && was !== 'Ready' && this.snapshot) {
      this.watcher = this.deps.watcher?.(this.snapshot, this) ?? null;
      this.watcher?.start();
    }
  }

  open(result: HashParseResult): void {
    const s = this.state;
    if (!result.target) {
      if (result.error) {
        // [検査NG]: Idle / Failed → Idle with open-error; from the other states the same (the user left the target).
        this.cancel();
        this.target = null;
        this.snapshot = null;
        this.error = null;
        this.openError = result.error;
        this.route = result.route;
        this.setState('Idle');
        this.changed();
      } else this.changeTarget();
      return;
    }
    const same = this.target !== null && targetKey(this.target) === targetKey(result.target);
    if (same && (s === 'Ready' || s === 'Stale' || s === 'Loading' || s === 'NeedToken')) {
      // Same target: only the route changes (NeedToken / Stale / Loading keep their state).
      this.route = result.route;
      this.changed();
      return;
    }
    this.route = result.route;
    this.openError = null;
    this.start(result.target);
  }

  changeTarget(): void {
    if (this.state === 'Idle' || this.state === 'Failed') return;
    this.cancel();
    this.target = null;
    this.snapshot = null;
    this.error = null;
    this.openError = null;
    this.route = null;
    this.progress = EMPTY_PROGRESS;
    this.setState('Idle');
    this.changed();
  }

  reload(): void {
    if ((this.state !== 'Ready' && this.state !== 'Stale') || !this.target) return;
    this.start(this.target);
  }

  onPatChanged(): void {
    if ((this.state !== 'NeedToken' && this.state !== 'Ready' && this.state !== 'Stale') || !this.target) return;
    this.start(this.target);
  }

  onHeadChanged(sha: string): void {
    if (this.state !== 'Ready') return;
    this.staleSha = sha;
    this.setState('Stale');
    this.changed();
  }

  /** `loaded` of generation `gen`. */
  onLoaded(gen: number, snapshot: TargetSnapshot): void {
    if (gen !== this.generation || this.state !== 'Loading') return;
    this.snapshot = snapshot;
    this.error = null;
    this.progress = EMPTY_PROGRESS;
    this.setState('Ready');
    this.deps.recent?.add(snapshot.target, snapshot.pr?.title ?? targetLabelOf(snapshot));
    this.changed();
  }

  /** `failed` of generation `gen`. */
  onFailed(gen: number, e: unknown): void {
    if (gen !== this.generation || this.state !== 'Loading') return;
    const c = classifyLoadError(e, this.deps.pat);
    this.error = c.error;
    this.snapshot = null;
    this.setState(c.state);
    this.changed();
  }

  private cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.generation++;
  }

  private start(target: HostedTarget): void {
    this.cancel();
    const gen = this.generation;
    this.target = target;
    this.snapshot = null;
    this.error = null;
    this.staleSha = null;
    this.progress = { ...EMPTY_PROGRESS, step: 'info' };
    this.setState('Loading');
    this.changed();
    const signal = this.abort.signal;
    void this.load(target, gen, signal).then(
      (snap) => this.onLoaded(gen, snap),
      (e) => {
        if (!(e instanceof Aborted)) this.onFailed(gen, e);
      },
    );
  }

  private step(gen: number, signal: AbortSignal, p: Partial<LoadProgress>): void {
    if (signal.aborted || gen !== this.generation) throw new Aborted();
    this.progress = { ...this.progress, ...p };
    this.changed();
  }

  private async load(target: HostedTarget, gen: number, signal: AbortSignal): Promise<TargetSnapshot> {
    const { client, pat } = this.deps;
    const { owner, repo } = target;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    this.deps.probe?.reset();
    const r = await client.restWithHeaders<RawRepo>('GET', base);
    this.deps.probe?.fromRepo(r.data, r.headers, pat.kind ?? null);
    const info = { defaultBranch: r.data.default_branch, private: Boolean(r.data.private), permission: (r.data.permissions?.push ? 'write' : 'read') as Permission };
    let commitSha: string;
    let pr: PullInfo | undefined;
    let baseSha: string | undefined;
    let mergeBase: string | undefined;
    if (target.kind === 'pr') {
      const raw = await client.rest<RawPull & { base: { sha?: string; ref: string } }>('GET', `${base}/pulls/${target.pr}`);
      this.step(gen, signal, {});
      pr = toPullInfo(raw);
      commitSha = pr.headSha;
      baseSha = raw.base.sha;
      if (baseSha) {
        try {
          const c = await client.rest<{ merge_base_commit?: { sha?: string } }>('GET', `${base}/compare/${baseSha}...${commitSha}`);
          mergeBase = c.merge_base_commit?.sha;
        } catch {
          mergeBase = undefined;
        }
      }
    } else {
      const ref = target.ref ?? info.defaultBranch;
      try {
        commitSha = (await client.rest<{ sha: string }>('GET', `${base}/commits/${encodeRef(ref)}`)).sha;
      } catch (e) {
        if (e instanceof GitHubError && e.status === 422) throw new GitHubError('notFound', 404, e.message);
        throw e;
      }
    }
    this.step(gen, signal, { step: 'tree' });
    const roots = treeRoots(parseConfig({}));
    const tree = await TreeIndex.load(client, owner, repo, commitSha, roots);
    const store = new CountingStore(this.deps.store);
    const headRepo = pr && pr.headRepo && pr.headRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ? pr.headRepo : undefined;
    const reader = new GitHubRepoReader({
      client,
      owner,
      repo,
      sha: commitSha,
      tree,
      store,
      hasToken: () => pat.state !== 'none',
      roots,
      ...(headRepo ? { headRepo } : {}),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.rawBase ? { rawBase: this.deps.rawBase } : {}),
    });
    this.step(gen, signal, {});
    let config: DdvConfig = parseConfig({});
    for (const name of CONFIG_FILES) {
      const text = await reader.tryReadText(name);
      if (text === null) continue;
      try {
        config = parseConfigText(name, text);
      } catch (e) {
        throw new ConfigLoadError((e as Error).message);
      }
      break;
    }
    const files = selectPrefetch(tree.entries.values(), config);
    this.step(gen, signal, { step: 'files', done: 0, total: files.length, cached: 0 });
    store.hits.clear();
    await reader.prefetch(files, (done, total) => {
      if (gen !== this.generation) return;
      this.progress = { ...this.progress, done, total, cached: Math.min(store.hits.size, done) };
      this.changed();
    });
    this.step(gen, signal, { step: 'build', done: files.length, total: files.length, cached: Math.min(store.hits.size, files.length) });
    const snapshot: TargetSnapshot = { target, ...info, commitSha, reader, config, ...(pr ? { pr } : {}), ...(baseSha ? { baseSha } : {}), ...(mergeBase ? { mergeBase } : {}) };
    if (this.deps.build) snapshot.built = await this.deps.build(snapshot);
    this.step(gen, signal, {});
    return snapshot;
  }
}

function targetLabelOf(s: TargetSnapshot): string {
  return s.target.kind === 'ref' ? (s.target.ref ?? s.defaultBranch) : targetLabel(s.target);
}
