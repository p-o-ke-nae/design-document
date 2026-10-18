// `ScenarioSession` of a WPF / WinForms app (flaui-driver.md「デスクトップの実行」).
import path from 'node:path';
import type { Capture, DesktopApp, HookHostContext, PlatformMap, Scenario, ScenarioSession, ScreenshotOptions, TableDump } from '@ddv/mock';
import { DriverError } from './client.ts';
import { FlaUiDriver, type DesktopStep, type DriverRequester } from './flaui-driver.ts';

export type DesktopPlatform = 'wpf' | 'winforms';

export interface DesktopSeedContext {
  platform: DesktopPlatform;
  /** JSON written by `FixturesWriter` (also passed to the app as `DDV_FIXTURES`). */
  fixturesFile: string;
  scenario: Scenario;
}

/** Desktop part of `e2e/ddv-hooks.ts`. */
export interface DesktopHooks {
  desktopSeed?: (fixtures: string[], ctx: DesktopSeedContext) => Promise<void> | void;
  desktopSteps?: Record<string, DesktopStep>;
}

export interface DesktopAppConfig {
  /** Absolute path of the executable. */
  path: string;
  args?: string[];
  cwd?: string;
}

export interface FlaUiSessionOptions {
  runner: string;
  platform: DesktopPlatform;
  app: DesktopAppConfig;
  automation?: 'uia3' | 'uia2';
  /** ms (step expects and `find`). */
  timeout: number;
  map?: PlatformMap;
  hooks?: DesktopHooks;
  fixturesFile: string;
  /** Extra environment of the app. */
  env?: Record<string, string>;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const CLOSE_TIMEOUT_MS = 5000;

export class FlaUiSession implements ScenarioSession {
  readonly target = 'app' as const;
  readonly driver: FlaUiDriver;
  private opened = false;

  constructor(
    private readonly client: DriverRequester,
    readonly opts: FlaUiSessionOptions,
  ) {
    this.driver = new FlaUiDriver(client, { platform: opts.platform, map: opts.map, timeout: opts.timeout, steps: opts.hooks?.desktopSteps, pollMs: opts.pollMs });
  }

  get platform(): DesktopPlatform {
    return this.opts.platform;
  }

  hasOp(name: string): boolean {
    return this.driver.hasOp(name);
  }

  async open(scenario: Scenario): Promise<void> {
    this.driver.useScenario(scenario);
    await this.opts.hooks?.desktopSeed?.(scenario.fixtures ?? [], { platform: this.platform, fixturesFile: this.opts.fixturesFile, scenario });
    const app = this.opts.app;
    this.opened = true;
    await this.client.request('launch', {
      path: app.path,
      args: app.args ?? [],
      cwd: app.cwd ?? path.dirname(app.path),
      env: { ...this.opts.env, DDV_SCENARIO: scenario.id, DDV_FIXTURES: this.opts.fixturesFile, DDV_PLATFORM: this.platform },
      automation: this.opts.automation ?? 'uia3',
      timeoutMs: Math.max(this.opts.timeout, 10_000),
    });
    const deadline = Date.now() + this.opts.timeout;
    let now: string | null = null;
    for (;;) {
      now = await this.driver.screen();
      if (now === scenario.start) {
        this.driver.useScenario(scenario);
        return;
      }
      if (Date.now() >= deadline) break;
      await sleep(this.opts.pollMs ?? 100);
    }
    throw new Error(`開始の画面 ${scenario.start} になりません（今：${now ?? '不明'}）`);
  }

  /** The desktop has no API / DB recording. */
  async capture(): Promise<Capture> {
    return { take: async () => ({ calls: [], db: null }) };
  }

  async screenshot(file: string, opts?: ScreenshotOptions): Promise<void> {
    if (opts?.fullPage) throw new Error(`fullPage はデスクトップでは使えません（${this.platform}）`);
    await this.client.request('screenshot', { path: file });
  }

  async screenshotElement(key: string, file: string): Promise<void> {
    const n = this.driver.name('field', key);
    try {
      await this.client.request('screenshot', { path: file, by: n.by, name: n.name });
    } catch (e) {
      if (e instanceof DriverError && (e.code === 'notFound' || e.code === 'offscreen')) {
        throw new Error(`要素 ${key} が${e.code === 'notFound' ? '見つかりません' : '画面外です'}（探した名前: ${n.name}、${this.platform}）`);
      }
      throw e;
    }
  }

  async mockTables(): Promise<TableDump[] | null> {
    return null;
  }

  hookContext(): HookHostContext {
    const app: DesktopApp = {
      find: async (key) => {
        const r = await this.driver.find(this.driver.name('field', key));
        return { found: r.found, visible: r.visible };
      },
      screenshot: (file, key) => (key === undefined ? this.screenshot(file) : this.screenshotElement(key, file)),
    };
    return { app };
  }

  /** Closes the app (killed after 5 s). Safe to call more than once. */
  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    await this.client.request('close', { timeoutMs: CLOSE_TIMEOUT_MS }, CLOSE_TIMEOUT_MS + 5000);
  }
}
