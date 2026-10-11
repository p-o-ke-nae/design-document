import type { Graph, GraphDiff, StateEventTable, TestCase } from '@ddv/graph';
import type { DdvConfig, DiagramBlock, DirectiveRef, Heading, TocEntry } from '@ddv/core';

export type { Graph, GraphDiff, StateEventTable, TestCase, DdvConfig, DiagramBlock, Heading, TocEntry };

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

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !(body && typeof body === 'object' && 'ok' in body)) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  config: () => fetch('/api/config').then((r) => json<{ repoRoot: string; repoName: string; config: DdvConfig }>(r)),
  tree: () => fetch('/api/tree').then((r) => json<{ docsRoot: string; docs: TreeDoc[] }>(r)),
  doc: (path: string) => fetch(`/api/doc?path=${encodeURIComponent(path)}`).then((r) => json<DocResponse>(r)),
  resolve: (from: string, ref: string) => fetch(`/api/resolve?from=${encodeURIComponent(from)}&ref=${encodeURIComponent(ref)}`).then((r) => json<ResolveResponse>(r)),
  tests: () => fetch('/api/tests').then((r) => json<TestsResponse>(r)),
  latest: () => fetch('/api/results/latest').then((r) => json<Record<string, CaseResult>>(r)),
  runs: () => fetch('/api/runs').then((r) => json<RunSummary[]>(r)),
  run: (id: string) => fetch(`/api/runs/${id}`).then((r) => json<RunSummary>(r)),
  startRun: (body: { ids?: string[]; runner?: string }) =>
    fetch('/api/tests/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<{ id: string }>(r)),
  generateIds: () => fetch('/api/testids/generate', { method: 'POST' }).then((r) => json<{ changed: boolean; added: string[]; retired: string[] }>(r)),
  scenarios: () => fetch('/api/mocks/scenarios').then((r) => json<{ scenarios: ScenarioSummary[] }>(r)),
  scenario: (id: string) => fetch(`/api/mocks/scenario?id=${encodeURIComponent(id)}`).then((r) => json<ScenarioDetail>(r)),
  played: (body: { id: string; ok: boolean; failures?: StepFailure[] }) => post('/api/mocks/played', body).then((r) => json<unknown>(r)),
  scaffold: (body: { mock?: string } = {}) => post('/api/mocks/scaffold', body).then((r) => json<Record<string, unknown>>(r)),
  runSnapshots: (body: { ids?: string[] }) => post('/api/snapshots/run', body).then((r) => json<{ runId: string }>(r)),
  snapshots: (id: string) => fetch(`/api/snapshots?id=${encodeURIComponent(id)}`).then((r) => json<SnapshotInfo>(r)),
  approveSnapshots: (body: { id: string; steps?: number[] }) => post('/api/snapshots/approve', body).then((r) => json<unknown>(r)),
};
