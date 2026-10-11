import { useEffect, useRef, useState } from 'react';
import { api, type DocResponse } from '../api.ts';
import { docHref, useApp } from '../state.tsx';
import { MockHubProvider } from '../mockHub.tsx';
import { Markdown } from './Markdown.tsx';
import { Toc } from './Toc.tsx';

const KIND: Record<string, string> = { requirements: '要件定義', basic: '基本設計', detailed: '詳細設計', other: 'ドキュメント' };

export function DocPage() {
  const { route, version } = useApp();
  const [doc, setDoc] = useState<DocResponse | null>(null);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const lastScrolled = useRef('');

  useEffect(() => {
    if (!route.path) return;
    let alive = true;
    api
      .doc(route.path)
      .then((d) => {
        if (!alive) return;
        setDoc(d);
        setError('');
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [route.path, version]);

  useEffect(() => {
    if (!doc || doc.path !== route.path) return;
    const key = `${route.path}#${route.heading}`;
    if (lastScrolled.current === key) return;
    lastScrolled.current = key;
    if (route.heading) {
      requestAnimationFrame(() => document.getElementById(route.heading)?.scrollIntoView({ block: 'start' }));
    } else scroller.current?.scrollTo({ top: 0 });
  }, [doc, route.path, route.heading]);

  if (!route.path) return <div className="empty">左のツリーからドキュメントを選択してください</div>;
  if (error) return <div className="empty error">{error}</div>;
  if (!doc) return <div className="empty muted">読み込み中…</div>;
  const errors = doc.issues.filter((i) => i.severity === 'error').length;

  return (
    <div className="doc-layout">
      <div
        className="doc-scroll"
        ref={(el) => {
          scroller.current = el;
          if (el !== root) setRoot(el);
        }}
      >
        <article className="doc" data-testid="doc">
          <div className="doc-meta">
            <span className="chip">{KIND[doc.kind] ?? doc.kind}</span>
            <code>{doc.id}</code>
            <span className={`status st-doc-${doc.status}`}>{doc.status}</span>
            <span className="muted">{doc.path}</span>
            {doc.traces.length > 0 && (
              <span className="traces" data-testid="traces">
                トレース:{' '}
                {doc.traces.map((t) =>
                  t.path ? (
                    <a key={t.code} href={docHref(t.path)} title={t.path}>
                      <code>{t.code}</code>
                    </a>
                  ) : (
                    <code key={t.code}>{t.code}</code>
                  ),
                )}
              </span>
            )}
          </div>
          {doc.issues.length > 0 && (
            <details className={`issues${errors ? ' has-error' : ''}`}>
              <summary>
                ddv lint: エラー {errors} / 警告 {doc.issues.length - errors}
              </summary>
              <ul>
                {doc.issues.map((i, n) => (
                  <li key={n} className={i.severity}>
                    [{i.rule}] {i.line ? `L${i.line}: ` : ''}
                    {i.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <MockHubProvider key={doc.path} version={version}>
            <Markdown text={doc.text} basePath={doc.path} doc={doc} />
          </MockHubProvider>
        </article>
      </div>
      <aside className="side">
        <Toc headings={doc.headings} scrollRoot={root} />
      </aside>
    </div>
  );
}
