import type { Graph, GraphDiff, StateEventTable, TestCase } from '@ddv/graph';
import type { DdvConfig, DiagramBlock, DirectiveRef, DocElement, Heading, SourceBlock, TocEntry } from '@ddv/core';
import type { ElementPatch } from '@ddv/mock/tune-patch';
import type { TraceFile } from '@ddv/mock/trace-format';

export type { Graph, GraphDiff, StateEventTable, TestCase, DdvConfig, DiagramBlock, DocElement, Heading, SourceBlock, TocEntry };

export interface TestLink {
  id: string;
  runner: string;
  level: 'unit' | 'integration';
  file: string;
  line: number;
  test: string;
}

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface CaseResult {
  status: TestStatus;
  durationMs: number;
  message?: string;
  runner: string;
  test: string;
  runId?: string;
  at?: string;
  /** `/api/results/latest`: the trace of that run is still there. */
  trace?: boolean;
}

/** `GET /api/traces/{runId}/{testId}`: the trace plus the run's commit. */
export type TraceResponse = TraceFile & { commit?: string; dirty?: boolean };

export interface MatrixCase extends TestCase {
  id: string;
  provisional: boolean;
  links: TestLink[];
}

export interface Matrix {
  doc: string;
  diagram: string;
  diagramKey: string;
  level: 'unit' | 'integration';
  graph: Graph;
  cases: MatrixCase[];
  table?: StateEventTable;
  retired: Array<{ signature: string; id: string }>;
  warnings: string[];
}

export interface LintIssue {
  severity: 'error' | 'warning';
  rule: string;
  path: string;
  line?: number;
  message: string;
}

export interface DocResponse {
  path: string;
  kind: string;
  id: string;
  title: string;
  status: string;
  frontMatter: Record<string, unknown>;
  /** `traces` resolved to the defining documents (`path` is absent when unknown) */
  traces: Array<{ code: string; path?: string }>;
  text: string;
  headings: Heading[];
  toc: TocEntry[];
  diagrams: DiagramBlock[];
  directives: DirectiveRef[];
  /** Commentable source blocks (absent on older servers). */
  blocks?: SourceBlock[];
  graphs: Record<string, Graph>;
  diffs: Record<string, GraphDiff & { compare: string }>;
  matrices: Matrix[];
  issues: LintIssue[];
}

export interface TreeDoc {
  path: string;
  kind: string;
  title: string;
  id: string;
  status: string;
  traces: string[];
}

export interface ResolveResponse {
  ok: boolean;
  path: string;
  heading: string;
  slug?: string;
  title?: string;
  line?: number;
  markdown?: string;
  error?: string;
}

export interface TestsResponse {
  cases: Array<{ id: string; diagramKey: string; signature: string; title: string; doc: string; level: 'unit' | 'integration'; links: TestLink[]; latest: CaseResult | null }>;
  unknown: TestLink[];
  runners: Array<{ name: string; type: string; level: string; cwd: string }>;
}

export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  request: { ids?: string[]; runner?: string };
  runners: Array<{ name: string; command: string; exitCode: number | null; error?: string }>;
  results: Record<string, CaseResult>;
  total: number;
  log?: string[];
  kind?: string;
  commit?: string;
  dirty?: boolean;
  rerunOf?: string;
  attempt?: number;
  times?: number;
  traces?: string[];
  /** `/api/runs/{id}`: whether each trace file still exists. */
  traceOf?: Record<string, boolean>;
}

export type RecentMark = TestStatus | 'none';
export type CoverageClass = 'unlinked' | 'unexecuted' | 'passed' | 'failed' | 'skipped';

export interface TestSummary {
  recent: RecentMark[];
  recentAt: Array<{ at: string; commit?: string; dirty?: boolean } | null>;
  flaky: boolean;
  flakyCommits: string[];
}

export interface HistorySummary {
  tests: Record<string, TestSummary>;
  flakyCount: number;
  rerunnable: number;
}

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

export interface TestHistory {
  id: string;
  known: boolean;
  doc?: string;
  diagram?: string;
  title?: string;
  entries: HistoryEntry[];
  changed: string[];
  firstFailure?: HistoryEntry;
  flakyCommits: string[];
}

export interface FlakyEntry {
  id: string;
  doc: string;
  commits: Array<{ commit: string; passed: number; failed: number }>;
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

export type StepValue = string | number | boolean;

export interface StepExpect {
  screen: string;
  visible?: string[];
  hidden?: string[];
  text?: Record<string, string>;
  count?: Record<string, number>;
}

export interface Step {
  event: string;
  click?: string;
  input?: Record<string, StepValue>;
  do?: string;
  wait?: number;
  expect: StepExpect;
}

export type ScenarioStatus = 'Unverified' | 'Passed' | 'Failed' | 'Retired';

export interface ScenarioSummary {
  id: string;
  title: string;
  mock: string;
  file: string;
  status: ScenarioStatus;
  issues: string[];
}

export interface ScenarioTransition {
  from: string;
  to: string;
  event: string;
  guard?: string;
  edge: number;
}

export interface ScenarioDetail {
  id: string;
  title: string;
  mock: string;
  /** Relative to mocksRoot, e.g. "order/index.html". */
  mockPath: string;
  doc: string | null;
  /** Screen transition diagram id in doc. */
  diagram: string | null;
  /** null when the file could not be parsed (see issues). */
  scenario: { id: string; title: string; fixtures?: string[]; start: string; steps: Step[] } | null;
  transitions: ScenarioTransition[];
  edges: number[];
  issues: string[];
}

export interface StepFailure {
  key: string;
  expected: unknown;
  actual: unknown;
}

export type SnapshotStatus = 'None' | 'NoBase' | 'Match' | 'Diff';

export interface SnapshotStep {
  /** 1-based step number. */
  step: number;
  status: SnapshotStatus;
  diffRatio?: number;
  warnings: string[];
  images: { baseline?: string; current?: string; diff?: string };
}

export interface SnapshotInfo {
  id: string;
  browser?: string;
  steps: SnapshotStep[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Response body of a refused request (test data save: errors / warnings). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// --- Test data editor (DD-TDEDIT) ---

export type TdValue = string | number | boolean | null;
export type TdRow = Record<string, TdValue>;
export type FixtureTables = Record<string, TdRow[]>;
export type TdWorkspaceKind = 'local' | 'pr' | 'branch';
export type IssueCode = 'schema' | 'generated' | 'duplicateKey' | 'emptyKey' | 'unknownFixture' | 'conflict' | 'unknownElement' | 'unknownTable' | 'sharedFixture';

export interface TdScenario {
  id: string;
  title: string;
  fixtures?: string[];
  start: string;
  steps: Step[];
}

export interface FileData<T> {
  name: string;
  path: string;
  hash: string;
  data: T;
}

export interface MockField {
  key: string;
  kind: 'text' | 'number' | 'select' | 'checkbox';
  required: boolean;
  options: string[];
}

export interface TestDataBundle {
  scenario: FileData<TdScenario>;
  fixtures: FileData<FixtureTables>[];
  availableFixtures: string[];
  mock: { fields: MockField[]; testids: string[]; tables: Array<{ name: string; key: string }> };
  editable: boolean;
  readonlyReason?: string;
  workspace: TdWorkspaceKind;
  headSha?: string;
  transitions: ScenarioTransition[];
  retired: boolean;
}

export interface TestDataDraft {
  scenarioId: string;
  scenario: TdScenario;
  fixtures: Record<string, FixtureTables>;
  base: Record<string, string>;
  headSha?: string;
  comment?: string;
}

export interface DataIssue {
  file: string;
  path: string;
  code: IssueCode;
  message: string;
}

export interface LineHunk {
  startLine: number;
  endLine: number;
  before: string[];
  after: string[];
}

export interface ValidationResult {
  errors: DataIssue[];
  warnings: DataIssue[];
  diff: Array<{ path: string; hunks: LineHunk[] }>;
}

export interface SaveResult {
  mode: 'file' | 'suggestion';
  files: string[];
  comments: string[];
  warnings?: string[];
}

export interface DepsTarget {
  dir: string;
  lockfile?: string;
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  command: string;
  args: string[];
  runners: string[];
  missing: string[];
}

export interface DepsStatus {
  needed: boolean;
  targets: DepsTarget[];
  problems: string[];
}

/** Detail of the `ddv-deps-missing` window event: `retry` re-sends the refused test run. */
export interface DepsMissingDetail {
  retry: () => void;
}

const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const send = (method: string, url: string, body?: unknown) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const BAD_RESPONSE = 'サーバの応答を解釈できません（サーバが古い可能性があります。再起動してください）';

export async function json<T>(res: Response): Promise<T> {
  const text = await res.text().catch(() => '');
  let body: unknown = {};
  let parsed = true;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }
  if (res.ok && !parsed) throw new ApiError(BAD_RESPONSE, res.status, 'bad-response');
  if (!res.ok && !(body && typeof body === 'object' && 'ok' in body)) {
    const b = body as { error?: string; message?: string; code?: string };
    if (res.status === 403 && b.code === 'untrusted') window.dispatchEvent(new CustomEvent('ddv-untrusted'));
    if (res.status === 401 && (b.code === 'session-required' || b.code === 'bad-token')) window.dispatchEvent(new CustomEvent('ddv-session-required'));
    throw new ApiError(b.message ?? b.error ?? `HTTP ${res.status}`, res.status, b.code, body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined);
  }
  return body as T;
}

/** `/api/...` of the given workspace ('' = the local one): `/api/w/<ws>/...`. */
export function apiPath(ws: string, p: string): string {
  return ws ? `/api/w/${encodeURIComponent(ws)}${p.replace(/^\/api/, '')}` : p;
}

/** `/raw/...` of the given workspace: `/w/<ws>/raw/...`. */
export function rawPath(ws: string, p: string): string {
  return ws ? `/w/${encodeURIComponent(ws)}${p}` : p;
}

export function createApi(ws: string) {
  const A = (p: string) => apiPath(ws, p);
  const get = <T>(p: string) => fetch(A(p)).then((r) => json<T>(r));
  return {
    config: () => get<{ repoRoot: string; repoName: string; config: DdvConfig }>('/api/config'),
    tree: () => get<{ docsRoot: string; docs: TreeDoc[] }>('/api/tree'),
    doc: (path: string) => get<DocResponse>(`/api/doc?path=${encodeURIComponent(path)}`),
    resolve: (from: string, ref: string) => get<ResolveResponse>(`/api/resolve?from=${encodeURIComponent(from)}&ref=${encodeURIComponent(ref)}`),
    tests: () => get<TestsResponse>('/api/tests'),
    latest: () => get<Record<string, CaseResult>>('/api/results/latest'),
    runs: () => get<RunSummary[]>('/api/runs'),
    run: (id: string) => get<RunSummary>(`/api/runs/${id}`),
    startRun: (body: { ids?: string[]; runner?: string }) => post(A('/api/tests/run'), body).then((r) => json<{ id: string }>(r)),
    rerun: (times: number) => post(A('/api/tests/rerun'), { times }).then((r) => json<{ id: string; status: 'running'; rerunOf: string; attempt: number; times: number }>(r)),
    historySummary: () => get<HistorySummary>('/api/history/summary'),
    historyTest: (id: string) => get<TestHistory>(`/api/history/tests/${encodeURIComponent(id)}`),
    flaky: () => get<FlakyEntry[]>('/api/history/flaky'),
    trace: (runId: string, id: string) => get<TraceResponse>(`/api/traces/${encodeURIComponent(runId)}/${encodeURIComponent(id)}`),
    traceShot: (runId: string, id: string, n: number) => A(`/api/traces/${encodeURIComponent(runId)}/${encodeURIComponent(id)}/steps/${n}.png`),
    coverage: (path: string) => get<DocCoverage>(`/api/coverage?path=${encodeURIComponent(path)}`),
    deps: () => get<DepsStatus>('/api/deps'),
    installDeps: () => post(A('/api/deps/install')).then((r) => json<{ runId: string; deps: DepsStatus }>(r)),
    generateIds: () => fetch(A('/api/testids/generate'), { method: 'POST' }).then((r) => json<{ changed: boolean; added: string[]; retired: string[] }>(r)),
    scenarios: () => get<{ scenarios: ScenarioSummary[] }>('/api/mocks/scenarios'),
    scenario: (id: string) => get<ScenarioDetail>(`/api/mocks/scenario?id=${encodeURIComponent(id)}`),
    played: (body: { id: string; ok: boolean; failures?: StepFailure[] }) => post(A('/api/mocks/played'), body).then((r) => json<unknown>(r)),
    testData: (scenario: string) => get<TestDataBundle>(`/api/testdata?scenario=${encodeURIComponent(scenario)}`),
    validateTestData: (draft: TestDataDraft) => post(A('/api/testdata/validate'), draft).then((r) => json<ValidationResult>(r)),
    saveTestData: (draft: TestDataDraft) => post(A('/api/testdata/save'), draft).then((r) => json<SaveResult>(r)),
    scaffold: (body: { mock?: string } = {}) => post(A('/api/mocks/scaffold'), body).then((r) => json<Record<string, unknown>>(r)),
    mockSource: (body: { mock: string; path: number[]; expect: { tag: string; testid?: string }; patch?: ElementPatch }) =>
      post(A('/api/mock-source'), body).then((r) => json<MockSourceResult>(r)),
    runSnapshots: (body: { ids?: string[] }) => post(A('/api/snapshots/run'), body).then((r) => json<{ runId: string }>(r)),
    snapshots: (id: string) =>
      get<SnapshotInfo>(`/api/snapshots?id=${encodeURIComponent(id)}`).then((s) => ({
        ...s,
        steps: s.steps.map((st) => ({ ...st, images: Object.fromEntries(Object.entries(st.images).map(([k, v]) => [k, v && A(v)])) })),
      })),
    approveSnapshots: (body: { id: string; steps?: number[] }) => post(A('/api/snapshots/approve'), body).then((r) => json<unknown>(r)),
    prFiles: () => get<ChangedFiles>('/api/pr/files'),
    prDiff: (path: string) => get<DocDiff>(`/api/pr/diff?path=${encodeURIComponent(path)}`),
    prThreads: (path?: string) => get<Thread[]>(path ? `/api/pr/threads?path=${encodeURIComponent(path)}` : '/api/pr/threads'),
    review: () => get<PendingReview>('/api/review'),
    addComment: (body: CommentInput) => post(A('/api/review/comments'), body).then((r) => json<PendingComment>(r)),
    updateComment: (id: string, body: Partial<CommentInput>) => send('PATCH', A(`/api/review/comments/${encodeURIComponent(id)}`), body).then((r) => json<PendingComment>(r)),
    deleteComment: (id: string) => send('DELETE', A(`/api/review/comments/${encodeURIComponent(id)}`)).then((r) => json<{ ok: boolean }>(r)),
    submitReview: (body: { event: ReviewEvent; body?: string; approveDocs?: string[] }) => post(A('/api/review/submit'), body).then((r) => json<SubmitResult>(r)),
    reviews: () => get<ReviewerState[]>('/api/reviews'),
    replyThread: (id: string, body: string) => post(A(`/api/pr/threads/${encodeURIComponent(id)}/replies`), { body }).then((r) => json<ThreadComment>(r)),
    resolveThread: (id: string, resolved: boolean) => post(A(`/api/pr/threads/${encodeURIComponent(id)}/resolve`), { resolved }).then((r) => json<{ id: string; resolved: boolean }>(r)),
  };
}

let currentWs = '';

/** The workspace the viewer shows ('' = local). `api`, `apiUrl` and `rawUrl` follow it. */
export function workspace(): string {
  return currentWs;
}

export function setWorkspace(ws: string): void {
  if (ws === currentWs) return;
  currentWs = ws;
  api = createApi(ws);
}

export function apiUrl(p: string): string {
  return apiPath(currentWs, p);
}

export function rawUrl(p: string): string {
  return rawPath(currentWs, p);
}

export let api = createApi('');

// --- GitHub workspaces ---

export type WsState = 'None' | 'Fetching' | 'Ready' | 'Stale' | 'Error';
export type FetchStep = 'pr' | 'clone' | 'fetch' | 'worktree' | 'ready' | 'error';

export interface WorkspaceInfo {
  id: string;
  repo: string;
  kind: 'pr' | 'ref';
  pr?: number;
  ref?: string;
  title?: string;
  state: WsState;
  step?: FetchStep;
  error?: string;
  trusted: boolean;
  headSha: string;
  remoteHeadSha?: string;
  openedAt: string;
}

export interface AuthStatus {
  source: 'gh' | 'env' | 'none';
  login: string;
  reason?: 'missing' | 'invalid';
}

export interface PullSummary {
  number: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
}

export interface PrInfo extends Omit<WorkspaceInfo, 'pr'> {
  baseRef?: string;
  mergeBase?: string;
  pr: { number: number; title: string; state: 'open' | 'closed'; merged: boolean; htmlUrl: string; baseRef: string; headRef: string; headSha: string } | null;
  /** Latest review state per reviewer. */
  reviews?: ReviewerState[];
}

export interface ReviewerState {
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  submittedAt?: string;
}

// --- PR diff / review threads (REVCMT) ---

export type FileStatus = 'A' | 'M' | 'D' | 'R';

export interface ChangedFile {
  status: FileStatus;
  path: string;
  oldPath?: string;
}

export interface ChangedFiles {
  base?: string;
  head: string;
  docs: ChangedFile[];
  mocks: ChangedFile[];
  others: number;
}

export interface DiagramDiff {
  change: 'added' | 'changed' | 'unchanged' | 'removed';
  beforeId?: string;
  before?: string;
  diff?: GraphDiff;
}

export interface DocDiff {
  path: string;
  status: FileStatus | null;
  oldPath?: string;
  base?: string;
  head: string;
  blocks: { line: number; endLine: number; change: 'added' | 'changed' }[];
  removed: { beforeLine: number | null; markdown: string }[];
  diagrams: Record<string, DiagramDiff>;
  ids: { added: string[]; retired: string[] };
}

export interface ThreadComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export type ThreadPlacement = { kind: 'element'; element: DocElement } | { kind: 'file' } | { kind: 'outdated' };

export interface Thread {
  id: string;
  url: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  side: 'LEFT' | 'RIGHT';
  comments: ThreadComment[];
  placement?: ThreadPlacement;
}

// --- pending review (REVCMT) ---

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ElementRef {
  kind: 'block' | 'tableRow' | 'node' | 'edge' | 'diagram' | 'matrixRow' | 'mockElement' | 'testData';
  key: string;
  label?: string;
}

export interface PendingComment {
  id: string;
  anchor: { path: string; side: 'LEFT' | 'RIGHT'; startLine: number; line: number; lineText: string[]; element: Required<ElementRef> };
  body: string;
  suggestion?: string;
  state: 'Pending' | 'Drifted';
  placement: 'line' | 'file' | 'body';
  shrunk?: boolean;
  commitId: string;
  reason?: string;
}

export interface PendingReview {
  headSha: string;
  mergeBase?: string;
  comments: PendingComment[];
}

export interface CommentInput {
  path: string;
  element: ElementRef;
  body: string;
  suggestion?: string;
  /** Line anchor (required for `mockElement`). */
  anchor?: { path: string; side: 'RIGHT'; startLine: number; line: number; element: Required<ElementRef> };
}

export interface MockSourceElement {
  path: number[];
  tag: string;
  startLine: number;
  endLine: number;
  textCount: number;
  source: string[];
  sourceStartLine: number;
}

export interface MockSuggestion {
  startLine: number;
  line: number;
  lines: string[];
  changed: boolean;
}

export interface MockSourceResult {
  /** Repo-relative path of the mock HTML. */
  file: string;
  element: MockSourceElement;
  suggestion?: MockSuggestion;
}

export interface SubmitResult {
  reviewId: number;
  reviewUrl: string;
  posted: { line: number; file: number; body?: number };
  failed: { id: string; message: string }[];
  statusCommit?: { mode: 'commit'; sha: string; paths: string[] } | { mode: 'suggestion'; paths: string[] };
  warnings?: string[];
}

export const gh = {
  auth: () => fetch('/api/github/auth').then((r) => json<AuthStatus>(r)),
  pulls: (repo: string) => fetch(`/api/github/pulls?repo=${encodeURIComponent(repo)}`).then((r) => json<PullSummary[]>(r)),
  workspaces: () => fetch('/api/workspaces').then((r) => json<{ local: boolean; workspaces: WorkspaceInfo[] }>(r)),
  open: (body: { repo: string; pr?: string; ref?: string }) => post('/api/workspaces', body).then((r) => json<{ id: string; state: WsState }>(r)),
  info: (id: string) => fetch(`/api/workspaces/${encodeURIComponent(id)}`).then((r) => json<WorkspaceInfo>(r)),
  refresh: (id: string) => post(`/api/workspaces/${encodeURIComponent(id)}/refresh`).then((r) => json<WorkspaceInfo>(r)),
  trust: (id: string) => post(`/api/workspaces/${encodeURIComponent(id)}/trust`).then((r) => json<WorkspaceInfo>(r)),
  check: (id: string) => post(`/api/workspaces/${encodeURIComponent(id)}/check`).then((r) => json<WorkspaceInfo & { stale: boolean }>(r)),
  close: (id: string) => fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<unknown>(r)),
  pr: (id: string) => fetch(apiPath(id, '/api/pr')).then((r) => json<PrInfo>(r)),
  eventsUrl: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/events`,
};

// --- Local folder (LOCALF) ---

export interface RecentFolder {
  path: string;
  openedAt: string;
  hasConfig: boolean;
}

export type BusyKind = 'test' | 'snapshot' | 'deps';

export interface LocalInfo {
  state: 'Empty' | 'Open' | 'Swapping';
  root: string | null;
  repoName: string | null;
  hasConfig: boolean;
  busy: BusyKind | null;
  recent: RecentFolder[];
}

export interface DirEntry {
  name: string;
  path: string;
  kind: 'dir' | 'home' | 'drive';
  hasConfig: boolean;
}

export interface DirList {
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
  truncated: boolean;
}

/** SSE `local` of `/api/events`: the local folder was swapped or closed. */
export interface LocalEvent {
  root: string | null;
  repoName: string | null;
  generation: number;
}

export const localApi = {
  info: () => fetch('/api/local').then((r) => json<LocalInfo>(r)),
  open: (path: string) => post('/api/local/open', { path }).then((r) => json<{ root: string; repoName: string; hasConfig: boolean }>(r)),
  close: () => post('/api/local/close').then((r) => json<{ ok: true }>(r)),
  removeRecent: (path: string) => send('DELETE', '/api/local/recent', { path }).then((r) => json<{ recent: RecentFolder[] }>(r)),
  dirs: (path?: string) => fetch(path === undefined ? '/api/fs/dirs' : `/api/fs/dirs?path=${encodeURIComponent(path)}`).then((r) => json<DirList>(r)),
  eventsUrl: '/api/events',
};