import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type DocResponse } from '../api.ts';
import { docHref, useApp } from '../state.tsx';
import { MockHubProvider } from '../mockHub.tsx';
import { Markdown } from './Markdown.tsx';
import { Toc } from './Toc.tsx';
import { MermaidView } from './MermaidView.tsx';
import { ChangeMark, ThreadView, usePr } from './Pr.tsx';
import type { ReviewMarks } from '../remark-review.ts';

const KIND: Record<string, string> = { requirements: '要件定義', basic: '基本設計', detailed: '詳細設計', other: 'ドキュメント' };

export function DocPage() {
  const { route, version } = useApp();
  const [doc, setDoc] = useState<DocResponse | null>(null);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const lastScrolled = useRef('');
  const pr = usePr();
  const prDiff = pr?.diff && pr.diff.path === route.path ? pr.diff : null;
  const review = useMemo<ReviewMarks | undefined>(() => {
    if (!pr) return undefined;
    const threads = pr.threads.flatMap((t) => (t.placement?.kind === 'element' ? [{ id: t.id, line: t.placement.element.startLine }] : []));
    const diffOn = pr.diffOn && prDiff;
    return { threads, blocks: diffOn ? prDiff.blocks : undefined, removed: diffOn ? prDiff.removed : undefined };
  }, [pr, prDiff]);
  const looseThreads = pr?.threads.filter((t) => t.placement?.kind !== 'element') ?? [];

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
          {pr && <DiffView path={doc.path} />}
          {looseThreads.length > 0 && (
            <section className="threads loose" data-testid="file-threads">
              <h4>ファイル・以前の版へのコメント（{looseThreads.length}）</h4>
              {looseThreads.map((t) => (
                <ThreadView key={t.id} thread={t} showPlace />
              ))}
            </section>
          )}
          <MockHubProvider key={doc.path} version={version}>
            <Markdown text={doc.text} basePath={doc.path} doc={doc} review={review} />
          </MockHubProvider>
        </article>
      </div>
      <aside className="side">
        <Toc headings={doc.headings} scrollRoot={root} />
      </aside>
    </div>
  );
}

/** 本文 / 差分 の切替（開くと本文に差分を重ねる）と、文書の差分の要約. */
function DiffView({ path }: { path: string }) {
  const pr = usePr()!;
  const { files, info, diff, diffOn, setDiffOn } = pr;
  const change = pr.changeOf(path);
  const d = diff && diff.path === path ? diff : null;
  const base = info?.pr?.baseRef ?? files?.base?.slice(0, 7) ?? 'base';
  const head = info?.pr?.headRef ?? files?.head.slice(0, 7) ?? 'head';
  const others = files ? files.others + files.mocks.length : 0;
  const count = (c: string) => d?.blocks.filter((b) => b.change === c).length ?? 0;
  const diagrams = d ? Object.entries(d.diagrams).filter(([, g]) => g.change !== 'unchanged') : [];
  return (
    <details className="diff-view" data-testid="diff-view" open={diffOn} onToggle={(e) => setDiffOn((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        差分を表示（{base}...{head}：設計書 {files?.docs.length ?? '…'} 件、文書以外 {files ? others : '…'} 件）
      </summary>
      {!files ? (
        <p className="muted">{pr.error || '読み込み中…'}</p>
      ) : !change ? (
        <p className="muted" data-testid="diff-unchanged">
          この文書は PR で変更されていません。
        </p>
      ) : !d ? (
        <p className="muted">{pr.error || '読み込み中…'}</p>
      ) : (
        <div className="diff-summary" data-testid="diff-summary">
          <h4>
            <ChangeMark status={change.status} /> {path}
            {change.oldPath && <span className="muted">（{change.oldPath} から）</span>}
          </h4>
          <div className="legend">
            <span className="lg added">追加 {count('added')}</span>
            <span className="lg changed">変更 {count('changed')}</span>
            <span className="lg removed">削除 {d.removed.length}</span>
            <span className="muted">（本文に重ねて表示しています）</span>
          </div>
          {diagrams.length > 0 && (
            <>
              <h4>図の差分</h4>
              <ul className="diagram-changes" data-testid="diagram-changes">
                {diagrams.map(([id, g]) => (
                  <li key={id} className={g.change}>
                    {g.change === 'removed' ? (
                      <>
                        削除: <code>#{g.beforeId ?? id}</code>
                        {g.before && <MermaidView code={g.before} diagramId={`removed-${id}`} />}
                      </>
                    ) : (
                      <a href={`#diagram-${id}`} onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(`diagram-${id}`)?.scrollIntoView({ block: 'start' });
                      }}>
                        {g.change === 'added' ? '追加' : '変更'}: <code>#{id}</code>
                        {g.beforeId && g.beforeId !== id ? `（base では #${g.beforeId}）` : ''}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>テストIDの増減</h4>
          {d.ids.added.length + d.ids.retired.length === 0 ? (
            <p className="muted">ありません</p>
          ) : (
            <ul className="ids" data-testid="id-changes">
              {d.ids.added.map((id) => (
                <li key={`+${id}`} className="added">
                  ＋ {id}
                </li>
              ))}
              {d.ids.retired.map((id) => (
                <li key={`-${id}`} className="removed">
                  － {id}（欠番）
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  );
}
