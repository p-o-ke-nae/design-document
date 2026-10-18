// `Driver` of the scenario runner for WPF / WinForms apps via the FlaUI driver (flaui-driver.md「操作の方法」).
import { StepError, desktopNotFoundMessage, desktopScreenCandidates, resolveDesktopName, type DesktopName, type DesktopNameKind, type Driver, type FieldKind, type PlatformMap, type Scenario } from '@ddv/mock';
import { DriverError } from './client.ts';

/** What `FlaUiDriver` needs from `DriverClient`. */
export interface DriverRequester {
  request<T = unknown>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface FindResult {
  found: boolean;
  visible: boolean;
  controlType: string | null;
  patterns: string[];
}

export type DesktopStep = () => Promise<void> | void;

export type FillMethod = 'toggle' | 'select' | 'setValue';

/** Same rule as the driver's `ElementFinder.FillMethod` (DD-FLAUI-FILL). */
export function fillMethod(patterns: readonly string[]): FillMethod | null {
  if (patterns.includes('Toggle')) return 'toggle';
  if (patterns.includes('Selection') || patterns.includes('ExpandCollapse')) return 'select';
  if (patterns.includes('Value')) return 'setValue';
  return null;
}

const KIND: Record<FillMethod, FieldKind> = { toggle: 'checkbox', select: 'select', setValue: 'text' };

export interface FlaUiDriverOptions {
  platform: 'wpf' | 'winforms';
  map?: PlatformMap;
  /** How long `find` is retried before an element counts as missing (ms). */
  timeout: number;
  steps?: Record<string, DesktopStep>;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FlaUiDriver implements Driver {
  private scenario: Scenario | null = null;
  private previous: string | null = null;

  constructor(
    private readonly client: DriverRequester,
    readonly opts: FlaUiDriverOptions,
  ) {}

  get map(): PlatformMap | undefined {
    return this.opts.map;
  }

  get timeout(): number {
    return this.opts.timeout;
  }

  /** Scenario whose states `screen()` tries. */
  useScenario(scenario: Scenario): void {
    this.scenario = scenario;
    this.previous = null;
  }

  name(kind: DesktopNameKind, key: string, event?: string): DesktopName {
    return resolveDesktopName(kind, key, this.opts.map, event);
  }

  async find(n: DesktopName): Promise<FindResult> {
    return this.client.request<FindResult>('find', { by: n.by, name: n.name });
  }

  /** `find` until found or the timeout. */
  private async waitFound(n: DesktopName): Promise<FindResult> {
    const deadline = Date.now() + this.opts.timeout;
    for (;;) {
      const r = await this.find(n);
      if (r.found || Date.now() >= deadline) return r;
      await sleep(this.opts.pollMs ?? 100);
    }
  }

  private notFound(key: string, n: DesktopName): StepError {
    return new StepError('notFound', desktopNotFoundMessage(key, n, this.opts.platform), { key });
  }

  /** Driver errors with code `notFound` become `StepError('notFound')`. */
  private async send(key: string, n: DesktopName, cmd: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.client.request(cmd, { name: n.name, ...args });
    } catch (e) {
      if (e instanceof DriverError && e.code === 'notFound') throw this.notFound(key, n);
      throw e;
    }
  }

  async fieldKind(key: string): Promise<FieldKind | null> {
    const r = await this.waitFound(this.name('field', key));
    if (!r.found) return null;
    const m = fillMethod(r.patterns);
    return m ? KIND[m] : null;
  }

  async fill(key: string, value: string | boolean): Promise<void> {
    const n = this.name('field', key);
    const r = await this.waitFound(n);
    if (!r.found) throw this.notFound(key, n);
    const m = fillMethod(r.patterns);
    if (m === 'toggle') return this.send(key, n, 'toggle', { on: typeof value === 'boolean' ? value : /^(true|1|on|yes)$/i.test(value.trim()) });
    if (m === 'select') return this.send(key, n, 'select', { text: String(value) });
    if (m === 'setValue') return this.send(key, n, 'setValue', { value: String(value) });
    throw new StepError('notFound', `入力できない要素です: ${key}（${r.controlType ?? '不明'}）`, { key });
  }

  async click(key: string, event?: string): Promise<void> {
    const n = event !== undefined ? this.name('event', key, event) : this.name('field', key);
    const r = await this.waitFound(n);
    if (!r.found) throw this.notFound(key, n);
    await this.send(key, n, 'invoke', {});
  }

  async invoke(name: string): Promise<void> {
    const step = this.opts.steps?.[name];
    if (!step) throw new StepError('unknownOp', `未登録の操作です: ${name}`, { key: name });
    await step();
  }

  hasOp(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.opts.steps ?? {}, name);
  }

  async screen(): Promise<string | null> {
    const ids = this.scenario ? desktopScreenCandidates(this.scenario, this.opts.map, this.previous) : Object.keys(this.opts.map?.screens ?? {});
    for (const id of ids) {
      const r = await this.find(this.name('screen', id));
      if (r.found && r.visible) {
        this.previous = id;
        return id;
      }
    }
    return null;
  }

  async isVisible(key: string): Promise<boolean> {
    const r = await this.find(this.name('field', key));
    return r.found && r.visible;
  }

  async text(key: string): Promise<string | null> {
    try {
      return await this.client.request<string | null>('query', { what: 'text', name: this.name('field', key).name });
    } catch (e) {
      if (e instanceof DriverError && e.code === 'notFound') return null;
      throw e;
    }
  }

  async count(key: string): Promise<number> {
    try {
      return await this.client.request<number>('query', { what: 'count', name: this.name('field', key).name });
    } catch (e) {
      if (e instanceof DriverError && e.code === 'notFound') return 0;
      throw e;
    }
  }
}
