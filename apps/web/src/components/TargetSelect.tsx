import { useEffect, useReducer } from 'react';
import type { RunBody } from '../api.ts';
import { api, workspace } from '../backend/index.ts';
import { loadSavedTargets, openTargetSelect, saveTargets, targetSelectReducer } from '../targets.ts';

/** 接続先の選択 (platform-results.md「接続先の選択（TargetSelect）」「接続先の選択の状態」). The targets are fetched every time it opens. */
export function TargetSelect({ body, count, onStarted, onClose }: { body: RunBody; count: number; onStarted(id: string, body: RunBody): void; onClose(): void }) {
  const [state, dispatch] = useReducer(targetSelectReducer, undefined, openTargetSelect);
  const ws = workspace() || 'local';

  useEffect(() => {
    if (state.kind !== 'Loading') return;
    let alive = true;
    api
      .targets()
      .then((r) => alive && dispatch({ type: 'loaded', targets: r.targets, saved: loadSavedTargets(localStorage, ws) }))
      .catch((e: Error) => alive && dispatch({ type: 'loadFailed', error: e.message }));
    return () => {
      alive = false;
    };
  }, [state.kind, ws]);

  const start = () => {
    const next = targetSelectReducer(state, { type: 'start' });
    dispatch({ type: 'start' });
    if (next.kind !== 'Starting') return;
    const request: RunBody = { ...body, runners: next.selected };
    api
      .startRun(request)
      .then((r) => {
        saveTargets(localStorage, ws, next.selected);
        dispatch({ type: 'started', runId: r.id });
        onStarted(r.id, request);
      })
      .catch((e: Error) => dispatch({ type: 'rejected', error: e.message }));
  };

  useEffect(() => {
    if (state.kind === 'Closed') onClose();
  }, [state.kind, onClose]);

  const targets = state.kind === 'Choosing' || state.kind === 'Starting' ? state.targets : [];
  const selected = state.kind === 'Choosing' || state.kind === 'Starting' ? state.selected : [];
  const error = state.kind === 'Choosing' || state.kind === 'LoadError' ? state.error : '';
  return (
    <div className="dialog-backdrop">
      <div className="dialog target-select" role="dialog" aria-modal="true" aria-label="接続先の選択" data-testid="target-select">
        <h3>接続先の選択</h3>
        <p>シナリオ {count} 件を、選んだ接続先で順に実行します。</p>
        {state.kind === 'Loading' && <p className="muted">読み込み中…</p>}
        {targets.length > 0 && (
          <table className="trace-table" data-testid="targets">
            <thead>
              <tr>
                <th />
                <th>接続先</th>
                <th>プラットフォーム</th>
                <th>対象</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.name} className={t.available ? '' : 'muted'}>
                  <td>
                    <input
                      type="checkbox"
                      data-testid={`target-${t.name}`}
                      aria-label={t.name}
                      checked={selected.includes(t.name)}
                      disabled={!t.available || state.kind !== 'Choosing'}
                      onChange={() => dispatch({ type: 'toggle', name: t.name })}
                    />
                  </td>
                  <td>
                    {t.name}
                    {!t.available && t.reason && (
                      <div className="fail-msg" data-testid={`target-${t.name}-reason`}>
                        {t.reason}
                      </div>
                    )}
                  </td>
                  <td>{t.platform}</td>
                  <td>
                    <code>{t.target}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && (
          <div className="notice warn" data-testid="target-error">
            {error}
          </div>
        )}
        <div className="row">
          {state.kind === 'LoadError' && (
            <button type="button" data-testid="target-reload" onClick={() => dispatch({ type: 'reopen' })}>
              開き直す
            </button>
          )}
          <button type="button" data-testid="target-cancel" disabled={state.kind === 'Loading' || state.kind === 'Starting'} onClick={() => dispatch({ type: 'cancel' })}>
            キャンセル
          </button>
          <button type="button" className="primary" data-testid="target-start" disabled={state.kind !== 'Choosing'} onClick={start}>
            開始
          </button>
        </div>
      </div>
    </div>
  );
}
