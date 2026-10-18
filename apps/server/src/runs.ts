import { EventEmitter } from 'node:events';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig } from '@ddv/core';
import { safeJoin } from '@ddv/core/node';
import { parseResultKey, resultKey } from '@ddv/services';
import { idPattern, linksScenarios, scanTestLinks, type TestLink } from '@ddv/testid';
import { executeRunner, type CaseResult } from './runner.ts';
import { RepoStateReader } from './repo-state.ts';
import { Pruner, TRACES_DIR, traceDirs, type PrunePlan } from './prune.ts';
import type { StepResultMeta } from './snapshots.ts';

export interface RunRequest {
  ids?: string[];
  runner?: string;
  /** Targets (runner names) to run the scenarios on (platform-results.md「開始の要求」). */
  runners?: string[];
}

export type RunKind = 'test' | 'snapshot' | 'deps';

export interface RunEvent {
  event: string;
  data: string;
}

/** Given to task runs (e.g. snapshots) to report progress through the run's SSE stream. */
export interface TaskHandle {
  runId: string;
  log(line: string): void;
  event(name: string, data: unknown): void;
}

export interface RunRecord {
  id: string;
  /** Absent in older records = test. */
  kind?: RunKind;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  request: RunRequest;
  runners: Array<{ name: string; command: string; exitCode: number | null; error?: string; skipped?: boolean; message?: string }>;
  results: Record<string, CaseResult>;
  log: string[];
  /** Custom SSE events of task runs (replayed to late subscribers). */
  events?: RunEvent[];
  /** HEAD at the start of the run; absent = unknown (not git / git missing). */
  commit?: string;
  /** Uncommitted changes outside `.ddv/` at the start (present together with `commit`). */
  dirty?: boolean;
  /** Re-runs: the run whose failures are re-run (same for every attempt). */
  rerunOf?: string;
  /** Re-runs: 1-based attempt. */
  attempt?: number;
  /** Re-runs: number of attempts requested. */
  times?: number;
  /** Test ids whose trace was written in this run (kept after the traces are pruned). */
  traces?: string[];
  /** Where the run was executed; absent = local (RunManager never writes it). */
  source?: 'local' | 'actions';
  /** Actions: GITHUB_RUN_ID (`id` is `<run id>-<attempt>`). */
  actionsRunId?: string;
  /** Actions: request id given by the viewer. */
  actionsRequest?: string;
  /** Actions: the branch / tag the workflow ran on. */
  ref?: string;
  /** Actions: warnings of the workflow (e.g. the commit differs from the branch head). */
  warnings?: string[];
  /** Actions: scenarios captured in the run. */
  snapshots?: SnapshotOutcome[];
}

export interface SnapshotOutcome {
  id: string;
  status: 'passed' | 'failed' | 'error';
  steps: StepResultMeta[];
}

export interface RerunSession {
  originId: string;
  ids: string[];
  /** `request.runners` of the origin run (re-runs use the same targets). */
  runners?: string[];
  times: number;
  attempt: number;
}

export type RerunErrorCode = 'no-failures' | 'times-invalid';

export class RerunError extends Error {
  constructor(
    readonly code: RerunErrorCode,
    message = code === 'no-failures' ? '直近の実行に失敗したテストはありません' : 'times は 1〜5 の整数です',
  ) {
    super(message);
    this.name = 'RerunError';
  }
}

export const BUSY_MESSAGE = '別のテスト実行が進行中です';

export type ExecuteRunner = typeof executeRunner;

export interface RunManagerOptions {
  repoState?: RepoStateReader;
  /** Replaces the runner process (tests). */
  execute?: ExecuteRunner;
}

export interface RunTestsDeps {
  execute?: ExecuteRunner;
  /** A reason to skip a runner (no results are made for its ids), e.g. flaui outside Windows in `ddv ci run`. */
  skip?: (runner: DdvConfig['runners'][number]) => string | undefined;
}

/** Runners of a request: with `runners`, the non-target runners plus the listed targets (config order); otherwise as before. */
export function runnersOf(config: DdvConfig, request: RunRequest): DdvConfig['runners'] {
  if (request.runners) {
    const chosen = new Set(request.runners);
    return config.runners.filter((r) => !linksScenarios(r) || chosen.has(r.name));
  }
  return config.runners.filter((r) => !request.runner || r.name === request.runner);
}

/** Platform of a runner's results: its `platform`, playwright = web; none for vitest / dotnet / command. */
export function platformOf(r: DdvConfig['runners'][number]): 'web' | 'wpf' | 'winforms' | undefined {
  return r.platform ?? (r.type === 'playwright' ? 'web' : undefined);
}

/** Runs the configured runners for `run.request` and sets `run.runners` / `results` / `status` (the body of a test run, shared with `ddv ci run`). Throws on unexpected failures. */
export async function runTests(repoRoot: string, config: DdvConfig, run: RunRecord, log: (line: string) => void, deps: RunTestsDeps = {}): Promise<void> {
  const execute = deps.execute ?? executeRunner;
  const links: TestLink[] = await scanTestLinks(repoRoot, config);
  const idRe = idPattern(Object.values(config.idPrefix));
  // Requested entries may be result keys (re-runs): `<id>@<platform>` only runs on that platform, a plain id on every runner.
  const requested = run.request.ids?.length ? run.request.ids.map(parseResultKey).map((k, i) => ({ ...k, any: !run.request.ids![i].includes('@') })) : null;
  const multi = !!run.request.runners;
  const skippedIds = new Set<string>();
  for (const r of runnersOf(config, run.request)) {
    const platform = platformOf(r);
    const skip = deps.skip?.(r);
    if (skip) {
      log(`── ${r.name} (${r.type}, ${r.level}): ${skip} ──`);
      run.runners.push({ name: r.name, command: '', exitCode: null, skipped: true, message: skip });
      for (const l of links) if (l.runner === r.name) skippedIds.add(l.id);
      continue;
    }
    let ids: string[] | null = null;
    if (requested) {
      const wanted = new Set(requested.filter((k) => k.any || k.platform === (platform ?? 'web')).map((k) => k.testId));
      ids = [...new Set(links.filter((l) => l.runner === r.name && wanted.has(l.id)).map((l) => l.id))];
      if (!ids.length) continue;
    }
    const runLog = multi ? (line: string) => log(`[${r.name}] ${line}`) : log;
    log(`── ${r.name} (${r.type}, ${r.level}) ──`);
    const res = await execute(repoRoot, r, ids, links, idRe, runLog, run.id);
    run.runners.push({ name: r.name, command: res.command, exitCode: res.exitCode, error: res.error });
    if (res.error) runLog(`! ${res.error}`);
    for (const [id, result] of Object.entries(res.results)) {
      run.results[resultKey(id, platform)] = platform && platform !== 'web' ? { ...result, platform } : result;
    }
    const startFailed = res.error ?? (res.exitCode === null && !Object.keys(res.results).length ? 'プロセスを起動できませんでした' : undefined);
    if (startFailed) {
      const message = `ランナー ${r.name} を起動できませんでした: ${startFailed}`;
      const failedIds = ids ?? [...new Set(links.filter((l) => l.runner === r.name).map((l) => l.id))];
      for (const id of failedIds) run.results[resultKey(id, platform)] ??= { status: 'error', durationMs: 0, message, runner: r.name, test: '', ...(platform && platform !== 'web' ? { platform } : {}) };
    }
  }
  if (requested) {
    const done = new Set(Object.keys(run.results).map((k) => parseResultKey(k).testId));
    for (const { testId: id } of requested) {
      if (!done.has(id) && !run.results[id] && !skippedIds.has(id)) run.results[id] = { status: 'error', durationMs: 0, message: '紐づくテストが無いか、結果が見つかりませんでした', runner: '', test: '' };
    }
  }
  const statuses = Object.values(run.results).map((r) => r.status);
  const runnerFailed = run.runners.some((r) => !r.skipped && (r.error || r.exitCode === null));
  run.status = runnerFailed || statuses.includes('error') ? (statuses.includes('failed') ? 'failed' : 'error') : statuses.includes('failed') ? 'failed' : 'passed';
  if (!run.runners.length) {
    run.status = 'error';
    log('! 実行対象のランナーがありません');
  }
}

export const RUNS_DIR = '.ddv/runs';

export class RunManager extends EventEmitter {
  runs = new Map<string, RunRecord>();
  active: RunRecord | null = null;
  rerunSession: RerunSession | null = null;
  private repoState: RepoStateReader;
  private executeRunner?: ExecuteRunner;

  constructor(
    private repoRoot: string,
    private getConfig: () => DdvConfig,
    opts: RunManagerOptions = {},
  ) {
    super();
    this.repoState = opts.repoState ?? new RepoStateReader();
    this.executeRunner = opts.execute;
  }

  async load(): Promise<void> {
    const dir = safeJoin(this.repoRoot, RUNS_DIR);
    if (!existsSync(dir)) return;
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as RunRecord;
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.startedAt !== 'string') continue;
        r.results ??= {};
        r.log ??= [];
        r.runners ??= [];
        r.request ??= {};
        if (r.status === 'running') r.status = 'error';
        // A record without `commit` is registered as is (= unknown commit, REQ-309) and never written back.
        this.runs.set(r.id, r);
      } catch {
        /* ignore broken files */
      }
    }
  }

  /** Test runs, newest first (task runs such as snapshots are kept in memory only and not listed). */
  list(): RunRecord[] {
    return [...this.runs.values()].filter((r) => (r.kind ?? 'test') === 'test').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** `LocalRuns.onEnd` (services): called when any run ends; returns the unsubscribe function. */
  onEnd(listener: (id: string) => void): () => void {
    const h = (id: string) => listener(id);
    this.on('end', h);
    return () => this.off('end', h);
  }

  /** Latest result per test id (most recent run that produced a result for it). */
  latest(): Record<string, CaseResult & { runId: string; at: string }> {
    const out: Record<string, CaseResult & { runId: string; at: string }> = {};
    for (const r of this.list().reverse()) for (const [id, res] of Object.entries(r.results)) out[id] = { ...res, runId: r.id, at: r.finishedAt ?? r.startedAt };
    return out;
  }

  private async save(r: RunRecord) {
    const dir = safeJoin(this.repoRoot, RUNS_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${r.id}.json`), JSON.stringify(r, null, 2), 'utf8');
  }

  start(req: RunRequest): RunRecord {
    if (this.active || this.rerunSession) throw new Error(BUSY_MESSAGE);
    const run = this.newRun(req);
    this.active = run;
    void this.execute(run);
    return run;
  }

  /** Re-runs the failures of the latest test run `times` times in a row (DD-RUNREC-RERUN). Returns the first attempt. */
  rerun(times: number): RunRecord {
    if (!Number.isInteger(times) || times < 1 || times > 5) throw new RerunError('times-invalid');
    if (this.active || this.rerunSession) throw new Error(BUSY_MESSAGE);
    const ids = this.failedIdsOfLatest();
    if (!ids.length) throw new RerunError('no-failures');
    const head = this.list()[0];
    const originId = head.rerunOf ?? head.id;
    const runners = this.runs.get(originId)?.request.runners;
    this.rerunSession = { originId, ids, times, attempt: 1, ...(runners ? { runners } : {}) };
    const run = this.newRun({ ids, ...(runners ? { runners } : {}) }, { rerunOf: originId, attempt: 1, times });
    this.active = run;
    void this.execute(run);
    return run;
  }

  /** Failed / error ids of the latest test run; when that is a re-run, of the run it re-ran. */
  failedIdsOfLatest(): string[] {
    const head = this.list()[0];
    if (!head) return [];
    const origin = head.rerunOf ? (this.runs.get(head.rerunOf) ?? head) : head;
    return Object.entries(origin.results)
      .filter(([, r]) => r.status === 'failed' || r.status === 'error')
      .map(([id]) => id);
  }

  private newRun(request: RunRequest, rerun?: { rerunOf: string; attempt: number; times: number }): RunRecord {
    const now = new Date();
    let id = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 6);
    while (this.runs.has(id)) id = id.slice(0, -4) + Math.random().toString(36).slice(2, 6);
    // startedAt strictly increases so that attempts started in the same millisecond keep their order in list().
    const last = this.list()[0]?.startedAt;
    const at = last && last >= now.toISOString() ? new Date(Date.parse(last) + 1) : now;
    const run: RunRecord = { id, kind: 'test', startedAt: at.toISOString(), status: 'running', request, runners: [], results: {}, log: [], ...rerun };
    this.runs.set(id, run);
    return run;
  }

  private tasks = new Map<RunKind, RunRecord>();

  activeTask(kind: RunKind): RunRecord | null {
    return this.tasks.get(kind) ?? null;
  }

  /** Starts a non-test run (one per kind at a time). Progress goes to the same SSE stream (`log`, custom events, `end`). */
  startTask(kind: Exclude<RunKind, 'test'>, request: RunRequest, exec: (h: TaskHandle) => Promise<RunRecord['status']>): RunRecord {
    if (this.tasks.has(kind)) throw new Error(kind === 'snapshot' ? '別のスナップショット撮影が進行中です' : kind === 'deps' ? '依存の導入が進行中です' : `別の ${kind} 実行が進行中です`);
    const now = new Date();
    const id = `${kind}-` + now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 6);
    const run: RunRecord = { id, kind, startedAt: now.toISOString(), status: 'running', request, runners: [], results: {}, log: [], events: [] };
    this.runs.set(id, run);
    this.tasks.set(kind, run);
    const handle: TaskHandle = {
      runId: id,
      log: (line) => this.log(run, line),
      event: (name, data) => {
        const ev = { event: name, data: typeof data === 'string' ? data : JSON.stringify(data) };
        run.events!.push(ev);
        this.emit('event', id, ev);
      },
    };
    void (async () => {
      try {
        run.status = await exec(handle);
      } catch (e) {
        run.status = 'error';
        this.log(run, `! ${e instanceof Error ? e.message : String(e)}`);
      }
      run.finishedAt = new Date().toISOString();
      if (this.tasks.get(kind) === run) this.tasks.delete(kind);
      this.emit('end', run.id, run);
    })();
    return run;
  }

  private log(run: RunRecord, line: string) {
    run.log.push(line);
    if (run.log.length > 5000) run.log.splice(0, run.log.length - 5000);
    this.emit('log', run.id, line);
  }

  private async execute(run: RunRecord) {
    const config = this.getConfig();
    try {
      const state = await this.repoState.read(this.repoRoot);
      if (state) Object.assign(run, { commit: state.commit, dirty: state.dirty });
      await runTests(this.repoRoot, config, run, (l) => this.log(run, l), { execute: this.executeRunner });
    } catch (e) {
      run.status = 'error';
      this.log(run, `! ${(e as Error).stack ?? e}`);
    }
    run.finishedAt = new Date().toISOString();
    await this.finish(run);
  }

  /** Lists the run's traces, saves, prunes, then hands over to the next re-run attempt or releases `active`. */
  private async finish(run: RunRecord) {
    try {
      // Always set for test runs (also when empty) so that a missing trace reads as "not recorded" rather than "before traces existed".
      if ((run.kind ?? 'test') === 'test') run.traces = [];
      const dir = safeJoin(this.repoRoot, `${TRACES_DIR}/${run.id}`);
      if (existsSync(dir)) {
        const ids = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
        if (ids.length) run.traces = ids.sort();
      }
    } catch {
      /* no traces */
    }
    try {
      await this.save(run);
    } catch (e) {
      this.log(run, `! 実行結果を保存できませんでした: ${(e as Error).message}`);
    }
    await this.prune(run);
    const session = this.rerunSession;
    if (session && run.rerunOf === session.originId && session.attempt < session.times) {
      session.attempt++;
      // `active` is never empty between attempts so that no other run can start.
      const next = this.newRun({ ids: session.ids, ...(session.runners ? { runners: session.runners } : {}) }, { rerunOf: session.originId, attempt: session.attempt, times: session.times });
      this.active = next;
      this.emit('end', run.id, run);
      this.emit('run', next.id, next);
      void this.execute(next);
      return;
    }
    if (session) this.rerunSession = null;
    // Release before notifying so listeners can start the next run immediately.
    if (this.active === run) this.active = null;
    this.emit('end', run.id, run);
  }

  /** Deletes records / traces over the `history` limits (after each save and once after `load`). Failures are logged and retried next time. */
  async prune(run?: RunRecord): Promise<PrunePlan> {
    let p: PrunePlan;
    try {
      p = Pruner.plan(this.list(), await traceDirs(this.repoRoot), this.getConfig().history);
    } catch {
      return { runs: [], traces: [] };
    }
    if (!p.runs.length && !p.traces.length) return p;
    try {
      await Pruner.apply(this.repoRoot, p, RUNS_DIR);
    } catch (e) {
      const line = `! 古い実行記録を削除できませんでした: ${(e as Error).message}`;
      if (run) this.log(run, line);
      else console.warn(`[ddv] ${line}`);
    }
    for (const id of p.runs) if (!existsSync(safeJoin(this.repoRoot, `${RUNS_DIR}/${id}.json`))) this.runs.delete(id);
    return p;
  }
}
