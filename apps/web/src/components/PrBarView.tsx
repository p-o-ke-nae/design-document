import type { PrInfo } from '../api.ts';
import { reviewHref } from '../state.tsx';
import { ReviewStates, usePr } from './Pr.tsx';

export interface PrBarViewProps {
  kind: 'pr' | 'ref';
  /** PR number (kind pr). */
  pr?: number;
  /** PR title before `info` arrives. */
  title?: string;
  /** kind ref: `owner/repo @ref`. */
  refLabel?: string;
  headSha: string;
  stale: boolean;
  info: PrInfo | null;
  onRefresh: () => void;
  error: string;
  /** Local edition only (`ws-close`: the worktree is removed). */
  onClose?: () => void;
}

/** PR bar: number, title, base ← head, head, 更新あり, 最新化, review states (local workspaces and Pages targets). */
export function PrBarView({ kind, pr: number, title, refLabel, headSha, stale, info, onRefresh, error, onClose }: PrBarViewProps) {
  const prCtx = usePr();
  const pr$ = !!prCtx && kind === 'pr';
  const pendingCount = Array.isArray(prCtx?.review?.comments) ? prCtx.review.comments.length : 0;
  const pr = info?.pr;
  return (
    <div className="prbar" data-testid="prbar">
      {kind === 'pr' ? (
        <>
          <span className="title" data-testid="pr-title">
            #{number} {pr?.title ?? title ?? ''}
          </span>
          {pr && (
            <code>
              {pr.baseRef} ← {pr.headRef}
            </code>
          )}
        </>
      ) : (
        <span className="title" data-testid="pr-title">
          {refLabel}
        </span>
      )}
      <code data-testid="head-sha" title={headSha}>
        {headSha.slice(0, 7)}
      </code>
      {stale && (
        <span className="stale" data-testid="stale">
          更新あり
        </span>
      )}
      {pr && pr.state === 'closed' && (
        <span className="badge" data-testid="pr-state">
          {pr.merged ? 'マージ済み' : 'クローズ'}
        </span>
      )}
      <button type="button" onClick={onRefresh} data-testid="refresh">
        最新化
      </button>
      {error && <span className="error">{error}</span>}
      <span className="spacer" />
      <ReviewStates info={info} />
      {pr$ && (
        <button type="button" className="primary" onClick={() => (location.hash = reviewHref())} data-testid="to-review" title="保留中のレビューを開く">
          レビュー（<span data-testid="pending-count">{pendingCount}</span>）
        </button>
      )}
      {pr && (
        <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
          GitHub で開く
        </a>
      )}
      {onClose && (
        <button type="button" onClick={onClose} data-testid="ws-close" title="worktree を削除します">
          閉じる
        </button>
      )}
    </div>
  );
}
