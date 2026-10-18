import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { setWorkspace } from '../backend/index.ts';
import { AppProvider, docHref, setRouteCodec, useApp, viewHref } from '../state.tsx';
import { MockSourceContext, type MockSource } from '../mockSource.ts';
import { formatHostedHash, parseHostedHash, targetWs } from '../pages/hash-route.ts';
import { NO_DB_WARNING } from '../pages/pending-store.ts';
import { PagesRuntime } from '../pages/runtime.ts';
import type { TargetSnapshot } from '../pages/target-loader.ts';
import { DocTree } from './DocTree.tsx';
import { DocPage } from './DocPage.tsx';
import { TestsPage } from './TestsPage.tsx';
import { ActionsPanel } from './ActionsPanel.tsx';
import { TestHistoryView } from './TestHistory.tsx';
import { FlakyList } from './FlakyList.tsx';
import { TraceView } from './TraceView.tsx';
import { PrProvider } from './Pr.tsx';
import { PrBarView } from './PrBarView.tsx';
import { CommentComposer, DonePage, ReviewPage } from './Review.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { PagesTopBar } from './PagesTopBar.tsx';
import { OpenTargetPage } from './OpenTargetPage.tsx';
import { TargetLoadingPage } from './TargetLoadingPage.tsx';
import { TokenPage } from './TokenPage.tsx';
import { TargetHeader } from './TargetHeader.tsx';
import { prInfoOf } from '../pages/target-context.ts';

let runtime: PagesRuntime | null = null;
/** `doc-change` / `token-change` go to `#/`, which opens `PagesConfig.defaultTarget` when there is one: this skips that once. */
let changing = false;

/** The singletons and the hash wiring (once per tab). */
function getRuntime(): PagesRuntime {
  if (runtime) return runtime;
  const rt = new PagesRuntime();
  runtime = rt;
  setRouteCodec({
    parse: (hash) => parseHostedHash(hash, rt.config).route,
    href: (view) => (rt.loader.target ? formatHostedHash(rt.loader.target, view) : '#/'),
  });
  const open = () => {
    if (changing && (location.hash === '' || location.hash === '#/' || location.hash === '#')) {
      changing = false;
      rt.loader.changeTarget();
      return;
    }
    changing = false;
    rt.loader.open(parseHostedHash(location.hash, rt.config));
  };
  window.addEventListener('hashchange', open);
  open();
  return rt;
}

/** `location.hash = '#/'` (`TargetLoader.changeTarget`). */
function changeTarget(rt: PagesRuntime): void {
  if (location.hash === '#/') rt.loader.changeTarget();
  else {
    changing = true;
    location.hash = '#/';
  }
}

function useLoader(rt: PagesRuntime): number {
  return useSyncExternalStore(
    (fn) => rt.loader.subscribe(fn),
    () => rt.loader.revision,
  );
}

function usePatState(rt: PagesRuntime) {
  return useSyncExternalStore(
    (fn) => rt.pat.subscribe(fn),
    () => rt.pat.state,
  );
}

function Screen({ rt, children }: { rt: PagesRuntime; children: ReactNode }) {
  return (
    <div className="app">
      <PagesTopBar config={rt.config} rate={rt.rate} pat={rt.pat} />
      <div className="body">
        <ErrorBoundary resetKey={String(rt.loader.revision)}>{children}</ErrorBoundary>
      </div>
    </div>
  );
}

/**
 * Screen root of the Pages edition (`#app-impl` when DDV_EDITION=pages; the local App.tsx — workspaces, local folder — is not
 * in that bundle). 対象の指定 / 取得中 / PAT が必要 / 文書 by `TargetLoader.state` (pages-viewer.md「画面」).
 */
export function App() {
  const rt = getRuntime();
  useLoader(rt);
  const { loader } = rt;
  const state = loader.state;
  const target = loader.target;

  if ((state === 'Loading' || state === 'NeedToken') && target)
    return (
      <Screen rt={rt}>
        {state === 'Loading' ? (
          <TargetLoadingPage target={target} progress={loader.progress} rate={rt.rate} />
        ) : (
          <TokenPage target={target} error={loader.error} store={rt.pat} onChangeTarget={() => changeTarget(rt)} />
        )}
      </Screen>
    );
  const snapshot = loader.snapshot;
  if ((state === 'Ready' || state === 'Stale') && target && snapshot) {
    const scope = targetWs(target);
    setWorkspace(scope);
    return (
      <TargetView key={`${scope}@${snapshot.commitSha}`} rt={rt} snapshot={snapshot} />
    );
  }
  return (
    <Screen rt={rt}>
      <OpenTargetPage
        key={`${loader.revision}`}
        config={rt.config}
        recent={rt.recent}
        openError={loader.openError}
        fetchError={state === 'Failed' ? loader.error : null}
        last={state === 'Failed' ? target : null}
        onOpen={(hash) => {
          if (location.hash === hash) loader.open(parseHostedHash(hash, rt.config));
          else location.hash = hash;
        }}
      />
    </Screen>
  );
}

function TargetView({ rt, snapshot }: { rt: PagesRuntime; snapshot: TargetSnapshot }) {
  const mock: MockSource = {
    reader: snapshot.reader,
    blobUrl: (p) =>
      `https://github.com/${encodeURIComponent(snapshot.target.owner)}/${encodeURIComponent(snapshot.target.repo)}/blob/${snapshot.commitSha}/${p.split('/').map(encodeURIComponent).join('/')}`,
  };
  return (
    <MockSourceContext.Provider value={mock}>
      <AppProvider>
        {snapshot.target.kind === 'pr' ? (
          <PrProvider>
            <PagesShell rt={rt} snapshot={snapshot} />
          </PrProvider>
        ) : (
          <PagesShell rt={rt} snapshot={snapshot} />
        )}
      </AppProvider>
    </MockSourceContext.Provider>
  );
}

function PagesShell({ rt, snapshot }: { rt: PagesRuntime; snapshot: TargetSnapshot }) {
  const { route, showMatrix, setShowMatrix } = useApp();
  const patState = usePatState(rt);
  const lastDoc = useRef('');
  if (route.view === 'doc' && route.path) lastDoc.current = route.path;
  const built = rt.built();
  const [persistent, setPersistent] = useState(true);
  useEffect(() => {
    let alive = true;
    void rt.pending.then((p) => alive && setPersistent(p.persistent));
    return () => {
      alive = false;
    };
  }, [rt]);
  const { target } = snapshot;
  const info = prInfoOf(snapshot);
  return (
    <div className="app">
      <PagesTopBar config={rt.config} rate={rt.rate} pat={rt.pat}>
        <nav className="views">
          <a href={lastDoc.current ? docHref(lastDoc.current) : viewHref('root')} className={route.view === 'doc' ? 'is-active' : ''} data-testid="nav-docs">
            ドキュメント
          </a>
          <a href={viewHref('tests')} className={route.view === 'tests' ? 'is-active' : ''} data-testid="nav-tests">
            テスト
          </a>
        </nav>
        <label className="toggle" title="状態図/フロー図から自動生成したテストマトリクスの表示">
          <input type="checkbox" checked={showMatrix} onChange={(e) => setShowMatrix(e.target.checked)} data-testid="global-matrix-toggle" />
          マトリクス表示
        </label>
      </PagesTopBar>
      <ErrorBoundary resetKey={JSON.stringify(route)}>
        <TargetHeader snapshot={snapshot} hasPat={patState !== 'none'} lock={built?.lock ?? null} onChange={() => changeTarget(rt)} />
        <PrBarView
          kind={target.kind}
          {...(target.pr ? { pr: target.pr } : {})}
          {...(snapshot.pr ? { title: snapshot.pr.title } : {})}
          refLabel={`${target.owner}/${target.repo} @${target.ref ?? snapshot.defaultBranch}`}
          headSha={snapshot.commitSha}
          stale={rt.loader.state === 'Stale'}
          info={info}
          onRefresh={() => rt.loader.reload()}
          error=""
        />
        {target.kind === 'pr' && !persistent && <p className="warn">{NO_DB_WARNING}</p>}
        <div className="body">
          <aside className="left">
            <DocTree />
          </aside>
          <main className="main">
            {route.view === 'tests' ? (
              route.sub === 'history' ? (
                <TestHistoryView id={route.testId ?? ''} />
              ) : route.sub === 'trace' ? (
                <TraceView runId={route.runId ?? ''} testId={route.testId ?? ''} platform={route.platform} />
              ) : route.sub === 'flaky' ? (
                <FlakyList />
              ) : route.sub === 'actions' ? (
                <ActionsPanel path={route.actions ?? ''} />
              ) : (
                <TestsPage />
              )
            ) : route.view === 'review' ? (
              <ReviewPage lastDoc={lastDoc.current} />
            ) : route.view === 'done' ? (
              <DonePage lastDoc={lastDoc.current} />
            ) : (
              <DocPage />
            )}
          </main>
        </div>
        <CommentComposer />
      </ErrorBoundary>
    </div>
  );
}
