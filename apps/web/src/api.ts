import type { Graph, GraphDiff, StateEventTable, TestCase } from '@ddv/graph';
import type { DdvConfig, DiagramBlock, DirectiveRef, DocElement, Heading, SourceBlock, TocEntry } from '@ddv/core';

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
}

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
  ) {
    super(message);
  }
}

const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

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
    throw new ApiError(b.message ?? b.error ?? `HTTP ${res.status}`, res.status, b.code);
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
    generateIds: () => fetch(A('/api/testids/generate'), { method: 'POST' }).then((r) => json<{ changed: boolean; added: string[]; retired: string[] }>(r)),
    scenarios: () => get<{ scenarios: ScenarioSummary[] }>('/api/mocks/scenarios'),
    scenario: (id: string) => get<ScenarioDetail>(`/api/mocks/scenario?id=${encodeURIComponent(id)}`),
    played: (body: { id: string; ok: boolean; failures?: StepFailure[] }) => post(A('/api/mocks/played'), body).then((r) => json<unknown>(r)),
    scaffold: (body: { mock?: string } = {}) => post(A('/api/mocks/scaffold'), body).then((r) => json<Record<string, unknown>>(r)),
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
