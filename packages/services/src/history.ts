import { activeIds, type DiagramMatrix, type TestIdLock } from '@ddv/testid/core';
import { HistoryError } from './errors.ts';
import type { CoverageService } from './coverage.ts';
import type { TraceService } from './traces.ts';

export { HistoryError };

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface CaseResult {
  status: TestStatus;
  durationMs: number;
  message?: string;
  runner: string;
  test: string;
}

export type RunKind = 'test' | 'snapshot' | 'deps';

/** A run record (`.ddv/runs/<id>.json`; the server's `RunRecord`). */
export interface RunRecord {
  id: string;
  kind?: RunKind;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  request: { ids?: string[]; runner?: string };
  runners: Array<{ name: string; command: string; exitCode: number | null; error?: string }>;
  results: Record<string, CaseResult>;
  log: string[];
  events?: Array<{ event: string; data: string }>;
  commit?: string;
  dirty?: boolean;
  rerunOf?: string;
  attempt?: number;
  times?: number;
  traces?: string[];
}

export type Unsubscribe = () => void;

/** The local run records (server: `RunManager`; Pages edition: empty). */
export interface LocalRuns {
  /** Test runs, newest first. */
  list(): RunRecord[];
  failedIdsOfLatest(): string[];
  onEnd(listener: (id: string) => void): Unsubscribe;
}

export const EMPTY_RUNS: LocalRuns = { list: () => [], failedIdsOfLatest: () => [], onEnd: () => () => {} };

export type LatestResult = CaseResult & { runId: string; at: string };
export type LatestResults = Record<string, LatestResult>;

/** Latest result per test id of the runs (newest first): the most recent run that produced a result for it. */
export function latestOfRuns(runs: RunRecord[]): LatestResults {
  const out: LatestResults = {};
  for (const r of [...runs].reverse()) for (const [id, res] of Object.entries(r.results)) out[id] = { ...res, runId: r.id, at: r.finishedAt ?? r.startedAt };
  return out;
}

/** Local runs and the runs received by `setActionsRuns` (newest first, the same id once; the local record wins). */
export function mergeRuns(local: RunRecord[], actions: RunRecord[]): RunRecord[] {
  if (!actions.length) return local;
  const seen = new Set(local.map((r) => r.id));
  return [...local, ...actions.filter((r) => !seen.has(r.id))].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export type RecentMark = TestStatus | 'none';
export type CoverageClass = 'unlinked' | 'unexecuted' | 'passed' | 'failed' | 'skipped';

export interface HistoryEntry {
  runId: string;
  at: string;
  commit?: string;
  dirty?: boolean;
  rerunOf?: string;
  attempt?: number;
  times?: number;
  status: TestStatus;
  durationMs: number;
  message?: string;
  trace: boolean;
}

export interface TestSummary {
  recent: RecentMark[];
  /** Newest entries of `recent` (same order) for the dot tooltips. */
  recentAt: Array<{ at: string; commit?: string; dirty?: boolean } | null>;
  flaky: boolean;
  flakyCommits: string[];
}

export interface HistorySummary {
  tests: Record<string, TestSummary>;
  flakyCount: number;
  rerunnable: number;
}

export interface TestHistory {
  id: string;
  /** false when the id is not active in the lock (retired or unknown). */
  known: boolean;
  doc?: string;
  diagram?: string;
  title?: string;
  entries: HistoryEntry[];
  changed: string[];
  firstFailure?: HistoryEntry;
  flakyCommits: string[];
}

export interface FlakyCommit {
  commit: string;
  passed: number;
  failed: number;
}

export interface FlakyEntry {
  id: string;
  doc: string;
  commits: FlakyCommit[];
  lastFailedAt: string;
  lastFailedRun: string;
}

export interface CoverageCount {
  ids: number;
  linked: number;
  executed: number;
  passed: number;
}

export interface ElementCoverage {
  edges: Record<number, CoverageClass>;
  nodes: Record<string, CoverageClass>;
}

export interface DocCoverage {
  path: string;
  total: CoverageCount;
  diagrams: Record<string, CoverageCount>;
  cases: Record<string, CoverageClass>;
  elements: Record<string, ElementCoverage>;
}

const isFail = (s: string) => s === 'failed' || s === 'error';

/** Entries of one id from test runs (newest first), as `HistoryEntry[]`. */
export function entriesOf(runs: RunRecord[], id: string, hasTrace: (runId: string, id: string) => boolean = () => false): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const r of runs) {
    const res = r.results[id];
    if (res) out.push(toEntry(r, id, res, hasTrace));
  }
  return out;
}

function toEntry(r: RunRecord, id: string, res: CaseResult, hasTrace: (runId: string, id: string) => boolean): HistoryEntry {
  const e: HistoryEntry = { runId: r.id, at: r.finishedAt ?? r.startedAt, status: res.status, durationMs: res.durationMs, trace: !!r.traces?.includes(id) && hasTrace(r.id, id) };
  if (r.commit !== undefined) e.commit = r.commit;
  if (r.dirty !== undefined) e.dirty = r.dirty;
  if (r.rerunOf !== undefined) Object.assign(e, { rerunOf: r.rerunOf, attempt: r.attempt, times: r.times });
  if (res.message !== undefined) e.message = res.message;
  return e;
}

/** All ids' entries in one pass over the runs (newest first). */
export function allEntries(runs: RunRecord[]): Map<string, HistoryEntry[]> {
  const out = new Map<string, HistoryEntry[]>();
  for (const r of runs) for (const [id, res] of Object.entries(r.results)) {
    let list = out.get(id);
    if (!list) out.set(id, (list = []));
    list.push(toEntry(r, id, res, () => false));
  }
  return out;
}

/** runIds of rows whose status differs from the next older row (the oldest row is never included). */
export function changedRows(entries: HistoryEntry[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < entries.length - 1; i++) if (entries[i].status !== entries[i + 1].status) out.push(entries[i].runId);
  return out;
}

/** The oldest run of the current streak of failures (skipped rows do not break it) (DD-HIST-FIRSTFAIL). */
export function firstFailure(entries: HistoryEntry[]): HistoryEntry | undefined {
  const head = entries[0];
  if (!head || !isFail(head.status)) return undefined;
  let candidate = head;
  for (let i = 1; i < entries.length; i++) {
    const s = entries[i].status;
    if (isFail(s)) candidate = entries[i];
    else if (s === 'skipped') continue;
    else break;
  }
  return candidate;
}

function flakyGroups(entries: HistoryEntry[]): Map<string, { passed: number; failed: number }> {
  const groups = new Map<string, { passed: number; failed: number }>();
  for (const e of entries) {
    if (!e.commit || e.dirty !== false) continue;
    if (e.status !== 'passed' && e.status !== 'failed') continue;
    let g = groups.get(e.commit);
    if (!g) groups.set(e.commit, (g = { passed: 0, failed: 0 }));
    g[e.status]++;
  }
  return groups;
}

/** Commits (newest first) with both passed and failed rows, using only clean known commits (DD-HIST-FLAKY). */
export function flakyCommits(entries: HistoryEntry[]): string[] {
  const groups = flakyGroups(entries);
  // Map keeps insertion order = order of the newest row of each commit.
  return [...groups].filter(([, g]) => g.passed > 0 && g.failed > 0).map(([c]) => c);
}

export function flakyCounts(entries: HistoryEntry[]): FlakyCommit[] {
  const groups = flakyGroups(entries);
  return [...groups].filter(([, g]) => g.passed > 0 && g.failed > 0).map(([commit, g]) => ({ commit, ...g }));
}

export function recentMarks(entries: HistoryEntry[], n = 10): RecentMark[] {
  return Array.from({ length: n }, (_, i) => entries[i]?.status ?? 'none');
}

/** Coverage class of one id (DD-HIST-CLASSIFY). */
export function classify(_id: string, linked: boolean, latest: { status: TestStatus } | undefined | null): CoverageClass {
  if (!linked) return 'unlinked';
  if (!latest) return 'unexecuted';
  if (latest.status === 'passed') return 'passed';
  if (latest.status === 'skipped') return 'skipped';
  return 'failed';
}

const RANK: Record<CoverageClass, number> = { passed: 4, failed: 3, skipped: 2, unexecuted: 1, unlinked: 0 };

export function bestClass(a: CoverageClass | undefined, b: CoverageClass): CoverageClass {
  return a === undefined || RANK[b] > RANK[a] ? b : a;
}

type MatrixLike = Pick<DiagramMatrix, 'graph'> & { cases: Array<{ id: string; kind: string; edges: number[]; nodes: string[] }> };

/** Class per edge / node of a diagram: the best class of the T / P cases containing it; none when no case does (DD-HIST-ELEMENT). */
export function elementClasses(matrix: MatrixLike, cases: Record<string, CoverageClass>): ElementCoverage {
  const out: ElementCoverage = { edges: {}, nodes: {} };
  for (const c of matrix.cases) {
    const cls = cases[c.id];
    if (!cls || (c.kind !== 'T' && c.kind !== 'P')) continue;
    // T: one transition and its two ends (edges/nodes of T include the prefix path to reach it). P: everything on the path.
    const edges = c.kind === 'T' ? c.edges.slice(-1) : c.edges;
    const nodes = c.kind === 'T' ? c.nodes.slice(-2) : c.nodes;
    for (const e of edges) out.edges[e] = bestClass(out.edges[e], cls);
    for (const n of nodes) out.nodes[n] = bestClass(out.nodes[n], cls);
  }
  const edgeSet = new Set(matrix.graph.edges.map((e) => e.index));
  const nodeSet = new Set(matrix.graph.nodes.map((n) => n.id));
  for (const k of Object.keys(out.edges)) if (!edgeSet.has(Number(k))) delete out.edges[Number(k)];
  for (const k of Object.keys(out.nodes)) if (!nodeSet.has(k)) delete out.nodes[k];
  return out;
}

export const emptyCount = (): CoverageCount => ({ ids: 0, linked: 0, executed: 0, passed: 0 });

export function countClass(c: CoverageCount, cls: CoverageClass) {
  c.ids++;
  if (cls === 'unlinked') return;
  c.linked++;
  if (cls === 'unexecuted') return;
  c.executed++;
  if (cls === 'passed') c.passed++;
}

/** Trend, flaky detection and design coverage computed from the run records (DD-HIST). */
export class HistoryService {
  private cache: { summary?: HistorySummary; flaky?: FlakyEntry[] } = {};
  private actionsRuns: RunRecord[] = [];

  constructor(
    private readonly local: LocalRuns,
    private readonly lock: () => Promise<TestIdLock>,
    private readonly traces: Pick<TraceService, 'exists'>,
    private readonly coverageService: Pick<CoverageService, 'coverage'>,
  ) {
    local.onEnd(() => {
      this.cache = {};
    });
  }

  /** Run records of GitHub Actions (merged with the local ones). */
  setActionsRuns(records: RunRecord[]): void {
    this.actionsRuns = records;
    this.cache = {};
  }

  private runs(): RunRecord[] {
    return mergeRuns(this.local.list(), this.actionsRuns);
  }

  /** Latest result per test id. */
  latest(): LatestResults {
    return latestOfRuns(this.runs());
  }

  async summary(): Promise<HistorySummary> {
    if (this.cache.summary) return this.cache.summary;
    const tests: Record<string, TestSummary> = {};
    let flakyCount = 0;
    for (const [id, entries] of allEntries(this.runs())) {
      const commits = flakyCommits(entries);
      if (commits.length) flakyCount++;
      tests[id] = {
        recent: recentMarks(entries),
        recentAt: Array.from({ length: 10 }, (_, i) => (entries[i] ? { at: entries[i].at, commit: entries[i].commit, dirty: entries[i].dirty } : null)),
        flaky: commits.length > 0,
        flakyCommits: commits,
      };
    }
    const s: HistorySummary = { tests, flakyCount, rerunnable: this.local.failedIdsOfLatest().length };
    this.cache.summary = s;
    return s;
  }

  async test(id: string): Promise<TestHistory> {
    const lock = await this.lock();
    const info = activeIds(lock).get(id);
    const runs = this.runs();
    const present = new Set<string>();
    for (const r of runs) if (r.results[id] && r.traces?.includes(id) && (await this.traces.exists(r.id, id))) present.add(r.id);
    const entries = entriesOf(runs, id, (runId) => present.has(runId));
    if (!info && !entries.length) throw new HistoryError(404, 'unknown-id', `テストIDが見つかりません: ${id}`);
    const h: TestHistory = { id, known: !!info, entries, changed: changedRows(entries), flakyCommits: flakyCommits(entries) };
    if (info) Object.assign(h, { doc: info.doc, diagram: lock.diagrams[info.diagramKey]?.diagram, title: info.title });
    const ff = firstFailure(entries);
    if (ff) h.firstFailure = ff;
    return h;
  }

  async flaky(): Promise<FlakyEntry[]> {
    if (this.cache.flaky) return this.cache.flaky;
    const ids = activeIds(await this.lock());
    const out: FlakyEntry[] = [];
    for (const [id, entries] of allEntries(this.runs())) {
      const commits = flakyCounts(entries);
      if (!commits.length) continue;
      const lastFail = entries.find((e) => isFail(e.status))!;
      out.push({ id, doc: ids.get(id)?.doc ?? '', commits, lastFailedAt: lastFail.at, lastFailedRun: lastFail.runId });
    }
    out.sort((a, b) => b.lastFailedAt.localeCompare(a.lastFailedAt) || a.id.localeCompare(b.id));
    this.cache.flaky = out;
    return out;
  }

  coverage(docPath: string): Promise<DocCoverage> {
    return this.coverageService.coverage(docPath, this.latest());
  }
}