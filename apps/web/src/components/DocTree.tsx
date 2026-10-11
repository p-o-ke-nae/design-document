import { useEffect, useState } from 'react';
import { api, type TreeDoc } from '../api.ts';
import { docHref, parseHash, useApp } from '../state.tsx';

const GROUPS: Array<[string, string]> = [
  ['requirements', '要件定義'],
  ['basic', '基本設計'],
  ['detailed', '詳細設計'],
  ['other', 'その他'],
];

export function DocTree() {
  const { version, route } = useApp();
  const [docs, setDocs] = useState<TreeDoc[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .tree()
      .then((t) => {
        setDocs(t.docs);
        setError('');
        const r = parseHash(location.hash);
        // Open the first document on a bare URL (local) or a workspace root (#/w/<ws>/ or #/w/<ws>/doc).
        if (t.docs[0] && (r.ws ? r.view === 'doc' && !r.path : !location.hash)) location.hash = docHref(t.docs[0].path);
      })
      .catch((e: Error) => setError(e.message));
  }, [version]);
  return (
    <nav className="tree" aria-label="ドキュメント" data-testid="doc-tree">
      {error && <div className="error">{error}</div>}
      {GROUPS.map(([kind, label]) => {
        const list = docs.filter((d) => d.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind}>
            <h3>{label}</h3>
            <ul>
              {list.map((d) => (
                <li key={d.path}>
                  <a href={docHref(d.path)} className={route.view === 'doc' && route.path === d.path ? 'is-active' : ''} title={d.path}>
                    <span className="tree-title">{d.title}</span>
                    <span className={`status st-doc-${d.status}`}>{d.status}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {!docs.length && !error && <div className="muted">ドキュメントがありません</div>}
    </nav>
  );
}
