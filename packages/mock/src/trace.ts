// Trace recorder for scenario E2E (Node). Browser-safe format helpers live in trace-format.ts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expandOnly, type Platform } from './platform.ts';
import type { Step } from './types.ts';
import { TRACE_DIR_ENV, TRACE_VERSION, traceKey, type ApiCall, type DbChange, type ExpectObservation, type TraceFile, type TraceStep, type TraceTarget } from './trace-format.ts';

export * from './trace-format.ts';

export interface TraceMeta {
  runId: string;
  testId: string;
  title: string;
  mock: string;
  target: TraceTarget;
  /** Absent = web. */
  platform?: Platform;
}

/** What `runScenario` observed for one step. */
export interface StepTrace {
  screenAfter: string | null;
  expects: ExpectObservation[];
  ok: boolean;
  error?: string;
  durationMs: number;
  calls: ApiCall[];
  db: DbChange[] | null;
  screenshot?: string;
}

export const ORDER_ERROR = 'トレースの記録の順序が不正です';

/** Absolute trace directory from `DDV_TRACE_DIR`, or null when unset / empty. */
export function traceDirOf(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[TRACE_DIR_ENV]?.trim();
  return v ? path.resolve(v) : null;
}

type State = 'idle' | 'inStep' | 'written';

/** Collects one test's steps and writes `<dir>/<result key>.json` (detailed design: 記録の流れ; platform-results.md「トレース」). */
export class TraceRecorder {
  private state: State = 'idle';
  private readonly file: TraceFile;
  private readonly started = Date.now();
  private current: Omit<TraceStep, keyof StepTrace> | null = null;

  constructor(
    readonly dir: string,
    meta: TraceMeta,
  ) {
    const { platform, ...rest } = meta;
    this.file = { version: TRACE_VERSION, ...rest, ...(platform && platform !== 'web' ? { platform } : {}), startedAt: new Date(this.started).toISOString(), durationMs: 0, status: 'passed', steps: [] };
  }

  /** The result key (file name of the trace and of its screenshot directory). */
  get key(): string {
    return traceKey(this.file.testId, this.file.platform);
  }

  get trace(): Readonly<TraceFile> {
    return this.file;
  }

  /** Screenshot of step `index`: path relative to the trace directory and the absolute file path. */
  screenshotOf(index: number): { rel: string; abs: string } {
    const rel = `${this.key}/${index}.png`;
    return { rel, abs: path.join(this.dir, this.key, `${index}.png`) };
  }

  private head(index: number, step: Step, screenBefore: string | null): Omit<TraceStep, keyof StepTrace> {
    return {
      index,
      event: step.event ?? '',
      ...(step.only !== undefined ? { only: expandOnly(step.only) } : {}),
      ...(step.input !== undefined ? { input: step.input } : {}),
      ...(step.click !== undefined ? { click: step.click } : {}),
      ...(step.do !== undefined ? { do: step.do } : {}),
      screenBefore,
    };
  }

  /** Step not run on this platform (`only:`): recorded as passed without expects; the trace status is unaffected. */
  skipStep(index: number, step: Step, screen: string | null): void {
    if (this.state !== 'idle') throw new Error(ORDER_ERROR);
    this.file.steps.push({ ...this.head(index, step, screen), skipped: true, screenAfter: screen, expects: [], ok: true, durationMs: 0, calls: [], db: null });
  }

  beginStep(index: number, step: Step, screenBefore: string | null): void {
    if (this.state !== 'idle') throw new Error(ORDER_ERROR);
    this.state = 'inStep';
    this.current = this.head(index, step, screenBefore);
  }

  /** Ends the step; a failed step finishes the trace (written immediately). */
  async endStep(result: StepTrace): Promise<void> {
    if (this.state !== 'inStep' || !this.current) throw new Error(ORDER_ERROR);
    const s: TraceStep = { ...this.current, ...result };
    if (s.error === undefined) delete s.error;
    if (s.screenshot === undefined) delete s.screenshot;
    this.file.steps.push(s);
    this.current = null;
    if (result.ok) {
      this.state = 'idle';
      return;
    }
    this.file.status = 'failed';
    this.file.failedStep = s.index;
    if (result.error !== undefined) this.file.error = result.error;
    await this.flush();
  }

  /** Failure before the steps (page open / fixtures): `failedStep: 0`, no steps. */
  async fail(message: string): Promise<void> {
    if (this.state !== 'idle') throw new Error(ORDER_ERROR);
    this.file.status = 'failed';
    this.file.failedStep = 0;
    this.file.error = message;
    this.file.steps = [];
    await this.flush();
  }

  async write(): Promise<void> {
    if (this.state !== 'idle') throw new Error(ORDER_ERROR);
    await this.flush();
  }

  private async flush(): Promise<void> {
    this.state = 'written';
    this.file.durationMs = Date.now() - this.started;
    await fs.mkdir(this.dir, { recursive: true });
    const out = path.join(this.dir, `${this.key}.json`);
    const tmp = `${out}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.file, null, 2) + '\n');
    await fs.rename(tmp, out);
  }
}

/** `TraceRecorder` for one test; the ID comes from the `[ID]` of the test title (undefined without it). The file is named by the result key of `platform`. */
export function recorderFor(dir: string, title: string, mock: string, target: TraceTarget, platform?: Platform): TraceRecorder | undefined {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(title);
  if (!m) return undefined;
  return new TraceRecorder(dir, { runId: path.basename(dir), testId: m[1], title: m[2], mock, target, ...(platform ? { platform } : {}) });
}
