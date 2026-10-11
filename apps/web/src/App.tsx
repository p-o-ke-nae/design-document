import { useRef } from 'react';
import { AppProvider, docHref, useApp } from './state.tsx';
import { DocTree } from './components/DocTree.tsx';
import { DocPage } from './components/DocPage.tsx';
import { TestsPage } from './components/TestsPage.tsx';
import { StatusBadge } from './components/StatusBadge.tsx';

function Shell() {
  const { route, repoName, showMatrix, setShowMatrix, activeRun } = useApp();
  const lastDoc = useRef('');
  if (route.view === 'doc' && route.path) lastDoc.current = route.path;
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          ddv
        </a>
        <span className="repo" title="リポジトリ">
          {repoName}
        </span>
        <nav className="views">
          <a href={lastDoc.current ? docHref(lastDoc.current) : '#/'} className={route.view === 'doc' ? 'is-active' : ''} data-testid="nav-docs">
            ドキュメント
          </a>
          <a href="#/tests" className={route.view === 'tests' ? 'is-active' : ''} data-testid="nav-tests">
            テスト
          </a>
        </nav>
        <span className="spacer" />
        {activeRun && (
          <a href="#/tests" className="run-indicator" data-testid="run-indicator">
            テスト実行 <StatusBadge status={activeRun.status} />
          </a>
        )}
        <label className="toggle" title="状態図/フロー図から自動生成したテストマトリクスの表示">
          <input type="checkbox" checked={showMatrix} onChange={(e) => setShowMatrix(e.target.checked)} data-testid="global-matrix-toggle" />
          マトリクス表示
        </label>
      </header>
      <div className="body">
        <aside className="left">
          <DocTree />
        </aside>
        <main className="main">{route.view === 'tests' ? <TestsPage /> : <DocPage />}</main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
