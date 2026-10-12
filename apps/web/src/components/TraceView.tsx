import { useEffect, useReducer } from 'react';
import { api, ApiError, type TraceResponse } from '../api.ts';
import { viewHref } from '../state.tsx';
import { acceptsArrowKeys, goBack, reduceTraceView, shortSha, startTrace } from '../trace-view.ts';
import { TraceStepDetail, TraceTimeline } from './TraceStepDetail.tsx';

const fmtAt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** `#/tests/trace/<runId>/<testId>` — one test id's trace in one run (DD-TRVIEW). `load` / `shotUrl` read another source (an Actions run's files). */
export function TraceView({
  runId,
  testId,
  load,
  shotUrl,
  backHref,
}: {
  runId: string;
  testId: string;
  load?: () => Promise<TraceResponse>;
  shotUrl?: (n: number) => string;
  backHref?: string;
}) {
  const [state, dispatch] = useReducer(reduceTraceView, { runId, testId }, startTrace);

  useEffect(() => {
    const key = { runId, testId };
    dispatch({ type: 'open', key });
    let alive = true;
    (load ? load() : api.trace(runId, testId))
      .then((trace) => alive && dispatch({ type: 'fetched', key, trace }))
      .catch((e: Error) => alive && dispatch({ type: 'fetched', key, code: e instanceof ApiError ? (e.code ?? String(e.status)) : 'error', message: e.message }));
    return () => {
      alive = false;
    };
  }, [runId, testId, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || !acceptsArrowKeys(e.target)) return;
      if (e.key === 'ArrowLeft') dispatch({ type: 'prev' });
      else if (e.key === 'ArrowRight') dispatch({ type: 'next' });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const back = () => goBack(backHref ?? viewHref('tests'));

  if (state.kind === 'Loading')
    return (
      <div className="tests-page trace-view" data-testid="trace-loading">
        <p className="muted">読み込み中…</p>
      </div>
    );

  if (state.kind === 'None')
    return (
      <div className="tests-page trace-view">
        <p className="notice warn" data-testid="no-trace" data-code={state.code}>
          {state.message}
        </p>
        <button type="button" data-testid="notrace-back" onClick={back}>
          ← 戻る
        </button>
      </div>
    );

  const { trace, selected } = state;
  const steps = trace.steps;
  const at = steps.findIndex((s) => s.index === selected);
  const step = at >= 0 ? steps[at] : null;
  return (
    <div className="tests-page trace-view" data-testid="trace-view">
      <div className="trace-head">
        <button type="button" data-testid="trace-back" onClick={back}>
          ← 戻る
        </button>
        <span data-testid="trace-header" className="trace-header">
          <strong>
            <code className="test-id">{trace.testId}</code>
          </strong>
          <span className="muted">
            {fmtAt(trace.startedAt)}
            {trace.commit ? `・${shortSha(trace.commit)}${trace.dirty ? '（未コミットの変更あり）' : ''}` : ''}・{trace.target === 'app' ? '実アプリ' : 'モック'}・{(trace.durationMs / 1000).toFixed(1)}s
          </span>
        </span>
        <span data-testid="trace-status" data-status={trace.status} className={`badge st-${trace.status}`}>
          {trace.status === 'failed' ? (trace.failedStep && trace.failedStep >= 1 ? `失敗：ステップ ${trace.failedStep}` : '失敗：開始前') : '成功'}
        </span>
      </div>
      {trace.title && <p className="muted trace-title">{trace.title}</p>}
      {trace.status === 'failed' && !(trace.failedStep && trace.failedStep >= 1) && trace.error && (
        <div className="notice error" data-testid="trace-error">
          {trace.error}
        </div>
      )}
      <div className="trace-split">
        <div className="trace-side">
          {steps.length ? <TraceTimeline steps={steps} selected={selected} onSelect={(index) => dispatch({ type: 'select', index })} /> : <p className="muted">ステップはありません</p>}
          <div className="row">
            <button type="button" data-testid="step-prev" disabled={at <= 0} onClick={() => dispatch({ type: 'prev' })} title="前のステップ（←）">
              ← 前
            </button>
            <button type="button" data-testid="step-next" disabled={!steps.length || at >= steps.length - 1} onClick={() => dispatch({ type: 'next' })} title="次のステップ（→）">
              次 →
            </button>
          </div>
        </div>
        <div className="trace-main">{step && <TraceStepDetail step={step} shotUrl={step.screenshot ? (shotUrl ? shotUrl(step.index) : api.traceShot(runId, testId, step.index)) : null} />}</div>
      </div>
    </div>
  );
}
