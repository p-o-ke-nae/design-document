import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../backend/index.ts';
import type { CoverageClass, Matrix, MatrixCase, TestSummary } from '../api.ts';
import { actionsHref, historyHref, traceHref, useApp } from '../state.tsx';
import { dispatchFromMatrix, useActionsStatus } from './ActionsPanel.tsx';
import { scenarioLinked } from '../trace-view.ts';
import { useCoverage } from './CoverageBadge.tsx';
import { FlakyMark } from './TestHistory.tsx';
import { useMockHub } from '../mockHub.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { CommentGutter } from './Review.tsx';
import { GateReason, useGate } from '../gate.tsx';
import { resultsByPlatform, scenarioCount, shouldOpenTargetSelect } from '../targets.ts';
import { evidenceBadge, type EvidenceBadge } from '../evidence-view.ts';
import { PlatformBadges, hasBadges } from './PlatformBadges.tsx';
import { TargetSelect } from './TargetSelect.tsx';

type Tab = 'all' | 'P' | 'T' | 'S' | 'X' | 'table';

const KIND_LABEL: Record<string, string> = { P: '経路', T: '遷移', S: 'Nスイッチ', X: '不正遷移' };
const COVERAGE_LABEL: Record<CoverageClass, string> = { passed: '成功', failed: '失敗', skipped: 'スキップ', unexecuted: '未実行', unlinked: '未紐づけ' };

export function MatrixPanel({ matrix, selected, onSelect }: { matrix: Matrix; selected: string | null; onSelect(id: string | null): void }) {
  const { latest, runTests, followStarted, activeRun, history, targets } = useApp();
  const [select, setSelect] = useState<{ ids: string[]; count: number } | null>(null);
  const platforms = targets.map((t) => t.platform);
  const actionsReady = useActionsStatus()?.state === 'ready';
  const coverage = useCoverage();
  const hub = useMockHub();
  const [tab, setTab] = useState<Tab>('all');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const running = activeRun?.status === 'running';
  const counts = useMemo(() => {
    const c: Record<string, number> = { P: 0, T: 0, S: 0, X: 0 };
    matrix.cases.forEach((x) => c[x.kind]++);
    return c;
  }, [matrix]);
  const rows = tab === 'all' || tab === 'table' ? matrix.cases : matrix.cases.filter((c) => c.kind === tab);
  const linked = matrix.cases.filter((c) => c.links.length);
  const provisional = matrix.cases.filter((c) => c.provisional);

  const toggle = (id: string) => {
    const n = new Set(checked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setChecked(n);
  };
  const run = (ids: string[]) => {
    if (shouldOpenTargetSelect(ids, matrix.cases, targets.length)) setSelect({ ids, count: scenarioCount(ids, matrix.cases) });
    else void runTests({ ids });
  };
  const runGate = useGate('runLocal');
  const idGate = useGate('generateTestIds');

  return (
    <section className="matrix" data-testid="matrix" data-diagram-key={matrix.diagramKey}>
      {select && <TargetSelect body={{ ids: select.ids }} count={select.count} onStarted={followStarted} onClose={() => setSelect(null)} />}
      <header className="matrix-head">
        <strong>テストマトリクス</strong>
        <code>{matrix.diagramKey}</code>
        <span className="chip">{matrix.level === 'unit' ? '単体' : '結合'}</span>
        <span className="muted">
          {matrix.cases.length} 件 / 紐づけ {linked.length} 件
        </span>
        <span className="spacer" />
        {provisional.length > 0 && (
          <button
            type="button"
            className="primary"
            disabled={!idGate.enabled}
            title={idGate.reason ?? '未採番(仮ID)のケースにIDを確定し .ddv/testids.lock.json を更新します'}
            onClick={async () => {
              const r = await api.generateIds();
              setMsg(`ロックを更新しました（追加 ${r.added.length} / 欠番 ${r.retired.length}）`);
            }}
          >
            IDを確定（{provisional.length}）
          </button>
        )}
        {provisional.length > 0 && <GateReason gate={idGate} />}
        <button type="button" disabled={running || !checked.size || !runGate.enabled} title={runGate.reason} onClick={() => run([...checked].filter((id) => matrix.cases.find((c) => c.id === id)?.links.length))}>
          選択を実行
        </button>
        <button type="button" disabled={running || !linked.length || !runGate.enabled} title={runGate.reason} onClick={() => run(linked.map((c) => c.id))}>
          紐づくテストを全て実行
        </button>
        <GateReason gate={runGate} />
      </header>
      {msg && <div className="notice">{msg}</div>}
      {matrix.warnings.map((w, i) => (
        <div key={i} className="notice warn">
          ⚠ {w}
        </div>
      ))}
      <nav className="tabs" role="tablist">
        {(['all', 'P', 'T', 'S', 'X'] as const).map((k) => (
          <button key={k} type="button" role="tab" className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>
            {k === 'all' ? `すべて (${matrix.cases.length})` : `${k} ${KIND_LABEL[k]} (${counts[k]})`}
          </button>
        ))}
        {matrix.table && (
          <button type="button" role="tab" className={tab === 'table' ? 'is-active' : ''} onClick={() => setTab('table')}>
            状態×イベント表
          </button>
        )}
      </nav>
      {tab === 'table' && matrix.table ? (
        <StateEventTable matrix={matrix} onSelect={onSelect} selected={selected} />
      ) : (
        <div className="table-wrap matrix-table">
          <table>
            <thead>
              <tr>
                <th />
                <th>テストID</th>
                <th>種別</th>
                <th>経路 / 操作</th>
                <th>期待結果</th>
                <th>紐づくテスト</th>
                <th>結果</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <MatrixRow
                  key={c.id}
                  c={c}
                  doc={matrix.doc}
                  selected={selected === c.id}
                  checked={checked.has(c.id)}
                  onCheck={() => toggle(c.id)}
                  onSelect={() => onSelect(selected === c.id ? null : c.id)}
                  result={latest[c.id]}
                  evidence={evidenceBadge(resultsByPlatform(latest, c.id))}
                  badges={hasBadges(c.id, platforms, latest) ? <PlatformBadges testId={c.id} platforms={platforms} latest={latest} /> : undefined}
                  coverage={coverage?.cases[c.id]}
                  summary={history?.tests[c.id]}
                  running={running}
                  onRun={() => run([c.id])}
                  onRunActions={actionsReady && c.links.length ? () => dispatchFromMatrix([c.id]) : undefined}
                  onPlayMock={
                    hub?.hasScenario(c.id)
                      ? () => {
                          onSelect(null);
                          hub.requestPlay(c.id);
                        }
                      : undefined
                  }
                  onTestData={hub?.hasScenario(c.id) ? () => hub.openTestData(c.id) : undefined}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {matrix.retired.length > 0 && (
        <details className="retired">
          <summary>欠番 {matrix.retired.length} 件（図から消えた経路）</summary>
          <ul>
            {matrix.retired.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> <span className="muted">{r.signature}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function MatrixRow({
  c,
  selected,
  checked,
  onCheck,
  onSelect,
  result,
  running,
  onRun,
  onRunActions,
  onPlayMock,
  onTestData,
  doc,
  coverage,
  summary,
  badges,
  evidence,
}: {
  c: MatrixCase;
  doc: string;
  selected: boolean;
  checked: boolean;
  onCheck(): void;
  onSelect(): void;
  result?: { status: string; message?: string; durationMs: number; runId?: string; source?: string };
  running: boolean;
  onRun(): void;
  onRunActions?: () => void;
  onPlayMock?: () => void;
  onTestData?: () => void;
  coverage?: CoverageClass;
  summary?: TestSummary;
  badges?: ReactNode;
  evidence?: EvidenceBadge | null;
}) {
  const runGate = useGate('runLocal');
  const executed = !!result || !!summary?.recent.some((m) => m !== 'none');
  return (
    <tr className={`${selected ? 'is-selected' : ''}`} onClick={onSelect} data-testid="matrix-row" data-test-id={c.id}>
      <td onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`${c.id} を選択`} />
      </td>
      <td className="nowrap">
        <code className="test-id">{c.id}</code>
        {c.provisional && (
          <span className="chip warn" title="ロックファイル未登録の仮ID">
            仮
          </span>
        )}
      </td>
      <td>
        <span className={`kind kind-${c.kind}`}>{c.kind}</span>
      </td>
      <td className="path-cell">{c.title}</td>
      <td>{c.expected}</td>
      <td className="links">
        {c.links.length ? (
          c.links.map((l, i) => (
            <span key={i} className="chip" title={`${l.file}:${l.line}\n${l.test}`}>
              {l.runner}
            </span>
          ))
        ) : (
          <span className="muted">未実装</span>
        )}
      </td>
      <td className="nowrap">
        {badges ?? (result ? <StatusBadge status={result.status} title={result.message} /> : <span className="muted">-</span>)}
        {coverage && (
          <span className={`cov-chip cov-${coverage}`} data-testid="matrix-coverage" data-class={coverage} title="設計カバレッジの分類">
            {COVERAGE_LABEL[coverage]}
          </span>
        )}
        {evidence && (
          <span className={`badge evidence-count${evidence.warn ? ' st-warn' : ''}`} data-testid="evidence-count" title={evidence.title}>
            {evidence.text}
          </span>
        )}
        {result?.source === 'actions' && (
          <span className="chip" data-testid="matrix-source" title="最新の結果は GitHub Actions の実行">
            Actions
          </span>
        )}
        {summary?.flaky && <span data-testid="matrix-flaky"><FlakyMark commits={summary.flakyCommits} /></span>}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <button type="button" className="run" disabled={!c.links.length || running || !runGate.enabled} onClick={onRun} data-testid="run-case" title={runGate.reason ?? (c.links.length ? 'このテストを実行' : '紐づくテストがありません')}>
          ▶ 実行
        </button>
        {onRunActions && (
          <button type="button" className="run" onClick={onRunActions} data-testid="matrix-run-actions" title="このテストを GitHub Actions で実行">
            Actionsで実行
          </button>
        )}
        {onPlayMock && (
          <button type="button" className="run play-mock" onClick={onPlayMock} data-testid="matrix-play-mock" title="この経路のシナリオを同じ文書のモックで再生">
            ▶ モック
          </button>
        )}
        {onTestData && (
          <button type="button" className="run" onClick={onTestData} data-testid="td-open" title="この経路のシナリオのテストデータ（入力値・期待値・fixtures）を表示・編集">
            テストデータ
          </button>
        )}
        <button type="button" className="run" disabled={!executed} onClick={() => (location.hash = historyHref(c.id))} data-testid="matrix-history" title={executed ? 'このテストIDの履歴' : 'まだ実行していません'}>
          履歴
        </button>
        {result?.runId && scenarioLinked(c.links) && (
          <button type="button" className="run" onClick={() => (location.hash = result.source === 'actions' ? actionsHref(`runs/${encodeURIComponent(result.runId!)}/trace/${encodeURIComponent(c.id)}`) : traceHref(result.runId!, c.id))} data-testid="trace-open" title="直近の実行のトレース（ステップごとの記録）">
            トレース
          </button>
        )}
        <CommentGutter inline path={doc} element={{ kind: 'matrixRow', key: c.id, label: c.title }} />
      </td>
    </tr>
  );
}

function StateEventTable({ matrix, selected, onSelect }: { matrix: Matrix; selected: string | null; onSelect(id: string | null): void }) {
  const t = matrix.table!;
  const label = (id: string) => matrix.graph.nodes.find((n) => n.id === id)?.label ?? id;
  const caseFor = (state: string, event: string, targets: string[]) =>
    targets.length
      ? matrix.cases.find((c) => c.kind === 'T' && c.nodes.at(-2) === state && matrix.graph.edges.find((x) => x.index === c.edges.at(-1))?.event === event)
      : matrix.cases.find((c) => c.kind === 'X' && c.state === state && c.event === event);
  return (
    <div className="table-wrap">
      <table className="se-table" data-testid="state-event-table">
        <thead>
          <tr>
            <th>状態 ＼ イベント</th>
            {t.events.map((e) => (
              <th key={e}>{e}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.states.map((s) => (
            <tr key={s}>
              <th>{label(s)}</th>
              {t.events.map((e) => {
                const targets = t.cells[s]?.[e] ?? [];
                const c = caseFor(s, e, targets);
                return (
                  <td key={e} className={`${targets.length ? 'ok' : 'ng'}${c && selected === c.id ? ' is-selected' : ''}`} onClick={() => c && onSelect(selected === c.id ? null : c.id)}>
                    {targets.length ? targets.map(label).join(' / ') : '×'}
                    {c && <div className="cell-id">{c.id}</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
