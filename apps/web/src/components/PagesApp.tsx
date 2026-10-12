import { useEffect, useState } from 'react';
import { api } from '../backend/index.ts';

/**
 * Screen root of the Pages edition (`#app-impl` when DDV_EDITION=pages; the local App.tsx — workspaces, local folder — is not in that bundle).
 * The target screens (hash route, TargetLoader, OpenTargetPage …; pages-viewer.md) are mounted here.
 */
export function App() {
  const [staleSha, setStaleSha] = useState('');
  useEffect(() => api.subscribe((ev) => ev.type === 'stale' && setStaleSha(ev.headSha)), []);
  return (
    <div className="app">
      <div className="body" data-testid="pages-app">
        {staleSha && <p className="muted">新しいコミットがあります（{staleSha.slice(0, 7)}）</p>}
        <p className="muted">GitHub のリポジトリを開いて文書を表示します</p>
      </div>
    </div>
  );
}
