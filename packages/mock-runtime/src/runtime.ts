import { parse as parseYaml } from 'yaml';
import { observeExpect, runStep, type ExpectObservation, type Step, type StepResult } from '@ddv/mock/step';
import type { TapResult } from '@ddv/mock/trace-format';
import { DeclarativeBinder } from './binder.ts';
import { HostBridge, type BridgeEngine, type BridgeState, type FixtureData } from './bridge.ts';
import { MemoryDb, type Row } from './db.ts';
import { DomDriver, type ExecOptions } from './driver.ts';
import { FetchInterceptor } from './fetch.ts';
import { ApiRouter, parseApiSpec, type ApiSpec, type RouteHandler } from './router.ts';
import { ScreenController } from './screen.ts';
import { TraceTap } from './trace-tap.ts';
import { Tuner } from './tuner.ts';
import type { ElementPatch, PatchIssue } from '@ddv/mock/tune-patch';
import { Validator } from './validator.ts';
import { RUNTIME_VERSION } from './version.ts';

export interface ScreenContext {
  screen: string;
  db: MemoryDb;
  root: Document;
  runtime: MockRuntime;
}

export type ScreenHandler = (ctx: ScreenContext) => unknown;
export type OpHandler = (ctx: Omit<ScreenContext, 'screen'> & { screen: string | null }) => unknown;

export interface MockRuntimeOptions {
  win?: Window & typeof globalThis;
  /** Reads a file relative to the page (`api.yaml`, `fixtures/default.yaml`). Resolves null when it does not exist. */
  load?: (rel: string) => Promise<string | null>;
  /** Retry time of `expect` after the step's DOM work has settled. Default 0 (checked once). */
  stepTimeoutMs?: number;
  /** Wait used for the highlight hold (tests inject it). */
  sleep?: (ms: number) => Promise<void>;
}

/** Facade exposed as `window.__ddv` and as `mock` for mock.js. */
export class MockRuntime implements BridgeEngine {
  readonly version = RUNTIME_VERSION;
  readonly db = new MemoryDb();
  readonly win: Window & typeof globalThis;
  readonly doc: Document;
  readonly router: ApiRouter;
  readonly interceptor: FetchInterceptor;
  readonly screens: ScreenController;
  readonly validator = new Validator();
  readonly binder: DeclarativeBinder;
  readonly driver: DomDriver;
  readonly bridge: HostBridge;
  readonly tuner: Tuner;
  /** API / DB recording of a step (window.__ddv.trace). */
  readonly trace = new TraceTap(() => this.db);
  private spec: ApiSpec = { base: '/api', tables: [], routes: [] };
  private readonly hooks = new Map<string, Set<ScreenHandler>>();
  private readonly ops = new Map<string, OpHandler>();
  private readonly load: (rel: string) => Promise<string | null>;
  private readonly stepTimeoutMs: number;
  private started: Promise<void> | null = null;

  constructor(opts: MockRuntimeOptions = {}) {
    this.win = opts.win ?? (window as Window & typeof globalThis);
    this.doc = this.win.document;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 0;
    this.router = new ApiRouter(this.db, (m) => this.reportError(m));
    this.interceptor = new FetchInterceptor(this.win);
    this.interceptor.onCall = (c) => this.trace.record(c);
    this.screens = new ScreenController(this.doc);
    this.binder = new DeclarativeBinder({
      win: this.win,
      root: this.doc,
      screens: this.screens,
      validator: this.validator,
      base: () => this.spec.base,
      onError: (m) => this.reportError(m),
    });
    this.driver = new DomDriver({ screens: this.screens, binder: this.binder, root: this.doc, invoke: (n) => this.invoke(n), sleep: opts.sleep });
    this.bridge = new HostBridge(this.win, this);
    this.tuner = new Tuner(this.doc, (picked) => this.bridge.notify({ type: 'ddv:picked', ...picked }));
    this.load = opts.load ?? ((rel) => this.fetchFile(rel));
  }

  /** Resolves on the first successful boot (rejects when it fails). */
  get ready(): Promise<void> {
    return this.bridge.ready;
  }

  get state(): BridgeState {
    return this.bridge.state;
  }

  get base(): string {
    return this.spec.base;
  }

  /** Installs listeners and boots with the default fixture. Idempotent. */
  start(): Promise<void> {
    this.install();
    this.started ??= this.bridge.start().then(() => undefined);
    return this.started;
  }

  /** Removes listeners and restores `fetch` (for tests / re-mounting). */
  dispose(): void {
    this.tuner.stop();
    this.binder.cancel();
    this.binder.unbind();
    this.bridge.unlisten();
    this.interceptor.uninstall();
    this.offScreen?.();
    this.offScreen = null;
    this.installed = false;
    this.started = null;
  }

  private offScreen: (() => void) | null = null;
  private installed = false;
  private install() {
    if (this.installed) return;
    this.installed = true;
    this.binder.bind(this.doc);
    this.offScreen = this.screens.onChange((id) => this.onScreen(id));
    this.bridge.listen();
  }

  /** Re-initializes the DB with the fixtures (layered in order) and shows `start` (default: first data-screen). */
  reset(fixtures: string[] = [], start?: string, data?: FixtureData): Promise<{ screen: string | null }> {
    this.install();
    return this.bridge.reset(fixtures, start, data);
  }

  step(step: Step): Promise<StepResult> {
    return this.bridge.step(step);
  }

  /** `on('screen:Input', ctx => ...)`: called after the screen is shown. */
  on(name: string, handler: ScreenHandler): () => void {
    let set = this.hooks.get(name);
    if (!set) this.hooks.set(name, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** `route('POST /orders', (req, db) => ({ status: 201, body }))` */
  route(spec: string, handler: RouteHandler): void {
    this.router.route(spec, handler);
  }

  /** Custom operation for the scenario `do` key. */
  op(name: string, handler: OpHandler): void {
    this.ops.set(name, handler);
  }

  // ---- BridgeEngine ----

  async boot(fixtures: string[] | null, start?: string, given?: FixtureData): Promise<{ screen: string | null }> {
    this.binder.cancel();
    const apiText = await this.load('api.yaml');
    const { spec, errors } = parseApiSpec(apiText === null ? null : parseYaml(apiText));
    for (const e of errors) this.reportError(e);
    this.spec = spec;
    this.router.setRoutes(spec.routes);
    this.interceptor.install(this.router, spec.base);

    const rows: Array<Record<string, Row[]>> = [];
    for (const name of fixtures ?? ['default']) {
      const draft = given?.[name];
      if (draft) {
        rows.push(draft as Record<string, Row[]>);
        continue;
      }
      const text = await this.load(`fixtures/${name}.yaml`);
      if (text === null) {
        if (fixtures === null) continue;
        throw new Error(`fixtures/${name}.yaml がありません`);
      }
      const data = parseYaml(text) as unknown;
      if (data !== null && (typeof data !== 'object' || Array.isArray(data))) throw new Error(`fixtures/${name}.yaml は「表名: 行の配列」の形式にしてください`);
      rows.push((data ?? {}) as Record<string, Row[]>);
    }
    this.db.reset(spec.tables, rows);
    for (const r of spec.routes) if (r.table) this.db.ensure(r.table);

    const target = start ?? this.screens.first();
    if (!target) throw new Error('data-screen を持つ要素がありません');
    this.screens.show(target);
    await this.binder.settled();
    return { screen: this.screens.current };
  }

  exec(step: Step, opts: ExecOptions = {}): Promise<StepResult> {
    this.driver.highlight = opts.highlight ?? null;
    return runStep(this.driver, step, { timeoutMs: this.stepTimeoutMs, retryIntervalMs: 20, hasOp: (n) => this.ops.has(n) }).finally(() => {
      this.driver.highlight = null;
    });
  }

  cancel(): void {
    this.binder.cancel();
  }

  traceBegin(): void {
    this.trace.begin(this.db);
  }

  traceTake(): TapResult {
    return this.trace.take(this.db);
  }

  observe(step: Step): Promise<ExpectObservation[]> {
    return observeExpect(this.driver, step.expect);
  }

  screen(): string | null {
    return this.screens.current;
  }

  get tuning(): boolean {
    return this.tuner.active;
  }

  tune(on: boolean): void {
    if (on) this.tuner.start();
    else this.tuner.stop();
  }

  patch(path: number[], patch: ElementPatch | null): PatchIssue[] {
    return this.tuner.apply(path, patch);
  }

  // ---- internals ----

  private reportError(message: string) {
    this.win.console?.warn?.(`[ddv] ${message}`);
    this.bridge?.error(message);
  }

  private onScreen(id: string) {
    void this.binder.onShow(id);
    for (const name of [`screen:${id}`, 'screen']) {
      for (const h of this.hooks.get(name) ?? []) {
        try {
          const r = h({ screen: id, db: this.db, root: this.doc, runtime: this });
          if (r && typeof (r as Promise<unknown>).then === 'function') void this.binder.track(Promise.resolve(r).catch((e) => this.reportError(String(e))));
        } catch (e) {
          this.reportError(e instanceof Error ? e.message : String(e));
        }
      }
    }
    this.bridge.screenChanged(id);
  }

  private async invoke(name: string) {
    const fn = this.ops.get(name);
    if (!fn) throw new Error(`未登録の操作です: ${name}`);
    await fn({ screen: this.screens.current, db: this.db, root: this.doc, runtime: this });
  }

  private async fetchFile(rel: string): Promise<string | null> {
    const url = new URL(rel, this.doc.baseURI).href;
    const res = await this.interceptor.originalFetch(url, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${rel} を読めません（HTTP ${res.status}）`);
    return res.text();
  }
}
