import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, apiUrl, ApiError, workspace, type CaseResult, type DdvConfig, type DepsMissingDetail, type RunSummary } from './api.ts';

export interface Route {
  /** Workspace id ('' = local). */
  ws: string;
  view: 'doc' | 'tests' | 'open';
  path: string;
  heading: string;
}

/** `#/doc?path=…` / `#/tests` / `#/open`, and `#/w/<ws>/doc?path=…` / `#/w/<ws>/tests` for a GitHub workspace. */
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
  if (p === '/tests') return { ws, view: 'tests', path: '', heading: '' };
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
  const esRef = useRef<EventSource | null>(null);

  const refreshResults = useCallback(() => {
    api.latest().then(setLatest).catch(() => {});
  }, []);

  useEffect(() => {
    api.config().then((c) => {
      setConfig(c.config);
      setRepoName(c.repoName);
      document.title = `ddv - ${c.repoName}`;
    });
    refreshResults();
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    const es = new EventSource(apiUrl('/api/events'));
    es.addEventListener('change', () => setVersion((v) => v + 1));
    es.addEventListener('run-end', () => refreshResults());
    return () => {
      window.removeEventListener('hashchange', onHash);
      es.close();
    };
  }, [refreshResults]);

  const follow = useCallback(
    async (run: RunSummary) => {
      const id = run.id;
      setRunLog([]);
      setActiveRun(run);
      esRef.current?.close();
      await new Promise<void>((resolve) => {
        const es = new EventSource(apiUrl(`/api/runs/${id}/events`));
        esRef.current = es;
        es.addEventListener('log', (e) => setRunLog((l) => [...l, (e as MessageEvent).data]));
        es.addEventListener('end', () => {
          es.close();
          resolve();
        });
        es.onerror = () => {
          es.close();
          resolve();
        };
      });
      const done = await api.run(id);
      setActiveRun({ ...done, total: Object.keys(done.results).length });
      refreshResults();
    },
    [refreshResults],
  );

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

  const value = useMemo<AppState>(
    () => ({ config, repoName, route, version, latest, activeRun, runLog, runError, runTests, showMatrix, setShowMatrix, refreshResults }),
    [config, repoName, route, version, latest, activeRun, runLog, runError, runTests, showMatrix, setShowMatrix, refreshResults],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
