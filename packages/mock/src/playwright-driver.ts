// Web driver and session of the scenario runner (Playwright). Detailed design: desktop-scenario.md#構造, scenario.md#要素の解決.
import type { Locator, Page, Request } from '@playwright/test';
import type { HookHostContext, ScreenshotOptions, TableDump } from './evidence-host.ts';
import type { PlatformMap, ScreenMap } from './map.ts';
import type { Platform } from './platform.ts';
import { resolveLocator, type LocatorKind, type LocatorTarget } from './resolve.ts';
import type { Capture, ScenarioSession } from './run-scenario.ts';
import { DEFAULT_STEP_TIMEOUT_MS, StepError, type Driver } from './step.ts';
import { clipBody, type ApiCall, type TapResult, type TraceTarget } from './trace-format.ts';
import type { FieldKind, Scenario } from './types.ts';

export type StepHook = (page: Page) => Promise<void> | void;

export interface SeedContext {
  page: Page;
  scenario: Scenario;
  /** Mock folder name. */
  mock: string;
  baseURL: string;
}

/** Optional `e2e/ddv-hooks.ts` of the user repository. */
export interface ScenarioHooks {
  seed?: (fixtures: string[], ctx: SeedContext) => Promise<void> | void;
  steps?: Record<string, StepHook>;
}

export type ScenarioTarget =
  | { kind: 'mock'; url: string; mock?: string; hooks?: ScenarioHooks }
  | { kind: 'app'; url: string; mock?: string; /** `_map.yaml` (its web section is used) or the web section itself. */ map: ScreenMap | PlatformMap; hooks?: ScenarioHooks };

/** Web section of a map given as a `ScreenMap` or already as a `PlatformMap`. */
export function webMapOf(map: ScreenMap | PlatformMap | undefined): PlatformMap | undefined {
  if (!map) return undefined;
  return 'of' in map ? map.web : map;
}

/** `Driver` over a Playwright page (detailed design: 要素の解決). */
export class PlaywrightDriver implements Driver {
  constructor(
    readonly page: Page,
    readonly target: LocatorTarget,
    readonly map?: PlatformMap,
    readonly hooks?: ScenarioHooks,
    readonly actionTimeout = DEFAULT_STEP_TIMEOUT_MS,
  ) {}

  private resolve(kind: LocatorKind, key: string, screen?: string) {
    const r = resolveLocator(kind, key, this.target, this.map, screen ? { screen } : {});
    if (!r.ok) throw new StepError('notFound', r.message, { key });
    return r;
  }

  /** First visible match, else first match, else null. */
  private async pick(selector: string, within?: string): Promise<Locator | null> {
    const scope = within ? this.page.locator(within).filter({ visible: true }) : null;
    const all = scope ? scope.locator(selector) : this.page.locator(selector);
    const visible = all.filter({ visible: true });
    if (await visible.count()) return visible.first();
    if (await all.count()) return all.first();
    return null;
  }

  private async field(key: string): Promise<Locator | null> {
    const r = this.resolve('field', key);
    return r.ok && r.selector ? this.pick(r.selector) : null;
  }

  async fieldKind(key: string): Promise<FieldKind | null> {
    const el = await this.field(key);
    if (!el) return null;
    return el.evaluate((n): FieldKind => {
      const tag = n.tagName.toLowerCase();
      if (tag === 'select') return 'select';
      if (tag === 'input') {
        const t = ((n as HTMLInputElement).type || 'text').toLowerCase();
        if (t === 'checkbox' || t === 'radio') return 'checkbox';
        if (t === 'number' || t === 'range') return 'number';
      }
      return 'text';
    });
  }

  async fill(key: string, value: string | boolean): Promise<void> {
    const el = await this.field(key);
    if (!el) throw new StepError('notFound', `入力要素が見つかりません: ${key}`, { key });
    const kind = await this.fieldKind(key);
    const timeout = this.actionTimeout;
    if (kind === 'checkbox') await el.setChecked(value === true, { timeout });
    else if (kind === 'select') await el.selectOption(String(value), { timeout });
    else await el.fill(String(value), { timeout });
  }

  /** The element `click` resolves to (detailed design: Web の補助ステップのクリック), or throws `StepError('notFound')`. */
  async clickTarget(key: string, event?: string): Promise<Locator> {
    if (this.target === 'mock') {
      const screen = await this.screen();
      const r = this.resolve('event', key, screen ?? undefined);
      const el = r.ok && r.selector ? await this.pick(r.selector, r.within) : null;
      if (!el) throw new StepError('notFound', `操作要素が見つかりません: ${key}${screen ? `（画面 ${screen}）` : ''}`, { key, screen });
      return el;
    }
    if (event !== undefined) {
      const r = this.resolve('event', event);
      const el = r.ok && r.selector ? await this.pick(r.selector) : null;
      if (!el) throw new StepError('notFound', `イベント ${event} の操作要素が見つかりません: ${r.ok ? r.selector : ''}`, { key: event });
      return el;
    }
    const r = this.resolve('field', key);
    const el = r.ok && r.selector ? await this.pick(r.selector) : null;
    if (!el) throw new StepError('notFound', `操作要素が見つかりません: ${key}（${r.ok ? r.selector : ''}）`, { key });
    return el;
  }

  async click(key: string, event?: string): Promise<void> {
    const el = await this.clickTarget(key, event);
    await el.click({ timeout: this.actionTimeout });
  }

  async invoke(name: string): Promise<void> {
    const fn = this.hooks?.steps?.[name];
    if (!fn) throw new StepError('unknownOp', `未登録の操作です: ${name}`, { key: name });
    await fn(this.page);
  }

  async screen(): Promise<string | null> {
    if (this.target === 'mock') {
      const shown = this.page.locator('[data-screen]').filter({ visible: true });
      const n = await shown.count();
      return n ? shown.nth(n - 1).getAttribute('data-screen') : null;
    }
    const pathname = (() => {
      try {
        return new URL(this.page.url()).pathname;
      } catch {
        return this.page.url();
      }
    })();
    for (const id of Object.keys(this.map?.screens ?? {})) {
      const r = resolveLocator('screen', id, 'app', this.map);
      if (!r.ok) continue;
      if (r.url !== undefined && !new RegExp(r.url).test(pathname)) continue;
      if (r.selector !== undefined && !(await this.page.locator(r.selector).filter({ visible: true }).count())) continue;
      return id;
    }
    return null;
  }

  async isVisible(key: string): Promise<boolean> {
    const r = this.resolve('field', key);
    return r.ok && r.selector ? (await this.page.locator(r.selector).filter({ visible: true }).count()) > 0 : false;
  }

  async text(key: string): Promise<string | null> {
    const el = await this.field(key);
    if (!el) return null;
    return el.evaluate((n) => {
      if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement || n instanceof HTMLSelectElement) return n.value;
      return (n as HTMLElement).innerText ?? n.textContent ?? '';
    });
  }

  /** List size: `[data-item]` children of the matched container (mock binder convention); in app mode without such children, the number of visible matches. */
  async count(key: string): Promise<number> {
    const r = this.resolve('field', key);
    if (!r.ok || !r.selector) return 0;
    const matches = this.page.locator(r.selector).filter({ visible: true });
    const n = await matches.count();
    const el = n ? matches.first() : await this.pick(r.selector);
    const items = el ? await el.evaluate((node) => Array.from(node.children).filter((c) => c.hasAttribute('data-item')).length) : 0;
    if (this.target === 'mock' || items > 0 || n === 0) return items;
    return n;
  }

  /** Selector of an element key for input / expect / evidence (mock: inside the shown screen). */
  async elementLocator(key: string): Promise<{ locator: Locator; selector: string }> {
    if (this.target === 'mock') {
      const screen = await this.screen();
      const r = this.resolve('event', key, screen ?? undefined);
      const selector = r.ok && r.selector ? r.selector : '';
      const scope = r.ok && r.within ? this.page.locator(r.within).filter({ visible: true }).locator(selector) : this.page.locator(selector);
      return { locator: scope, selector };
    }
    const r = this.resolve('field', key);
    const selector = r.ok && r.selector ? r.selector : '';
    return { locator: this.page.locator(selector), selector };
  }
}

interface DdvWindow {
  __ddv?: {
    ready: Promise<void>;
    reset(fixtures: string[], start?: string): Promise<{ screen: string }>;
    trace?: { begin(): void; take(): TapResult | null };
    dump?(): TableDump[];
  };
}

/** Starts recording the mock runtime's API calls and DB (window.__ddv.trace). */
async function captureMock(page: Page): Promise<Capture> {
  const ok = await page.evaluate(() => {
    const t = (window as unknown as DdvWindow).__ddv?.trace;
    if (!t) return false;
    t.begin();
    return true;
  });
  if (!ok) throw new Error('この runtime は記録に対応していません（ddv mock init で更新してください）');
  return {
    async take() {
      const r = await page.evaluate(() => (window as unknown as DdvWindow).__ddv?.trace?.take() ?? null);
      return r ?? { calls: [], db: [] };
    },
  };
}

/** Real-app network capture: fetch / xhr requests started during the step (detailed design: 実アプリの通信の記録). */
function captureApp(page: Page, baseURL: string): Capture {
  let origin = '';
  try {
    origin = new URL(baseURL).origin;
  } catch {
    /* keep empty */
  }
  const pathOf = (url: string) => {
    try {
      const u = new URL(url);
      return u.origin === origin ? u.pathname + u.search : url;
    } catch {
      return url;
    }
  };
  type Entry = { call: ApiCall; start: number; done: boolean };
  const entries = new Map<Request, Entry>();
  const pending: Promise<void>[] = [];
  const onRequest = (req: Request) => {
    const kind = req.resourceType();
    if (kind !== 'fetch' && kind !== 'xhr') return;
    const call: ApiCall = { method: req.method(), path: pathOf(req.url()), status: -1, durationMs: 0 };
    const body = clipBody(req.postData());
    if (body) {
      call.requestBody = body.body;
      if (body.truncated) call.truncated = true;
    }
    entries.set(req, { call, start: Date.now(), done: false });
  };
  const onFinished = (req: Request) => {
    const e = entries.get(req);
    if (!e) return;
    e.done = true;
    e.call.durationMs = Date.now() - e.start;
    pending.push(
      (async () => {
        const res = await req.response().catch(() => null);
        e.call.status = res?.status() ?? 0;
        const text = res ? await res.text().catch(() => undefined) : undefined;
        const body = clipBody(text);
        if (body) {
          e.call.responseBody = body.body;
          if (body.truncated) e.call.truncated = true;
        }
      })(),
    );
  };
  const onFailed = (req: Request) => {
    const e = entries.get(req);
    if (!e) return;
    e.done = true;
    e.call.durationMs = Date.now() - e.start;
    e.call.status = 0;
    e.call.responseBody = req.failure()?.errorText ?? '失敗';
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    async take() {
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      await Promise.all(pending);
      return { calls: [...entries.values()].map((e) => e.call), db: null };
    },
  };
}

async function openTarget(page: Page, scenario: Scenario, target: ScenarioTarget, timeout: number): Promise<void> {
  await page.goto(target.url);
  if (target.kind === 'mock') {
    try {
      await page.waitForFunction(() => !!(window as unknown as DdvWindow).__ddv, undefined, { timeout: Math.max(timeout, 10_000) });
    } catch {
      throw new Error(`モックの runtime（window.__ddv）が読み込まれません: ${target.url}（ddv mock init で _ddv/mock-runtime.js を配置してください）`);
    }
    await page.evaluate(
      async ({ fixtures, start }) => {
        const ddv = (window as unknown as DdvWindow).__ddv!;
        await ddv.ready;
        await ddv.reset(fixtures, start);
      },
      { fixtures: scenario.fixtures ?? [], start: scenario.start },
    );
  } else if (target.hooks?.seed) {
    await target.hooks.seed(scenario.fixtures ?? [], { page, scenario, mock: target.mock ?? '', baseURL: target.url });
  }
}

export interface PlaywrightSessionOptions {
  /** Expect retry / action timeout (ms). Default 5000. */
  timeout?: number;
}

/** `ScenarioSession` of the web (mock or real app) over a Playwright page. */
export class PlaywrightSession implements ScenarioSession {
  readonly platform: Platform = 'web';
  readonly target: TraceTarget;
  readonly driver: PlaywrightDriver;
  private readonly timeout: number;

  constructor(
    readonly page: Page,
    readonly scenarioTarget: ScenarioTarget,
    opts: PlaywrightSessionOptions = {},
  ) {
    this.timeout = opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
    this.target = scenarioTarget.kind;
    this.driver = new PlaywrightDriver(page, scenarioTarget.kind, scenarioTarget.kind === 'app' ? webMapOf(scenarioTarget.map) : undefined, scenarioTarget.hooks, this.timeout);
  }

  /** Whether hooks register the custom `do` operation. */
  hasOp(name: string): boolean {
    return !!this.scenarioTarget.hooks?.steps?.[name];
  }

  /** mock: `window.__ddv.reset`; app: hooks' `seed`. */
  open(scenario: Scenario): Promise<void> {
    return openTarget(this.page, scenario, this.scenarioTarget, this.timeout);
  }

  async capture(): Promise<Capture> {
    return this.scenarioTarget.kind === 'mock' ? captureMock(this.page) : captureApp(this.page, this.scenarioTarget.url);
  }

  async screenshot(path: string, opts: ScreenshotOptions = {}): Promise<void> {
    await this.page.screenshot({ path, ...(opts.fullPage ? { fullPage: true } : {}) });
  }

  /** Same resolution as input / expect (mock: `[data-testid=key]` in the shown screen; app: `map.fields`, else `[data-testid=key]`). */
  async screenshotElement(key: string, path: string): Promise<void> {
    const { locator, selector } = await this.driver.elementLocator(key);
    const el = locator.first();
    if (!(await locator.count())) throw new Error(`要素 ${key} が見つかりません（探した名前: ${selector}、web）`);
    if (!(await el.isVisible())) throw new Error(`要素 ${key} が画面外です（探した名前: ${selector}、web）`);
    await el.screenshot({ path, timeout: this.timeout });
  }

  /** The mock's pseudo DB (`window.__ddv.dump()`); null for a real app. */
  async mockTables(): Promise<TableDump[] | null> {
    if (this.scenarioTarget.kind !== 'mock') return null;
    const r = await this.page.evaluate(() => {
      const d = (window as unknown as DdvWindow).__ddv;
      return typeof d?.dump === 'function' ? d.dump() : null;
    });
    if (!r) throw new Error('この runtime は疑似 DB の取り出しに対応していません（ddv mock init で更新してください）');
    return r;
  }

  hookContext(): HookHostContext {
    return { page: this.page };
  }

  /** Nothing to do: Playwright closes the page. */
  async close(): Promise<void> {}
}
