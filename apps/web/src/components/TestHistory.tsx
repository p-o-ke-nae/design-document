import { useEffect, useState } from 'react';
import { api, ApiError, type HistoryEntry, type RecentMark, type RunSummary, type TestHistory, type TestSummary } from '../api.ts';
import { docHref, traceHref, useApp, viewHref } from '../state.tsx';
import { StatusBadge } from './StatusBadge.tsx';

const RESULT: Record<string, string> = { passed: '成功', failed: '失敗', skipped: 'スキップ', error: 'エラー', none: '未実行' };

const pad = (n: number) => String(n).padStart(2, '0');

/** `MM/DD HH:mm` in local time. */
export function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Short SHA + 「（変更あり）」, 「不明」 without a commit, + 「再実行 n/m」. */
export function formatCommit(e: Pick<HistoryEntry, 'commit' | 'dirty' | 'rerunOf' | 'attempt' | 'times'>): string {
  let s = e.commit ? `${e.commit.slice(0, 7)}${e.dirty ? '（変更あり）' : ''}` : '不明';
  if (e.rerunOf) s += ` 再実行 ${e.attempt ?? '?'}/${e.times ?? '?'}`;
  return s;
}

export function RecentDots({ summary }: { summary?: TestSummary }) {
  const marks: RecentMark[] = summary?.recent ?? Array<RecentMark>(10).fill('none');
  return (
    <span className="dots" data-testid="test-dots">
      {marks.map((m, i) => {
        const at = summary?.recentAt?.[i];
        const title = at ? `${formatAt(at.at)}・${formatCommit(at)}・${RESULT[m]}` : RESULT.none;
        return <span key={i} className={`dot dot-${m}`} title={title} data-mark={m} />;
      })}
    </span>
  );
}

export function FlakyMark({ commits }: { commits: string[] }) {
  return (
    <span className="flaky-mark" data-testid="flaky-mark" title={`同じコミットで成功と失敗：${commits.map((c) => c.slice(0, 7)).join(', ')}`}>
      フレーキー
    </span>
  );
}

/** Rerunning: which attempt and its log (each attempt is followed in turn by the app state). */
export function RerunPanel({ run, log }: { run: RunSummary; log: string[] }) {
  return (
    <section className="rerun-panel">
      <div className="row">
        <strong>失敗を再実行中</strong>{' '}
        <span className="badge" data-testid="rerun-attempt">
          {run.attempt ?? 1} / {run.times ?? 1} 回目
        </span>
      </div>
      <pre className="log" data-testid="rerun-log">
        {log.join('\n')}
      </pre>
    </section>
  );
}

function firstLine(s = '') {
  const l = s.split('\n')[0];
  return l.length > 120 ? l.slice(0, 120) : l;
}

export function TestHistoryView({ id }: { id: string }) {
  const { version, latest } = useApp();
  const [h, setH] = useState<TestHistory | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .historyTest(id)
      .then((r) => {
        if (!alive) return;
        setH(r);
        setMissing(false);
        setError('');
      })
      .catch((e) => {
        if (!alive) return;
        setH(null);
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [id, version, latest]);

  const unknown = missing || (h && !h.known);
  const ff = h?.firstFailure;
  return (
    <div className="tests-page test-history" data-testid="test-history">
      <div className="row">
        <button type="button" onClick={() => (location.hash = viewHref('tests'))} data-testid="detail-back">
          ← 一覧へ
        </button>
        <span data-testid="detail-title">
          <strong>{id}</strong>{' '}
          {unknown ? (
            <span className="muted">このテストIDはロックにありません（欠番か存在しません）</span>
          ) : (
            h?.doc && (
              <span className="muted">
                <a href={docHref(h.doc)}>{h.doc.split('/').slice(-2).join('/')}</a>
                {h.diagram ? `・${h.diagram}` : ''}
                {h.title ? `　${h.title}` : ''}
              </span>
            )
          )}
        </span>
        {h && h.flakyCommits.length > 0 && (
          <span className="flaky-mark" data-testid="detail-flaky">
            フレーキー（{h.flakyCommits.map((c) => c.slice(0, 7)).join(', ')}）
          </span>
        )}
      </div>
      {error && <div className="notice warn">{error}</div>}
      {ff && (
        <p data-testid="first-failure">
          失敗し始めた実行：{formatAt(ff.at)}（{formatCommit(ff)}）
        </p>
      )}
      {h && h.entries.length > 0 ? (
        <table className="tests-table" data-testid="history">
          <thead>
            <tr>
              <th>実行日時</th>
              <th>コミット</th>
              <th>結果</th>
              <th>所要時間</th>
              <th>メッセージ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {h.entries.map((e) => {
              const changed = h.changed.includes(e.runId);
              return (
                <tr key={e.runId} data-testid="history-row" data-run-id={e.runId} data-changed={changed ? '' : undefined} className={`${changed ? 'changed' : ''} ${ff?.runId === e.runId ? 'first-failure' : ''}`.trim() || undefined}>
                  <td className="nowrap">{formatAt(e.at)}</td>
                  <td className="nowrap">{formatCommit(e)}</td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="num">{(e.durationMs / 1000).toFixed(1)}s</td>
                  <td title={e.message}>{firstLine(e.message)}</td>
                  <td>
                    {e.trace && (
                      <a className="button" href={traceHref(e.runId, id)} data-testid="history-trace">
                        トレース
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        (h || missing) && (
          <div className="muted" data-testid="history">
            まだ実行していません
          </div>
        )
      )}
    </div>
  );
}
