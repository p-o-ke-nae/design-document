import { GitHubError, getWorkflowRun, listRunJobs, listWorkflowRuns, type GhJob, type GhWorkflowRun, type GitHubClient } from '@ddv/github';
import { DDV_WORKFLOW_FILE, type RepoRef } from './gate.ts';

export const FIND_RUN_FIRST_DELAY_MS = 2_000;
export const FIND_RUN_TIMEOUT_MS = 60_000;
export const FIND_RUN_INTERVAL_MS = 3_000;
export const TRACK_INTERVAL_MS = 10_000;
export const REQUEST_ID = /^ddv-[0-9a-f]{8}$/;

export type ActionsMode = 'test' | 'approve';
export type TrackerState = 'Dispatching' | 'Running' | 'Completed' | 'Cancelled' | 'Failed' | 'Stopped';
export type RunStatus = 'queued' | 'in_progress' | 'completed';

export interface ActionsRunInfo {
  id: string;
  attempt: number;
  resultId: string;
  request?: string;
  mode: ActionsMode;
  ref?: string;
  sha: string;
  actor?: string;
  createdAt: string;
  status: RunStatus;
  conclusion?: string;
  url: string;
}

export interface JobProgress {
  name: string;
  status: RunStatus;
  conclusion?: string;
  steps: Array<{ number: number; name: string; status: string; conclusion?: string }>;
  url: string;
}

/** SSE `actions` (`type: 'tracker'`). */
export interface TrackerUpdate {
  type: 'tracker';
  request: string;
  mode: ActionsMode;
  state: TrackerState;
  startedAt: string;
  runId?: string;
  resultId?: string;
  url?: string;
  status?: RunStatus;
  conclusion?: string;
  jobs?: JobProgress[];
  error?: string;
  code?: string;
  approveCommit?: string | null;
}

/** Time source and waits of the tracker (tests advance a fake clock). */
export interface TrackerTimers {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realTimers: TrackerTimers = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface TrackerIntervals {
  firstFind: number;
  find: number;
  findTimeout: number;
  track: number;
}

export const DEFAULT_INTERVALS: TrackerIntervals = { firstFind: FIND_RUN_FIRST_DELAY_MS, find: FIND_RUN_INTERVAL_MS, findTimeout: FIND_RUN_TIMEOUT_MS, track: TRACK_INTERVAL_MS };

export const TRACK_MESSAGES = {
  notDetected: '60 秒以内に Actions の実行を検出できませんでした。Actions の画面で確認してください',
  pollFailed: '状態を取得できません（再試行中）',
  cancelled: '待機中に新しい実行が起動されたためキャンセルされました',
  already: '追跡はすでに始まっています',
} as const;

/** A failure of dispatch / findRun with the message shown to the user (`code` goes along in the SSE). */
export class DispatchFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DispatchFailure';
  }
}

class Stopped extends Error {}

const statusOf = (s: string | null | undefined): RunStatus => (s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'queued');

const words = (t: string | undefined) => (t ?? '').split(/\s+/).filter(Boolean);

/** `ActionsRunInfo` of a GitHub workflow run (actions-run.md「実行の特定」). */
export function toRunInfo(r: GhWorkflowRun): ActionsRunInfo {
  const w = words(r.display_title);
  const attempt = r.run_attempt ?? 1;
  const info: ActionsRunInfo = {
    id: String(r.id),
    attempt,
    resultId: `${r.id}-${attempt}`,
    mode: w.includes('approve') ? 'approve' : 'test',
    sha: r.head_sha,
    createdAt: r.created_at,
    status: statusOf(r.status),
    url: r.html_url,
  };
  const request = w.find((x) => REQUEST_ID.test(x));
  if (request) info.request = request;
  if (r.head_branch) info.ref = r.head_branch;
  const actor = r.triggering_actor?.login ?? r.actor?.login;
  if (actor) info.actor = actor;
  if (r.conclusion) info.conclusion = r.conclusion;
  return info;
}

export function toJobProgress(j: GhJob, runUrl: string): JobProgress {
  const out: JobProgress = {
    name: j.name,
    status: statusOf(j.status),
    steps: (j.steps ?? []).map((s) => ({ number: s.number, name: s.name, status: s.status, ...(s.conclusion ? { conclusion: s.conclusion } : {}) })),
    url: j.html_url ?? runUrl,
  };
  if (j.conclusion) out.conclusion = j.conclusion;
  return out;
}

export interface FindRunDeps {
  client: Pick<GitHubClient, 'rest'>;
  repo: RepoRef;
  timers: TrackerTimers;
  intervals?: Partial<TrackerIntervals>;
  /** false = stop looking (tracker stopped). */
  alive?: () => boolean;
}

/** Finds the run whose `display_title` contains the request id (actions-run.md「実行の特定」). Throws `DispatchFailure`. */
export async function findRun(deps: FindRunDeps, request: string, ref: string, deadline: number): Promise<ActionsRunInfo> {
  const iv = { ...DEFAULT_INTERVALS, ...deps.intervals };
  const alive = deps.alive ?? (() => true);
  for (;;) {
    if (!alive()) throw new Stopped();
    let runs: GhWorkflowRun[] | null = null;
    try {
      runs = await listWorkflowRuns(deps.client, deps.repo.owner, deps.repo.repo, DDV_WORKFLOW_FILE, { event: 'workflow_dispatch', branch: ref, perPage: 20 });
    } catch (e) {
      if (!(e instanceof GitHubError)) throw new DispatchFailure((e as Error).message);
      if (e.kind !== 'network' && e.kind !== 'rateLimit') throw new DispatchFailure(e.message, `github-${e.kind}`);
    }
    if (!alive()) throw new Stopped();
    if (runs) {
      const hit = runs.filter((r) => words(r.display_title).includes(request)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (hit) return toRunInfo(hit);
    }
    if (deps.timers.now() >= deadline) throw new DispatchFailure(TRACK_MESSAGES.notDetected);
    await deps.timers.sleep(iv.find);
  }
}

export interface TrackerDeps extends FindRunDeps {
  onUpdate?: (u: TrackerUpdate) => void;
}

/** Follows one dispatched (or opened) run until it ends (actions-run.md「実行の追跡」). */
export class ActionsRunTracker {
  state: TrackerState | null = null;
  runId?: string;
  resultId?: string;
  info?: ActionsRunInfo;
  jobs: JobProgress[] = [];
  error?: string;
  code?: string;
  approveCommit?: string | null;
  startedAt = '';
  endedAt?: number;
  private readonly listeners = new Set<(u: TrackerUpdate) => void>();
  private readonly iv: TrackerIntervals;
  private done: Promise<void> = Promise.resolve();

  constructor(
    public request: string,
    readonly mode: ActionsMode,
    private readonly deps: TrackerDeps,
  ) {
    this.iv = { ...DEFAULT_INTERVALS, ...deps.intervals };
    if (deps.onUpdate) this.listeners.add(deps.onUpdate);
  }

  onUpdate(l: (u: TrackerUpdate) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get ended(): boolean {
    return this.state === 'Completed' || this.state === 'Cancelled' || this.state === 'Failed' || this.state === 'Stopped';
  }

  /** Resolves when the tracker reaches an end state. */
  finished(): Promise<void> {
    return this.done;
  }

  /** The latest update (replayed to new SSE subscribers). */
  snapshot(): TrackerUpdate {
    const u: TrackerUpdate = { type: 'tracker', request: this.request, mode: this.mode, state: this.state ?? 'Dispatching', startedAt: this.startedAt };
    if (this.runId) u.runId = this.runId;
    if (this.resultId) u.resultId = this.resultId;
    if (this.info) Object.assign(u, { url: this.info.url, status: this.info.status, ...(this.info.conclusion ? { conclusion: this.info.conclusion } : {}) });
    if (this.jobs.length) u.jobs = this.jobs;
    if (this.error) u.error = this.error;
    if (this.code) u.code = this.code;
    if (this.approveCommit !== undefined) u.approveCommit = this.approveCommit;
    return u;
  }

  /** Adds fields after the end (approval commit, error) and sends them. */
  patch(fields: { approveCommit?: string | null; error?: string; code?: string }): void {
    Object.assign(this, fields);
    this.emit();
  }

  private emit(): void {
    const u = this.snapshot();
    for (const l of this.listeners) l(u);
  }

  private begin(state: TrackerState): void {
    if (this.state !== null) throw new Error(TRACK_MESSAGES.already);
    this.state = state;
    this.startedAt = new Date(this.deps.timers.now()).toISOString();
  }

  private end(state: TrackerState): void {
    this.state = state;
    this.endedAt = this.deps.timers.now();
    this.emit();
  }

  private alive = () => this.state !== 'Stopped';

  /** From the dispatch: Dispatching → Running → Completed / Cancelled (or Failed). */
  start(dispatch: () => Promise<void>, ref: string): Promise<void> {
    this.begin('Dispatching');
    this.emit();
    this.done = this.runStart(dispatch, ref);
    return this.done;
  }

  /** From a run already in progress: Running → Completed / Cancelled. */
  attach(runId: string, info?: ActionsRunInfo): Promise<void> {
    this.begin('Running');
    this.runId = runId;
    if (info) {
      this.info = info;
      this.resultId = info.resultId;
    }
    this.emit();
    this.done = this.poll(true).catch(this.swallowStop);
    return this.done;
  }

  stop(): void {
    if (this.state === null || this.ended) return;
    this.end('Stopped');
  }

  private swallowStop = (e: unknown) => {
    if (!(e instanceof Stopped)) throw e;
  };

  private async runStart(dispatch: () => Promise<void>, ref: string): Promise<void> {
    try {
      try {
        await dispatch();
      } catch (e) {
        throw e instanceof DispatchFailure ? e : new DispatchFailure((e as Error).message, e instanceof GitHubError ? `github-${e.kind}` : undefined);
      }
      if (!this.alive()) return;
      const deadline = this.deps.timers.now() + this.iv.findTimeout;
      await this.deps.timers.sleep(this.iv.firstFind);
      const info = await findRun({ ...this.deps, alive: this.alive }, this.request, ref, deadline);
      if (!this.alive()) return;
      this.info = info;
      this.runId = info.id;
      this.resultId = info.resultId;
      this.state = 'Running';
      this.emit();
      if (info.status === 'completed') {
        this.finish(info);
        return;
      }
      await this.poll(false);
    } catch (e) {
      if (e instanceof Stopped || !this.alive()) return;
      this.error = (e as Error).message;
      if (e instanceof DispatchFailure && e.code) this.code = e.code;
      this.end('Failed');
    }
  }

  private finish(info: ActionsRunInfo): void {
    if (info.conclusion === 'cancelled') {
      this.error = TRACK_MESSAGES.cancelled;
      this.end('Cancelled');
    } else {
      this.error = undefined;
      this.end('Completed');
    }
  }

  private async poll(immediate: boolean): Promise<void> {
    let first = immediate;
    for (;;) {
      if (!first) await this.deps.timers.sleep(this.iv.track);
      first = false;
      if (!this.alive()) return;
      if (await this.tick()) return;
    }
  }

  /** One status fetch; true when the run ended. Results that arrive after stop are dropped. */
  private async tick(): Promise<boolean> {
    const { client, repo } = this.deps;
    let run: GhWorkflowRun;
    let jobs: GhJob[];
    try {
      [run, jobs] = await Promise.all([getWorkflowRun(client, repo.owner, repo.repo, this.runId!), listRunJobs(client, repo.owner, repo.repo, this.runId!)]);
    } catch (e) {
      if (!this.alive()) return true;
      if (!(e instanceof GitHubError)) throw e;
      this.error = TRACK_MESSAGES.pollFailed;
      this.emit();
      return false;
    }
    if (!this.alive()) return true;
    const info = toRunInfo(run);
    if (!this.request && info.request) this.request = info.request;
    this.info = info;
    this.resultId = info.resultId;
    this.jobs = jobs.map((j) => toJobProgress(j, info.url));
    this.error = undefined;
    if (info.status === 'completed') {
      this.finish(info);
      return true;
    }
    this.emit();
    return false;
  }
}
