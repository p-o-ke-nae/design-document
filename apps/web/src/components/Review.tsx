import { useEffect, useMemo, useState } from 'react';
import { elementsOf, type DocElement, type ParsedDoc } from '@ddv/core';
import { api, type DocResponse, type ElementRef, type PendingComment, type ReviewEvent, type TreeDoc } from '../api.ts';
import { docHref, useApp } from '../state.tsx';
import { recalledSubmit, rememberSubmit, usePr } from './Pr.tsx';

const KIND_LABEL: Record<string, string> = { block: 'ブロック', tableRow: '表の行', node: 'ノード', edge: '遷移', diagram: '図', matrixRow: 'マトリクス行', mockElement: 'モック要素', testData: 'テストデータ' };
const EVENT_LABEL: Record<ReviewEvent, string> = { COMMENT: 'Comment', APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes' };

const cache = new WeakMap<DocResponse, DocElement[]>();

/** Commentable elements of a document (blocks, table rows, diagrams, their nodes and edges). */
export function docElements(doc: DocResponse): DocElement[] {
  let els = cache.get(doc);
  if (!els) {
    try {
      els = elementsOf({ ...doc, blocks: doc.blocks ?? [] } as unknown as ParsedDoc, doc.text);
    } catch {
      els = [];
    }
    cache.set(doc, els);
  }
  return els;
}

/** The block / table row starting at `line`. */
export function elementAtLine(doc: DocResponse, line: number): ElementRef | undefined {
  const e = docElements(doc).find((x) => (x.kind === 'block' || x.kind === 'tableRow') && x.startLine === line);
  return e && { kind: e.kind, key: e.key, label: e.label };
}

const same = (a: ElementRef, b: ElementRef) => a.kind === b.kind && a.key === b.key;

/** 💬 of one element; opens the comment form. Renders nothing outside a PR workspace. */
export function CommentGutter({ path, element, inline }: { path: string; element: ElementRef; inline?: boolean }) {
  const pr = usePr();
  if (!pr) return null;
  return (
    <button
      type="button"
      className={`cmt-btn${inline ? ' inline' : ''}`}
      title="この要素にコメント"
      data-testid="comment-gutter"
      data-key={element.key}
      aria-label="この要素にコメント"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        pr.openComposer({ path, element });
      }}
    />
  );
}

/** Loads the elements of a document for the anchor select. */
function useElements(path: string): DocElement[] {
  const [els, setEls] = useState<DocElement[]>([]);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api
      .doc(path)
      .then((d) => alive && setEls(docElements(d)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return els;
}

function AnchorOptions({ first, elements }: { first?: ElementRef; elements: DocElement[] }) {
  return (
    <>
      {first && <option value="0">{`${KIND_LABEL[first.kind] ?? first.kind}: ${first.label ?? first.key}`}</option>}
      {[...elements]
        .sort((a, b) => Number(b.diagram === first?.key && first?.kind === 'diagram') - Number(a.diagram === first?.key && first?.kind === 'diagram'))
        .filter((e) => !first || !same(e, first))
        .map((e, i) => (
          <option key={`${e.kind}:${e.key}:${i}`} value={`${e.kind}\u0000${e.key}\u0000${e.label}`}>
            {`${KIND_LABEL[e.kind] ?? e.kind}: ${e.label}（L${e.startLine}${e.endLine > e.startLine ? `-${e.endLine}` : ''}）`}
          </option>
        ))}
    </>
  );
}

function parseOption(v: string, first?: ElementRef): ElementRef | undefined {
  if (v === '0') return first;
  const [kind, key, label] = v.split('\u0000');
  return key ? { kind: kind as ElementRef['kind'], key, label } : undefined;
}

/** Comment form (場所・コメント・suggestion・保留に追加). */
export function CommentComposer() {
  const pr = usePr();
  const c = pr?.composer;
  if (!pr || !c) return null;
  return <ComposerForm key={`${c.path}\u0000${c.element.kind}\u0000${c.element.key}`} />;
}

function ComposerForm() {
  const pr = usePr()!;
  const { path, element } = pr.composer!;
  const elements = useElements(path);
  const [anchor, setAnchor] = useState('0');
  const [body, setBody] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inPr = !!pr.changeOf(path);

  const add = async () => {
    if (!body.trim()) return setError('コメントを入力してください');
    const el = parseOption(anchor, element) ?? element;
    setError('');
    setBusy(true);
    try {
      await api.addComment({ path, element: el, body, suggestion: suggestion.trim() ? suggestion : undefined });
      await pr.reloadReview();
      pr.openComposer(null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="composer" role="dialog" aria-label="コメントを追加" data-testid="comment-dialog">
      <h4>コメントを追加</h4>
      <label className="field">
        <span>場所</span>
        <select value={anchor} onChange={(e) => setAnchor(e.target.value)} data-testid="anchor">
          <AnchorOptions first={element} elements={elements} />
        </select>
      </label>
      <div className="muted small">
        <code>{path}</code>
        {inPr ? '：差分の外の場所はファイルへのコメントになります' : '：PR で変更されていない文書のため、ファイルへのコメントになります'}
      </div>
      <label className="field">
        <span>コメント（{body.length} / 2000）</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={2000} autoFocus data-testid="comment" />
      </label>
      <label className="field">
        <span>suggestion（任意：この場所を置き換える内容）</span>
        <textarea value={suggestion} onChange={(e) => setSuggestion(e.target.value)} rows={2} data-testid="suggestion" />
      </label>
      {error && (
        <div className="error" data-testid="comment-error">
          {error}
        </div>
      )}
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void add()} data-testid="add-comment">
          保留に追加
        </button>
        <button type="button" disabled={busy} onClick={() => pr.openComposer(null)} data-testid="comment-cancel">
          キャンセル
        </button>
      </div>
    </div>
  );
}

function PendingItem({ c, onChanged }: { c: PendingComment; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const [suggestion, setSuggestion] = useState(c.suggestion ?? '');
  const [anchor, setAnchor] = useState('');
  const [error, setError] = useState('');
  const elements = useElements(editing ? c.anchor.path : '');
  const a = c.anchor;
  const drifted = c.state === 'Drifted';

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = () => {
    if (!body.trim()) return setError('コメントを入力してください');
    const el = anchor ? parseOption(anchor) : undefined;
    void run(() => api.updateComment(c.id, { body, suggestion, ...(el ? { path: a.path, element: el } : {}) }));
  };

  return (
    <li className={`pending-item${drifted ? ' drifted' : ''}`} data-testid="pending-item" data-state={c.state} data-placement={c.placement}>
      <div className="pending-head">
        <code>{a.path}</code> <span>{a.element.label}</span>{' '}
        <span className="muted">
          L{a.startLine}
          {a.line > a.startLine ? `-${a.line}` : ''}
        </span>{' '}
        <span className="badge">{c.placement === 'line' ? '行コメント' : c.placement === 'file' ? 'ファイルコメント' : 'レビュー本文'}</span>
        {c.placement === 'body' && <span className="muted">（PR の差分に無いファイルのため、レビュー本文に含めます）</span>}
        {c.shrunk && <span className="muted">（1 行に縮めました）</span>}
      </div>
      {drifted && (
        <div className="warn" data-testid="pending-drifted">
          位置を確認していません{c.reason ? `：${c.reason}` : ''}（修正で位置を選び直すと送信できます）
        </div>
      )}
      {editing ? (
        <div className="pending-edit">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} data-testid="pending-body" />
          <textarea value={suggestion} onChange={(e) => setSuggestion(e.target.value)} rows={2} placeholder="suggestion（任意）" data-testid="pending-suggestion" />
          <select value={anchor} onChange={(e) => setAnchor(e.target.value)} data-testid="pending-anchor">
            <option value="">（位置は変えない）</option>
            <AnchorOptions elements={elements} />
          </select>
          <div className="row">
            <button type="button" className="primary" onClick={save} data-testid="pending-save">
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="comment-body" data-testid="pending-text">
            {c.body}
          </div>
          {c.suggestion && <pre className="suggestion">{c.suggestion}</pre>}
          <div className="row">
            <button type="button" onClick={() => setEditing(true)} data-testid="pending-edit">
              修正
            </button>
            <button type="button" onClick={() => void run(() => api.deleteComment(c.id))} data-testid="pending-delete">
              削除
            </button>
          </div>
        </>
      )}
      {error && (
        <div className="error" data-testid="pending-error">
          {error}
        </div>
      )}
    </li>
  );
}

/** 保留中レビュー: pending comments, 種類, 本文, status 連動, 送信. */
export function ReviewPage({ lastDoc }: { lastDoc: string }) {
  const pr = usePr();
  const { route } = useApp();
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [body, setBody] = useState('');
  const [approve, setApprove] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tree, setTree] = useState<TreeDoc[]>([]);
  const reloadReview = pr?.reloadReview;

  useEffect(() => {
    void reloadReview?.();
    api
      .tree()
      .then((t) => Array.isArray(t?.docs) && setTree(t.docs))
      .catch(() => {});
  }, [reloadReview]);

  const comments = useMemo(() => (Array.isArray(pr?.review?.comments) ? pr.review.comments : []), [pr?.review]);
  const candidates = useMemo(
    () =>
      (pr?.files?.docs ?? [])
        .filter((f) => f.status !== 'D')
        .map((f) => ({ path: f.path, doc: tree.find((d) => d.path === f.path) }))
        .filter((x) => x.doc && x.doc.status !== 'approved'),
    [pr?.files, tree],
  );
  if (!pr) return <div className="empty muted">レビューは GitHub の PR で使えます</div>;

  const close = lastDoc ? docHref(lastDoc) : `#/w/${encodeURIComponent(route.ws)}/`;
  const changeEvent = (e: ReviewEvent) => {
    setEvent(e);
    if (e !== 'APPROVE') setApprove([]);
  };

  const submit = async () => {
    const drifted = comments.filter((c) => c.state === 'Drifted').length;
    if (drifted) return setError('位置を確認していないコメントがあります');
    if (event !== 'APPROVE' && !body.trim() && comments.length === 0) return setError('Comment / Request changes には本文が必要です');
    setError('');
    setBusy(true);
    try {
      const result = await api.submitReview({ event, body: body.trim() ? body : undefined, approveDocs: event === 'APPROVE' ? approve : undefined });
      rememberSubmit(route.ws, event, result);
      // The page may be replaced when a status commit moved head; the hash carries the way to the result.
      location.hash = `#/w/${encodeURIComponent(route.ws)}/review/done`;
      void pr.reloadReview();
      pr.reloadReviews();
    } catch (e) {
      setError((e as Error).message);
      void pr.reloadReview();
      setBusy(false);
    }
  };

  return (
    <section className="review-page" data-testid="review-page">
      <h2>保留中のレビュー</h2>
      <p className="muted">
        保留中のコメント <strong>{comments.length}</strong> 件（送信するまで GitHub には投稿されません）
      </p>
      {comments.length === 0 ? (
        <p className="muted" data-testid="pending-empty">
          保留中のコメントはありません。文書の 💬 から追加できます。
        </p>
      ) : (
        <ul className="pending-list" data-testid="pending">
          {comments.map((c) => (
            <PendingItem key={`${c.id}:${c.body}:${c.state}`} c={c} onChanged={() => void pr.reloadReview()} />
          ))}
        </ul>
      )}
      <div className="review-form">
        <label className="field">
          <span>種類</span>
          <select value={event} onChange={(e) => changeEvent(e.target.value as ReviewEvent)} data-testid="event">
            <option value="COMMENT">Comment</option>
            <option value="APPROVE">Approve</option>
            <option value="REQUEST_CHANGES">Request changes</option>
          </select>
        </label>
        <label className="field">
          <span>本文（{body.length} / 5000）{event === 'APPROVE' ? '' : '：コメントが無いときは必須'}</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={5000} data-testid="body" />
        </label>
        {candidates.length > 0 && (
          <fieldset className="approve-docs" disabled={event !== 'APPROVE'}>
            <legend>Approve と一緒に status を approved にする文書</legend>
            {candidates.map(({ path, doc }) => (
              <label key={path} className="toggle">
                <input
                  type="checkbox"
                  checked={approve.includes(path)}
                  disabled={event !== 'APPROVE'}
                  onChange={(e) => setApprove(e.target.checked ? [...approve, path] : approve.filter((p) => p !== path))}
                  data-testid="approve-status"
                  data-path={path}
                />
                {doc?.title ?? path} <code>{path}</code> <span className="muted">（{doc?.status}）</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <div className="error" data-testid="submit-error">
            {error}
          </div>
        )}
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void submit()} data-testid="review-submit">
            {EVENT_LABEL[event]} として送信
          </button>
          <button type="button" onClick={() => (location.hash = close)} data-testid="review-close">
            閉じる
          </button>
        </div>
      </div>
    </section>
  );
}

/** 送信済: result of the review, link to GitHub, back to the PR. */
export function DonePage({ lastDoc }: { lastDoc: string }) {
  const pr = usePr();
  const { route } = useApp();
  const r = recalledSubmit(route.ws);
  const back = lastDoc ? docHref(lastDoc) : `#/w/${encodeURIComponent(route.ws)}/`;
  useEffect(() => {
    if (!r) location.hash = back;
  }, [r, back]);
  if (!r) return null;
  const { result, event } = r;
  const sc = result.statusCommit;
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const safeUrl = /^https?:\/\//.test(result.reviewUrl ?? '') ? result.reviewUrl : '';
  return (
    <section className="review-page done" data-testid="done-page">
      <h2>{failed.length ? 'レビューを送信しました（一部のコメントは未投稿）' : 'レビューを送信しました'}</h2>
      <p data-testid="done-message">
        {EVENT_LABEL[event]} を送信しました（行コメント {result.posted?.line ?? 0} 件・ファイルコメント {result.posted?.file ?? 0} 件
        {result.posted?.body ? `・本文に含めたコメント ${result.posted.body} 件` : ''}
        {failed.length ? `・失敗 ${failed.length} 件` : ''}）。
        {sc?.mode === 'commit' && ` status を approved にしました（コミット ${sc.sha.slice(0, 7)}・${sc.paths.length} 件）。`}
        {sc?.mode === 'suggestion' && ` status の更新は suggestion コメントとして追加しました（${sc.paths.length} 件）。`}
      </p>
      {failed.length > 0 && (
        <ul className="error" data-testid="done-failed">
          {failed.map((f) => (
            <li key={f.id}>{f.message}（保留に残しています）</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="warn" data-testid="done-warnings">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div className="row">
        {safeUrl && (
          <a href={safeUrl} target="_blank" rel="noreferrer" data-testid="review-url">
            GitHub でレビューを開く
          </a>
        )}
        <button
          type="button"
          onClick={() => {
            pr?.reloadThreads();
            void pr?.reloadReview();
            pr?.reloadReviews();
            location.hash = back;
          }}
          data-testid="back-to-pr"
        >
          PR に戻る
        </button>
      </div>
    </section>
  );
}
