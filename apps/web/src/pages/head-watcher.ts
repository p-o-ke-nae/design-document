/** Detects new commits of a `Ready` PR target (pages-viewer.md「更新の検知」). */

export interface HeadWatcherEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** `window` (`focus`). */
  window: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** `document` (`hidden`, `visibilitychange`). */
  document: (Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { readonly hidden: boolean }) | null;
}

export interface HeadWatcherOptions {
  /** `GET /repos/o/r/pulls/N` → `head.sha`. */
  fetchHead(): Promise<string>;
  /** `snapshot.pr.headSha`. */
  headSha(): string;
  onChanged(sha: string): void;
  hasToken(): boolean;
  env?: Partial<HeadWatcherEnv>;
}

export const POLL_WITH_PAT_MS = 60_000;
export const POLL_WITHOUT_PAT_MS = 300_000;
export const FOCUS_WITH_PAT_MS = 30_000;

const browserEnv = (): HeadWatcherEnv => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  window: typeof window === 'undefined' ? null : window,
  document: typeof document === 'undefined' ? null : document,
});

export class HeadWatcher {
  private readonly env: HeadWatcherEnv;
  private timer: unknown = null;
  private running = false;
  private lastCheck = -Infinity;
  private pausedUntil = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly opts: HeadWatcherOptions) {
    this.env = { ...browserEnv(), ...opts.env };
  }

  get intervalMs(): number {
    return this.opts.hasToken() ? POLL_WITH_PAT_MS : POLL_WITHOUT_PAT_MS;
  }

  private get focusGapMs(): number {
    return this.opts.hasToken() ? FOCUS_WITH_PAT_MS : POLL_WITHOUT_PAT_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastCheck = this.env.now();
    this.env.window?.addEventListener('focus', this.onFocus);
    this.env.document?.addEventListener('visibilitychange', this.onVisibility);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
    this.env.window?.removeEventListener('focus', this.onFocus);
    this.env.document?.removeEventListener('visibilitychange', this.onVisibility);
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = this.env.setTimeout(() => {
      this.timer = null;
      void this.check().finally(() => this.schedule());
    }, this.intervalMs);
  }

  private readonly onFocus = () => {
    if (this.env.now() - this.lastCheck < this.focusGapMs) return;
    void this.check();
  };

  private readonly onVisibility = () => {
    if (!this.env.document?.hidden) this.onFocus();
  };

  check(): Promise<void> {
    if (this.env.document?.hidden) return Promise.resolve();
    if (this.env.now() < this.pausedUntil) return Promise.resolve();
    return (this.inFlight ??= this.run().finally(() => (this.inFlight = null)));
  }

  private async run(): Promise<void> {
    this.lastCheck = this.env.now();
    try {
      const sha = await this.opts.fetchHead();
      if (this.running && sha && sha !== this.opts.headSha()) this.opts.onChanged(sha);
    } catch (e) {
      const err = e as { kind?: string; resetAt?: Date };
      if (err?.kind === 'rateLimit' && err.resetAt) this.pausedUntil = err.resetAt.getTime();
    }
  }
}
