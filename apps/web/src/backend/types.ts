/** Backend types shared by HttpBackend / PagesBackend (detailed design: services.md「Backend」). Pure: no imports of `fetch` / `EventSource` code. */
import type { RepoReader } from '@ddv/services';
import type { createApi } from '../api.ts';
import type { GitHubOp } from '../pages/permission.ts';

/** Error of an API call as the screens see it (same as the one `json()` of api.ts makes). */
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

export type Edition = 'local' | 'pages';

export type Unsubscribe = () => void;

export type { GitHubOp };

// OperationId の値と理由の文言は pages-viewer.md の「操作の一覧」と同じ（正本はこの型。OperationGate も引く）
export type OperationId =
  | 'viewUncommitted'
  | 'saveFile'
  | 'generateTestIds'
  | 'lint'
  | 'scaffold'
  | 'runLocal'
  | 'installDeps'
  | 'snapshotLocal'
  | 'comment'
  | 'reply'
  | 'resolveThread'
  | 'submitReview'
  | 'suggestTestData'
  | 'suggestMock'
  | 'approveStatus'
  | 'actionsDispatch'
  | 'snapshotApprove';

export const OPERATION_IDS: readonly OperationId[] = [
  'viewUncommitted',
  'saveFile',
  'generateTestIds',
  'lint',
  'scaffold',
  'runLocal',
  'installDeps',
  'snapshotLocal',
  'comment',
  'reply',
  'resolveThread',
  'submitReview',
  'suggestTestData',
  'suggestMock',
  'approveStatus',
  'actionsDispatch',
  'snapshotApprove',
];

export type AvailabilityKind = 'available' | 'unsupported' | 'write';

export type Availability = { kind: 'available' } | { kind: 'unsupported'; reason: string } | { kind: 'write'; gitHubOp: GitHubOp };

/** Actions events (actions-run.md; the SSE `actions` payload). Defined by the Actions slice. */
export type ActionsEvent = { type: string } & Record<string, unknown>;

export type BackendEvent =
  | { type: 'change'; paths: string[] }
  | { type: 'run'; id: string; kind: 'test'; rerunOf?: string; attempt?: number; times?: number }
  | { type: 'run-end'; id: string; kind: string }
  | { type: 'actions'; data: ActionsEvent }
  | { type: 'stale'; headSha: string }
  | { type: 'resync' }
  /** Local edition only: the local folder was swapped / closed (local-folder.md; SSE `local` of `/api/events`). */
  | { type: 'local'; root: string | null; repoName: string | null; generation: number };

export type BackendListener = (ev: BackendEvent) => void;

/** `OperationGate.check(op)` (pages-viewer.md). */
export interface GateResult {
  enabled: boolean;
  reason?: string;
}

type ApiMethods = ReturnType<typeof createApi>;

/**
 * What the screens call (services.md「メソッド」): the same methods as `createApi(ws)` plus the members below.
 * `traceShot` / `rawUrl` resolve asynchronously (Pages makes `blob:` URLs).
 */
export type Backend = Omit<ApiMethods, 'traceShot'> & {
  readonly edition: Edition;
  readonly capabilities: Readonly<Record<OperationId, Availability>>;
  subscribe(listener: BackendListener): Unsubscribe;
  /** Local runs (`GET /api/runs/{id}/events`). Pages has no local runs and never calls it. */
  followRun(id: string, handlers: RunHandlers): Unsubscribe;
  traceShot(runId: string, id: string, n: number): Promise<string>;
  rawUrl(p: string): Promise<string>;
  /** Pages: the target head's reader (MockFrame builds `srcdoc` from it). Local: `null`. */
  repo(): RepoReader | null;
};

export interface RunHandlers {
  onLog?(line: string): void;
  onEvent?(name: string, data: string): void;
  onEnd?(status: string): void;
}

/** What `toApiError` reads of `PatStore` (pat.md). */
export interface PatView {
  readonly state: 'none' | 'session' | 'stored';
  readonly lastClear: 'user' | 'invalid' | 'otherTab' | null;
  redact?(text: string): string;
}