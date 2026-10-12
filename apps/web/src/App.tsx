import { useEffect, useRef, useState, type ReactNode } from 'react';
import { setWorkspace } from './api.ts';
import { AppProvider, docHref, useApp, viewHref } from './state.tsx';
import { DocTree } from './components/DocTree.tsx';
import { DocPage } from './components/DocPage.tsx';
import { TestsPage } from './components/TestsPage.tsx';
import { TestHistoryView } from './components/TestHistory.tsx';
import { FlakyList } from './components/FlakyList.tsx';
import { TraceView } from './components/TraceView.tsx';
import { StatusBadge } from './components/StatusBadge.tsx';
import { DepsDialog, LoadingPage, LocalBar, OpenPage, PrBar, TopBar, TrustDialog, WorkspaceBar, WorkspaceProvider, useWorkspaces } from './components/Workspace.tsx';
import { FolderPicker } from './components/FolderPicker.tsx';
import { TokenRequired } from './components/TokenRequired.tsx';
import { PrProvider } from './components/Pr.tsx';
import { CommentComposer, DonePage, ReviewPage } from './components/Review.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

function Shell() {
  const { route } = useApp();
  const { current } = useWorkspaces();
  if (route.ws && current?.kind === 'pr')
    return (
      <PrProvider>
        <ShellBody />
      </PrProvider>
    );
  return <ShellBody />;
}

function ShellBody() {
  const { route, repoName, showMatrix, setShowMatrix, activeRun } = useApp();
  const lastDoc = useRef('');
  if (route.view === 'doc' && route.path) lastDoc.current = route.path;
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          ddv
        </a>
        <WorkspaceBar />
        <span className="repo" title="リポジトリ">
          {repoName}
        </span>
        {!route.ws && <LocalBar />}
        <nav className="views">
          <a href={lastDoc.current ? docHref(lastDoc.current) : viewHref('root')} className={route.view === 'doc' ? 'is-active' : ''} data-testid="nav-docs">
            ドキュメント
          </a>
          <a href={viewHref('tests')} className={route.view === 'tests' ? 'is-active' : ''} data-testid="nav-tests">
            テスト
          </a>
        </nav>
        <span className="spacer" />
        {activeRun && (
          <a href={viewHref('tests')} className="run-indicator" data-testid="run-indicator">
            テスト実行 <StatusBadge status={activeRun.status} />
          </a>
        )}
        <label className="toggle" title="状態図/フロー図から自動生成したテストマトリクスの表示">
          <input type="checkbox" checked={showMatrix} onChange={(e) => setShowMatrix(e.target.checked)} data-testid="global-matrix-toggle" />
          マトリクス表示
        </label>
      </header>
      <ErrorBoundary resetKey={JSON.stringify(route)}>
        {route.ws && <PrBar />}
        <div className="body">
          <aside className="left">
            <DocTree />
          </aside>
          <main className="main">
            {route.view === 'tests' ? (
              route.sub === 'history' ? (
                <TestHistoryView id={route.testId ?? ''} />
              ) : route.sub === 'trace' ? (
                <TraceView runId={route.runId ?? ''} testId={route.testId ?? ''} />
              ) : route.sub === 'flaky' ? (
                <FlakyList />
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

function Screen({ children }: { children: ReactNode }) {
  const { route } = useWorkspaces();
  return (
    <div className="app">
      <TopBar />
      <div className="body">
        <ErrorBoundary resetKey={JSON.stringify(route)}>{children}</ErrorBoundary>
      </div>
    </div>
  );
}

/** Chooses the screen from the hash: フォルダの選択 / 手元 / GitHub を開く / 取得中 / PR の文書. */
function Root() {
  const { route, local, localInfo, current } = useWorkspaces();
  const ws = route.view === 'open' || route.view === 'folder' ? '' : route.ws;
  // Without a local folder the viewer starts on 「フォルダの選択」.
  useEffect(() => {
    if (route.view !== 'open' && route.view !== 'folder' && !route.ws && local === false) location.hash = '#/folder';
  }, [route.view, route.ws, local]);

  if (route.view === 'folder')
    return (
      <Screen>
        <FolderPicker />
      </Screen>
    );
  if (route.view === 'open')
    return (
      <Screen>
        <OpenPage />
      </Screen>
    );
  if (ws) {
    if (!current || (current.state !== 'Ready' && current.state !== 'Stale'))
      return (
        <Screen>
          <LoadingPage />
        </Screen>
      );
    setWorkspace(ws);
    return (
      <AppProvider key={`${ws}@${current.headSha}`}>
        <Shell />
        <TrustDialog />
        <DepsDialog />
      </AppProvider>
    );
  }
  if (!local) return <Screen>{null}</Screen>;
  setWorkspace('');
  return (
    <AppProvider key={`local@${localInfo.generation}`}>
      <Shell />
    </AppProvider>
  );
}

export function App() {
  const [sessionRequired, setSessionRequired] = useState(false);
  useEffect(() => {
    const on = () => setSessionRequired(true);
    window.addEventListener('ddv-session-required', on);
    return () => window.removeEventListener('ddv-session-required', on);
  }, []);
  if (sessionRequired) return <TokenRequired />;
  return (
    <WorkspaceProvider>
      <Root />
    </WorkspaceProvider>
  );
}
