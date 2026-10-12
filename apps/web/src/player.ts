import type { Step, StepFailure } from './api.ts';
import type { ElementPatch, PickedElement } from '@ddv/mock/tune-patch';
import type { LiveStepTrace, TraceStep } from '@ddv/mock/trace-format';
import { FRAME_PROTOCOL, acceptFrameMessage, parseFromFrame, type FromFrame } from '@ddv/mock/frame-protocol';

/** BD-MOCK-PLAYER (docs/design/basic/mock-player.md#プレイヤー). */
export type PlayerState = 'Idle' | 'Playing' | 'Paused' | 'Done' | 'Failed';
/** play=再生 pause=一時停止 step=1ステップ stepEnd=ステップ終了 rewind=巻き戻し reset=リセット */
export type PlayerEvent = 'play' | 'pause' | 'step' | 'stepEnd' | 'rewind' | 'reset';
/** remaining=残りあり last=最終 mismatch=期待値不一致 */
export type StepGuard = 'remaining' | 'last' | 'mismatch';

type Target = PlayerState | Partial<Record<StepGuard, PlayerState>>;

const TABLE: Record<PlayerState, Partial<Record<PlayerEvent, Target>>> = {
  Idle: { play: 'Playing', step: 'Paused' },
  Playing: { pause: 'Paused', stepEnd: { remaining: 'Playing', last: 'Done', mismatch: 'Failed' } },
  Paused: { play: 'Playing', step: { remaining: 'Paused', last: 'Done', mismatch: 'Failed' }, rewind: 'Paused', reset: 'Idle' },
  Done: { rewind: 'Paused', reset: 'Idle' },
  Failed: { rewind: 'Paused', reset: 'Idle' },
};

export const INITIAL_STATE: PlayerState = 'Idle';

/** Next state, or null when the event is not accepted in that state (ignored). */
export function nextState(state: PlayerState, event: PlayerEvent, guard?: StepGuard): PlayerState | null {
  const t = TABLE[state][event];
  if (!t) return null;
  if (typeof t === 'string') return t;
  return guard ? (t[guard] ?? null) : null;
}

/** Whether the event is accepted in the state (for any guard). */
export function accepts(state: PlayerState, event: PlayerEvent): boolean {
  return TABLE[state][event] !== undefined;
}

export const STATE_LABEL: Record<PlayerState, string> = { Idle: '停止', Playing: '再生中', Paused: '一時停止', Done: '完了', Failed: '失敗' };

/** Wait per step = 1000ms ÷ rate (最速 = 0). */
export const SPEEDS: Array<{ label: string; ms: number }> = [
  { label: '0.25×', ms: 4000 },
  { label: '0.5×', ms: 2000 },
  { label: '0.75×', ms: 1333 },
  { label: '1×', ms: 1000 },
  { label: '1.5×', ms: 667 },
  { label: '2×', ms: 500 },
  { label: '4×', ms: 250 },
  { label: '最速', ms: 0 },
];

/** Highlight hold per element = 400ms ÷ rate, i.e. 0.4 × the step wait (最速 = 0). */
export function highlightHoldMs(speedMs: number): number {
  return Math.max(0, Math.round(speedMs * 0.4));
}

export interface StepHighlight {
  holdMs: number;
}

export const RESPONSE_TIMEOUT_MS = 10_000;
export const NO_RESPONSE = 'モックが応答しません';

export interface StepResult {
  ok: boolean;
  screen: string | null;
  failures: StepFailure[];
  message?: string;
  /** Step record for the live view (absent when the runtime does not support it). */
  trace?: LiveStepTrace;
}

export interface PlayerTransport {
  /** Sends ddv:reset and resolves on the following ddv:ready. */
  reset(fixtures: string[], start?: string, data?: DraftData): Promise<{ screen: string | null }>;
  /** Sends ddv:step and resolves on the matching ddv:result. `trace` asks the runtime for the step record. */
  step(index: number, step: Step, highlight?: StepHighlight, trace?: boolean): Promise<StepResult>;
}

/** Contents of fixtures by name (ddv:reset data): used instead of the files (DD-TDEDIT 編集中の再生). */
export type DraftData = Record<string, Record<string, Array<Record<string, unknown>>>>;

export interface LiveTraceSnapshot {
  steps: TraceStep[];
  /** false once a result came back without `trace` (old runtime). */
  supported: boolean;
  /** Playing the data being edited (test data editor). */
  draft: boolean;
}

/** Step records of the player's playback, kept in memory only (DD-TRVIEW ライブ表示). */
export class LiveTrace {
  private snap: LiveTraceSnapshot = { steps: [], supported: true, draft: false };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): LiveTraceSnapshot => this.snap;

  get steps(): TraceStep[] {
    return this.snap.steps;
  }

  get supported(): boolean {
    return this.snap.supported;
  }

  get draft(): boolean {
    return this.snap.draft;
  }

  /** Adds (or replaces, for the same index) the record of step `index` (0-based). `responded` = false for a timeout. */
  add(index: number, step: Step, result: StepResult, durationMs: number, responded = true) {
    const t = result.trace;
    const rec: TraceStep = {
      index: index + 1,
      event: step.event,
      ...(step.input ? { input: step.input } : {}),
      ...(step.click !== undefined ? { click: step.click } : {}),
      ...(step.do !== undefined ? { do: step.do } : {}),
      screenBefore: t?.screenBefore ?? null,
      screenAfter: result.screen,
      expects: t?.expects ?? [],
      ok: result.ok,
      ...(result.message ? { error: result.message } : {}),
      durationMs: Math.max(0, Math.round(durationMs)),
      calls: t?.calls ?? [],
      db: t ? t.db : null,
    };
    const steps = [...this.snap.steps.filter((s) => s.index !== rec.index), rec].sort((a, b) => a.index - b.index);
    this.emit({ steps, supported: this.snap.supported && (!responded || !!t) });
  }

  clear(draft = false) {
    this.emit({ steps: [], supported: true, draft });
  }

  private emit(p: Partial<LiveTraceSnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }
}

export interface PlayerTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimer: PlayerTimer = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface PlayerScenario {
  id: string;
  fixtures?: string[];
  start?: string;
  steps: Step[];
}

export interface PlayerFailure {
  /** Failed step index (null when the mock could not be reset). */
  index: number | null;
  event?: string;
  message?: string;
  screen: string | null;
  expectedScreen?: string;
  failures: StepFailure[];
}

export interface PlayerSnapshot {
  state: PlayerState;
  scenarioId: string | null;
  /** Number of steps completed; the next step to run is `cursor`. */
  cursor: number;
  total: number;
  /** Index of the step being executed. */
  running: number | null;
  /** Waiting for the mock (reset, rewind replay or a step). */
  busy: boolean;
  speed: number;
  /** 操作をハイライト (a setting, not a state). */
  highlight: boolean;
  screen: string | null;
  failure: PlayerFailure | null;
  /** Playing the data being edited (playDraft): results are not reported as played. */
  draft: boolean;
}

export interface PlayerOptions {
  timer?: PlayerTimer;
  timeoutMs?: number;
  speed?: number;
  highlight?: boolean;
  /** Clock for the live view's step durations (ms). */
  now?: () => number;
  /** Called when a playback reaches 完了 / 失敗. */
  onFinish?: (r: { id: string; ok: boolean; failures: StepFailure[] }) => void;
  /** Called instead of onFinish when a draft playback (playDraft) reaches 完了 / 失敗. */
  onDraftFinish?: (r: { id: string; ok: boolean; failures: StepFailure[] }) => void;
}

/** Framework-free player; React reads it with useSyncExternalStore(subscribe, getSnapshot). */
export class PlayerController {
  private snap: PlayerSnapshot;
  private listeners = new Set<() => void>();
  private scenario: PlayerScenario | null = null;
  private data: DraftData | null = null;
  private timer: PlayerTimer;
  private timeoutMs: number;
  /** Invalidates in-flight work (load / reset / rewind). */
  private epoch = 0;
  /** Invalidates the play loop (pause). */
  private loop = 0;
  private cancelSleep: (() => void) | null = null;
  private disposed = false;
  readonly liveTrace = new LiveTrace();
  private now: () => number;

  constructor(
    private transport: PlayerTransport,
    private opts: PlayerOptions = {},
  ) {
    this.timer = opts.timer ?? defaultTimer;
    this.timeoutMs = opts.timeoutMs ?? RESPONSE_TIMEOUT_MS;
    this.now = opts.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.snap = { state: INITIAL_STATE, scenarioId: null, cursor: 0, total: 0, running: null, busy: false, speed: opts.speed ?? 1000, highlight: opts.highlight ?? false, screen: null, failure: null, draft: false };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): PlayerSnapshot => this.snap;

  getScenario(): PlayerScenario | null {
    return this.scenario;
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
    this.listeners.clear();
  }

  /** Loads a scenario and starts over at 停止 ([*] --> 停止). */
  load(scenario: PlayerScenario | null) {
    this.loadWith(scenario, null);
  }

  /** Plays the data being edited: ddv:reset carries data, and the result is not reported as played (onDraftFinish). */
  playDraft(scenario: PlayerScenario, data: DraftData): boolean {
    this.loadWith(scenario, data);
    return this.play();
  }

  private loadWith(scenario: PlayerScenario | null, data: DraftData | null) {
    this.invalidate();
    this.scenario = scenario;
    this.data = scenario ? data : null;
    this.clearTrace();
    this.set({ state: INITIAL_STATE, scenarioId: scenario?.id ?? null, cursor: 0, total: scenario?.steps.length ?? 0, running: null, busy: false, failure: null, draft: !!this.data });
  }

  private clearTrace() {
    this.liveTrace.clear(!!this.data);
  }

  private resetMock(s: PlayerScenario) {
    return this.transport.reset(s.fixtures ?? [], s.start, this.data ?? undefined);
  }

  /** Speed is a setting, not a state change. */
  setSpeed(ms: number) {
    this.set({ speed: Math.max(0, ms) });
  }

  /** Highlight is a setting, not a state change; applies to 再生 / 1ステップ (never to rewind replay). */
  setHighlight(on: boolean) {
    this.set({ highlight: on });
  }

  setScreen(screen: string | null) {
    if (screen !== this.snap.screen) this.set({ screen });
  }

  play(): boolean {
    if (!this.scenario || this.snap.busy) return false;
    const from = this.snap.state;
    const to = nextState(from, 'play');
    if (!to) return false;
    this.set({ state: to, failure: from === 'Idle' ? null : this.snap.failure });
    void this.runLoop(from === 'Idle');
    return true;
  }

  pause(): boolean {
    const to = nextState(this.snap.state, 'pause');
    if (!to) return false;
    this.loop++;
    this.cancelSleep?.();
    this.set({ state: to });
    return true;
  }

  step(): boolean {
    if (!this.scenario || this.snap.busy) return false;
    const from = this.snap.state;
    if (!accepts(from, 'step')) return false;
    if (from === 'Idle') {
      // 停止 --1ステップ--> 一時停止: prepare the mock and stop before the first step
      const to = nextState(from, 'step')!;
      const epoch = this.epoch;
      this.set({ state: to, cursor: 0, failure: null });
      void this.doReset(epoch).then((ok) => ok && this.alive(epoch) && this.set({ busy: false }));
      return true;
    }
    if (this.snap.cursor >= this.snap.total) {
      this.set({ state: nextState(from, 'step', 'last')! });
      return true;
    }
    void this.execStep('step');
    return true;
  }

  /** Back to step k (0..total): reset the mock and replay steps 0..k-1 without waiting. */
  rewind(k: number): boolean {
    if (!this.scenario) return false;
    const to = nextState(this.snap.state, 'rewind');
    if (!to) return false;
    const target = Math.max(0, Math.min(Math.floor(k), this.snap.total));
    this.invalidate();
    const epoch = this.epoch;
    const steps = this.scenario.steps;
    this.set({ state: to, cursor: 0, running: null, failure: null });
    void (async () => {
      if (!(await this.doReset(epoch))) return;
      for (let i = 0; i < target; i++) {
        this.set({ running: i, busy: true });
        const r = await this.callStep(epoch, i, steps[i]);
        if (!this.alive(epoch)) return;
        if (!r.ok) {
          this.set({ running: null, busy: false, cursor: i, failure: this.failureOf(i, r) });
          return;
        }
        this.set({ cursor: i + 1, screen: r.screen ?? this.snap.screen });
      }
      this.set({ running: null, busy: false });
    })();
    return true;
  }

  reset(): boolean {
    const to = nextState(this.snap.state, 'reset');
    if (!to) return false;
    this.invalidate();
    this.clearTrace();
    this.set({ state: to, cursor: 0, running: null, busy: false, failure: null });
    if (this.scenario) void this.resetMock(this.scenario).catch(() => {});
    return true;
  }

  private set(p: Partial<PlayerSnapshot>) {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  private invalidate() {
    this.epoch++;
    this.loop++;
    this.cancelSleep?.();
  }

  private alive(epoch: number) {
    return !this.disposed && epoch === this.epoch;
  }

  private withTimeout<T>(p: Promise<T>, extraMs = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const h = this.timer.setTimeout(() => reject(new Error(NO_RESPONSE)), this.timeoutMs + extraMs);
      p.then(
        (v) => {
          this.timer.clearTimeout(h);
          resolve(v);
        },
        (e) => {
          this.timer.clearTimeout(h);
          reject(e);
        },
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const h = this.timer.setTimeout(done, ms);
      const self = this;
      function done() {
        self.timer.clearTimeout(h);
        if (self.cancelSleep === done) self.cancelSleep = null;
        resolve();
      }
      this.cancelSleep = done;
    });
  }

  /** Runs one step and records it in the live view (unless the work was invalidated meanwhile). */
  private async callStep(epoch: number, index: number, step: Step, highlight?: StepHighlight): Promise<StepResult> {
    const t0 = this.now();
    let r: StepResult;
    let responded = true;
    try {
      const ops = highlight ? Object.keys(step.input ?? {}).length + (step.click !== undefined ? 1 : 0) : 0;
      r = await this.withTimeout(this.transport.step(index, step, highlight, true), highlight ? highlight.holdMs * ops : 0);
    } catch (e) {
      responded = false;
      r = { ok: false, screen: null, failures: [], message: (e as Error)?.message || NO_RESPONSE };
    }
    if (this.alive(epoch)) this.liveTrace.add(index, step, r, this.now() - t0, responded);
    return r;
  }

  private failureOf(index: number | null, r: { screen: string | null; failures: StepFailure[]; message?: string }): PlayerFailure {
    const step = index === null ? undefined : this.scenario?.steps[index];
    return { index, event: step?.event, message: r.message, screen: r.screen, expectedScreen: step?.expect.screen, failures: r.failures ?? [] };
  }

  /** Resets the mock to the scenario start; on failure records it (and fails a running playback). */
  private async doReset(epoch: number): Promise<boolean> {
    const s = this.scenario!;
    this.clearTrace();
    this.set({ busy: true });
    try {
      const r = await this.withTimeout(this.resetMock(s));
      if (!this.alive(epoch)) return false;
      this.set({ screen: r?.screen ?? this.snap.screen });
      return true;
    } catch (e) {
      if (!this.alive(epoch)) return false;
      const failure = this.failureOf(null, { screen: null, failures: [], message: (e as Error)?.message || NO_RESPONSE });
      const to = nextState(this.snap.state, 'stepEnd', 'mismatch');
      this.set({ busy: false, failure, ...(to ? { state: to } : {}) });
      if (to === 'Failed') this.finish(false);
      return false;
    }
  }

  private async execStep(origin: 'play' | 'step'): Promise<void> {
    const s = this.scenario!;
    const epoch = this.epoch;
    const index = this.snap.cursor;
    this.set({ running: index, busy: true, failure: null });
    const highlight = this.snap.highlight ? { holdMs: highlightHoldMs(this.snap.speed) } : undefined;
    const r = await this.callStep(epoch, index, s.steps[index], highlight);
    // A late result after reset / rewind / reload is ignored (ステップ終了 in 停止 etc.)
    if (!this.alive(epoch)) return;
    const guard: StepGuard = !r.ok ? 'mismatch' : index + 1 >= s.steps.length ? 'last' : 'remaining';
    // Paused during playback: the result is kept but ステップ終了 does not change 一時停止
    const to = nextState(this.snap.state, origin === 'play' ? 'stepEnd' : 'step', guard);
    this.set({
      running: null,
      busy: false,
      cursor: r.ok ? index + 1 : index,
      screen: r.screen ?? this.snap.screen,
      failure: r.ok ? null : this.failureOf(index, r),
      ...(to ? { state: to } : {}),
    });
    if (to === 'Done') this.finish(true);
    else if (to === 'Failed') this.finish(false);
  }

  private async runLoop(fromIdle: boolean) {
    const loop = ++this.loop;
    const epoch = this.epoch;
    const going = () => this.alive(epoch) && loop === this.loop && this.snap.state === 'Playing';
    if (fromIdle) {
      this.set({ cursor: 0 });
      if (!(await this.doReset(epoch))) return;
      if (!this.alive(epoch)) return;
      this.set({ busy: false });
    }
    while (going()) {
      if (this.snap.cursor >= this.snap.total) {
        this.set({ state: nextState('Playing', 'stepEnd', 'last')! });
        this.finish(true);
        return;
      }
      await this.execStep('play');
      if (!going()) return;
      await this.sleep(this.snap.speed);
    }
  }

  private finish(ok: boolean) {
    const s = this.scenario;
    if (!s) return;
    const r = { id: s.id, ok, failures: this.snap.failure?.failures ?? [] };
    if (this.data) this.opts.onDraftFinish?.(r);
    else this.opts.onFinish?.(r);
  }
}

export type MockMessage = FromFrame;

/** Tune mode messages to the mock (DD-TUNE). */
export type TuneMessage = { type: 'ddv:tune'; on: boolean } | { type: 'ddv:patch'; path: number[]; patch: ElementPatch | null };

/** Build-time edition of the viewer: `local` = /raw/ iframe, `pages` = sandboxed srcdoc (DD-MOCKSB). */
export type Edition = 'local' | 'pages';

export type FrameSessionState = 'Building' | 'Loading' | 'Initializing' | 'Ready' | 'Running' | 'Failed';
export type FrameSessionEvent = 'show' | 'built' | 'buildFailed' | 'hello' | 'ready' | 'timeout' | 'error' | 'step' | 'result' | 'reload';

export const VERSION_MISMATCH = 'モックの runtime の版が合いません';
export const BUILD_FAILED = 'モックの HTML を読めません';

/** Connection with the mock iframe (DD-MOCKSB HANDSHAKE). `null` = the pair is not in the diagram (ignored). */
export function frameSessionTransition(state: FrameSessionState | null, event: FrameSessionEvent, edition: Edition): FrameSessionState | null {
  const pages = edition === 'pages';
  if (state === null) return event === 'show' ? (pages ? 'Building' : 'Loading') : null;
  switch (`${state}|${event}`) {
    case 'Building|built':
      return 'Loading';
    case 'Building|buildFailed':
      return 'Failed';
    case 'Loading|hello':
      return pages ? 'Initializing' : null;
    case 'Loading|ready':
      return pages ? null : 'Ready';
    case 'Loading|timeout':
      return pages ? 'Failed' : null;
    case 'Initializing|ready':
      return 'Ready';
    case 'Initializing|error':
    case 'Initializing|timeout':
      return 'Failed';
    case 'Ready|step':
      return 'Running';
    case 'Running|result':
      return 'Ready';
    case 'Ready|hello':
    case 'Running|hello':
      return pages ? 'Initializing' : null;
    case 'Ready|reload':
    case 'Running|reload':
    case 'Failed|reload':
      return pages ? 'Building' : 'Loading';
    default:
      return null;
  }
}

/** State holder of {@link frameSessionTransition} with the failure message. */
export class FrameSession {
  state: FrameSessionState | null = null;
  failure = '';
  private listeners = new Set<() => void>();

  constructor(readonly edition: Edition) {}

  /** Applies the event; returns false (state unchanged) when the diagram has no such transition. */
  fire(event: FrameSessionEvent, failure?: string): boolean {
    const next = frameSessionTransition(this.state, event, this.edition);
    if (!next) return false;
    this.state = next;
    this.failure = next === 'Failed' ? (failure ?? '') : '';
    for (const f of [...this.listeners]) f();
    return true;
  }

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Resolves once Ready/Running, rejects with the failure message once Failed. */
  whenReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.state === 'Ready' || this.state === 'Running') resolve();
        else if (this.state === 'Failed') reject(new Error(this.failure || NO_RESPONSE));
        else return false;
        off();
        return true;
      };
      const off = this.subscribe(() => void check());
      check();
    });
  }
}

export interface FrameTransport extends PlayerTransport {
  send(msg: TuneMessage): void;
  dispose(): void;
  readonly session: FrameSession;
  /** Pages: the srcdoc has been set on the iframe (Building → Loading). */
  built(files: Record<string, string>): void;
  /** Pages: MockDocumentBuilder failed (Building → Failed). */
  buildFailed(reason: string): void;
  /** ⟳ of MockFrame. */
  reload(): void;
}

export interface FrameTransportOptions {
  onMessage?: (m: MockMessage) => void;
  win?: Window;
  bootWaitMs?: number;
  /** Default `local` (Phase 5 behaviour). */
  edition?: Edition;
  /** Pages: no answer in Loading/Initializing (default RESPONSE_TIMEOUT_MS). */
  timeoutMs?: number;
  onSession?: (s: FrameSession) => void;
}

/** postMessage transport to the mock iframe (mock-runtime HostBridge). */
export function createFrameTransport(getFrame: () => HTMLIFrameElement | null, opts: FrameTransportOptions = {}): FrameTransport {
  const win = opts.win ?? window;
  const edition = opts.edition ?? 'local';
  const pages = edition === 'pages';
  const session = new FrameSession(edition);
  let loaded = false;
  let files: Record<string, string> = {};
  let readyWaiters: Array<(screen: string | null) => void> = [];
  const stepWaiters = new Map<number, { resolve(r: StepResult): void; reject(e: Error): void }>();
  let chain: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const target = () => getFrame()?.contentWindow ?? null;
  // An opaque-origin (sandboxed srcdoc) frame can only be addressed with '*'; nothing secret is sent
  const post = (msg: unknown) => target()?.postMessage(JSON.parse(JSON.stringify(msg)), pages ? '*' : win.location.origin);

  const notifySession = () => opts.onSession?.(session);
  session.subscribe(notifySession);
  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const startTimer = () => {
    stopTimer();
    timer = setTimeout(() => {
      timer = undefined;
      session.fire('timeout', NO_RESPONSE);
    }, opts.timeoutMs ?? RESPONSE_TIMEOUT_MS);
  };
  const dropSteps = (why: string) => {
    for (const w of stepWaiters.values()) w.reject(new Error(why));
    stepWaiters.clear();
  };
  session.subscribe(() => {
    if (session.state !== 'Loading' && session.state !== 'Initializing') stopTimer();
    if (session.state === 'Failed') dropSteps(session.failure || NO_RESPONSE);
  });

  const onMessage = (e: MessageEvent) => {
    const w = target();
    if (!w) return;
    const d = acceptFrameMessage(e, { source: w, origin: pages ? 'null' : win.location.origin }, parseFromFrame);
    if (!d) return;
    if (d.type === 'ddv:hello') {
      if (session.fire('hello')) {
        dropSteps('reset');
        if (d.protocol !== FRAME_PROTOCOL) session.fire('error', VERSION_MISMATCH);
        else {
          startTimer();
          post({ type: 'ddv:init', protocol: FRAME_PROTOCOL, files });
        }
      }
    } else if (d.type === 'ddv:ready') {
      loaded = true;
      session.fire('ready');
      const ws = readyWaiters;
      readyWaiters = [];
      ws.forEach((f) => f(d.screen ?? null));
    } else if (d.type === 'ddv:result') {
      session.fire('result');
      const w2 = stepWaiters.get(d.index);
      stepWaiters.delete(d.index);
      const trace = d.trace && typeof d.trace === 'object' ? d.trace : undefined;
      w2?.resolve({ ok: !!d.ok, screen: d.screen ?? null, failures: Array.isArray(d.failures) ? d.failures : [], message: d.message, ...(trace ? { trace } : {}) });
    } else if (d.type === 'ddv:error') {
      session.fire('error', d.message);
    }
    opts.onMessage?.(d);
  };
  win.addEventListener('message', onMessage);
  session.fire('show');

  const nextReady = (ms: number) =>
    new Promise<string | null>((resolve, reject) => {
      const f = (s: string | null) => {
        clearTimeout(h);
        resolve(s);
      };
      const h = setTimeout(() => {
        readyWaiters = readyWaiters.filter((x) => x !== f);
        reject(new Error(NO_RESPONSE));
      }, ms);
      readyWaiters.push(f);
    });

  return {
    session,
    reset(fixtures, start, data) {
      const run = async () => {
        if (pages) await session.whenReady();
        // Initial load: wait for the runtime to announce itself (it may already have, unseen)
        else if (!loaded) await nextReady(opts.bootWaitMs ?? 3000).catch(() => {});
        dropSteps('reset');
        const p = nextReady(RESPONSE_TIMEOUT_MS);
        post({ type: 'ddv:reset', fixtures, ...(start ? { start } : {}), ...(data ? { data } : {}) });
        return { screen: await p };
      };
      const r = chain.then(run, run);
      chain = r.catch(() => {});
      return r;
    },
    step(index, step, highlight, trace) {
      return new Promise<StepResult>((resolve, reject) => {
        if (pages && session.state !== 'Ready' && session.state !== 'Running') {
          reject(new Error(session.failure || NO_RESPONSE));
          return;
        }
        stepWaiters.get(index)?.reject(new Error('superseded'));
        stepWaiters.set(index, { resolve, reject });
        session.fire('step');
        post({ type: 'ddv:step', index, step, ...(highlight ? { highlight } : {}), ...(trace ? { trace: true } : {}) });
      });
    },
    send(msg) {
      post(msg);
    },
    built(f) {
      files = f;
      if (session.fire('built')) startTimer();
    },
    buildFailed(reason) {
      session.fire('buildFailed', `${BUILD_FAILED}: ${reason}`);
    },
    reload() {
      if (!session.fire('reload')) return;
      loaded = false;
      dropSteps('reset');
      stopTimer();
    },
    dispose() {
      win.removeEventListener('message', onMessage);
      stopTimer();
      dropSteps('disposed');
      readyWaiters = [];
    },
  };
}
