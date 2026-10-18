/** The screen route of the viewer (pure: shared by `state.tsx` and the Pages edition's `hash-route.ts`). */
export interface Route {
  /** Workspace id ('' = local; Pages: `gh~owner~repo~pr-N` etc.). */
  ws: string;
  view: 'doc' | 'tests' | 'open' | 'folder' | 'review' | 'done';
  path: string;
  heading: string;
  /** Tests tab: '' = list, 'history' = one test id's history, 'flaky' = flaky tests, 'trace' = one test id's trace in one run. */
  sub?: '' | 'history' | 'flaky' | 'trace' | 'actions';
  /** Tests tab, `actions`: the part after `tests/actions/` ('' = list, 'setup', 'requests/<id>', 'runs/<id>', 'runs/<id>/trace/<testId>'). */
  actions?: string;
  /** Tests tab, `history` / `trace`: the test id. */
  testId?: string;
  /** Tests tab, `trace`: the run id. */
  runId?: string;
  /** Tests tab, `trace`: `?platform=` (wpf / winforms; none = web). */
  platform?: string;
  /** Pages edition: `view=diff` (open the PR diff of the document). */
  diff?: boolean;
}

/** The part of a route an href points at (`state.tsx` helpers; Pages: `formatHostedHash`). */
export type HrefView = Pick<Route, 'view' | 'path' | 'heading' | 'sub' | 'actions' | 'testId' | 'runId' | 'platform' | 'diff'>;
