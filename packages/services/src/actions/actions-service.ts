import type { Approval, DdvConfig, ResultsIndexEntry } from '@ddv/core';
import {
  dispatchWorkflow,
  getContent,
  getRepo,
  getWorkflowRun,
  GitHubError,
  listCheckRuns,
  listRunJobs,
  listWorkflowRuns,
  type GhWorkflowRun,
  type GitHubClient,
} from '@ddv/github';
import { idPattern } from '@ddv/testid/core';
import type { Clock, Random } from '../env.ts';
import { ActionsError, type ActionsErrorCode } from '../errors.ts';
import { MemoryBlobStore, type BlobStore } from '../github-reader.ts';
import type { HistoryService, RunRecord, SnapshotOutcome } from '../history.ts';
import { actionsGate, DDV_WORKFLOW_FILE, DDV_WORKFLOW_PATH, type ActionsEdition, type ActionsGateState, type RepoRef } from './gate.ts';
import { RESULT_ID, ResultsBranchReader, type IndexState, type RecordState } from './results-branch.ts';
import {
  ActionsRunTracker,
  DispatchFailure,
  realTimers,
  toJobProgress,
  toRunInfo,
  type ActionsMode,
  type ActionsRunInfo,
  type JobProgress,
  type TrackerIntervals,
  type TrackerTimers,
  type TrackerUpdate,
} from './tracker.ts';

export const STATUS_TTL_MS = 60_000;
export const TRACKER_KEEP_MS = 10 * 60_000;
export const MAX_IDS = 200;
const RUN_LIST_SIZE = 30;
const NO_TOKEN_HISTORY_RUNS = 20;

export interface ActionsTarget {
  ref?: string;
  sha: string;
  pr?: number;
  headRef?: string;
  fork: boolean;
  dirty?: boolean;
  problem?: ActionsErrorCode;
}

export interface ActionsTargetProvider {
  resolve(): Promise<ActionsTarget>;
}

export interface ActionsStatus {
  state: ActionsGateState;
  reason: string;
  repo?: string;
  defaultBranch?: string;
  workflow: boolean | null;
  workflowUrl?: string;
  target?: ActionsTarget;
  canInit: boolean;
}

export type ActionsRowState = 'queued' | 'in_progress' | 'passed' | 'failed' | 'error' | 'cancelled' | 'no-result';

export interface ActionsRunRow {
  id: string;
  actionsRunId: string;
  request?: string;
  mode: ActionsMode;
  commit: string;
  pr?: number;
  actor?: string;
  at: string;
  state: ActionsRowState;
  counts?: { passed: number; failed: number; skipped: number; error: number };
  snapshots?: { diff: number; noBase: number };
  approvals: number;
  trimmed: boolean;
  warnings: string[];
  url: string;
}

export interface ActionsCheck {
  name: string;
  status: string;
  conclusion?: string;
  url: string;
}

export interface ActionsRunList {
  index: { state: IndexState; skipped: number; message?: string };
  rows: ActionsRunRow[];
  checks?: ActionsCheck[];
}

export interface ActionsRunDetail {
  info: ActionsRunInfo;
  jobs: JobProgress[];
  recordState: RecordState;
  record?: RunRecord;
  traceOf: Record<string, boolean>;
  snapshots: SnapshotOutcome[];
  approvals: Approval[];
  trimmed: boolean;
  warnings: string[];
}

export type ActionsEvent = TrackerUpdate | { type: 'history' };

export interface DispatchRequest {
  ids?: unknown;
  runner?: unknown;
}

export const ACTIONS_MESSAGES = {
  noRemote: 'GitHub のリモートがありません',
  detached: 'ブランチをチェックアウトしてください（detached HEAD は Actions で実行できません）',
  notPushed: (ref: string, sha: string) => `${ref}（${sha.slice(0, 7)}）が GitHub にありません。push してください`,
  missingOnRef: (ref: string) => `PR のブランチ（${ref}）に ddv のワークフローがありません。既定ブランチを取り込んでから実行してください`,
  forbidden: 'ワークフローを起動する権限がありません（PAT に Actions: Write が必要です）',
  workflowNotFound: 'ddv ワークフローが見つかりません。既定ブランチにマージされているか確認してください',
  inputs: (m: string) => `ワークフローの入力が ddv と合いません。ddv actions init で雛形を更新してください: ${m}`,
  idInvalid: (v: string) => `テストIDの形式ではありません: ${v}`,
  idsTooMany: `テストIDは ${MAX_IDS} 件までです`,
  runnerUnknown: (n: string) => `ランナー ${n} は設定にありません`,
  runIdInvalid: (v: string) => `結果IDの形式ではありません: ${v}`,
  pathInvalid: (v: string) => `ファイルのパスが不正です: ${v}`,
  notFound: (id: string) => `実行 ${id} が見つかりません`,
  notPr: 'PR のワークスペースで承認してください',
  otherPr: '別の PR の実行です',
  trimmed: '古い実行のため画像が削除されています。もう一度実行してください',
  approveIds: '差分のあるシナリオを選んでください',
  approveFailed: '承認のワークフローが失敗しました。Actions のログを確認してください',
  approveUnknown: '承認は完了しましたが、結果ブランチで確認できません。Actions の画面で確認してください',
  readFailed: (m: string) => `! Actions の結果を読めませんでした: ${m}`,
} as const;

export function newRequestId(random: Random): string {
  return `ddv-${[...random.bytes(4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** `ids`: test ids (anchored `idPattern`), at most 200. Throws `ActionsError(400, 'ids-invalid')`. */
export function validateIds(ids: unknown, prefixes: string[]): string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new ActionsError(400, 'ids-invalid', ACTIONS_MESSAGES.idInvalid(String(ids)));
  if (ids.length > MAX_IDS) throw new ActionsError(400, 'ids-invalid', ACTIONS_MESSAGES.idsTooMany);
  const re = new RegExp(`^(?:${idPattern(prefixes).source})$`);
  for (const x of ids) if (typeof x !== 'string' || !re.test(x)) throw new ActionsError(400, 'ids-invalid', ACTIONS_MESSAGES.idInvalid(String(x)));
  return ids as string[];
}

export function validateRunner(runner: unknown, config: Pick<DdvConfig, 'runners'>): string {
  if (runner === undefined || runner === null || runner === '') return '';
  if (typeof runner !== 'string' || !config.runners.some((r) => r.name === runner)) throw new ActionsError(400, 'runner-unknown', ACTIONS_MESSAGES.runnerUnknown(String(runner)));
  return runner;
}

export function validateResultId(id: string): void {
  if (!RESULT_ID.test(id)) throw new ActionsError(400, 'run-id-invalid', ACTIONS_MESSAGES.runIdInvalid(id));
}

const FILE_PATHS = [/^traces\/[^/]+\.json$/, /^traces\/[^/]+\/\d+\.png$/, /^snapshots\/(?:current|diff|baseline)\/[^/]+\/\d+\.png$/];

export function validateFilePath(path: string): void {
  if (path.includes('..') || path.includes('\\') || !FILE_PATHS.some((re) => re.test(path))) throw new ActionsError(400, 'path-invalid', ACTIONS_MESSAGES.pathInvalid(path));
}

/** Message and code of a failed `workflow_dispatch` (actions-run.md「起動」). */
export function dispatchFailure(e: unknown, ref: string): DispatchFailure {
  if (!(e instanceof GitHubError)) return new DispatchFailure((e as Error).message);
  if (e.kind === 'forbidden') return new DispatchFailure(ACTIONS_MESSAGES.forbidden, 'github-forbidden');
  if (e.kind === 'notFound') return new DispatchFailure(ACTIONS_MESSAGES.workflowNotFound, 'github-notFound');
  if (e.kind === 'validation') {
    if (/not found|does not have 'workflow_dispatch' trigger/i.test(e.message)) return new DispatchFailure(ACTIONS_MESSAGES.missingOnRef(ref), 'workflow-missing-on-ref');
    return new DispatchFailure(ACTIONS_MESSAGES.inputs(e.message), 'github-validation');
  }
  return new DispatchFailure(e.message, `github-${e.kind}`);
}

const snapshotsWithDiff = (r: RunRecord | undefined): SnapshotOutcome[] => (r?.snapshots ?? []).filter((s) => s.steps.some((x) => x.status === 'Diff' || x.status === 'NoBase'));

export interface ActionsServiceOptions {
  client: Pick<GitHubClient, 'rest'>;
  repo: RepoRef;
  targets: ActionsTargetProvider;
  history: HistoryService;
  clock: Clock;
  random: Random;
  /** Whether a token / PAT is set (also = authenticated before the first call). */
  hasToken: () => boolean | Promise<boolean>;
  store?: BlobStore;
  edition?: ActionsEdition;
  canInit?: boolean;
  /** For validating `ids` / `runner` (absent = not validated). */
  getConfig?: () => DdvConfig;
  timers?: TrackerTimers;
  intervals?: Partial<TrackerIntervals>;
  /** Server log line (`! Actions の結果を読めませんでした: …`). */
  log?: (line: string) => void;
  /** After a successful approval (GitHub workspace: `checkHead(id, true)`). */
  onApproved?: () => Promise<void> | void;
  /** Tests: a prepared reader. */
  reader?: ResultsBranchReader;
  fetch?: typeof fetch;
  rawBase?: string;
}

/** Status, dispatch, tracking and results of one repository (actions-run.md「構造」). */
export class ActionsService {
  readonly reader: ResultsBranchReader;
  readonly trackers = new Map<string, ActionsRunTracker>();
  private cached: { at: number; status: ActionsStatus } | null = null;
  private historyStarted = false;
  private lastIndexCommit: string | undefined | null = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  private readonly listeners = new Set<(e: ActionsEvent) => void>();
  private readonly timers: TrackerTimers;

  constructor(private readonly opts: ActionsServiceOptions) {
    this.reader =
      opts.reader ??
      new ResultsBranchReader({ client: opts.client, repo: opts.repo, store: opts.store ?? new MemoryBlobStore(), hasToken: opts.hasToken, fetch: opts.fetch, rawBase: opts.rawBase });
    this.timers = opts.timers ?? { now: () => opts.clock.now(), sleep: realTimers.sleep };
  }

  get repoName(): string {
    return `${this.opts.repo.owner}/${this.opts.repo.repo}`;
  }

  get workflowUrl(): string {
    return `https://github.com/${this.repoName}/actions/workflows/${DDV_WORKFLOW_FILE}`;
  }

  onEvent(l: (e: ActionsEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: ActionsEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** The latest update of every tracker (sent when an SSE subscription starts). */
  replay(): TrackerUpdate[] {
    this.prune();
    return [...this.trackers.values()].filter((t) => t.state !== null).map((t) => t.snapshot());
  }

  private prune(): void {
    const now = this.opts.clock.now();
    for (const [k, t] of this.trackers) if (t.ended && t.endedAt !== undefined && now - t.endedAt >= TRACKER_KEEP_MS) this.trackers.delete(k);
  }

  invalidateStatus(): void {
    this.cached = null;
  }

  async status(refresh = false): Promise<ActionsStatus> {
    const now = this.opts.clock.now();
    if (!refresh && this.cached && now - this.cached.at < STATUS_TTL_MS) return this.cached.status;
    const status = await this.loadStatus();
    this.cached = { at: now, status };
    if (!this.historyStarted && status.state !== 'hidden') {
      this.historyStarted = true;
      void this.refreshHistory();
    }
    return status;
  }

  private async loadStatus(): Promise<ActionsStatus> {
    const { client, repo } = this.opts;
    let authenticated = await this.opts.hasToken();
    let defaultBranch: string | undefined;
    let canPush = false;
    let workflow: boolean | null = null;
    let lookupError: string | undefined;
    const fail = (e: unknown) => {
      if (e instanceof GitHubError && e.kind === 'auth') authenticated = false;
      else lookupError = (e as Error).message;
    };
    try {
      const r = await getRepo(client, repo.owner, repo.repo);
      defaultBranch = r.default_branch;
      canPush = r.permissions?.push === true;
    } catch (e) {
      fail(e);
    }
    if (defaultBranch !== undefined) {
      try {
        await getContent(client, repo.owner, repo.repo, DDV_WORKFLOW_PATH, defaultBranch);
        workflow = true;
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'notFound') workflow = false;
        else fail(e);
      }
    }
    let target: ActionsTarget | undefined;
    try {
      target = await this.opts.targets.resolve();
    } catch {
      target = undefined;
    }
    if (target && workflow === true && !target.problem && target.ref && target.ref !== defaultBranch) {
      try {
        await getContent(client, repo.owner, repo.repo, DDV_WORKFLOW_PATH, target.ref);
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'notFound') target = { ...target, problem: 'workflow-missing-on-ref' };
      }
    }
    const gate = actionsGate({ remote: repo, workflow, fork: target?.fork ?? false, canPush, authenticated, lookupError, defaultBranch, edition: this.opts.edition });
    const out: ActionsStatus = { state: gate.state, reason: gate.reason, repo: this.repoName, workflow, workflowUrl: this.workflowUrl, canInit: this.opts.canInit ?? false };
    if (defaultBranch !== undefined) out.defaultBranch = defaultBranch;
    if (target) out.target = target;
    return out;
  }

  private assertRunnable(st: ActionsStatus): ActionsTarget {
    if (st.state === 'hidden') throw new ActionsError(404, 'no-remote', ACTIONS_MESSAGES.noRemote);
    if (st.state === 'setup') throw new ActionsError(409, 'setup', st.reason);
    if (st.state === 'fork' || st.state === 'readonly') throw new ActionsError(403, st.state, st.reason);
    if (!st.target) throw new ActionsError(409, 'detached', ACTIONS_MESSAGES.detached);
    return st.target;
  }

  private problemError(t: ActionsTarget): ActionsError {
    const code = t.problem!;
    const msg =
      code === 'detached'
        ? ACTIONS_MESSAGES.detached
        : code === 'not-pushed'
          ? ACTIONS_MESSAGES.notPushed(t.ref ?? '', t.sha)
          : code === 'workflow-missing-on-ref'
            ? ACTIONS_MESSAGES.missingOnRef(t.headRef ?? t.ref ?? '')
            : code;
    return new ActionsError(409, code, msg);
  }

  private newTracker(request: string, mode: ActionsMode): ActionsRunTracker {
    this.prune();
    const t = new ActionsRunTracker(request, mode, {
      client: this.opts.client,
      repo: this.opts.repo,
      timers: this.timers,
      intervals: this.opts.intervals,
      onUpdate: (u) => this.emit(u),
    });
    this.trackers.set(request, t);
    return t;
  }

  private afterTest(t: ActionsRunTracker): void {
    void t.finished().then(() => {
      if (t.state === 'Completed') void this.refreshHistory();
    });
  }

  /** Starts the workflow with `mode: test`. Returns the request id (progress goes to `onEvent`). */
  async dispatch(req: DispatchRequest = {}): Promise<string> {
    const config = this.opts.getConfig?.();
    const ids = config ? validateIds(req.ids, Object.values(config.idPrefix)) : ((req.ids as string[] | undefined) ?? []);
    const runner = config ? validateRunner(req.runner, config) : typeof req.runner === 'string' ? req.runner : '';
    const st = await this.status();
    const t = this.assertRunnable(st);
    if (t.problem) throw this.problemError(t);
    if (!t.ref) throw new ActionsError(409, 'detached', ACTIONS_MESSAGES.detached);
    const ref = t.ref;
    const request = newRequestId(this.opts.random);
    const tracker = this.newTracker(request, 'test');
    const { owner, repo } = this.opts.repo;
    void tracker.start(async () => {
      try {
        await dispatchWorkflow(this.opts.client, owner, repo, DDV_WORKFLOW_FILE, ref, { request, mode: 'test', ids: ids.join(','), runner, sha: t.sha, run: '' });
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'notFound') this.invalidateStatus();
        throw dispatchFailure(e, ref);
      }
    }, ref);
    this.afterTest(tracker);
    return request;
  }

  /** Follows a run that is already in progress (a running row of the list). */
  attach(runId: string, info?: ActionsRunInfo): ActionsRunTracker {
    for (const t of this.trackers.values()) if (t.runId === runId && !t.ended) return t;
    const key = info?.request ?? `run-${runId}`;
    const existing = this.trackers.get(key);
    if (existing && !existing.ended) return existing;
    const t = this.newTracker(key, info?.mode ?? 'test');
    void t.attach(runId, info);
    if (t.mode === 'test') this.afterTest(t);
    return t;
  }

  stopAll(): void {
    for (const t of this.trackers.values()) t.stop();
  }

  async runs(): Promise<ActionsRunList> {
    const st = await this.status();
    const { client, repo } = this.opts;
    const [idx, list] = await Promise.all([this.reader.readIndex(), listWorkflowRuns(client, repo.owner, repo.repo, DDV_WORKFLOW_FILE, { perPage: RUN_LIST_SIZE })]);
    if (this.lastIndexCommit !== null && idx.commit !== this.lastIndexCommit) void this.refreshHistory();
    const ok = idx.state === 'ok';
    const rows: ActionsRunRow[] = [];
    const inIndex = new Set<string>();
    if (ok)
      for (const e of idx.index!.runs) {
        inIndex.add(e.id);
        rows.push(this.rowOf(e));
      }
    for (const r of list) {
      const info = toRunInfo(r);
      if (inIndex.has(info.resultId)) continue;
      if (info.status !== 'completed') {
        rows.push(this.ghRow(r, info, info.status));
        this.attach(info.id, info);
      } else if (ok && info.mode === 'test') rows.push(this.ghRow(r, info, info.conclusion === 'cancelled' ? 'cancelled' : 'no-result'));
    }
    rows.sort((a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? 1 : -1));
    const out: ActionsRunList = { index: { state: idx.state, skipped: idx.skipped }, rows };
    const message = this.indexMessage(idx.state, idx.skipped, idx.message);
    if (message) out.index.message = message;
    if (st.state === 'fork' && st.target) {
      const ddvRuns = new Set(list.map((r) => String(r.id)));
      const checks = await listCheckRuns(client, repo.owner, repo.repo, st.target.sha);
      out.checks = checks
        .filter((c) => {
          const m = /\/actions\/runs\/(\d+)/.exec(c.details_url ?? c.html_url ?? '');
          return !(m && ddvRuns.has(m[1]!));
        })
        .map((c) => ({ name: c.name, status: c.status, ...(c.conclusion ? { conclusion: c.conclusion } : {}), url: c.html_url ?? c.details_url ?? '' }));
    }
    return out;
  }

  private indexMessage(state: IndexState, skipped: number, reason?: string): string | undefined {
    if (state === 'noBranch') return 'まだ Actions の実行結果はありません';
    if (state === 'indexMissing' || state === 'broken') return `結果ブランチの index.json を読めません（${reason ?? ''}）`;
    if (state === 'unsupported') return '新しい ddv の結果形式です。ddv を更新してください';
    if (skipped > 0) return `読めない実行が ${skipped} 件あります`;
    return undefined;
  }

  private runUrl(runId: string, attempt: string | number): string {
    return `https://github.com/${this.repoName}/actions/runs/${runId}/attempts/${attempt}`;
  }

  private rowOf(e: ResultsIndexEntry): ActionsRunRow {
    const attempt = e.id.split('-')[1] ?? '1';
    const row: ActionsRunRow = {
      id: e.id,
      actionsRunId: e.actionsRunId,
      mode: 'test',
      commit: e.commit,
      at: e.startedAt,
      state: e.status,
      counts: e.counts,
      approvals: e.approvals.length,
      trimmed: e.trimmed,
      warnings: e.warnings,
      url: this.runUrl(e.actionsRunId, attempt),
    };
    if (e.request) row.request = e.request;
    if (e.pr !== undefined) row.pr = e.pr;
    if (e.actor) row.actor = e.actor;
    if (e.snapshots) row.snapshots = e.snapshots;
    return row;
  }

  private ghRow(r: GhWorkflowRun, info: ActionsRunInfo, state: ActionsRowState): ActionsRunRow {
    const row: ActionsRunRow = {
      id: info.resultId,
      actionsRunId: info.id,
      mode: info.mode,
      commit: r.head_sha,
      at: info.createdAt,
      state,
      approvals: 0,
      trimmed: false,
      warnings: [],
      url: this.runUrl(info.id, info.attempt),
    };
    if (info.request) row.request = info.request;
    if (info.actor) row.actor = info.actor;
    return row;
  }

  async run(id: string): Promise<ActionsRunDetail> {
    validateResultId(id);
    const [runId, attempt] = id.split('-') as [string, string];
    const { client, repo } = this.opts;
    const [gh, idx] = await Promise.all([
      Promise.all([getWorkflowRun(client, repo.owner, repo.repo, runId), listRunJobs(client, repo.owner, repo.repo, runId)]).catch((e: unknown) => e as Error),
      this.reader.readIndex(),
    ]);
    const row = idx.state === 'ok' ? idx.index!.runs.find((r) => r.id === id) : undefined;
    let info: ActionsRunInfo;
    let jobs: JobProgress[] = [];
    if (gh instanceof Error) {
      if (!row) {
        if (gh instanceof GitHubError && gh.kind === 'notFound') throw new ActionsError(404, 'not-found', ACTIONS_MESSAGES.notFound(id));
        throw gh;
      }
      info = {
        id: runId,
        attempt: Number(attempt),
        resultId: id,
        mode: 'test',
        sha: row.commit,
        createdAt: row.startedAt,
        status: 'completed',
        conclusion: row.status === 'passed' ? 'success' : 'failure',
        url: this.runUrl(runId, attempt),
        ...(row.request ? { request: row.request } : {}),
        ...(row.ref ? { ref: row.ref } : {}),
        ...(row.actor ? { actor: row.actor } : {}),
      };
    } else {
      info = { ...toRunInfo(gh[0]), attempt: Number(attempt), resultId: id, url: this.runUrl(runId, attempt) };
      jobs = gh[1].map((j) => toJobProgress(j, info.url));
    }
    const rec = idx.reader ? await this.reader.readRecord(id) : { state: 'missing' as const };
    const files = rec.state === 'ok' ? new Set(await this.reader.runFiles(id)) : new Set<string>();
    const record = rec.record;
    const traceOf: Record<string, boolean> = {};
    for (const t of record?.traces ?? []) traceOf[t] = files.has(`traces/${t}.json`);
    const warnings = [...new Set([...(row?.warnings ?? []), ...(record?.warnings ?? [])])];
    const out: ActionsRunDetail = {
      info,
      jobs,
      recordState: rec.state,
      traceOf,
      snapshots: snapshotsWithDiff(record),
      approvals: row?.approvals ?? [],
      trimmed: row?.trimmed ?? false,
      warnings,
    };
    if (record) out.record = record;
    return out;
  }

  async file(id: string, path: string): Promise<Uint8Array> {
    validateResultId(id);
    validateFilePath(path);
    if (!this.reader.current?.reader) await this.reader.readIndex();
    return this.reader.readFile(id, path);
  }

  /** Starts the approval workflow for the scenarios `ids` of the run `id`. Returns the request id. */
  async approve(id: string, ids: unknown): Promise<string> {
    validateResultId(id);
    const st = await this.status();
    const t = this.assertRunnable(st);
    if (t.pr === undefined || !t.headRef) throw new ActionsError(409, 'not-pr', ACTIONS_MESSAGES.notPr);
    if (t.problem === 'workflow-missing-on-ref') throw this.problemError(t);
    const idx = await this.reader.readIndex();
    const row = idx.state === 'ok' ? idx.index!.runs.find((r) => r.id === id) : undefined;
    if (!row) throw new ActionsError(404, 'not-found', ACTIONS_MESSAGES.notFound(id));
    if (row.pr !== t.pr) throw new ActionsError(409, 'other-pr', ACTIONS_MESSAGES.otherPr);
    if (row.trimmed) throw new ActionsError(409, 'trimmed', ACTIONS_MESSAGES.trimmed);
    const rec = await this.reader.readRecord(id);
    const allowed = new Set(snapshotsWithDiff(rec.record).map((s) => s.id));
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string' || !allowed.has(x))) throw new ActionsError(400, 'ids-invalid', ACTIONS_MESSAGES.approveIds);
    const ref = t.headRef;
    const request = newRequestId(this.opts.random);
    const tracker = this.newTracker(request, 'approve');
    const { owner, repo } = this.opts.repo;
    void tracker
      .start(async () => {
        try {
          await dispatchWorkflow(this.opts.client, owner, repo, DDV_WORKFLOW_FILE, ref, { request, mode: 'approve', ids: (ids as string[]).join(','), runner: '', sha: '', run: id });
        } catch (e) {
          if (e instanceof GitHubError && e.kind === 'notFound') this.invalidateStatus();
          throw dispatchFailure(e, ref);
        }
      }, ref)
      .then(() => this.afterApprove(tracker, id))
      .catch((e: unknown) => this.opts.log?.(ACTIONS_MESSAGES.readFailed((e as Error).message)));
    return request;
  }

  private async afterApprove(t: ActionsRunTracker, id: string): Promise<void> {
    if (t.state !== 'Completed') return;
    if (t.info?.conclusion !== 'success') {
      t.patch({ error: ACTIONS_MESSAGES.approveFailed });
      return;
    }
    const idx = await this.reader.readIndex();
    const row = idx.index?.runs.find((r) => r.id === id);
    const ap = row?.approvals.find((a) => a.actionsRunId === t.runId);
    if (ap) t.patch({ approveCommit: ap.commit });
    else t.patch({ error: ACTIONS_MESSAGES.approveUnknown });
    await this.opts.onApproved?.();
  }

  /** Reads the results branch into the history (never two at once; a call while running runs once more after it). */
  refreshHistory(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        try {
          await this.loadHistory();
        } catch (e) {
          this.opts.log?.(ACTIONS_MESSAGES.readFailed((e as Error).message));
        }
      } while (this.again);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async loadHistory(): Promise<void> {
    const idx = await this.reader.readIndex();
    this.lastIndexCommit = idx.commit;
    let records: RunRecord[] = [];
    if (idx.state === 'ok') {
      let ids = [...idx.index!.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => r.id);
      if (!(await this.opts.hasToken())) ids = ids.slice(0, NO_TOKEN_HISTORY_RUNS);
      records = await this.reader.readRecords(ids);
    }
    this.opts.history.setActionsRuns(records, this.repoName);
    this.emit({ type: 'history' });
  }
}
