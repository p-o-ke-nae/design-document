import type { ExpectObservation, Step, StepResult } from '@ddv/mock/step';
import type { LiveStepTrace, TapResult } from '@ddv/mock/trace-format';
import type { ElementPatch, PatchIssue, PickedElement } from '@ddv/mock/tune-patch';

export type BridgeState = 'Booting' | 'Ready' | 'Running' | 'Broken';
export type BridgeEvent = 'loaded' | 'failed' | 'step' | 'done' | 'reset';

/** Transitions of the bridge (detailed design: BRIDGE). Returns null when the event does not change the state. */
export function bridgeTransition(state: BridgeState, ev: BridgeEvent): BridgeState | null {
  switch (state) {
    case 'Booting':
      return ev === 'loaded' ? 'Ready' : ev === 'failed' ? 'Broken' : null;
    case 'Ready':
      return ev === 'step' ? 'Running' : ev === 'reset' ? 'Booting' : null;
    case 'Running':
      return ev === 'done' ? 'Ready' : ev === 'reset' ? 'Booting' : null;
    case 'Broken':
      return ev === 'reset' ? 'Booting' : null;
  }
}

export type OutMessage =
  | { type: 'ddv:ready'; screen: string | null; version: string }
  | { type: 'ddv:result'; index: number; ok: boolean; screen: string | null; failures: StepResult['failures']; message?: string; trace?: LiveStepTrace }
  | { type: 'ddv:screen'; screen: string }
  | { type: 'ddv:error'; message: string }
  | ({ type: 'ddv:picked' } & PickedElement);

export type InMessage =
  /** `data`: fixture contents by name, used instead of reading `fixtures/<name>.yaml` (playing the editor's draft, DD-TDEDIT). */
  | { type: 'ddv:reset'; fixtures?: string[]; start?: string; data?: FixtureData }
  | { type: 'ddv:step'; index: number; step: Step; highlight?: { holdMs: number }; trace?: boolean }
  | { type: 'ddv:tune'; on: boolean }
  | { type: 'ddv:patch'; path: number[]; patch: ElementPatch | null };

/** Fixture name → table → rows. */
export type FixtureData = Record<string, Record<string, Array<Record<string, unknown>>>>;

export const TUNING_MESSAGE = 'モックの調整中のため実行できません（調整を終了してください）';

/** What the bridge drives (implemented by MockRuntime). */
export interface BridgeEngine {
  readonly version: string;
  /** Loads api.yaml / fixtures and shows the start screen. `fixtures` null = initial boot (default fixture when present). */
  boot(fixtures: string[] | null, start?: string, data?: FixtureData): Promise<{ screen: string | null }>;
  exec(step: Step, opts?: { highlight?: { holdMs: number } | null }): Promise<StepResult>;
  /** Discards in-flight declarative work of a running step. */
  cancel(): void;
  screen(): string | null;
  /** Tune mode (DD-TUNE): steps are refused while it is on. */
  readonly tuning?: boolean;
  tune?(on: boolean): void;
  /** Applies (null = reverts) the element's patch; returns the validation issues. */
  patch?(path: number[], patch: ElementPatch | null): PatchIssue[];
  /** Live trace (DD-TRREC): starts / takes the API and DB recording and observes the step's expect once. */
  traceBegin?(): void;
  traceTake?(): TapResult;
  observe?(step: Step): Promise<ExpectObservation[]>;
}

interface QueueItem {
  step: Step;
  index?: number;
  highlight?: { holdMs: number } | null;
  trace?: boolean;
  resolve: (r: StepResult) => void;
}

/** Accepts { holdMs } with a finite, non-negative holdMs (capped at 10s); anything else = no highlight. */
export function validHighlight(h: unknown): { holdMs: number } | null {
  if (!h || typeof h !== 'object') return null;
  const ms = (h as { holdMs?: unknown }).holdMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? { holdMs: Math.min(ms, 10_000) } : null;
}

/** `ddv:reset` data: only plain objects of tables (arrays of row objects) are kept. */
export function validData(d: unknown): FixtureData | undefined {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const out: FixtureData = {};
  for (const [name, tables] of Object.entries(d)) {
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) continue;
    const t: FixtureData[string] = {};
    for (const [table, rows] of Object.entries(tables)) if (Array.isArray(rows)) t[table] = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
    out[name] = t;
  }
  return out;
}

export class SupersededError extends Error {
  constructor() {
    super('後続のリセットにより中断しました');
    this.name = 'SupersededError';
  }
}

/** postMessage endpoint toward the viewer (parent window) and the state machine shared with `window.__ddv`. */
export class HostBridge {
  state: BridgeState = 'Booting';
  private gen = 0;
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private abort: AbortController | null = null;
  private readyResolve!: () => void;
  private readyReject!: (e: unknown) => void;
  private firstBootDone = false;
  /** Resolves on the first successful boot; rejects when the first boot fails. */
  readonly ready: Promise<void>;

  constructor(
    private readonly win: Window,
    private readonly engine: BridgeEngine,
  ) {
    this.ready = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.ready.catch(() => {});
  }

  private fire(ev: BridgeEvent): boolean {
    const next = bridgeTransition(this.state, ev);
    if (next) this.state = next;
    return next !== null;
  }

  listen(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    this.win.addEventListener('message', (e) => this.onMessage(e as MessageEvent), { signal: this.abort.signal });
  }

  unlisten(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private get embedded(): boolean {
    return this.win.parent !== this.win;
  }

  notify(msg: OutMessage): void {
    if (!this.embedded) return;
    const origin = this.win.location.origin;
    this.win.parent.postMessage(msg, origin && origin !== 'null' ? origin : '*');
  }

  onMessage(e: MessageEvent): void {
    if (!this.embedded || e.origin !== this.win.location.origin || e.source !== this.win.parent) return;
    const m = e.data as InMessage | null;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ddv:reset') this.reset(Array.isArray(m.fixtures) ? m.fixtures : [], m.start, validData(m.data)).catch(() => {});
    else if (m.type === 'ddv:step' && typeof m.index === 'number' && m.step && typeof m.step === 'object') void this.step(m.step, m.index, validHighlight(m.highlight), m.trace === true);
    else if (m.type === 'ddv:tune' && typeof m.on === 'boolean') this.engine.tune?.(m.on);
    else if (m.type === 'ddv:patch' && Array.isArray(m.path) && m.path.every((i) => Number.isInteger(i) && i >= 0)) {
      const issues = this.engine.patch?.(m.path, m.patch && typeof m.patch === 'object' ? m.patch : null) ?? [];
      if (issues.length) this.error(issues.map((i) => i.message).join('／'));
    }
  }

  /** Initial boot (state is already Booting). */
  start(): Promise<{ screen: string | null }> {
    return this.boot(null);
  }

  reset(fixtures: string[], start?: string, data?: FixtureData): Promise<{ screen: string | null }> {
    this.engine.cancel();
    this.discard();
    // Booting has no reset transition: a reset while booting supersedes the boot in progress and stays Booting.
    this.fire('reset');
    return this.boot(fixtures, start, data);
  }

  private discard() {
    const items = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const it of items) it.resolve({ ok: false, screen: this.engine.screen(), failures: [], error: { kind: 'error', message: 'リセットにより破棄しました' } });
  }

  private async boot(fixtures: string[] | null, start?: string, data?: FixtureData): Promise<{ screen: string | null }> {
    const g = ++this.gen;
    try {
      const r = await this.engine.boot(fixtures, start, data);
      if (g !== this.gen) throw new SupersededError();
      this.fire('loaded');
      this.notify({ type: 'ddv:ready', screen: r.screen, version: this.engine.version });
      if (!this.firstBootDone) {
        this.firstBootDone = true;
        this.readyResolve();
      }
      return r;
    } catch (e) {
      if (e instanceof SupersededError || g !== this.gen) throw e instanceof SupersededError ? e : new SupersededError();
      this.fire('failed');
      const message = e instanceof Error ? e.message : String(e);
      this.notify({ type: 'ddv:error', message });
      if (!this.firstBootDone) {
        this.firstBootDone = true;
        this.readyReject(e);
      }
      throw e;
    }
  }

  /** Runs a step (queued while another runs). `index` given = came from postMessage, so the result is posted back. */
  step(step: Step, index?: number, highlight?: { holdMs: number } | null, trace = false): Promise<StepResult> {
    if (this.state === 'Booting' || this.state === 'Broken' || this.engine.tuning) {
      const message = this.engine.tuning ? TUNING_MESSAGE : this.state === 'Booting' ? 'モックを起動中のため実行できません' : 'モックの読込に失敗しているため実行できません（リセットしてください）';
      const r: StepResult = { ok: false, screen: this.engine.screen(), failures: [], error: { kind: 'error', message } };
      this.post(index, r);
      return Promise.resolve(r);
    }
    return new Promise<StepResult>((resolve) => {
      this.queue.push({ step, index, highlight, trace, resolve });
      if (this.state === 'Ready') {
        this.fire('step');
        void this.pump();
      }
    });
  }

  private post(index: number | undefined, r: StepResult, trace?: LiveStepTrace) {
    if (index === undefined) return;
    this.notify({ type: 'ddv:result', index, ok: r.ok, screen: r.screen, failures: r.failures, ...(r.error ? { message: r.error.message } : {}), ...(trace ? { trace } : {}) });
  }

  private get canTrace(): boolean {
    return !!(this.engine.traceBegin && this.engine.traceTake && this.engine.observe);
  }

  private async pump(): Promise<void> {
    const g = this.gen;
    while (this.queue.length) {
      const item = this.queue.shift()!;
      this.current = item;
      const tracing = item.trace === true && item.index !== undefined && this.canTrace;
      const screenBefore = tracing ? this.engine.screen() : null;
      if (tracing) this.engine.traceBegin!();
      let r: StepResult;
      try {
        r = await this.engine.exec(item.step, item.highlight ? { highlight: item.highlight } : undefined);
      } catch (e) {
        r = { ok: false, screen: this.engine.screen(), failures: [], error: { kind: 'error', message: e instanceof Error ? e.message : String(e) } };
      }
      let trace: LiveStepTrace | undefined;
      if (tracing) {
        const tap = this.engine.traceTake!();
        let expects: ExpectObservation[] = [];
        try {
          expects = await this.engine.observe!(item.step);
        } catch {
          /* observation is best effort */
        }
        trace = { screenBefore, calls: tap.calls, db: tap.db, expects };
      }
      // Completion of a step discarded by reset: ignored (no result is posted).
      if (g !== this.gen) return;
      this.current = null;
      this.post(item.index, r, trace);
      item.resolve(r);
    }
    this.fire('done');
  }

  /** Screen changed by the user (not by a step or boot). */
  screenChanged(screen: string): void {
    if (this.state === 'Ready') this.notify({ type: 'ddv:screen', screen });
  }

  error(message: string): void {
    this.notify({ type: 'ddv:error', message });
  }
}
