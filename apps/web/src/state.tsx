import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { emitActionsEvent, resetActionsEvents } from './actionsApi.ts';
import { api, workspace } from './backend/index.ts';
import { ApiError } from './backend/types.ts';
import type { CaseResult, DdvConfig, DepsMissingDetail, HistorySummary, RunSummary } from './api.ts';

export interface Route {
  /** Workspace id ('' = local). */
  ws: string;
  view: 'doc' | 'tests' | 'open' | 'folder' | 'review' | 'done';
  path: string;
  heading: string;
  /** Tests tab: '' = list, 'history' = one test id's history, 'flaky' = flaky tests, 'trace' = one test id's trace in one run. */
  sub?: '' | 'history' | 'flaky' | 'trace' | 'actions';
  /** Tests tab, `actions`: the part after `#/tests/actions/` ('' = list, 'setup', 'requests/<id>', 'runs/<id>', 'runs/<id>/trace/<testId>'). */
  actions?: string;
  /** Tests tab, `history` / `trace`: the test id. */
  testId?: string;
  /** Tests tab, `trace`: the run id. */
  runId?: string;
}

/** `#/doc?path=…` / `#/tests` / `#/tests/history/<id>` / `#/tests/trace/<run>/<id>` / `#/tests/flaky` / `#/open` / `#/folder`, and the same under `#/w/<ws>` for a GitHub workspace (+ `#/w/<ws>/review` / `#/w/<ws>/review/done`). */
export function parseHash(hash: string): Route {
  let h = hash.replace(/^#/, '');
  let ws = '';
  const m = /^\/w\/([^/?]+)(.*)$/.exec(h);
  if (m) {
    ws = decodeURIComponent(m[1]);
    h = m[2] || '/';
  }
  const [p, q = ''] = h.split('?');
  const params = new URLSearchParams(q);
  if (p === '/open') return { ws: '', view: 'open', path: '', heading: '' };
  if (p === '/folder') return { ws: '', view: 'folder', path: '', heading: '' };
  if (p === '/tests') return { ws, view: 'tests', path: '', heading: '' };
  const am = /^\/tests\/actions(?:\/(.*))?$/.exec(p);
  if (am) return { ws, view: 'tests', path: '', heading: '', sub: 'actions', actions: am[1] ?? '' };
  if (p === '/tests/flaky') return { ws, view: 'tests', path: '', heading: '', sub: 'flaky' };
  const hm = /^\/tests\/history\/([^/]+)$/.exec(p);
  if (hm) return { ws, view: 'tests', path: '', heading: '', sub: 'history', testId: decodeURIComponent(hm[1]) };
  const tm = /^\/tests\/trace\/([^/]+)\/([^/]+)$/.exec(p);
  if (tm) return { ws, view: 'tests', path: '', heading: '', sub: 'trace', runId: decodeURIComponent(tm[1]), testId: decodeURIComponent(tm[2]) };
  if (ws && p === '/review') return { ws, view: 'review', path: '', heading: '' };
  if (ws && p === '/review/done') return { ws, view: 'done', path: '', heading: '' };
  return { ws, view: 'doc', path: params.get('path') ?? '', heading: params.get('h') ?? '' };
}

/** Hash prefix of a workspace: '#' (local) or '#/w/<ws>'. */
export function wsBase(ws = workspace()): string {
  return ws ? `#/w/${encodeURIComponent(ws)}` : '#';
}

export function docHref(path: string, heading = ''): string {
  const q = new URLSearchParams({ path });
  if (heading) q.set('h', heading);
  return `${wsBase()}/doc?${q}`;
}

export function viewHref(view: 'tests' | 'root'): string {
  return `${wsBase()}/${view === 'tests' ? 'tests' : ''}`;
}

export function historyHref(id: string): string {
  return `${wsBase()}/tests/history/${encodeURIComponent(id)}`;
}

export function flakyHref(): string {
  return `${wsBase()}/tests/flaky`;
}

/** Trace view of one test id in one run. */
export function traceHref(runId: string, id: string): string {
  return `${wsBase()}/tests/trace/${encodeURIComponent(runId)}/${encodeURIComponent(id)}`;
}

/** Actions tab of the tests view (actions-run.md「画面」): `part` = '' (list) / 'setup' / 'requests/<id>' / 'runs/<id>'. */
export function actionsHref(part = ''): string {
  return `${wsBase()}/tests/actions${part ? `/${part}` : ''}`;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      localStorage.setItem(key, JSON.stringify(nv));
    },
    [key],
  );
  return [v, set];
}

interface AppState {
  config: DdvConfig | null;
  repoName: string;
  route: Route;
  /** Increments whenever repository files change. */
  version: number;
  latest: Record<string, CaseResult>;
  activeRun: RunSummary | null;
  runLog: string[];
  runError: string;
  runTests(body: { ids?: string[]; runner?: string }): Promise<void>;
  /** Re-runs the failures of the latest run `times` times. Resolves to the error text ('' = started). */
  rerunTests(times: number): Promise<string>;
  /** Trend / flaky summary (refetched on file changes and at the end of each run). */
  history: HistorySummary | null;
  showMatrix: boolean;
  setShowMatrix(v: boolean): void;
  refreshResults(): void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider missing');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<DdvConfig | null>(null);
  const [repoName, setRepoName] = useState('');
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [version, setVersion] = useState(0);
  const [latest, setLatest] = useState<Record<string, CaseResult>>({});
  const [activeRun, setActiveRun] = useState<RunSummary | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runError, setRunError] = useState('');
  const [showMatrix, setShowMatrix] = useLocalStorage('ddv.showMatrix', true);
  const [history, setHistory] = useState<HistorySummary | null>(null);
  const followRef = useRef<{ id: string; stop: () => void } | null>(null);

  const refreshResults = useCallback(() => {
    api.latest().then(setLatest).catch(() => {});
    api.historySummary().then(setHistory).catch(() => {});
  }, []);

  const follow = useCallback(
    async (run: RunSummary) => {
      const id = run.id;
      // Re-run attempts follow each other: drop the previous subscription so that its late result does not win.
      followRef.current?.stop();
      setRunLog([]);
      setActiveRun(run);
      let stopped = false;
      await new Promise<void>((resolve) => {
        const unsubscribe = api.followRun(id, {
          onLog: (line) => setRunLog((l) => [...l, line]),
          onEnd: () => resolve(),
        });
        followRef.current = {
          id,
          stop: () => {
            stopped = true;
            unsubscribe();
            resolve();
          },
        };
      });
      if (stopped) return;
      const done = await api.run(id);
      if (followRef.current?.id !== id) return;
      setActiveRun({ ...done, total: Object.keys(done.results).length });
      refreshResults();
    },
    [refreshResults],
  );

  useEffect(() => {
    api.config().then((c) => {
      setConfig(c.config);
      setRepoName(c.repoName);
      document.title = `ddv - ${c.repoName}`;
    });
    refreshResults();
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    resetActionsEvents();
    const unsubscribe = api.subscribe((ev) => {
      if (ev.type === 'actions') {
        emitActionsEvent(ev.data as never);
        if (ev.data.type === 'history') refreshResults();
      } else if (ev.type === 'change') setVersion((v) => v + 1);
      else if (ev.type === 'run-end') refreshResults();
      else if (ev.type === 'resync') {
        // Events may have been missed while reconnecting: the same as a change.
        refreshResults();
        setVersion((v) => v + 1);
      } else if (ev.type === 'run')
        void follow({ id: ev.id, startedAt: new Date().toISOString(), status: 'running', request: {}, runners: [], results: {}, total: 0, rerunOf: ev.rerunOf, attempt: ev.attempt, times: ev.times });
    });
    return () => {
      window.removeEventListener('hashchange', onHash);
      unsubscribe();
    };
  }, [refreshResults, follow]);

  // Attach to a run already in progress on the server (e.g. started from another tab).
  useEffect(() => {
    api
      .runs()
      .then((rs) => {
        const r = rs.find((x) => x.status === 'running');
        if (r) void follow(r);
      })
      .catch(() => {});
  }, [follow]);

  const runTests = useCallback(
    async (body: { ids?: string[]; runner?: string }) => {
      setRunError('');
      let id: string;
      try {
        id = (await api.startRun(body)).id;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'deps-missing') {
          window.dispatchEvent(new CustomEvent<DepsMissingDetail>('ddv-deps-missing', { detail: { retry: () => void runTestsRef.current(body) } }));
        }
        setRunError((e as Error).message);
        return;
      }
      await follow({ id, startedAt: new Date().toISOString(), status: 'running', request: body, runners: [], results: {}, total: 0 });
    },
    [follow],
  );
  const runTestsRef = useRef(runTests);
  runTestsRef.current = runTests;

  const rerunTests = useCallback(
    async (times: number): Promise<string> => {
      setRunError('');
      let r: Awaited<ReturnType<typeof api.rerun>>;
      try {
        r = await api.rerun(times);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'deps-missing') {
          window.dispatchEvent(new CustomEvent<DepsMissingDetail>('ddv-deps-missing', { detail: { retry: () => void rerunRef.current(times) } }));
        }
        return (e as Error).message;
      }
      void follow({ id: r.id, startedAt: new Date().toISOString(), status: 'running', request: {}, runners: [], results: {}, total: 0, rerunOf: r.rerunOf, attempt: r.attempt, times: r.times });
      return '';
    },
    [follow],
  );
  const rerunRef = useRef(rerunTests);
  rerunRef.current = rerunTests;

  useEffect(() => {
    if (version) api.historySummary().then(setHistory).catch(() => {});
  }, [version]);

  const value = useMemo<AppState>(
    () => ({ config, repoName, route, version, latest, activeRun, runLog, runError, runTests, rerunTests, history, showMatrix, setShowMatrix, refreshResults }),
    [config, repoName, route, version, latest, activeRun, runLog, runError, runTests, rerunTests, history, showMatrix, setShowMatrix, refreshResults],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
