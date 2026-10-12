import type { DdvConfig } from '@ddv/core';
import type { GitHubClient } from '@ddv/github';
import type { ActionsService } from './actions/actions-service.ts';
import { CoverageService } from './coverage.ts';
import { DocService } from './docs.ts';
import type { ServiceEnv } from './env.ts';
import { HistoryService, type LocalRuns, type RunRecord } from './history.ts';
import { MatrixService } from './matrix.ts';
import { MockService, type PlayStore } from './mocks.ts';
import type { ChangeSource } from './pr-diff.ts';
import { PrService, type PrContext } from './pr.ts';
import type { RepoReader, RepoWriter } from './repo-reader.ts';
import { ReviewService, type PendingReviewStore } from './review.ts';
import type { StatusCommitter } from './status-commit.ts';
import { TestDataService } from './testdata.ts';
import { TraceService } from './traces.ts';

export * from './actions/index.ts';
export * from './config.ts';
export * from './coverage.ts';
export * from './docs.ts';
export * from './env.ts';
export * from './errors.ts';
export * from './github-reader.ts';
export * from './history.ts';
export * from './matrix.ts';
export * from './mime.ts';
export * from './mocks.ts';
export * from './pr-diff.ts';
export * from './pr.ts';
export * from './repo-path.ts';
export * from './repo-reader.ts';
export * from './repo-ref.ts';
export * from './review.ts';
export * from './status-commit.ts';
export * from './testdata.ts';
export * from './threads.ts';
export * from './traces.ts';

export interface ServiceDeps {
  env: ServiceEnv;
  reader: RepoReader;
  getConfig: () => DdvConfig;
  /** Pages: `EMPTY_RUNS`. */
  runs: LocalRuns & { get?(id: string): RunRecord | undefined };
  repoName: string;
  /** `DocService.config().repoRoot` (default `repoName`; Pages: `owner/repo`). */
  repoRoot?: string;
  /** Absent = files cannot be saved (Pages). */
  writer?: RepoWriter;
  /** Absent = scenario play results are not read. */
  plays?: PlayStore;
  /** Absent = Actions are not used (actions-run.md). */
  actions?: (history: HistoryService) => ActionsService;
  pr?: {
    context: () => Promise<PrContext>;
    github: GitHubClient;
    changes: ChangeSource;
    pending: PendingReviewStore;
    committer: StatusCommitter;
    refresh: (id: string) => Promise<void>;
  };
}

export interface Services {
  docs: DocService;
  matrix: MatrixService;
  coverage: CoverageService;
  history: HistoryService;
  traces: TraceService;
  mocks: MockService;
  testData: TestDataService<PrContext>;
  pr?: PrService;
  review?: ReviewService;
  actions?: ActionsService;
}

/** Builds the services of one repository version (server: per workspace; Pages: per target). */
export function createServices(deps: ServiceDeps): Services {
  const { reader, getConfig, runs, env } = deps;
  const matrix = new MatrixService(reader, getConfig);
  const lock = () => matrix.lock();
  const coverage = new CoverageService(reader, getConfig, matrix);
  const traces = new TraceService(reader, runs, getConfig);
  const history = new HistoryService(runs, lock, traces, coverage);
  const docs = new DocService(reader, getConfig, matrix, { repoRoot: deps.repoRoot ?? deps.repoName, repoName: deps.repoName });
  const mocks = new MockService(reader, getConfig, runs, () => docs.loadDocs(), lock, deps.plays);
  let review: ReviewService | undefined;
  let pr: PrService | undefined;
  if (deps.pr) {
    const p = deps.pr;
    review = new ReviewService({ store: p.pending, github: p.github, changes: p.changes, committer: p.committer, refresh: p.refresh, newId: () => env.newId() });
    pr = new PrService({ context: p.context, github: p.github, changes: p.changes, getConfig });
  }
  const testData = new TestDataService<PrContext>({ reader, writer: deps.writer, getConfig, env, mocks }, review);
  const services: Services = { docs, matrix, coverage, history, traces, mocks, testData, ...(pr ? { pr } : {}), ...(review ? { review } : {}) };
  if (deps.actions) services.actions = deps.actions(history);
  return services;
}
