import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../backend/index.ts';
import type { RunSummary, TestsResponse } from '../api.ts';
import { docHref, flakyHref, historyHref, traceHref, useApp, useLocalStorage } from '../state.tsx';
import { scenarioLinked } from '../trace-view.ts';
import { StatusBadge } from './StatusBadge.tsx';
import { FlakyMark, RecentDots, RerunPanel, formatCommit } from './TestHistory.tsx';

type Filter = 'all' | 'linked' | 'unlinked' | 'failed' | 'passed' | 'never';

export function TestsPage() {
  const { version, latest, runTests, rerunTests, history, activeRun, runLog, runError } = useApp();
  const [data, setData] = useState<TestsResponse | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [level, setLevel] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [viewRun, setViewRun] = useState<RunSummary | null>(null);
  const [rerunTimes, setRerunTimes] = useLocalStorage('ddv.rerunTimes', 2);
  const [rerunError, setRerunError] = useState('');
  const logRef = useRef<HTMLPreElement>(null);
  const running = activeRun?.status === 'running';

  useEffect(() => {
    api.tests().then(setData);
    api.runs().then(setRuns);
  }, [version, latest]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [runLog]);

  const rows = useMemo(() => {
    if (!data) return [];
    const ql = q.toLowerCase();
    return data.cases.filter((c) => {
      const r = latest[c.id];
      if (ql && !`${c.id} ${c.title} ${c.doc}`.toLowerCase().includes(ql)) return false;
      if (level && c.level !== level && !c.links.some((l) => l.level === level)) return false;
      switch (filter) {
        case 'linked':
          return c.links.length > 0;
        case 'unlinked':
          return c.links.length === 0;
        case 'failed':
          return r && (r.status === 'failed' || r.status === 'error');
        case 'passed':
          return r?.status === 'passed';
        case 'never':
          return c.links.length > 0 && !r;
        default:
          return true;
      }
    });
  }, [data, q, filter, level, latest]);

  const summary = useMemo(() => {
    const s = { total: 0, linked: 0, passed: 0, failed: 0, skipped: 0, never: 0 };
    for (const c of data?.cases ?? []) {
      s.total++;
      if (!c.links.length) continue;
      s.linked++;
      const r = latest[c.id];
      if (!r) s.never++;
      else if (r.status === 'passed') s.passed++;
      else if (r.status === 'skipped') s.skipped++;
      else s.failed++;
    }
    return s;
  }, [data, latest]);

  if (!data) return <div className="empty muted">読み込み中…</div>;
  const runnable = (ids: string[]) => ids.filter((id) => data.cases.find((c) => c.id === id)?.links.length);
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const rerunnable = history?.rerunnable ?? 0;
  const rerunBlocked = running ? 'テストの実行中は再実行できません' : !rerunnable ? '直近の実行に失敗したテストはありません' : '';
  const rerunning = !!activeRun?.rerunOf && (running || (activeRun.attempt ?? 0) < (activeRun.times ?? 0));

  return (
    <div className="tests-page" data-testid="tests-page">
      <section className="summary">
        <Stat label="テストケース" value={summary.total} />
        <Stat label="実装済み(紐づけ)" value={summary.linked} sub={`${summary.total ? Math.round((summary.linked / summary.total) * 100) : 0}%`} />
        <Stat label="成功" value={summary.passed} cls="ok" />
        <Stat label="失敗/エラー" value={summary.failed} cls="ng" />
        <Stat label="スキップ" value={summary.skipped} />
        <Stat label="未実行" value={summary.never} />
      </section>

      <section className="toolbar">
        <input type="search" placeholder="ID・タイトル・ドキュメントで絞り込み" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="状態">
          <option value="all">すべて</option>
          <option value="linked">紐づけあり</option>
          <option value="unlinked">未実装</option>
          <option value="failed">失敗</option>
          <option value="passed">成功</option>
          <option value="never">未実行</option>
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="レベル">
          <option value="">全レベル</option>
          <option value="unit">単体</option>
          <option value="integration">結合</option>
        </select>
        <span className="spacer" />
        <button type="button" disabled={running || !runnable([...checked]).length} onClick={() => runTests({ ids: runnable([...checked]) })} data-testid="run-selected">
          選択を実行 ({runnable([...checked]).length})
        </button>
        <button type="button" disabled={rerunning} title={rerunning ? '失敗の再実行中は開けません' : undefined} onClick={() => (location.hash = flakyHref())} data-testid="flaky-open">
          フレーキー（{history?.flakyCount ?? 0}）
        </button>
        <select value={rerunTimes} onChange={(e) => setRerunTimes(Number(e.target.value))} aria-label="再実行の回数" data-testid="rerun-times">
          {[1, 2, 3, 5].map((n) => (
            <option key={n} value={n}>
              {n} 回
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!!rerunBlocked}
          title={rerunBlocked || `直近の実行で失敗した ${rerunnable} 件を ${rerunTimes} 回続けて実行します`}
          onClick={async () => setRerunError(await rerunTests(rerunTimes))}
          data-testid="rerun"
        >
          失敗を再実行 ({rerunnable})
        </button>
        {data.runners.map((r) => (
          <button key={r.name} type="button" disabled={running} onClick={() => runTests({ runner: r.name })} title={`${r.type} @ ${r.cwd}`}>
            {r.name} を全実行
          </button>
        ))}
        <button type="button" className="primary" disabled={running || !data.runners.length} onClick={() => runTests({})} data-testid="run-all">
          一括実行
        </button>
      </section>

      {runError && <div className="notice warn">{runError}</div>}
      {rerunError && (
        <div className="notice warn" data-testid="rerun-error">
          {rerunError}
        </div>
      )}
      {rerunning && activeRun && <RerunPanel run={activeRun} log={runLog} />}
      {data.unknown.length > 0 && (
        <details className="notice warn">
          <summary>設計に存在しないテストIDの参照 {data.unknown.length} 件</summary>
          <ul>
            {data.unknown.map((l, i) => (
              <li key={i}>
                <code>{l.id}</code> {l.file}:{l.line}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="tests-grid">
        <div className="table-wrap">
          <table className="tests-table" data-testid="test-list">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="全選択"
                    checked={allChecked}
                    onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </th>
                <th>テストID</th>
                <th>内容</th>
                <th>設計</th>
                <th>実装</th>
                <th>最新結果</th>
                <th>直近 10 回</th>
                <th>時間</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const r = latest[c.id];
                return (
                  <tr key={c.id} data-testid="test-row" data-test-id={c.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.has(c.id)}
                        onChange={() => {
                          const n = new Set(checked);
                          if (n.has(c.id)) n.delete(c.id);
                          else n.add(c.id);
                          setChecked(n);
                        }}
                      />
                    </td>
                    <td className="nowrap">
                      {/* The re-run stays on the list until it ends (BD-TMON-SCREEN: no transition from 再実行中 but 実行完了). */}
                      {rerunning ? (
                        <code className="test-id" title="失敗の再実行中は開けません">
                          {c.id}
                        </code>
                      ) : (
                        <a href={historyHref(c.id)} data-testid="test-open">
                          <code className="test-id">{c.id}</code>
                        </a>
                      )}
                      {history?.tests[c.id]?.flaky && <FlakyMark commits={history.tests[c.id].flakyCommits} />}
                    </td>
                    <td>{c.title}</td>
                    <td>
                      <a href={docHref(c.doc)}>{c.doc.split('/').slice(-2).join('/')}</a>
                    </td>
                    <td className="links">
                      {c.links.length ? (
                        c.links.map((l, i) => (
                          <span key={i} className="chip" title={`${l.test}`}>
                            {l.runner}・{l.level === 'unit' ? '単体' : '結合'} {l.file.split('/').pop()}:{l.line}
                          </span>
                        ))
                      ) : (
                        <span className="muted">未実装</span>
                      )}
                    </td>
                    <td>
                      {r ? <StatusBadge status={r.status} title={r.message} /> : <span className="muted">-</span>}
                      {r?.message && r.status !== 'passed' && <div className="fail-msg">{r.message.split('\n')[0]}</div>}
                    </td>
                    <td>
                      <RecentDots summary={history?.tests[c.id]} />
                    </td>
                    <td className="num">{r ? `${r.durationMs}ms` : ''}</td>
                    <td>
                      <button type="button" className="run" disabled={!c.links.length || running} onClick={() => runTests({ ids: [c.id] })}>
                        ▶
                      </button>
                      {r?.runId && scenarioLinked(c.links) && (
                        <button type="button" className="run" onClick={() => (location.hash = traceHref(r.runId!, c.id))} data-testid="test-trace" title="直近の実行のトレース（ステップごとの記録）">
                          トレース
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="run-side">
          <h3>
            実行ログ {activeRun && <StatusBadge status={activeRun.status} />}
          </h3>
          <pre className="log" ref={logRef} data-testid="run-log">
            {runLog.length ? runLog.join('\n') : 'まだ実行していません'}
          </pre>
          <h3>実行履歴</h3>
          <ul className="runs">
            {runs.slice(0, 30).map((r) => {
              const vals = Object.values(r.results);
              const ok = vals.filter((v) => v.status === 'passed').length;
              const ng = vals.filter((v) => v.status === 'failed' || v.status === 'error').length;
              return (
                <li key={r.id}>
                  <button type="button" className="link" onClick={() => api.run(r.id).then((x) => setViewRun({ ...x, total: vals.length }))}>
                    {new Date(r.startedAt).toLocaleString()}
                  </button>{' '}
                  <StatusBadge status={r.status} /> <span className="ok">{ok}</span>/<span className="ng">{ng}</span>/{vals.length}
                  <span className="muted"> {r.request.ids ? `${r.request.ids.length}件指定` : r.request.runner ?? '全件'}（{formatCommit(r)}）</span>
                </li>
              );
            })}
          </ul>
          {viewRun && (
            <div className="run-detail">
              <h4>
                {new Date(viewRun.startedAt).toLocaleString()} <button type="button" className="link" onClick={() => setViewRun(null)}>閉じる</button>
              </h4>
              <ul>
                {Object.entries(viewRun.results).map(([id, r]) => (
                  <li key={id}>
                    <StatusBadge status={r.status} /> <code>{id}</code>
                  </li>
                ))}
              </ul>
              <details>
                <summary>ログ</summary>
                <pre className="log">{viewRun.log?.join('\n')}</pre>
              </details>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, cls }: { label: string; value: number; sub?: string; cls?: string }) {
  return (
    <div className={`stat ${cls ?? ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">
        {label} {sub && <span className="muted">{sub}</span>}
      </div>
    </div>
  );
}
