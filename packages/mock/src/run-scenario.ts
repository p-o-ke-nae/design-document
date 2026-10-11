import type { Locator, Page } from '@playwright/test';
import type { ScreenMap } from './map.ts';
import { resolveLocator, type LocatorKind, type LocatorTarget } from './resolve.ts';
import { DEFAULT_STEP_TIMEOUT_MS, executeStep, StepError, type Driver } from './step.ts';
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
  | { kind: 'app'; url: string; mock?: string; map: ScreenMap; hooks?: ScenarioHooks };

export interface RunScenarioOptions {
  /** Called after each step's expect succeeded (0-based index). */
  onStep?: (index: number) => Promise<void> | void;
  /** Expect retry timeout per step (ms). */
  timeout?: number;
}

/** `Driver` over a Playwright page (detailed design: 要素の解決). */
export class PlaywrightDriver implements Driver {
  constructor(
    readonly page: Page,
    readonly target: LocatorTarget,
    readonly map?: ScreenMap,
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

  async click(key: string, event: string): Promise<void> {
    let el: Locator | null;
    if (this.target === 'mock') {
      const screen = await this.screen();
      const r = this.resolve('event', key, screen ?? undefined);
      el = r.ok && r.selector ? await this.pick(r.selector, r.within) : null;
      if (!el) throw new StepError('notFound', `操作要素が見つかりません: ${key}${screen ? `（画面 ${screen}）` : ''}`, { key, screen });
    } else {
      const r = this.resolve('event', event);
      el = r.ok && r.selector ? await this.pick(r.selector) : null;
      if (!el) throw new StepError('notFound', `イベント ${event} の操作要素が見つかりません: ${r.ok ? r.selector : ''}`, { key: event });
    }
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
}

interface DdvWindow {
  __ddv?: { ready: Promise<void>; reset(fixtures: string[], start?: string): Promise<{ screen: string }> };
}

/** Opens the target, loads fixtures and executes all steps (throws `StepError` with the step number on failure). */
export async function runScenario(page: Page, scenario: Scenario, target: ScenarioTarget, opts: RunScenarioOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
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
  const driver = new PlaywrightDriver(page, target.kind, target.kind === 'app' ? target.map : undefined, target.hooks, timeout);
  const hasOp = (name: string) => !!target.hooks?.steps?.[name];
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    try {
      await executeStep(driver, step, { timeoutMs: timeout, hasOp });
    } catch (e) {
      const msg = `ステップ ${i + 1}（${step.event}）: ${e instanceof Error ? e.message : String(e)}`;
      if (e instanceof StepError) throw new StepError(e.kind, msg, { key: e.key, failures: e.failures, screen: e.screen });
      throw new Error(msg, { cause: e });
    }
    await opts.onStep?.(i);
  }
}
