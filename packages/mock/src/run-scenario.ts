// Driver-independent scenario runner (detailed design: desktop-scenario.md#実行器) and the Playwright compat entry.
import type { Page } from '@playwright/test';
import type { AtResult, EvidenceHost, EvidenceInputScope, StepEvidenceRunner } from './evidence-host.ts';
import { planSteps, type Platform, type StepPlan } from './platform.ts';
import { PlaywrightSession, type ScenarioTarget } from './playwright-driver.ts';
import { validateScenario } from './scenario.ts';
import { DEFAULT_STEP_TIMEOUT_MS, executeStep, observeExpect, StepError, type Driver } from './step.ts';
import type { ApiCall, DbChange, TraceEvidence, TraceTarget } from './trace-format.ts';
import type { TraceRecorder } from './trace.ts';
import type { Scenario, Step } from './types.ts';

export { PlaywrightDriver, PlaywrightSession, webMapOf } from './playwright-driver.ts';
export type { PlaywrightSessionOptions, ScenarioHooks, ScenarioTarget, SeedContext, StepHook } from './playwright-driver.ts';

/** API calls / DB changes recorded during one step. */
export interface Capture {
  take(): Promise<{ calls: ApiCall[]; db: DbChange[] | null }>;
}

/** One opened target (web page or desktop app) the runner drives (detailed design: 構造). */
export interface ScenarioSession extends EvidenceHost {
  readonly platform: Platform;
  readonly target: TraceTarget;
  readonly driver: Driver;
  /** Opens the target and loads the scenario's fixtures. */
  open(scenario: Scenario): Promise<void>;
  /** Starts recording one step's API calls and DB changes. */
  capture(): Promise<Capture>;
  close(): Promise<void>;
}

export interface RunScenarioOptions {
  /** Called after each executed step succeeded (0-based index in the file; skipped steps are not reported). */
  onStep?: (index: number) => Promise<void> | void;
  /** Expect retry timeout per step (ms). */
  timeout?: number;
  /** Records every step (including the failing one and skipped ones) into a trace file. */
  trace?: TraceRecorder;
  /** Whether a custom `do` operation is registered. */
  hasOp?: (name: string) => boolean;
  /** Captures the steps' evidence (evidence-runner.md#時点ごとの取得). */
  evidence?: StepEvidenceRunner;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Current screen, or null when it cannot be determined. */
const screenOf = (d: Driver) => Promise.resolve().then(() => d.screen()).catch(() => null);
const warnTrace = (what: string, e: unknown) => console.warn(`トレースの記録に失敗しました（${what}）: ${errText(e)}`);

/** 「ステップ 3（次へ）」 or 「ステップ 4（補助・closeDialog）」 (1-based file number). */
export function stepLabel(step: Step, index: number): string {
  if (step.event !== undefined) return `ステップ ${index + 1}（${step.event}）`;
  const name = step.click ?? step.do;
  return `ステップ ${index + 1}（補助${name !== undefined ? `・${name}` : ''}）`;
}

/**
 * Runs a scenario on an opened session: validates, plans for `session.platform`, executes the steps that apply and
 * records skipped ones (throws `StepError` with the step number on failure).
 */
export async function runScenarioWith(session: ScenarioSession, scenario: Scenario, opts: RunScenarioOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
  const rec = opts.trace;
  const issues = validateScenario(scenario);
  if (issues.length) {
    const msg = issues.map((i) => i.message).join('\n');
    if (rec) await rec.fail(msg).catch((w) => warnTrace('書き込み', w));
    throw new Error(msg);
  }
  const plans = planSteps(scenario, session.platform);
  try {
    await session.open(scenario);
  } catch (e) {
    if (rec) await rec.fail(errText(e)).catch((w) => warnTrace('書き込み', w));
    throw e;
  }
  const driver = session.driver;
  const hasOp = opts.hasOp ?? (() => false);
  const ev = opts.evidence;
  const scope = ev ? ev.scopeOf(scenario, plans) : null;
  let startWarned = false;
  for (const plan of plans) {
    const { step, index: i } = plan;
    if (!plan.run) {
      if (rec) {
        try {
          rec.skipStep(i + 1, step, await screenOf(driver), ev && step.evidence?.length ? ev.skip(plan) : undefined);
        } catch (e) {
          warnTrace('ステップ', e);
        }
      }
      continue;
    }
    const planned: Step = { ...step, expect: plan.expect };
    let capture: Capture | null = null;
    if (rec) {
      try {
        rec.beginStep(i + 1, step, await screenOf(driver));
        capture = await session.capture();
      } catch (e) {
        if (!startWarned) warnTrace('開始', e);
        startWarned = true;
      }
    }
    const t0 = Date.now();
    const withEvidence = ev && scope && step.evidence?.length ? { ev, scope } : null;
    const before = withEvidence ? await runAtSafe(withEvidence.ev, 'before', plan, session, withEvidence.scope) : null;
    let failure: Error | null = null;
    try {
      await executeStep(driver, planned, { timeoutMs: timeout, hasOp });
    } catch (e) {
      const msg = `${stepLabel(step, i)}: ${errText(e)}`;
      failure = e instanceof StepError ? new StepError(e.kind, msg, { key: e.key, failures: e.failures, screen: e.screen }) : new Error(msg, { cause: e });
    }
    const after = withEvidence ? await runAtSafe(withEvidence.ev, 'after', plan, session, withEvidence.scope) : null;
    const records = [...(before?.records ?? []), ...(after?.records ?? [])];
    failure = stepResult(step, i, failure, [...(before?.failures ?? []), ...(after?.failures ?? [])]);
    if (rec) await recordStep(rec, session, plan, i + 1, Date.now() - t0, failure, capture, records);
    if (failure) {
      await session.close().catch(() => undefined);
      throw failure;
    }
    await opts.onStep?.(i);
  }
  await session.close();
  if (rec) await rec.write().catch((w) => warnTrace('書き込み', w));
}

/** `runAt` never fails the run by throwing: an unexpected error becomes one failure without records. */
async function runAtSafe(ev: StepEvidenceRunner, at: 'before' | 'after', plan: StepPlan<Step>, host: EvidenceHost, scope: EvidenceInputScope): Promise<AtResult> {
  try {
    return await ev.runAt(at, plan, host, scope);
  } catch (e) {
    return { records: [], failures: [errText(e)], warnings: 0 };
  }
}

/** Step result from the operation / expectation and the evidence failures (evidence-runner.md#ステップの結果). */
export function stepResult(step: Step, index: number, failure: Error | null, evidenceFailures: string[]): Error | null {
  if (!evidenceFailures.length) return failure;
  const list = evidenceFailures.join('、');
  if (failure) {
    const msg = `${failure.message}\n証跡も失敗：${list}`;
    return failure instanceof StepError ? new StepError(failure.kind, msg, { key: failure.key, failures: failure.failures, screen: failure.screen }) : new Error(msg, { cause: failure.cause });
  }
  return new StepError('evidence', `${stepLabel(step, index)}: 証跡の取得に失敗しました：${list}`);
}

async function recordStep(rec: TraceRecorder, session: ScenarioSession, plan: StepPlan<Step>, index: number, durationMs: number, failure: Error | null, capture: Capture | null, evidence: TraceEvidence[] = []) {
  const driver = session.driver;
  try {
    const expects = await observeExpect(driver, plan.expect);
    const screenAfter = await screenOf(driver);
    let taken: { calls: ApiCall[]; db: DbChange[] | null } = { calls: [], db: session.target === 'mock' ? [] : null };
    if (capture) {
      try {
        taken = await capture.take();
      } catch (e) {
        warnTrace('通信・DB', e);
      }
    }
    let screenshot: string | undefined;
    const shot = rec.screenshotOf(index);
    try {
      await session.screenshot(shot.abs);
      screenshot = shot.rel;
    } catch (e) {
      warnTrace('スクリーンショット', e);
    }
    await rec.endStep({ screenAfter, expects, ok: !failure, ...(failure ? { error: failure.message } : {}), durationMs, calls: taken.calls, db: taken.db, ...(screenshot ? { screenshot } : {}), ...(evidence.length ? { evidence } : {}) });
  } catch (e) {
    warnTrace('ステップ', e);
  }
}

/** Opens the target, loads fixtures and executes all steps on the web (compat entry of `runScenarioWith`). */
export async function runScenario(page: Page, scenario: Scenario, target: ScenarioTarget, opts: RunScenarioOptions = {}): Promise<void> {
  const session = new PlaywrightSession(page, target, { timeout: opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS });
  await runScenarioWith(session, scenario, { ...opts, hasOp: opts.hasOp ?? ((name) => session.hasOp(name)) });
}
