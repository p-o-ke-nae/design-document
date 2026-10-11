import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, gh, type ChangedFile, type ChangedFiles, type DocDiff, type PrInfo, type Thread } from '../api.ts';
import { useApp } from '../state.tsx';
import { useWorkspaces } from './Workspace.tsx';

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
  error: string;
}

const Ctx = createContext<PrCtx | null>(null);

/** PR review state of a GitHub PR workspace; null outside one. */
export const usePr = () => useContext(Ctx);

export function PrProvider({ children }: { children: ReactNode }) {
  const { route, version } = useApp();
  const { current } = useWorkspaces();
  const id = current?.id ?? '';
  const [info, setInfo] = useState<PrInfo | null>(null);
  const [files, setFiles] = useState<ChangedFiles | null>(null);
  const [diffOn, setDiffOn] = useState(false);
  const [diff, setDiff] = useState<DocDiff | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    let alive = true;
    gh.pr(id).then((i) => alive && setInfo(i)).catch(() => {});
    api
      .prFiles()
      .then((f) => alive && setFiles(f))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id, version]);

  const changeOf = useMemo(() => {
    const m = new Map((files?.docs ?? []).map((f) => [f.path, f]));
    return (p: string) => m.get(p);
  }, [files]);

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
    if (!path) return;
    let alive = true;
    api
      .prThreads(path)
      .then((t) => alive && setThreads(t))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, version]);

  const value = useMemo(() => ({ info, files, changeOf, diffOn, setDiffOn, diff, threads, error }), [info, files, changeOf, diffOn, diff, threads, error]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const REVIEW_LABEL: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented' };

/** Latest review state per reviewer (PR bar). */
export function ReviewStates({ info }: { info: PrInfo | null }) {
  const reviews = info?.reviews ?? [];
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

/** One review thread (display only in Phase 2A). */
export function ThreadView({ thread, showPlace }: { thread: Thread; showPlace?: boolean }) {
  const [first, ...replies] = thread.comments;
  const place = thread.placement;
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
