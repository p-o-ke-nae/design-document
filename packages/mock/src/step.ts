// Browser-safe step interpreter shared by the player (DomDriver) and E2E (PlaywrightDriver). No Node imports.
import type { Expect, FieldKind, Step, Value } from './types.ts';
import type { ExpectObservation } from './trace-format.ts';

export type { Expect, FieldKind, PathSpec, PathTransition, Scenario, Step, Value } from './types.ts';
export type { ExpectObservation } from './trace-format.ts';
export { resolveLocator, attrSelector } from './resolve.ts';
export type { LocatorKind, LocatorTarget, ResolvedLocator } from './resolve.ts';

type Awaitable<T> = T | Promise<T>;

export interface Driver {
  /** Kind of the input element, or null when it does not exist. */
  fieldKind(key: string): Awaitable<FieldKind | null>;
  fill(key: string, value: string | boolean): Awaitable<void>;
  /** Clicks the element. Throws `StepError('notFound')` when it does not exist. `event` excludes the guard. */
  click(key: string, event?: string): Awaitable<void>;
  invoke(name: string): Awaitable<void>;
  screen(): Awaitable<string | null>;
  isVisible(key: string): Awaitable<boolean>;
  text(key: string): Awaitable<string | null>;
  count(key: string): Awaitable<number>;
}

export interface ExpectFailure {
  /** `screen`, `visible:<key>`, `hidden:<key>`, `text:<key>`, `count:<key>` */
  key: string;
  expected: Value | null;
  actual: Value | null;
}

export type StepErrorKind = 'notFound' | 'unknownOp' | 'expect' | 'evidence';

export class StepError extends Error {
  readonly kind: StepErrorKind;
  readonly key?: string;
  readonly failures: ExpectFailure[];
  readonly screen?: string | null;
  constructor(kind: StepErrorKind, message: string, extra: { key?: string; failures?: ExpectFailure[]; screen?: string | null } = {}) {
    super(message);
    this.name = 'StepError';
    this.kind = kind;
    this.key = extra.key;
    this.failures = extra.failures ?? [];
    this.screen = extra.screen;
  }
}

export interface StepResult {
  ok: boolean;
  screen: string | null;
  failures: ExpectFailure[];
  error?: { kind: StepErrorKind | 'error'; message: string; key?: string };
}

export interface StepOptions {
  /** Retry `expect` until this many ms (0 = check once). Default 5000. */
  timeoutMs?: number;
  retryIntervalMs?: number;
  /** Whether a custom `do` operation is registered. Default: none registered. */
  hasOp?: (name: string) => boolean;
}

export const DEFAULT_STEP_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Event name without guard / action. */
export function eventOf(label: string): string {
  return ws(label.replace(/\[[^\]]*\]/g, '').replace(/\/.*$/, ''));
}

function fillValue(kind: FieldKind, value: Value): string | boolean {
  if (kind === 'checkbox') return typeof value === 'boolean' ? value : /^(true|1|on|yes)$/i.test(String(value).trim());
  return String(value);
}

export async function checkExpect(driver: Driver, expect: Expect = {}): Promise<{ screen: string | null; failures: ExpectFailure[] }> {
  const failures: ExpectFailure[] = [];
  const screen = await driver.screen();
  if (expect.screen !== undefined && screen !== expect.screen) failures.push({ key: 'screen', expected: expect.screen, actual: screen });
  for (const k of expect.visible ?? []) if (!(await driver.isVisible(k))) failures.push({ key: `visible:${k}`, expected: true, actual: false });
  for (const k of expect.hidden ?? []) if (await driver.isVisible(k)) failures.push({ key: `hidden:${k}`, expected: false, actual: true });
  for (const [k, v] of Object.entries(expect.text ?? {})) {
    const t = await driver.text(k);
    if (t === null || ws(t) !== ws(v)) failures.push({ key: `text:${k}`, expected: v, actual: t });
  }
  for (const [k, v] of Object.entries(expect.count ?? {})) {
    const n = await driver.count(k);
    if (n !== v) failures.push({ key: `count:${k}`, expected: v, actual: n });
  }
  return { screen, failures };
}

/** Evaluates every `expect` item once (no retry) for the trace. Items whose element cannot be resolved get `actual: null`. */
export async function observeExpect(driver: Driver, expect: Expect = {}): Promise<ExpectObservation[]> {
  const out: ExpectObservation[] = [];
  const safe = async <T>(f: () => Awaitable<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  const screen = await safe(() => driver.screen());
  if (expect.screen !== undefined) out.push({ kind: 'screen', key: '', expected: expect.screen, actual: screen, ok: screen === expect.screen });
  for (const k of expect.visible ?? []) {
    const v = await safe(() => driver.isVisible(k));
    out.push({ kind: 'visible', key: k, expected: true, actual: v, ok: v === true });
  }
  for (const k of expect.hidden ?? []) {
    const v = await safe(() => driver.isVisible(k));
    out.push({ kind: 'hidden', key: k, expected: false, actual: v, ok: v === false });
  }
  for (const [k, v] of Object.entries(expect.text ?? {})) {
    const t = await safe(() => driver.text(k));
    out.push({ kind: 'text', key: k, expected: v, actual: t, ok: t !== null && ws(t) === ws(v) });
  }
  for (const [k, v] of Object.entries(expect.count ?? {})) {
    const n = await safe(() => driver.count(k));
    out.push({ kind: 'count', key: k, expected: v, actual: n, ok: n === v });
  }
  return out;
}

/** Executes one step (input → do → click → wait → expect). Throws `StepError` on failure. */
export async function executeStep(driver: Driver, step: Step, opts: StepOptions = {}): Promise<StepResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const interval = opts.retryIntervalMs ?? 100;

  const entries = Object.entries(step.input ?? {});
  const kinds: FieldKind[] = [];
  for (const [k] of entries) {
    const kind = await driver.fieldKind(k);
    if (!kind) throw new StepError('notFound', `入力要素が見つかりません: ${k}`, { key: k });
    kinds.push(kind);
  }
  for (let i = 0; i < entries.length; i++) await driver.fill(entries[i][0], fillValue(kinds[i], entries[i][1]));

  if (step.do !== undefined) {
    if (!opts.hasOp?.(step.do)) throw new StepError('unknownOp', `未登録の操作です: ${step.do}`, { key: step.do });
    await driver.invoke(step.do);
  }
  if (step.click !== undefined) await driver.click(step.click, step.event !== undefined ? eventOf(step.event) : undefined);
  if (step.wait) await sleep(step.wait);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await checkExpect(driver, step.expect);
    if (!r.failures.length) return { ok: true, screen: r.screen, failures: [] };
    if (Date.now() >= deadline) {
      throw new StepError('expect', `期待値と一致しません: ${r.failures.map((f) => `${f.key}（期待: ${JSON.stringify(f.expected)}、実際: ${JSON.stringify(f.actual)}）`).join(', ')}`, {
        failures: r.failures,
        screen: r.screen,
      });
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

/** Like `executeStep` but returns failures as a `StepResult` instead of throwing. */
export async function runStep(driver: Driver, step: Step, opts: StepOptions = {}): Promise<StepResult> {
  try {
    return await executeStep(driver, step, opts);
  } catch (e) {
    let screen: string | null = null;
    try {
      screen = await driver.screen();
    } catch {
      /* ignore */
    }
    if (e instanceof StepError) return { ok: false, screen: e.screen ?? screen, failures: e.failures, error: { kind: e.kind, message: e.message, ...(e.key !== undefined ? { key: e.key } : {}) } };
    return { ok: false, screen, failures: [], error: { kind: 'error', message: e instanceof Error ? e.message : String(e) } };
  }
}
