import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type InputHTMLAttributes, type ReactNode } from 'react';
import { api } from '../backend/index.ts';
import { ApiError } from '../backend/types.ts';
import type { DataIssue, MockField, Step, StepValue, TdRow, TdValue, TestDataBundle, ValidationResult } from '../api.ts';
import { useApp } from '../state.tsx';
import { useMockHub } from '../mockHub.tsx';
import { usePr } from './Pr.tsx';
import { GateReason, useGate } from '../gate.tsx';
import type { PlayerFailure } from '../player.ts';
import {
  CONFIRM_DISCARD,
  countValue,
  defaultComment,
  DraftStore,
  DUP_KEY,
  failedCells,
  fieldType,
  fieldValue,
  inputKind,
  inputValue,
  issueCell,
  nextDraftState,
  previewData,
  rowKeyField,
  selectOptions,
  cellOf,
  type DraftEvent,
  type DraftPath,
  type DraftState,
  type FieldType,
} from '../testdata.ts';

const VALIDATE_DELAY_MS = 400;
const FORM_CODES = new Set(['schema', 'generated', 'unknownFixture']);
const STATE_LABEL: Record<DraftState, string> = { View: '表示', Editing: '編集中', Previewing: '再生中', Saving: '保存中', Leaving: '離脱の確認' };

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function routeOf(b: TestDataBundle): string {
  const tr = b.transitions ?? [];
  if (!tr.length) return '';
  return [tr[0].from, ...tr.map((t) => `[${t.event}${t.guard ? ` [${t.guard}]` : ''}] ${t.to}`)].join(' → ');
}

/** テストデータの表示・編集（DD-TDEDIT）. */
export function TestDataEditor({ scenarioId }: { scenarioId: string }) {
  const hub = useMockHub();
  const prCtx = usePr();
  const { runTests, activeRun, version } = useApp();
  const [bundle, setBundle] = useState<TestDataBundle | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [state, setStateRaw] = useState<DraftState>('View');
  const stateRef = useRef<DraftState>('View');
  const store = useMemo(() => new DraftStore(), []);
  const ds = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const [saved, setSaved] = useState('');
  const [comment, setComment] = useState<string | null>(null);
  const [previewSeq, setPreviewSeq] = useState(0);
  const [failure, setFailure] = useState<PlayerFailure | null>(null);
  const [e2e, setE2e] = useState(false);

  const fire = useCallback((ev: DraftEvent, guard = true) => {
    const to = nextDraftState(stateRef.current, ev, guard);
    if (to) {
      stateRef.current = to;
      setStateRaw(to);
    }
    return to;
  }, []);

  // Saved data (refetched on file changes while not editing)
  useEffect(() => {
    if (stateRef.current !== 'View') return;
    let alive = true;
    api
      .testData(scenarioId)
      .then((b) => {
        if (!alive) return;
        setBundle(b);
        setLoadError('');
      })
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [scenarioId, reload, version, state === 'View']);

  useEffect(() => {
    let alive = true;
    api
      .tests()
      .then((t) => {
        if (!alive) return;
        const playwright = new Set(t.runners.filter((r) => r.type === 'playwright').map((r) => r.name));
        setE2e(!!t.cases.find((c) => c.id === scenarioId)?.links.some((l) => playwright.has(l.runner)));
      })
      .catch(() => alive && setE2e(false));
    return () => {
      alive = false;
    };
  }, [scenarioId]);

  // Diff / warnings / errors: re-validated 400ms after the input stops
  const draft = ds.draft;
  useEffect(() => {
    if (state !== 'Editing' || !draft) return;
    if (!ds.dirty) {
      setResult(null);
      return;
    }
    let alive = true;
    const h = setTimeout(() => {
      api
        .validateTestData(draft)
        .then((r) => {
          if (!alive) return;
          setResult(r);
          setSaveIssues([]);
        })
        .catch((e: Error) => alive && setSaveIssues([e.message]));
    }, VALIDATE_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [draft, ds.dirty, state]);

  // 他へ移る: another scenario (hub), a document link, or closing the tab
  const leave = useCallback((): boolean => {
    const s = stateRef.current;
    if (s === 'View') return true;
    if (s !== 'Editing') return false;
    if (!fire('leave', store.dirty)) return true;
    const ok = window.confirm(CONFIRM_DISCARD);
    fire(ok ? 'discard' : 'stay');
    if (ok) store.discard();
    return ok;
  }, [fire, store]);
  const setLeaveGuard = hub?.setLeaveGuard;
  useEffect(() => {
    setLeaveGuard?.(leave);
    return () => setLeaveGuard?.(null);
  }, [setLeaveGuard, leave]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#/"]');
      if (!a || stateRef.current === 'View' || !store.dirty) return;
      if (!leave()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (stateRef.current === 'View' || !store.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [leave, store]);

  // 再生終了
  const previewResult = hub?.previewResult;
  useEffect(() => {
    if (!previewResult || previewResult.seq !== previewSeq || stateRef.current !== 'Previewing') return;
    fire('previewEnd');
    setFailure(previewResult.failure);
  }, [previewResult, previewSeq, fire]);
  const saveFileGate = useGate('saveFile');
  const suggestGate = useGate('suggestTestData');
  const runGate = useGate('runLocal');

  if (loadError) return <Shell onClose={() => hub?.openTestData(null)} title={scenarioId}><div className="notice warn" data-testid="td-error">⚠ {loadError}</div></Shell>;
  if (!bundle) return <Shell onClose={() => hub?.openTestData(null)} title={scenarioId}><p className="muted">読み込み中…</p></Shell>;

  const b = bundle;
  const pr = b.workspace === 'pr';
  const editing = state !== 'View';
  const serverErrors = result?.errors ?? [];
  const cellErrors: Record<string, string> = {};
  for (const i of serverErrors) cellErrors[issueCell(i)] ??= i.message;
  Object.assign(cellErrors, ds.errors);
  const formOk = !store.hasInputErrors && !serverErrors.some((i) => FORM_CODES.has(i.code));
  const saveGate = pr ? suggestGate : saveFileGate;
  const canSave = saveGate.enabled && b.editable && ds.dirty && !store.hasInputErrors && !serverErrors.length && state === 'Editing';
  const commentText = comment ?? (draft ? defaultComment(draft, b) : '');

  const startEdit = () => {
    if (!fire('edit')) return;
    store.begin(b);
    setResult(null);
    setSaveIssues([]);
    setSaved('');
    setFailure(null);
    setComment(null);
  };
  const cancel = () => {
    if (state !== 'Editing') return;
    if (store.dirty && !window.confirm(CONFIRM_DISCARD)) return;
    fire('cancel');
    store.discard();
    setResult(null);
    setSaveIssues([]);
    setFailure(null);
  };
  const preview = () => {
    if (!draft || !hub || !fire('preview', formOk)) return;
    setFailure(null);
    setPreviewSeq(hub.startPreview(scenarioId, draft.scenario, previewData(draft)));
  };
  const save = async () => {
    if (!draft || !fire('save', canSave)) return;
    setSaveIssues([]);
    try {
      const r = await api.saveTestData({ ...draft, ...(pr ? { comment: commentText } : {}) });
      fire('response', true);
      setSaved([r.mode === 'suggestion' ? `suggestion を ${r.comments.length} 件追加しました` : '保存しました', ...(r.warnings ?? [])].join('。'));
      setResult(null);
      setFailure(null);
      setReload((n) => n + 1);
      hub?.refreshScenarios();
      if (r.mode === 'suggestion') void prCtx?.reloadReview();
    } catch (e) {
      fire('response', false);
      if (pr) void prCtx?.reloadReview();
      const body = e instanceof ApiError ? e.body : undefined;
      const errs = Array.isArray(body?.errors) ? (body.errors as Array<Partial<DataIssue>>) : [];
      if (errs.length && errs.every((x) => x.code)) setResult((cur) => ({ errors: errs as DataIssue[], warnings: (body?.warnings as DataIssue[]) ?? cur?.warnings ?? [], diff: cur?.diff ?? [] }));
      setSaveIssues(errs.length ? errs.map((x) => (x.code ? x.message ?? '' : `${x.file ?? ''} ${x.path ?? ''}: ${x.message ?? ''}`)) : [(e as Error).message]);
    }
  };

  const errorList = [...new Set([...serverErrors.map((i) => i.message), ...Object.values(ds.errors), ...saveIssues])];

  return (
    <Shell onClose={() => hub?.openTestData(null)} title={scenarioId} state={state}>
      <div className="td-head" data-testid="td-title">
        <strong>{b.scenario.data.id}</strong> <span>{b.scenario.data.title}</span>
        {b.retired && <span className="chip warn">引退</span>}
        {editing && <span className="chip">{STATE_LABEL[state]}</span>}
        <div className="muted td-route">{routeOf(b)}</div>
        <div className="muted">
          fixtures：{(b.scenario.data.fixtures ?? []).join('・') || '（なし）'}　<code>{b.scenario.path}</code>
        </div>
      </div>
      {state === 'Previewing' && (
        <p className="td-preview-badge" data-testid="preview-badge">
          編集中のデータで再生中
        </p>
      )}
      {failure && state !== 'Previewing' && (
        <p className="notice warn" data-testid="preview-failed">
          {failure.index === null ? `モックを初期化できません${failure.message ? `：${failure.message}` : ''}` : `ステップ ${failure.index + 1}「${failure.event ?? ''}」で失敗：${failure.failures.map((f) => f.key).join('・') || failure.message || ''}`}
        </p>
      )}
      {!editing ? (
        <ViewPane bundle={b} />
      ) : (
        draft && (
          <fieldset className="td-form" disabled={state !== 'Editing'}>
            <label className="td-field">
              タイトル
              <input data-testid="td-title-input" maxLength={200} value={draft.scenario.title} onChange={(e) => store.set(['scenario', 'title'], e.target.value)} />
            </label>
            <FixturesPicker bundle={b} value={draft.scenario.fixtures ?? []} error={cellErrors[cellOf(b, ['scenario', 'fixtures'])]} onChange={(v) => store.set(['scenario', 'fixtures'], v)} />
            <StepsEdit bundle={b} steps={draft.scenario.steps} store={store} errors={cellErrors} failure={failure} />
            {b.fixtures.map((f) =>
              Object.entries(draft.fixtures[f.name] ?? {}).map(([table, rows]) => (
                <FixtureTableEdit key={`${f.name}/${table}`} bundle={b} fixture={f.name} table={table} rows={rows} store={store} errors={cellErrors} />
              )),
            )}
            <div className="td-label">変わる行</div>
            <div className="td-diff" data-testid="diff">
              {!ds.dirty ? (
                <span className="muted">変更はありません</span>
              ) : !result ? (
                <span className="muted">確認中…</span>
              ) : (
                result.diff.map((d) => (
                  <div key={d.path} className="td-diff-file" data-path={d.path}>
                    <div className="td-diff-path">{d.path}</div>
                    {d.hunks.map((h, n) => (
                      <div key={n} className="td-hunk">
                        <div className="muted">@@ L{h.startLine}</div>
                        {h.before.map((l, i) => (
                          <div key={`-${i}`} className="del">
                            - {l}
                          </div>
                        ))}
                        {h.after.map((l, i) => (
                          <div key={`+${i}`} className="add">
                            + {l}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
            {!!result?.warnings.length && (
              <ul className="td-warnings" data-testid="warnings">
                {result.warnings.map((w, i) => (
                  <li key={i} data-code={w.code}>
                    警告：{w.message}
                  </li>
                ))}
              </ul>
            )}
            {errorList.length > 0 && (
              <ul className="td-errors" data-testid="save-error" role="alert">
                {errorList.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
            {pr && (
              <label className="td-field">
                コメント
                <textarea data-testid="td-comment" rows={2} value={commentText} onChange={(e) => setComment(e.target.value)} />
              </label>
            )}
          </fieldset>
        )
      )}
      <div className="td-actions">
        {!editing ? (
          <>
            <button type="button" data-testid="td-play" disabled={!hub?.hasScenario(scenarioId)} onClick={() => hub?.requestPlay(scenarioId)} title="保存済みの内容でモックを再生">
              ▶ 再生
            </button>
            <button type="button" data-testid="td-run-e2e" disabled={!e2e || activeRun?.status === 'running' || !runGate.enabled} onClick={() => void runTests({ ids: [scenarioId] })} title={runGate.reason ?? (e2e ? 'このシナリオの E2E テストを実行' : '紐づく playwright のテストがありません')}>
              E2E を実行
            </button>
            <span className="spacer" />
            <button type="button" className="primary" data-testid="edit" disabled={b.retired} onClick={startEdit} title={b.retired ? b.readonlyReason : b.editable ? '入力値・期待値・fixtures を編集' : `${b.readonlyReason ?? ''}`}>
              編集
            </button>
          </>
        ) : (
          <>
            <button type="button" data-testid="preview" disabled={state !== 'Editing' || !formOk || !hub?.hasScenario(scenarioId)} onClick={preview} title="編集中のデータでモックを再生（結果はシナリオの状態に記録しません）">
              ▶ 再生（編集中のデータ）
            </button>
            <span className="spacer" />
            <button type="button" data-testid="cancel" disabled={state !== 'Editing'} onClick={cancel}>
              取消
            </button>
            <button type="button" className="primary" data-testid="save" disabled={!canSave} onClick={() => void save()} title={saveGate.reason ?? (b.editable ? (ds.dirty ? '' : '変更がありません') : b.readonlyReason)}>
              {state === 'Saving' ? '保存中…' : pr ? 'suggestion に追加' : '保存'}
            </button>
            <GateReason gate={saveGate} />
          </>
        )}
      </div>
      {editing && !b.editable && b.readonlyReason && (
        <p className="muted" data-testid="td-readonly">
          {b.readonlyReason}
        </p>
      )}
      {saved && !editing && (
        <p className="notice" data-testid="saved">
          {saved}
        </p>
      )}
    </Shell>
  );
}

function Shell({ title, state, onClose, children }: { title: string; state?: DraftState; onClose(): void; children: ReactNode }) {
  return (
    <div className="td" data-state={state ?? 'View'} data-scenario={title}>
      <header className="td-bar">
        <strong>テストデータ</strong>
        <span className="spacer" />
        <button type="button" data-testid="td-close" onClick={onClose} title="閉じる">
          ×
        </button>
      </header>
      {children}
    </div>
  );
}

function inputText(input: Step['input']): string {
  return Object.entries(input ?? {})
    .map(([k, v]) => `${k}：${show(v)}`)
    .join('、');
}

function expectText(s: Step): string {
  const e = s.expect ?? {};
  const parts = [`画面 ${e.screen}`];
  for (const [k, v] of Object.entries(e.text ?? {})) parts.push(`${k}：${v}`);
  for (const [k, v] of Object.entries(e.count ?? {})) parts.push(`${k} 件数：${v}`);
  if (e.visible?.length) parts.push(`表示：${e.visible.join('・')}`);
  if (e.hidden?.length) parts.push(`非表示：${e.hidden.join('・')}`);
  return parts.join('、');
}

function tableFields(rows: TdRow[], key: string): string[] {
  const out = [key];
  for (const r of rows) for (const k of Object.keys(r)) if (!out.includes(k)) out.push(k);
  return out;
}

function ViewPane({ bundle }: { bundle: TestDataBundle }) {
  const steps = bundle.scenario.data.steps;
  return (
    <>
      <table className="td-table" data-testid="steps-view">
        <thead>
          <tr>
            <th>#</th>
            <th>イベント</th>
            <th>入力</th>
            <th>期待</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{s.event}</td>
              <td>{inputText(s.input)}</td>
              <td>{expectText(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {bundle.fixtures.map((f) =>
        Object.entries(f.data).map(([table, rows]) => {
          const key = rowKeyField(bundle.mock.tables, table, rows[0] ?? {});
          const fields = tableFields(rows, key);
          return (
            <div key={`${f.name}/${table}`}>
              <h4 className="td-h">
                fixtures：{f.name}（{table}）
              </h4>
              <table className="td-table" data-testid="fixtures-view" data-fixture={f.name} data-table={table}>
                <thead>
                  <tr>
                    {fields.map((k) => (
                      <th key={k}>{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {fields.map((k) => (
                        <td key={k}>{k in r ? show(r[k]) : ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }),
      )}
    </>
  );
}

/** Text box keeping what the user typed (even when it does not convert) until the stored value changes. */
function RawInput({ value, onText, invalid, ...rest }: { value: string; onText(v: string): void; invalid?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [raw, setRaw] = useState(value);
  useEffect(() => setRaw(value), [value]);
  return (
    <input
      {...rest}
      value={raw}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setRaw(e.target.value);
        onText(e.target.value);
      }}
    />
  );
}

function CellError({ message }: { message?: string }) {
  return message ? <span className="td-cell-error">{message}</span> : null;
}

function FixturesPicker({ bundle, value, error, onChange }: { bundle: TestDataBundle; value: string[]; error?: string; onChange(v: string[]): void }) {
  const rest = bundle.availableFixtures.filter((n) => !value.includes(n));
  return (
    <div className="td-field" data-testid="td-fixtures" aria-invalid={!!error || undefined}>
      使う fixtures
      <span className="td-chips">
        {value.map((n, i) => (
          <span key={n} className="chip" data-testid="td-fixture" data-name={n}>
            {n}
            {i > 0 && (
              <button type="button" title="前へ" onClick={() => onChange([...value.slice(0, i - 1), n, value[i - 1], ...value.slice(i + 1)])}>
                ↑
              </button>
            )}
            <button type="button" title="外す" data-testid="td-fixture-remove" onClick={() => onChange(value.filter((x) => x !== n))}>
              ×
            </button>
          </span>
        ))}
        {rest.length > 0 && (
          <select data-testid="td-fixture-add" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
            <option value="">＋ 追加</option>
            {rest.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
      </span>
      <CellError message={error} />
    </div>
  );
}

type KeyKind = 'input' | 'text' | 'count' | 'visible';
const KEY_KIND_LABEL: Record<KeyKind, string> = { input: '入力', text: '期待 text', count: '期待 count', visible: '期待 visible' };

function StepsEdit({ bundle, steps, store, errors, failure }: { bundle: TestDataBundle; steps: Step[]; store: DraftStore; errors: Record<string, string>; failure: PlayerFailure | null }) {
  const fields = new Map<string, MockField>(bundle.mock.fields.map((f) => [f.key, f]));
  const err = (path: DraftPath) => errors[cellOf(bundle, path)];
  return (
    <table className="td-table" data-testid="steps-edit">
      <thead>
        <tr>
          <th>#</th>
          <th>イベント</th>
          <th>入力</th>
          <th>期待（画面）</th>
          <th>期待（text・count・visible）</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step, i) => {
          const s = { ...step, expect: step.expect ?? {} };
          const failed = failure?.index === i;
          const marks = new Set(failed ? failedCells(failure.failures) : []);
          const at = (...p: DraftPath): DraftPath => ['scenario', 'steps', i, ...p];
          const mark = (k: string) => (marks.has(k) ? ' td-cell-failed' : '');
          return (
            <tr key={i} data-testid="step-row" data-index={i} className={failed ? 'td-row-failed' : ''} data-failed={failed || undefined}>
              <td>{i + 1}</td>
              <td className="td-gen">{s.event}</td>
              <td>
                {Object.entries(s.input ?? {}).map(([k, v]) => {
                  const f = fields.get(k);
                  const kind = inputKind(f);
                  const e = err(at('input', k));
                  return (
                    <div key={k} className="td-kv">
                      <label>
                        {k}{' '}
                        {kind === 'checkbox' ? (
                          <input type="checkbox" data-testid={`in-${k}`} checked={v === true} onChange={(ev) => store.set(at('input', k), ev.target.checked)} />
                        ) : kind === 'select' ? (
                          <select data-testid={`in-${k}`} value={String(v)} onChange={(ev) => store.set(at('input', k), ev.target.value)}>
                            {selectOptions(f, v).map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <RawInput
                            data-testid={`in-${k}`}
                            inputMode={kind === 'number' ? 'decimal' : undefined}
                            maxLength={1000}
                            value={String(v)}
                            invalid={!!e}
                            onText={(raw) => {
                              const c = inputValue(kind, raw);
                              if (c.ok) store.set(at('input', k), c.value);
                              else store.set(at('input', k), undefined, c.message);
                            }}
                          />
                        )}
                      </label>
                      <button type="button" className="td-x" data-testid="step-remove-key" data-kind="input" data-key={k} title="このキーを消す" onClick={() => store.set(at('input', k), undefined)}>
                        ×
                      </button>
                      <CellError message={e} />
                    </div>
                  );
                })}
                <CellError message={err(at('input'))} />
              </td>
              <td className={`td-gen${mark('screen')}`}>{s.expect.screen}</td>
              <td>
                {Object.entries(s.expect.text ?? {}).map(([k, v]) => {
                  const e = err(at('expect', 'text', k));
                  return (
                    <div key={`t-${k}`} className={`td-kv${mark(`ex-${k}`)}`}>
                      <label>
                        {k}{' '}
                        <RawInput data-testid={`ex-${k}`} maxLength={1000} value={v} invalid={!!e} onText={(raw) => store.set(at('expect', 'text', k), raw)} />
                      </label>
                      <button type="button" className="td-x" data-testid="step-remove-key" data-kind="text" data-key={k} title="このキーを消す" onClick={() => store.set(at('expect', 'text', k), undefined)}>
                        ×
                      </button>
                      <CellError message={e} />
                    </div>
                  );
                })}
                {Object.entries(s.expect.count ?? {}).map(([k, v]) => {
                  const e = err(at('expect', 'count', k));
                  return (
                    <div key={`c-${k}`} className={`td-kv${mark(`exc-${k}`)}`}>
                      <label>
                        {k} 件数{' '}
                        <RawInput
                          data-testid={`exc-${k}`}
                          inputMode="numeric"
                          value={String(v)}
                          invalid={!!e}
                          onText={(raw) => {
                            const c = countValue(raw);
                            if (c.ok) store.set(at('expect', 'count', k), c.value);
                            else store.set(at('expect', 'count', k), undefined, c.message);
                          }}
                        />
                      </label>
                      <button type="button" className="td-x" data-testid="step-remove-key" data-kind="count" data-key={k} title="このキーを消す" onClick={() => store.set(at('expect', 'count', k), undefined)}>
                        ×
                      </button>
                      <CellError message={e} />
                    </div>
                  );
                })}
                {s.expect.visible !== undefined && (
                  <div className={`td-kv${mark('exv')}`}>
                    <label>
                      表示{' '}
                      <select
                        multiple
                        data-testid="exv"
                        value={s.expect.visible}
                        onChange={(ev) => {
                          const v = [...ev.target.selectedOptions].map((o) => o.value);
                          store.set(at('expect', 'visible'), v.length ? v : undefined);
                        }}
                      >
                        {[...new Set([...s.expect.visible, ...bundle.mock.testids])].map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <CellError message={err(at('expect', 'visible'))} />
                  </div>
                )}
                <AddKey bundle={bundle} step={s} onAdd={(kind, key) => addKey(store, bundle, i, s, kind, key)} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function hasKey(s: Step, kind: KeyKind, key: string): boolean {
  if (kind === 'input') return !!s.input && key in s.input;
  if (kind === 'visible') return !!s.expect?.visible?.includes(key);
  return !!s.expect?.[kind] && key in s.expect[kind]!;
}

function addKey(store: DraftStore, bundle: TestDataBundle, i: number, s: Step, kind: KeyKind, key: string) {
  const at: DraftPath = ['scenario', 'steps', i];
  if (kind === 'input') {
    const k = inputKind(bundle.mock.fields.find((f) => f.key === key));
    const v: StepValue = k === 'checkbox' ? false : k === 'select' ? (selectOptions(bundle.mock.fields.find((f) => f.key === key), undefined)[0] ?? '') : '';
    store.set([...at, 'input', key], v);
  } else if (kind === 'text') store.set([...at, 'expect', 'text', key], '');
  else if (kind === 'count') store.set([...at, 'expect', 'count', key], 0);
  else store.set([...at, 'expect', 'visible'], [...(s.expect?.visible ?? []), key]);
}

function AddKey({ bundle, step, onAdd }: { bundle: TestDataBundle; step: Step; onAdd(kind: KeyKind, key: string): void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<KeyKind>('input');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const candidates = kind === 'count' ? bundle.mock.tables.map((t) => t.name) : bundle.mock.testids;
  const listId = `td-keys-${kind}`;
  if (!open)
    return (
      <button type="button" className="td-add" data-testid="step-add-key" onClick={() => setOpen(true)}>
        ＋ キー
      </button>
    );
  const submit = () => {
    const k = key.trim();
    if (!k) return;
    if (hasKey(step, kind, k)) {
      setError(DUP_KEY);
      return;
    }
    onAdd(kind, k);
    setOpen(false);
    setKey('');
    setError('');
  };
  return (
    <div className="td-addkey">
      <select data-testid="add-key-kind" value={kind} onChange={(e) => setKind(e.target.value as KeyKind)}>
        {(Object.keys(KEY_KIND_LABEL) as KeyKind[]).map((k) => (
          <option key={k} value={k}>
            {KEY_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <input data-testid="add-key-name" list={listId} value={key} aria-invalid={!!error || undefined} onChange={(e) => (setKey(e.target.value), setError(''))} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <datalist id={listId}>
        {candidates.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <button type="button" data-testid="add-key-ok" onClick={submit}>
        追加
      </button>
      <button type="button" onClick={() => (setOpen(false), setError(''))}>
        やめる
      </button>
      {error && (
        <span className="td-cell-error" data-testid="add-key-error">
          {error}
        </span>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<FieldType, string> = { string: '文字列', number: '数値', boolean: '真偽' };

function convertTo(type: FieldType, v: TdValue | undefined): TdValue {
  if (type === 'boolean') return v === true || v === 'true';
  if (type === 'number') {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v !== null ? n : 0;
  }
  return v === null || v === undefined ? '' : String(v);
}

function FixtureTableEdit({ bundle, fixture, table, rows, store, errors }: { bundle: TestDataBundle; fixture: string; table: string; rows: TdRow[]; store: DraftStore; errors: Record<string, string> }) {
  const key = rowKeyField(bundle.mock.tables, table, rows[0] ?? {});
  const fields = tableFields(rows, key);
  const [newField, setNewField] = useState<Record<number, string>>({});
  return (
    <div className="td-fx">
      <h4 className="td-h">
        fixtures：{fixture}（{table}）
      </h4>
      <table className="td-table" data-testid="fixtures-edit" data-fixture={fixture} data-table={table}>
        <thead>
          <tr>
            {fields.map((k) => (
              <th key={k}>{k}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rowKey = rowKeyField(bundle.mock.tables, table, r);
            return (
              <tr key={i} data-testid="fx-row" data-fixture={fixture} data-table={table} data-index={i}>
                {fields.map((k) => {
                  const path: DraftPath = ['fixtures', fixture, table, i, k];
                  const e = errors[cellOf(bundle, path)];
                  if (!(k in r))
                    return (
                      <td key={k} className="muted">
                        —
                      </td>
                    );
                  const v = r[k];
                  const type = fieldType(v);
                  const tid = k === rowKey ? 'fxkey' : `fx${k}`;
                  return (
                    <td key={k} aria-invalid={!!e || undefined}>
                      {type === 'boolean' ? (
                        <input type="checkbox" data-testid={tid} checked={v === true} onChange={(ev) => store.set(path, ev.target.checked)} />
                      ) : (
                        <RawInput
                          data-testid={tid}
                          maxLength={k === rowKey ? 100 : 1000}
                          inputMode={type === 'number' ? 'decimal' : undefined}
                          value={v === null ? '' : String(v)}
                          invalid={!!e}
                          onText={(raw) => {
                            const c = fieldValue(type, raw);
                            if (c.ok) store.set(path, c.value);
                            else store.set(path, undefined, c.message);
                          }}
                        />
                      )}
                      {k !== rowKey && (
                        <>
                          {(type === 'number' || type === 'boolean') && (
                            <select className="td-type" data-testid={`fxtype-${k}`} value={type} title="値の型" onChange={(ev) => store.set(path, convertTo(ev.target.value as FieldType, v))}>
                              {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => (
                                <option key={t} value={t}>
                                  {TYPE_LABEL[t]}
                                </option>
                              ))}
                            </select>
                          )}
                          <button type="button" className="td-x" data-testid="fx-remove-field" data-field={k} title="この項目を消す" onClick={() => store.set(path, undefined)}>
                            ×
                          </button>
                        </>
                      )}
                      <CellError message={e} />
                    </td>
                  );
                })}
                <td className="nowrap">
                  <input className="td-newfield" data-testid="fx-new-field" placeholder="項目名" value={newField[i] ?? ''} onChange={(e) => setNewField((m) => ({ ...m, [i]: e.target.value }))} />
                  <button
                    type="button"
                    data-testid="fx-add-field"
                    disabled={!(newField[i] ?? '').trim() || (newField[i] ?? '').trim() in r}
                    onClick={() => {
                      store.set(['fixtures', fixture, table, i, newField[i].trim()], '');
                      setNewField((m) => ({ ...m, [i]: '' }));
                    }}
                  >
                    ＋ 項目
                  </button>
                  <button type="button" data-testid="fx-remove-row" onClick={() => store.removeRow(fixture, table, i)}>
                    行を削除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="td-add" data-testid="fx-add-row" onClick={() => store.addRow(fixture, table)}>
        ＋ 行を追加
      </button>
    </div>
  );
}
