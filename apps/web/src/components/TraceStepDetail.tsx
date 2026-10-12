import { Fragment, useState } from 'react';
import type { DbChange, TraceStep } from '../trace-view.ts';
import { callStatus, describeAction } from '../trace-view.ts';

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const KIND_LABEL: Record<DbChange['kind'], string> = { added: '追加', changed: '変更', removed: '削除' };

/** Steps of a trace (番号・イベント・✓ / ✗・所要時間). */
export function TraceTimeline({ steps, selected, onSelect }: { steps: TraceStep[]; selected: number | null; onSelect(index: number): void }) {
  return (
    <ol className="trace-timeline" data-testid="timeline">
      {steps.map((s) => (
        <li key={s.index} data-testid="timeline-step" data-index={s.index} data-ok={String(s.ok)} aria-current={s.index === selected ? 'step' : undefined} className={`${s.ok ? '' : 'ng'}${s.index === selected ? ' sel' : ''}`}>
          <button type="button" className="link" data-testid="step-select" onClick={() => onSelect(s.index)}>
            <span className="ts-no">{s.index}</span>
            <span className="ts-event">{s.event}</span>
            <span className="ts-ok">{s.ok ? '✓' : '✗'}</span>
            <span className="ts-time">{secs(s.durationMs)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function DbDiff({ db }: { db: DbChange[] | null }) {
  if (db === null)
    return (
      <p className="muted" data-testid="db-diff">
        対象外（実アプリ）
      </p>
    );
  if (!db.length)
    return (
      <p className="muted" data-testid="db-diff">
        変化なし
      </p>
    );
  const tables = [...new Set(db.map((d) => d.table))];
  return (
    <div data-testid="db-diff" className="trace-db">
      {tables.map((t) => (
        <table key={t} className="trace-table">
          <caption>{t}</caption>
          <tbody>
            {db
              .filter((d) => d.table === t)
              .map((d, i) => {
                const fields = [...new Set([...Object.keys(d.before ?? {}), ...Object.keys(d.after ?? {})])];
                return (
                  <tr key={i} data-testid="db-change" data-kind={d.kind}>
                    <td className={`db-kind db-${d.kind}`}>{KIND_LABEL[d.kind]}</td>
                    <td>
                      <code>{d.key}</code>
                    </td>
                    <td>
                      {fields.map((f) => {
                        const b = d.before?.[f];
                        const a = d.after?.[f];
                        const changed = d.kind === 'changed' && JSON.stringify(b) !== JSON.stringify(a);
                        return (
                          <span key={f} className={`db-field${changed ? ' changed' : ''}`}>
                            {f}: {d.kind === 'changed' ? (changed ? `${show(b)} → ${show(a)}` : show(a)) : show(d.kind === 'removed' ? b : a)}
                          </span>
                        );
                      })}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      ))}
    </div>
  );
}

function ApiCalls({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!step.calls.length)
    return (
      <p className="muted" data-testid="api-calls">
        通信はありません
      </p>
    );
  const toggle = (i: number) => {
    const n = new Set(open);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    setOpen(n);
  };
  return (
    <table className="trace-table" data-testid="api-calls">
      <thead>
        <tr>
          <th>メソッド</th>
          <th>パス</th>
          <th>状態</th>
          <th>所要時間</th>
        </tr>
      </thead>
      <tbody>
        {step.calls.map((c, i) => (
          <Fragment key={i}>
            <tr data-testid="api-call" className={`clickable${c.status <= 0 || c.status >= 400 ? ' ng' : ''}`} onClick={() => toggle(i)} aria-expanded={open.has(i)}>
              <td>{c.method}</td>
              <td>
                <code>{c.path}</code>
              </td>
              <td>{callStatus(c.status)}</td>
              <td className="num">{c.durationMs}ms</td>
            </tr>
            {open.has(i) && (
              <tr data-testid="api-call-body">
                <td colSpan={4}>
                  <div className="trace-body">
                    <strong>要求</strong>
                    <pre>{c.requestBody ?? '（なし）'}</pre>
                    <strong>応答</strong>
                    <pre>{c.responseBody ?? '（なし）'}</pre>
                    {c.truncated && <span className="chip warn">64KB で切り詰め</span>}
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** Details of one step: screenshot, operation, screens, expectations, API calls and DB changes. `shotUrl` = undefined hides the screenshot (live view). */
export function TraceStepDetail({ step, shotUrl }: { step: TraceStep; shotUrl?: string | null }) {
  const [broken, setBroken] = useState('');
  const screenExpect = step.expects.find((e) => e.kind === 'screen');
  return (
    <div className="trace-detail" data-testid="trace-detail" data-index={step.index}>
      {shotUrl !== undefined &&
        (shotUrl && broken !== shotUrl ? (
          <img className="trace-shot" data-testid="screenshot" src={shotUrl} alt={`ステップ ${step.index} のスクリーンショット`} onError={() => setBroken(shotUrl)} />
        ) : (
          <div className="trace-shot empty muted" data-testid="screenshot">
            スクリーンショットはありません
          </div>
        ))}
      <p data-testid="trace-action">
        <strong>操作：</strong>
        {describeAction(step)}
      </p>
      <p data-testid="trace-screen">
        <strong>画面：</strong>
        {step.screenBefore ?? '（不明）'} → {step.screenAfter ?? '（不明）'}
        {screenExpect && !screenExpect.ok && <span className="ng">（期待 {show(screenExpect.expected)}）</span>}
      </p>
      {step.expects.length ? (
        <table className="trace-table" data-testid="expect-table">
          <thead>
            <tr>
              <th>期待</th>
              <th>期待値</th>
              <th>実際</th>
            </tr>
          </thead>
          <tbody>
            {step.expects.map((e, i) => (
              <tr key={i} className={e.ok ? '' : 'ng'} data-ok={String(e.ok)}>
                <td>{e.key ? `${e.kind} ${e.key}` : e.kind}</td>
                <td>{show(e.expected)}</td>
                <td>{show(e.actual)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted" data-testid="expect-table">
          期待はありません
        </p>
      )}
      {step.error && (
        <div className="notice error" data-testid="trace-error">
          {step.error}
        </div>
      )}
      <h4>API</h4>
      <ApiCalls key={step.index} step={step} />
      <h4>DB の変化</h4>
      <DbDiff db={step.db} />
    </div>
  );
}
