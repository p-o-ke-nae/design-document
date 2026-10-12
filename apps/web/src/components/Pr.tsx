import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../backend/index.ts';
import type { ChangedFile, ChangedFiles, DocDiff, ElementRef, PendingReview, PrInfo, ReviewEvent, ReviewerState, SubmitResult, Thread } from '../api.ts';
import { routeCodec, useApp } from '../state.tsx';
import { GateReason, useGate } from '../gate.tsx';

/** Where a new review comment is being written (the 💬 that opened it). */
export interface Composer {
  path: string;
  element: ElementRef;
}

interface PrCtx {
  info: PrInfo | null;
  files: ChangedFiles | null;
  /** Change of a document in the PR (undefined = unchanged). */
  changeOf: (path: string) => ChangedFile | undefined;
  /** 差分 view (true) or 本文 view (false). */
  diffOn: boolean;
  setDiffOn: (v: boolean) => void;
  /** Diff of the shown document (null while loading or when unchanged). */
  diff: DocDiff | null;
  /** Review threads of the shown document (unresolved first). */
  threads: Thread[];
  reloadThreads: () => void;
  /** Pending review of this workspace (null until loaded). */
  review: PendingReview | null;
  reloadReview: () => Promise<void>;
  /** Latest review state per reviewer (GET /reviews). */
  reviews: ReviewerState[] | null;
  reloadReviews: () => void;
  composer: Composer | null;
  openComposer: (c: Composer | null) => void;
  error: string;
}

const Ctx = createContext<PrCtx | null>(null);

/** PR review state of a GitHub PR workspace; null outside one. */
export const usePr = () => useContext(Ctx);

/** Result of the last submit, kept outside React so that it survives the remount after a status commit moved head. */
let lastSubmit: { ws: string; event: ReviewEvent; result: SubmitResult } | null = null;
export const rememberSubmit = (ws: string, event: ReviewEvent, result: SubmitResult) => {
  lastSubmit = { ws, event, result };
};
export const recalledSubmit = (ws: string) => (lastSubmit?.ws === ws ? lastSubmit : null);

export function PrProvider({ children }: { children: ReactNode }) {
  const { route, version } = useApp();
  // The workspace id (local: `#/w/<ws>`; Pages: the target's `Route.ws`). Not from Workspace.tsx: that is local-only UI.
  const id = route.ws;
  const [info, setInfo] = useState<PrInfo | null>(null);
  const [files, setFiles] = useState<ChangedFiles | null>(null);
  const [diffOn, setDiffOn] = useState(route.diff ?? false);
  const [diff, setDiff] = useState<DocDiff | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsTick, setThreadsTick] = useState(0);
  const [review, setReview] = useState<PendingReview | null>(null);
  const [reviews, setReviews] = useState<ReviewerState[] | null>(null);
  const [composer, openComposer] = useState<Composer | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    let alive = true;
    api.pr().then((i) => alive && setInfo(i)).catch(() => {});
    api
      .prFiles()
      .then((f) => alive && setFiles(f))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id, version]);

  const reloadReview = useCallback(async () => {
    const r = await api.review().catch(() => null);
    setReview(r && Array.isArray(r.comments) ? r : null);
  }, []);
  useEffect(() => {
    void reloadReview();
  }, [reloadReview, version]);

  const reloadReviews = useCallback(() => {
    api
      .reviews()
      .then((r) => setReviews(Array.isArray(r) ? r : null))
      .catch(() => {});
  }, []);
  useEffect(reloadReviews, [reloadReviews, version]);

  const reloadThreads = useCallback(() => setThreadsTick((n) => n + 1), []);

  const changeOf = useMemo(() => {
    const m = new Map((files?.docs ?? []).map((f) => [f.path, f]));
    return (p: string) => m.get(p);
  }, [files]);

  // Pages edition: the diff toggle is kept in the URL (`view=diff`) without adding history (pages-viewer.md「生成」).
  useEffect(() => {
    const c = routeCodec();
    if (!c || route.view !== 'doc' || !route.path) return;
    const href = c.href({ ...route, diff: diffOn });
    if (location.hash !== href) history.replaceState(history.state, '', href);
  }, [diffOn, route]);

  const path = route.view === 'doc' ? route.path : '';
  const changed = !!path && !!changeOf(path);
  useEffect(() => {
    setDiff(null);
    if (!path || !changed) return;
    let alive = true;
    api
      .prDiff(path)
      .then((d) => alive && setDiff(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, changed, version]);

  useEffect(() => {
    setThreads([]);
  }, [path]);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api
      .prThreads(path)
      .then((t) => alive && setThreads(Array.isArray(t) ? t : []))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, version, threadsTick]);

  const value = useMemo(
    () => ({ info, files, changeOf, diffOn, setDiffOn, diff, threads, reloadThreads, review, reloadReview, reviews, reloadReviews, composer, openComposer, error }),
    [info, files, changeOf, diffOn, diff, threads, reloadThreads, review, reloadReview, reviews, reloadReviews, composer, error],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const REVIEW_LABEL: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented' };

/** Latest review state per reviewer (PR bar). */
export function ReviewStates({ info }: { info: PrInfo | null }) {
  const pr = usePr();
  const reviews = Array.isArray(pr?.reviews) ? pr.reviews : Array.isArray(info?.reviews) ? info.reviews : [];
  if (!reviews.length) return null;
  return (
    <span className="review-states">
      {reviews.map((r) => (
        <span key={r.login} className={`badge review-${r.state.toLowerCase()}`} data-testid="review-state">
          {r.login}: {REVIEW_LABEL[r.state] ?? r.state}
        </span>
      ))}
    </span>
  );
}

export const MARK_TITLE: Record<string, string> = { A: '追加', M: '変更', D: '削除', R: '名前変更' };

/** A / M / D mark of a changed document. */
export function ChangeMark({ status }: { status?: string }) {
  return (
    <span className={`mark ${status ? `mark-${status.toLowerCase()}` : ''}`} title={status ? MARK_TITLE[status] : undefined} data-testid={status ? 'change-mark' : undefined}>
      {status ?? ''}
    </span>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

/** One review thread: comments, reply and 解決 / 未解決に戻す. */
export function ThreadView({ thread, showPlace }: { thread: Thread; showPlace?: boolean }) {
  const pr = usePr();
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [first, ...replies] = thread.comments;
  const place = thread.placement;
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      after?.();
      pr?.reloadThreads();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const replyGate = useGate('reply');
  const resolveGate = useGate('resolveThread');
  const send = () => {
    if (!reply.trim()) return setError('返信を入力してください');
    void run(() => api.replyThread(thread.id, reply), () => setReply(''));
  };
  return (
    <details className={`thread${thread.resolved ? ' resolved' : ''}`} data-testid="thread" data-thread-id={thread.id} open={!thread.resolved}>
      <summary>
        <span className="who">{first?.author ?? '?'}</span>：<span className="thread-head">{first?.body.split('\n')[0] ?? ''}</span>{' '}
        <span className="muted" data-testid="thread-state">
          （{thread.resolved ? '解決済み' : '未解決'}
          {replies.length ? `・返信 ${replies.length}` : ''}
          {thread.outdated ? '・古い位置' : ''}）
        </span>
      </summary>
      {showPlace && (
        <div className="thread-place muted">
          {place?.kind === 'element' ? place.element.label : place?.kind === 'outdated' ? `以前の版の行 ${thread.line ?? thread.startLine ?? ''}` : 'ファイルへのコメント'}
        </div>
      )}
      {place?.kind === 'element' && !showPlace && <div className="thread-place muted">{place.element.label}</div>}
      <ul className="comments">
        {thread.comments.map((c) => (
          <li key={c.id}>
            <span className="who">{c.author}</span> <span className="muted">{when(c.createdAt)}</span>
            <div className="comment-body">{c.body}</div>
          </li>
        ))}
      </ul>
      <a href={thread.url} target="_blank" rel="noreferrer" className="muted">
        GitHub で開く
      </a>
      {pr && (
        <div className="thread-actions">
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="返信を書く" rows={2} maxLength={2000} data-testid="thread-reply" />
          <div className="row">
            <button type="button" disabled={busy || !replyGate.enabled} title={replyGate.reason} onClick={send} data-testid="thread-reply-send">
              返信
            </button>
            <GateReason gate={replyGate} />
            <button type="button" disabled={busy || !resolveGate.enabled} title={resolveGate.reason} onClick={() => void run(() => api.resolveThread(thread.id, !thread.resolved))} data-testid="thread-resolve">
              {thread.resolved ? '未解決に戻す' : '解決済みにする'}
            </button>
            {resolveGate.reason !== replyGate.reason && <GateReason gate={resolveGate} />}
            {error && (
              <span className="error" data-testid="thread-error">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </details>
  );
}

/** Threads attached after a top-level block (`ddv-threads`). */
export function ThreadList({ ids }: { ids: string[] }) {
  const pr = usePr();
  const list = (pr?.threads ?? []).filter((t) => ids.includes(t.id));
  if (!list.length) return null;
  const open = list.filter((t) => !t.resolved).length;
  return (
    <div className="threads" data-testid="threads">
      <div className="threads-count muted" title="この要素のスレッド">
        💬 {list.length}
        {open ? `（未解決 ${open}）` : ''}
      </div>
      {list.map((t) => (
        <ThreadView key={t.id} thread={t} />
      ))}
    </div>
  );
}
