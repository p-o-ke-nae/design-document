/**
 * Local edition backend (services.md「HttpBackend と PagesBackend」「SseFeed」): wraps `createApi(ws)` (requests and answers unchanged)
 * and shares one SSE connection per URL between the subscribers.
 */
import { apiPath, createApi, gh, rawPath } from '../api.ts';
import { LOCAL_CAPABILITIES } from './capabilities.ts';
import type { Backend, BackendEvent, BackendListener, RunHandlers, Unsubscribe } from './types.ts';

/** 停止 / 接続中 / 受信中 / 再接続待ち (diagram `sse-feed`). */
export type FeedState = 'Stopped' | 'Connecting' | 'Open' | 'Retrying';

/** `event` = change・run・run-end・actions (and the local edition's `local`). `unsubscribeLast` = 最後の購読を解除. `reconnect` = 再接続の開始. */
export type FeedInput = 'subscribe' | 'hello' | 'error' | 'event' | 'reconnect' | 'unsubscribeLast';

const FEED_TABLE: Record<FeedState, Partial<Record<FeedInput, FeedState>>> = {
  Stopped: { subscribe: 'Connecting' },
  Connecting: { hello: 'Open', error: 'Retrying', unsubscribeLast: 'Stopped' },
  Open: { event: 'Open', error: 'Retrying', unsubscribeLast: 'Stopped' },
  Retrying: { reconnect: 'Connecting', unsubscribeLast: 'Stopped' },
};

/** The next state, or `null` for an input the state ignores (the caller keeps its state). */
export function nextFeedState(state: FeedState, input: FeedInput): FeedState | null {
  return FEED_TABLE[state][input] ?? null;
}

/** The part of `EventSource` the feeds use (tests pass a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}

export type OpenEventSource = (url: string) => EventSourceLike;

const CONNECTING = 0;
const defaultOpen: OpenEventSource = (url) => new EventSource(url) as EventSourceLike;

export interface SseFeedOptions {
  open?: OpenEventSource;
  /** Wait before opening a new connection when the browser gave up (`readyState` CLOSED). */
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called on every `error` that moves the feed to 再接続待ち. */
  onError?: () => void;
}

const FEED_EVENTS = ['change', 'run', 'run-end', 'actions', 'local'] as const;
type FeedEventName = (typeof FEED_EVENTS)[number];

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function toEvent(name: FeedEventName, data: string): BackendEvent | null {
  const d = parse(data);
  const obj = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  switch (name) {
    case 'change':
      return { type: 'change', paths: Array.isArray(d) ? d.filter((p): p is string => typeof p === 'string') : [] };
    case 'run':
      return obj && typeof obj.id === 'string'
        ? { type: 'run', id: obj.id, kind: 'test', rerunOf: obj.rerunOf as string | undefined, attempt: obj.attempt as number | undefined, times: obj.times as number | undefined }
        : null;
    case 'run-end':
      return obj && typeof obj.id === 'string' ? { type: 'run-end', id: obj.id, kind: typeof obj.kind === 'string' ? obj.kind : 'test' } : null;
    case 'actions':
      return obj && typeof obj.type === 'string' ? { type: 'actions', data: obj as { type: string } } : null;
    case 'local':
      return obj ? { type: 'local', root: (obj.root as string | null) ?? null, repoName: (obj.repoName as string | null) ?? null, generation: Number(obj.generation) || 0 } : null;
  }
}

/** One SSE connection shared by the subscribers of a `Backend` (diagram `sse-feed`). */
export class SseFeed {
  state: FeedState = 'Stopped';
  private readonly listeners = new Set<{ fn: BackendListener }>();
  private es: EventSourceLike | null = null;
  private timer: unknown = null;
  /** A `hello` arrived since the first subscribe: the next one is a reconnection (`resync`). */
  private opened = false;

  constructor(
    readonly url: string,
    private readonly opts: SseFeedOptions = {},
  ) {}

  get size(): number {
    return this.listeners.size;
  }

  add(fn: BackendListener): Unsubscribe {
    const entry = { fn };
    this.listeners.add(entry);
    // A second subscriber only joins (the state does not change).
    if (this.step('subscribe')) this.connect();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.listeners.delete(entry);
      if (this.listeners.size === 0 && this.step('unsubscribeLast')) this.stop();
    };
  }

  private step(input: FeedInput): boolean {
    const next = nextFeedState(this.state, input);
    if (!next) return false;
    this.state = next;
    return true;
  }

  private emit(ev: BackendEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l.fn(ev);
      } catch (e) {
        console.error('[ddv] event listener failed:', e);
      }
    }
  }

  private connect(): void {
    const es = (this.opts.open ?? defaultOpen)(this.url);
    this.es = es;
    es.addEventListener('hello', () => {
      if (this.es !== es || !this.step('hello')) return;
      const reconnect = this.opened;
      this.opened = true;
      if (reconnect) this.emit({ type: 'resync' });
    });
    for (const name of FEED_EVENTS)
      es.addEventListener(name, (e) => {
        if (this.es !== es || this.state !== 'Open') return;
        const ev = toEvent(name, String(e.data ?? ''));
        if (ev && this.step('event')) this.emit(ev);
      });
    es.addEventListener('error', () => {
      if (this.es !== es || !this.step('error')) return;
      this.opts.onError?.();
      this.retry(es);
    });
  }

  /** 再接続の開始: the browser's own reconnection when it is retrying, otherwise a new connection after `retryMs`. */
  private retry(es: EventSourceLike): void {
    if (es.readyState === CONNECTING) {
      this.step('reconnect');
      return;
    }
    es.close();
    this.es = null;
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      if (this.step('reconnect')) this.connect();
    }, this.opts.retryMs ?? 3000);
  }

  private stop(): void {
    this.es?.close();
    this.es = null;
    if (this.timer !== null) (this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.opened = false;
  }
}

/** Named events of `GET /api/runs/{id}/events` other than `log` / `end` (snapshots: `step` / `scenario`; unnamed = `message`). */
export const RUN_EVENTS = ['step', 'scenario', 'message'] as const;

/** Follows one local run: `log` lines, its events, then `end` (status) — or `''` when the stream fails. */
export function followRunEvents(url: string, h: RunHandlers, open: OpenEventSource = defaultOpen): Unsubscribe {
  const es = open(url);
  let done = false;
  const finish = (status: string) => {
    if (done) return;
    done = true;
    es.close();
    h.onEnd?.(status);
  };
  es.addEventListener('log', (e) => !done && h.onLog?.(String(e.data)));
  for (const name of RUN_EVENTS) es.addEventListener(name, (e) => !done && h.onEvent?.(name, String(e.data)));
  es.addEventListener('end', (e) => {
    const d = parse(String(e.data ?? '')) as { status?: unknown } | undefined;
    finish(d && typeof d.status === 'string' ? d.status : '');
  });
  es.addEventListener('error', () => finish(''));
  return () => {
    if (done) return;
    done = true;
    es.close();
  };
}

// A dropped stream may mean the server restarted (the session is gone): `json()` turns a 401 into `ddv-session-required` (local-folder.md).
let lastSessionCheck = 0;
function checkSession(): void {
  if (Date.now() - lastSessionCheck < 5000) return;
  lastSessionCheck = Date.now();
  void gh.workspaces().catch(() => null);
}

const feeds = new Map<string, SseFeed>();

/** The shared feed of an events URL (one connection per URL however many backends / screens subscribe). */
export function feedFor(url: string): SseFeed {
  let f = feeds.get(url);
  if (!f) feeds.set(url, (f = new SseFeed(url, { onError: checkSession })));
  return f;
}

/** `scope` = workspace id ('' = the local folder). */
export function createHttpBackend(scope: string): Backend {
  const base = createApi(scope);
  const feed = feedFor(apiPath(scope, '/api/events'));
  return {
    ...base,
    edition: 'local',
    capabilities: LOCAL_CAPABILITIES,
    subscribe: (listener) => feed.add(listener),
    followRun: (id, handlers) => followRunEvents(apiPath(scope, `/api/runs/${id}/events`), handlers),
    traceShot: async (runId, id, n) => base.traceShot(runId, id, n),
    rawUrl: async (p) => rawPath(scope, p),
    repo: () => null,
  };
}

export function createBackend(scope: string): Backend {
  return createHttpBackend(scope);
}
