import type { ExpectObservation, Step, StepResult } from '@ddv/mock/step';
import type { LiveStepTrace, TapResult } from '@ddv/mock/trace-format';
import type { ElementPatch, PatchIssue, PickedElement } from '@ddv/mock/tune-patch';
import { acceptFrameMessage, FRAME_PROTOCOL, parseToFrame, validData, validHighlight, type FixtureData } from '@ddv/mock/frame-protocol';
import type { HostInfo } from './host.ts';

export { validData, validHighlight, type FixtureData };

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
  | { type: 'ddv:hello'; protocol: number; version: string }
  | { type: 'ddv:ready'; screen: string | null; version: string; protocol?: number }
  | { type: 'ddv:result'; index: number; ok: boolean; screen: string | null; failures: StepResult['failures']; message?: string; trace?: LiveStepTrace }
  | { type: 'ddv:screen'; screen: string }
  | { type: 'ddv:error'; message: string }
  | ({ type: 'ddv:picked' } & PickedElement);

export type InMessage =
  /** `data`: fixture contents by name, used instead of reading `fixtures/<name>.yaml` (playing the editor's draft, DD-TDEDIT). */
  | { type: 'ddv:reset'; fixtures?: string[]; start?: string; data?: FixtureData }
  | { type: 'ddv:step'; index: number; step: Step; highlight?: { holdMs: number }; trace?: boolean }
  | { type: 'ddv:tune'; on: boolean }
  | { type: 'ddv:patch'; path: number[]; patch: ElementPatch | null }
  | { type: 'ddv:init'; protocol: number; files: Record<string, string> };

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
  /** srcdoc: the files of ddv:init (api.yaml, fixtures, files read by fetch). */
  init?(files: Record<string, string>): void;
}

interface QueueItem {
  step: Step;
  index?: number;
  highlight?: { holdMs: number } | null;
  trace?: boolean;
  resolve: (r: StepResult) => void;
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
    /** From detectHostMode. Absent = Phase 5 behaviour (no ddv:hello / protocol, origin = location.origin). */
    private readonly host?: HostInfo,
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
    if (this.host) this.notify({ type: 'ddv:hello', protocol: FRAME_PROTOCOL, version: this.engine.version });
  }

  unlisten(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private get embedded(): boolean {
    return this.host ? this.host.mode !== 'standalone' : this.win.parent !== this.win;
  }

  private get parentOrigin(): string {
    return this.host?.origin ?? this.win.location.origin;
  }

  notify(msg: OutMessage): void {
    if (!this.embedded) return;
    const origin = this.parentOrigin;
    this.win.parent.postMessage(msg, origin && origin !== 'null' ? origin : '*');
  }

  onMessage(e: MessageEvent): void {
    if (!this.embedded) return;
    const m = acceptFrameMessage(e, { source: this.win.parent, origin: this.parentOrigin }, parseToFrame);
    if (!m) return;
    if (m.type === 'ddv:init') {
      if (this.host?.mode === 'srcdoc') this.engine.init?.(m.files);
    } else if (m.type === 'ddv:reset') this.reset(m.fixtures, m.start, m.data).catch(() => {});
    else if (m.type === 'ddv:step') void this.step(m.step, m.index, m.highlight, m.trace);
    else if (m.type === 'ddv:tune') this.engine.tune?.(m.on);
    else if (m.type === 'ddv:patch') {
      const issues = this.engine.patch?.(m.path, m.patch) ?? [];
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
      this.notify({ type: 'ddv:ready', screen: r.screen, version: this.engine.version, ...(this.host ? { protocol: FRAME_PROTOCOL } : {}) });
      if (!this.firstBootDone) {
        this.firstBootDone = true;
        this.readyResolve();
        this.flushHeld();
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
        this.flushHeld();
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
    // srcdoc: the viewer treats ddv:error before the first ddv:ready as a boot failure, so warnings wait until then.
    if (this.host?.mode === 'srcdoc' && !this.firstBootDone) {
      this.held.push(message);
      return;
    }
    this.notify({ type: 'ddv:error', message });
  }

  private held: string[] = [];
  private flushHeld() {
    const ms = this.held;
    this.held = [];
    for (const message of ms) this.notify({ type: 'ddv:error', message });
  }
}
