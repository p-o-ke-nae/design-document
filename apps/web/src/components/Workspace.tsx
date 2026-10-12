import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, apiUrl, ApiError, BAD_RESPONSE, gh, localApi, type AuthStatus, type LocalEvent, type DepsMissingDetail, type DepsStatus, type FetchStep, type PrInfo, type PullSummary, type WorkspaceInfo } from '../api.ts';
import { parseHash, type Route } from '../state.tsx';
import { ReviewStates, usePr } from './Pr.tsx';

export const LOGIN_MESSAGE = 'GitHub にログインしてください（`gh auth login` または `GITHUB_TOKEN`）';

export interface OpenDraft {
  repo: string;
  kind: 'pr' | 'ref';
  target: string;
  error?: string;
}

interface WorkspacesState {
  route: Route;
  /** null until /api/workspaces answered. */
  local: boolean | null;
  /** The open local folder (
ull root = none) and its generation (SSE `local`). */
  localInfo: { root: string | null; generation: number };
  list: WorkspaceInfo[];
  /** The GitHub workspace of the route (kept current through SSE). */
  current: WorkspaceInfo | null;
  /** The route's workspace is not open on the server. */
  missing: boolean;
  auth: AuthStatus | null;
  authError: string;
  draft: OpenDraft | null;
  /** Hash to return to from "GitHub を開く" (キャンセル). */
  backHash: string;
  reload(): Promise<void>;
  checkAuth(): Promise<AuthStatus | null>;
  setDraft(d: OpenDraft | null): void;
  setAuthError(m: string): void;
  update(info: WorkspaceInfo): void;
}

const Ctx = createContext<WorkspacesState | null>(null);

export function useWorkspaces(): WorkspacesState {
  const v = useContext(Ctx);
  if (!v) throw new Error('WorkspaceProvider missing');
  return v;
}

/** Owns the hash route's workspace, the open-workspace list and the GitHub auth status. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [local, setLocal] = useState<boolean | null>(null);
  const [localInfo, setLocalInfo] = useState<{ root: string | null; generation: number }>({ root: null, generation: 0 });
  const [list, setList] = useState<WorkspaceInfo[]>([]);
  const [current, setCurrent] = useState<WorkspaceInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState('');
  const [draft, setDraft] = useState<OpenDraft | null>(null);
  const lastHash = useRef(location.hash);
  const [backHash, setBackHash] = useState('#/');

  useEffect(() => {
    const onHash = () => {
      const next = parseHash(location.hash);
      if (next.view === 'open' && parseHash(lastHash.current).view !== 'open') setBackHash(lastHash.current || '#/');
      lastHash.current = location.hash;
      setRoute(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const reload = useCallback(async () => {
    const [r, info] = await Promise.all([gh.workspaces().catch(() => null), localApi.info().catch(() => null)]);
    if (info && typeof info === 'object' && 'root' in info) setLocalInfo((l) => ({ ...l, root: info.root }));
    // Fall back to the local workspace when the list is unavailable (e.g. a server without the GitHub feature).
    if (!r || typeof r !== 'object' || !Array.isArray(r.workspaces)) {
      setLocal(true);
      setList([]);
      return;
    }
    setLocal(r.local !== false);
    setList(r.workspaces);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The local folder swapped / closed (in this tab or another): follow it.
  useEffect(() => {
    const es = new EventSource(localApi.eventsUrl);
    let checked = 0;
    es.addEventListener('local', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as LocalEvent;
      setLocalInfo({ root: ev.root, generation: ev.generation });
      void reload();
      const r = parseHash(location.hash);
      if (!ev.root && !r.ws && r.view !== 'open' && r.view !== 'folder') location.hash = '#/folder';
    });
    // A dropped stream may mean the server restarted (the session is gone): a 401 shows TokenRequired.
    es.addEventListener('error', () => {
      if (Date.now() - checked < 5000) return;
      checked = Date.now();
      void gh.workspaces().catch(() => null);
    });
    return () => es.close();
  }, [reload]);

  const checkAuth = useCallback(async () => {
    const a = await gh.auth().catch(() => null);
    setAuth(a);
    return a;
  }, []);

  const update = useCallback((info: WorkspaceInfo) => {
    setCurrent((c) => (c && c.id === info.id ? { ...c, ...info } : info));
    setList((l) => (l.some((w) => w.id === info.id) ? l.map((w) => (w.id === info.id ? { ...w, ...info } : w)) : [...l, info]));
  }, []);

  // Follow the route's workspace: initial state, then progress / ready / stale over SSE.
  const ws = route.view === 'open' ? '' : route.ws;
  useEffect(() => {
    setCurrent(null);
    setMissing(false);
    if (!ws) return;
    let closed = false;
    let es: EventSource | null = null;
    const connect = () => {
      es = new EventSource(gh.eventsUrl(ws));
      es.addEventListener('state', (e) => update(JSON.parse((e as MessageEvent).data) as WorkspaceInfo));
      es.addEventListener('progress', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { step: FetchStep; message?: string };
        setCurrent((c) => c && { ...c, step: d.step, state: d.step === 'error' ? 'Error' : 'Fetching', error: d.step === 'error' ? d.message : undefined });
      });
      es.addEventListener('ready', () => void gh.info(ws).then(update).catch(() => {}));
      es.addEventListener('stale', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { headSha: string };
        setCurrent((c) => c && { ...c, state: 'Stale', remoteHeadSha: d.headSha });
      });
    };
    gh.info(ws)
      .then((info) => {
        if (closed) return;
        update(info);
        connect();
      })
      .catch((e: unknown) => {
        if (!closed && e instanceof ApiError && e.status === 404) setMissing(true);
      });
    return () => {
      closed = true;
      es?.close();
    };
  }, [ws, update]);

  const value = useMemo<WorkspacesState>(
    () => ({ route, local, localInfo, list, current: current && current.id === ws ? current : null, missing, auth, authError, draft, backHash, reload, checkAuth, setDraft, setAuthError, update }),
    [route, local, localInfo, list, current, ws, missing, auth, authError, draft, backHash, reload, checkAuth, update],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function wsLabel(w: Pick<WorkspaceInfo, 'repo' | 'kind' | 'pr' | 'ref'>): string {
  return w.kind === 'pr' ? `${w.repo} #${w.pr}` : `${w.repo} @${w.ref}`;
}

function authText(a: AuthStatus): string {
  if (a.source === 'none') return a.reason === 'invalid' ? 'GitHub: トークンが無効です' : 'GitHub: 未ログイン';
  return `GitHub: ${a.source === 'gh' ? 'gh' : 'GITHUB_TOKEN'}（${a.login}）`;
}

/** Header part shared by every screen: workspace switcher, GitHub auth status, "GitHub を開く". */
export function WorkspaceBar() {
  const { route, local, list, auth, authError, checkAuth, setAuthError, setDraft } = useWorkspaces();
  const value = route.view === 'open' ? '__open' : route.view === 'folder' ? '__folder' : route.ws;
  // Resolve auth only once GitHub is in use (REQ-209: a local-only session never calls gh).
  useEffect(() => {
    if (!auth && (list.length || route.view === 'open' || route.ws)) void checkAuth();
  }, [auth, list.length, route.view, route.ws, checkAuth]);

  const openGitHub = async () => {
    const a = await checkAuth();
    if (!a || a.source === 'none') {
      setAuthError(LOGIN_MESSAGE);
      return;
    }
    setAuthError('');
    setDraft(null);
    location.hash = '#/open';
  };

  const switchTo = (v: string) => {
    if (v === '__open') location.hash = '#/open';
    else if (v === '__folder') location.hash = '#/folder';
    else location.hash = v === '' ? '#/' : `#/w/${encodeURIComponent(v)}/doc`;
  };
  // 「GitHub を開く」 starts from 手元の文書 only (screen flow); without a local repository the switcher offers it instead.
  const onLocal = route.view !== 'open' && route.view !== 'folder' && !route.ws && !!local;

  return (
    <>
      <select className="ws-switch" value={value} onChange={(e) => switchTo(e.target.value)} title="ワークスペース" data-testid="ws-switch">
        {local && <option value="">手元</option>}
        {(value === '__folder' || local === false) && <option value="__folder">フォルダの選択</option>}
        {list.map((w) => (
          <option key={w.id} value={w.id}>
            GitHub: {wsLabel(w)}
          </option>
        ))}
        {(value === '__open' || local === false) && <option value="__open">GitHub を開く…</option>}
        {value && value !== '__open' && value !== '__folder' && !list.some((w) => w.id === value) && <option value={value}>{value}</option>}
      </select>
      {onLocal && (
        <button type="button" onClick={() => void openGitHub()} data-testid="open-github">
          GitHub を開く
        </button>
      )}
      {authError && (
        <span className="error auth-error" data-testid="auth-error">
          {authError}
        </span>
      )}
      {auth && (
        <span className="muted" data-testid="auth-status">
          {authText(auth)}
        </span>
      )}
    </>
  );
}

export function TopBar() {
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        ddv
      </a>
      <WorkspaceBar />
      <span className="spacer" />
    </header>
  );
}

/** 手元のフォルダ（header of the local workspace only）: the open folder and 「フォルダを選び直す」. */
export function LocalBar() {
  const { localInfo, reload } = useWorkspaces();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const reselect = async () => {
    setError('');
    setBusy(true);
    try {
      await localApi.close();
      await reload();
      location.hash = '#/folder';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {localInfo.root && (
        <span className="muted local-root" title={localInfo.root} data-testid="local-root">
          {localInfo.root}
        </span>
      )}
      <button type="button" disabled={busy} onClick={() => void reselect()} data-testid="reselect">
        フォルダを選び直す
      </button>
      {error && (
        <span className="error" data-testid="reselect-error">
          {error}
        </span>
      )}
    </>
  );
}

const REPO_SHAPE = /^[^/\s]+\/[^/\s]+$/;

/** 「GitHub を開く」 */
export function OpenPage() {
  const { draft, list, auth, backHash, local, setDraft, reload } = useWorkspaces();
  const [repo, setRepo] = useState(draft?.repo ?? '');
  const [kind, setKind] = useState<'pr' | 'ref'>(draft?.kind ?? 'pr');
  const [target, setTarget] = useState(draft?.target ?? '');
  const [error, setError] = useState(draft?.error ?? '');
  const [busy, setBusy] = useState(false);
  const [pulls, setPulls] = useState<PullSummary[]>([]);
  const [pullsError, setPullsError] = useState('');
  const recent = useMemo(() => [...new Set(list.map((w) => w.repo))], [list]);

  useEffect(() => {
    setPulls([]);
    setPullsError('');
    const r = repo.trim();
    if (!REPO_SHAPE.test(r)) return;
    let stale = false;
    const t = setTimeout(() => {
      gh.pulls(r)
        .then((p) => {
          if (stale) return;
          if (Array.isArray(p)) setPulls(p);
          else setPullsError(BAD_RESPONSE);
        })
        .catch((e: Error) => !stale && setPullsError(e.message));
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [repo]);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const body = { repo: repo.trim(), ...(kind === 'pr' ? { pr: target.trim() } : { ref: target.trim() }) };
      const r = await gh.open(body);
      if (r.state === 'Error') await gh.refresh(r.id);
      setDraft({ repo: body.repo, kind, target: target.trim() });
      await reload();
      location.hash = `#/w/${encodeURIComponent(r.id)}/doc`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setDraft(null);
    location.hash = parseHash(backHash).view === 'open' ? '#/' : backHash;
  };

  return (
    <main className="main doc open-page" data-testid="open-page">
      <h2>GitHub を開く</h2>
      <form
        className="open-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="ddv-repo">リポジトリ（owner/repo）</label>
        <input id="ddv-repo" data-testid="repo" maxLength={100} placeholder="owner/repo" list="ddv-recent-repos" value={repo} onChange={(e) => setRepo(e.target.value)} autoFocus />
        <datalist id="ddv-recent-repos">
          {recent.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <label htmlFor="ddv-kind">種類</label>
        <select id="ddv-kind" data-testid="kind" value={kind} onChange={(e) => setKind(e.target.value as 'pr' | 'ref')}>
          <option value="pr">PR</option>
          <option value="ref">branch・tag</option>
        </select>
        <label htmlFor="ddv-target">PR 番号 または branch・tag 名</label>
        <input id="ddv-target" data-testid="target" maxLength={100} placeholder={kind === 'pr' ? '12' : 'main / v1.0'} value={target} onChange={(e) => setTarget(e.target.value)} />
        {error && (
          <p className="error" data-testid="open-error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={cancel} data-testid="open-cancel" disabled={!local && !list.length && parseHash(backHash).view !== 'doc'}>
            キャンセル
          </button>
          <button type="submit" className="primary" data-testid="open-submit" disabled={busy}>
            開く
          </button>
        </div>
      </form>
      <h3>オープンな PR</h3>
      <ul className="pulls" data-testid="pulls">
        {pulls.map((p) => (
          <li key={p.number}>
            <button
              type="button"
              className="link"
              onClick={() => {
                setKind('pr');
                setTarget(String(p.number));
              }}
            >
              #{p.number} {p.title}
            </button>{' '}
            <span className="muted">
              {p.headRef} → {p.baseRef}
            </span>
          </li>
        ))}
      </ul>
      {pullsError && (
        <p className="muted small" data-testid="pulls-error">
          PR 一覧を取得できませんでした: {pullsError}
        </p>
      )}
      {auth?.source === 'none' && <p className="error">{LOGIN_MESSAGE}</p>}
      <p className="muted small">トークンは表示・保存しません。</p>
    </main>
  );
}

const STEPS: Array<[FetchStep, string]> = [
  ['pr', 'PR 情報の取得'],
  ['clone', 'clone（初回のみ）'],
  ['fetch', 'fetch'],
  ['worktree', 'worktree 作成'],
];

/** 「取得中」: progress over SSE; on failure the reason with 再試行 / 戻る. */
export function LoadingPage() {
  const { route, current, missing, setDraft, update } = useWorkspaces();
  const [opening, setOpening] = useState('');
  const w = current;
  const failed = w?.state === 'Error';

  // A shared / reloaded URL whose workspace is not open on this server: open it.
  useEffect(() => {
    if (!missing) return;
    const m = /^gh~([^~]+)~([^~]+)~(?:pr-(\d+)|ref-(.+))$/.exec(route.ws);
    if (!m) {
      setOpening('ワークスペースIDが正しくありません');
      return;
    }
    gh.open({ repo: `${m[1]}/${m[2]}`, ...(m[3] ? { pr: m[3] } : { ref: m[4].replaceAll('~~', '/') }) })
      .then(() => location.reload())
      .catch((e: Error) => setOpening(e.message));
  }, [missing, route.ws]);

  const steps = w?.kind === 'ref' ? STEPS.map(([s, l]): [FetchStep, string] => (s === 'pr' ? [s, 'branch・tag の確認'] : [s, l])) : STEPS;
  // The step that was running when the fetch failed ('pr' when it failed before any progress was seen).
  const lastStep = useRef<FetchStep>('pr');
  if (w?.step && w.step !== 'error' && w.step !== 'ready') lastStep.current = w.step;
  const at = w?.step === 'ready' ? STEPS.length : Math.max(0, STEPS.findIndex(([s]) => s === (failed ? lastStep.current : w?.step)));
  const retry = async () => update(await gh.refresh(route.ws));
  const back = () => {
    if (w) setDraft({ repo: w.repo, kind: w.kind, target: w.kind === 'pr' ? String(w.pr) : w.ref ?? '', error: w.error });
    location.hash = '#/open';
  };

  return (
    <main className="main doc loading-page" data-testid="loading-page">
      <h2>{w ? `${wsLabel(w)} を取得中` : '取得中'}</h2>
      <ul className="progress" data-testid="progress">
        {steps.map(([s, label], i) => {
          const cls = i < at ? 'done' : i === at ? (failed ? 'failed' : 'now') : '';
          return (
            <li key={s} className={cls} data-step={s}>
              {label}
            </li>
          );
        })}
      </ul>
      {(failed || opening) && (
        <>
          <p className="error" data-testid="loading-error">
            {w?.error ?? opening}
          </p>
          <div className="actions">
            {failed && (
              <button type="button" className="primary" onClick={() => void retry()} data-testid="loading-retry">
                再試行
              </button>
            )}
            <button type="button" onClick={back} data-testid="loading-back">
              戻る
            </button>
          </div>
        </>
      )}
    </main>
  );
}

/** PR bar: number, title, base ← head, head, 更新あり, 最新化, review states. */
export function PrBar() {
  const { current, update, reload } = useWorkspaces();
  const prCtx = usePr();
  const pr$ = !!prCtx && current?.kind === 'pr';
  const pendingCount = Array.isArray(prCtx?.review?.comments) ? prCtx.review.comments.length : 0;
  const [info, setInfo] = useState<PrInfo | null>(null);
  const [error, setError] = useState('');
  const id = current?.id ?? '';
  const head = current?.headSha ?? '';

  useEffect(() => {
    if (!id) return;
    gh.pr(id)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [id, head]);

  // Update detection on focus (the server answers from its 30 s cache when called again quickly).
  useEffect(() => {
    if (!id || current?.kind !== 'pr') return;
    const onFocus = () => void gh.check(id).then(update).catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [id, current?.kind, update]);

  if (!current) return null;
  const pr = info?.pr;
  const refresh = async () => {
    setError('');
    try {
      update(await gh.refresh(id));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const close = async () => {
    try {
      await gh.close(id);
      await reload();
      location.hash = '#/';
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="prbar" data-testid="prbar">
      {current.kind === 'pr' ? (
        <>
          <span className="title" data-testid="pr-title">
            #{current.pr} {pr?.title ?? current.title ?? ''}
          </span>
          {pr && (
            <code>
              {pr.baseRef} ← {pr.headRef}
            </code>
          )}
        </>
      ) : (
        <span className="title" data-testid="pr-title">
          {current.repo} @{current.ref}
        </span>
      )}
      <code data-testid="head-sha" title={current.headSha}>
        {current.headSha.slice(0, 7)}
      </code>
      {current.state === 'Stale' && (
        <span className="stale" data-testid="stale">
          更新あり
        </span>
      )}
      {pr && pr.state === 'closed' && (
        <span className="badge" data-testid="pr-state">
          {pr.merged ? 'マージ済み' : 'クローズ'}
        </span>
      )}
      <button type="button" onClick={() => void refresh()} data-testid="refresh">
        最新化
      </button>
      {error && <span className="error">{error}</span>}
      <span className="spacer" />
      <ReviewStates info={info} />
      {pr$ && (
        <button type="button" className="primary" onClick={() => (location.hash = `#/w/${encodeURIComponent(id)}/review`)} data-testid="to-review" title="保留中のレビューを開く">
          レビュー（<span data-testid="pending-count">{pendingCount}</span>）
        </button>
      )}
      {pr && (
        <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
          GitHub で開く
        </a>
      )}
      <button type="button" onClick={() => void close()} data-testid="ws-close" title="worktree を削除します">
        閉じる
      </button>
    </div>
  );
}

/** Asks before running tests / snapshots with the code of a GitHub workspace. */
export function TrustDialog() {
  const { current, update } = useWorkspaces();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener('ddv-untrusted', on);
    return () => window.removeEventListener('ddv-untrusted', on);
  }, []);
  if (!open || !current) return null;
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" data-testid="trust-dialog">
        <h3>このワークスペースのコードを実行しますか</h3>
        <p>
          {wsLabel(current)} のテスト・スナップショットを実行すると、PR に含まれるコード（テストやビルドのスクリプト）がこの PC で実行されます。内容を確認してから許可してください。
        </p>
        <div className="actions">
          <button type="button" onClick={() => setOpen(false)} data-testid="trust-cancel">
            キャンセル
          </button>
          <button
            type="button"
            className="primary"
            onClick={() =>
              void gh.trust(current.id).then((i) => {
                update(i);
                setOpen(false);
              })
            }
            data-testid="trust-confirm"
          >
            許可する
          </button>
        </div>
        <p className="muted small">許可した後、もう一度実行してください。</p>
      </div>
    </div>
  );
}

/** Proposes installing the dependencies of a GitHub workspace when a test run was refused with `deps-missing`, then re-runs it. */
export function DepsDialog() {
  const { current } = useWorkspaces();
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [deps, setDeps] = useState<DepsStatus | null>(null);
  const [phase, setPhase] = useState<'confirm' | 'installing' | 'failed'>('confirm');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<DepsMissingDetail>).detail;
      setRetry(() => d.retry);
      setDeps(null);
      setPhase('confirm');
      setLog([]);
      setError('');
      api.deps().then(setDeps, (err: Error) => setError(err.message));
    };
    window.addEventListener('ddv-deps-missing', on);
    return () => window.removeEventListener('ddv-deps-missing', on);
  }, []);
  if (!retry || !current) return null;
  const close = () => setRetry(null);
  const install = async () => {
    setPhase('installing');
    setLog([]);
    setError('');
    let runId: string;
    try {
      runId = (await api.installDeps()).runId;
    } catch (e) {
      setError((e as Error).message);
      setPhase('failed');
      return;
    }
    await new Promise<void>((resolve) => {
      const es = new EventSource(apiUrl(`/api/runs/${runId}/events`));
      es.addEventListener('log', (e) => setLog((l) => [...l, (e as MessageEvent).data]));
      es.addEventListener('end', () => {
        es.close();
        resolve();
      });
      es.onerror = () => {
        es.close();
        resolve();
      };
    });
    const done = await api.run(runId).catch(() => null);
    if (done?.status === 'passed') {
      setRetry(null);
      retry();
    } else {
      setError('依存の導入に失敗しました。ログを確認してください');
      setPhase('failed');
    }
  };
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" data-testid="deps-dialog">
        <h3>依存を導入しますか</h3>
        <p>{wsLabel(current)} にはテストの実行に必要なパッケージ（node_modules）がありません。次のコマンドで導入します。PR に含まれるインストールスクリプトもこの PC で実行されます。</p>
        {deps ? (
          <ul className="deps-targets" data-testid="deps-targets">
            {deps.targets.map((t) => (
              <li key={t.dir}>
                <code>{[t.command, ...t.args].join(' ')}</code>（{t.dir}
                {t.lockfile ? ` / ${t.lockfile}` : ''}）<span className="muted small"> 不足: {t.missing.join(', ')}</span>
              </li>
            ))}
            {deps.problems.map((p) => (
              <li key={p} className="error">
                {p}
              </li>
            ))}
          </ul>
        ) : (
          !error && <p className="muted small">確認しています…</p>
        )}
        {log.length > 0 && (
          <pre className="deps-log" data-testid="deps-log">
            {log.join('\n')}
          </pre>
        )}
        {error && (
          <p className="error" data-testid="deps-error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={close} disabled={phase === 'installing'} data-testid="deps-cancel">
            {phase === 'failed' ? '閉じる' : 'キャンセル'}
          </button>
          <button type="button" className="primary" onClick={() => void install()} disabled={phase === 'installing' || !deps?.targets.length} data-testid="deps-install">
            {phase === 'installing' ? '導入中…' : phase === 'failed' ? '再試行' : '導入する'}
          </button>
        </div>
        <p className="muted small">導入が終わると、テストを自動で実行し直します。</p>
      </div>
    </div>
  );
}
