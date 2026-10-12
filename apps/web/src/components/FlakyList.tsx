import { useEffect, useState } from 'react';
import { api } from '../backend/index.ts';
import type { FlakyEntry } from '../api.ts';
import { docHref, historyHref, useApp, viewHref } from '../state.tsx';
import { formatAt } from './TestHistory.tsx';

export function FlakyList() {
  const { version, latest } = useApp();
  const [list, setList] = useState<FlakyEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .flaky()
      .then((l) => {
        setList(l);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  }, [version, latest]);

  return (
    <div className="tests-page flaky-page" data-testid="flaky-page">
      <div className="row">
        <button type="button" onClick={() => (location.hash = viewHref('tests'))} data-testid="flaky-back">
          ← 一覧へ
        </button>
        <strong>フレーキー（{list?.length ?? 0}）</strong>
      </div>
      {error && <div className="notice warn">{error}</div>}
      {list && list.length > 0 ? (
        <table className="tests-table" data-testid="flaky-list">
          <thead>
            <tr>
              <th>テストID</th>
              <th>文書</th>
              <th>コミット</th>
              <th>成功 / 失敗</th>
              <th>最後の失敗</th>
            </tr>
          </thead>
          <tbody>
            {list.map((f) => {
              const c = f.commits[0];
              return (
                <tr key={f.id} data-test-id={f.id}>
                  <td className="nowrap">
                    <a href={historyHref(f.id)} data-testid="flaky-test-open">
                      <code className="test-id">{f.id}</code>
                    </a>
                  </td>
                  <td>{f.doc ? <a href={docHref(f.doc)}>{f.doc.split('/').slice(-2).join('/')}</a> : <span className="muted">-</span>}</td>
                  <td className="nowrap">
                    {c.commit.slice(0, 7)}
                    {f.commits.length > 1 && <span className="muted">（ほか {f.commits.length - 1} 件）</span>}
                  </td>
                  <td className="num">
                    {c.passed} / {c.failed}
                  </td>
                  <td className="nowrap">{formatAt(f.lastFailedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        list && (
          <div className="muted" data-testid="flaky-list">
            フレーキーなテストはありません
          </div>
        )
      )}
    </div>
  );
}
