import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { parseTable, type EvidenceTable } from '../evidence-csv.ts';
import {
  AT_LABEL,
  DIALOG_CLOSED,
  LIVE_NOTE,
  STATUS_LABEL,
  canSave,
  evidenceNote,
  firstFile,
  kindLabel,
  moveEvent,
  navigable,
  reduceDialog,
  rowAction,
  saveEvidence,
  titleDetail,
  toggleExpanded,
  useLabel,
  baseName,
  type EvidenceFile,
  type TraceEvidence,
} from '../evidence-view.ts';

/** Reads the body of one file of the selected step (`Backend.evidence` or the results branch). */
export type EvidenceLoader = (file: EvidenceFile, signal: AbortSignal) => Promise<Blob>;

const STATUS_CLASS: Record<TraceEvidence['status'], string> = { ok: 'st-passed', warn: 'st-warn', failed: 'st-failed', skipped: 'st-skipped' };
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_LIMIT = 1024 * 1024;

/** 「証跡」 of a trace step: the list, the expanded reasons and the dialog (evidence-trace.md「画面」). Nothing without evidence. */
export function EvidencePanel({ evidence, load }: { evidence: TraceEvidence[] | undefined; load: EvidenceLoader }) {
  const records = [...(evidence ?? [])].sort((a, b) => a.seq - b.seq);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ seq: number; text: string } | null>(null);
  const [dialog, dispatch] = useReducer(reduceDialog, DIALOG_CLOSED);
  const openButtons = useRef(new Map<number, HTMLButtonElement>());
  const opener = useRef<number | null>(null);

  useEffect(() => {
    if (dialog.phase !== 'loading') return;
    const ctl = new AbortController();
    const r = records.find((x) => x.seq === dialog.target.seq);
    const f = r?.files[dialog.target.file];
    if (!f) {
      dispatch({ type: 'failed', token: dialog.token, error: '証跡がありません' });
      return;
    }
    load(f, ctl.signal).then(
      (blob) => !ctl.signal.aborted && dispatch({ type: 'loaded', token: dialog.token, blob }),
      (e: Error) => !ctl.signal.aborted && dispatch({ type: 'failed', token: dialog.token, error: e.message || '証跡を読み込めませんでした' }),
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.phase, dialog.token]);

  const close = useCallback(() => {
    dispatch({ type: 'close' });
    const seq = opener.current;
    queueMicrotask(() => (seq !== null ? openButtons.current.get(seq)?.focus() : undefined));
  }, []);

  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const move = useCallback((dir: 1 | -1) => {
    const e = moveEvent(dialogRef.current, recordsRef.current, dir);
    if (e) dispatch(e);
  }, []);

  useEffect(() => {
    if (dialog.phase === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
      // The dialog takes the keys: the trace's step moves do not see them.
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.key === 'Escape') close();
      else move(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dialog.phase, close, move]);

  if (!records.length) return null;

  const open = (r: TraceEvidence) => {
    const a = rowAction(r);
    setRowError(null);
    if (a.kind === 'expand') setExpanded((cur) => toggleExpanded(cur, r.seq));
    else if (a.kind === 'dialog') {
      setExpanded(null);
      opener.current = r.seq;
      dispatch({ type: 'open', target: { seq: r.seq, file: firstFile(r) } });
    }
  };
  const saveRow = async (r: TraceEvidence) => {
    const f = r.files[firstFile(r)];
    try {
      await saveEvidence(f, await load(f, new AbortController().signal));
    } catch (e) {
      setExpanded(null);
      setRowError({ seq: r.seq, text: (e as Error).message });
    }
  };

  const current = dialog.phase !== 'closed' ? records.find((r) => r.seq === dialog.target.seq) : undefined;
  return (
    <>
      <h4>証跡</h4>
      <table className="trace-table evidence-list" data-testid="evidence-list">
        <thead>
          <tr>
            <th>#</th>
            <th>表示名</th>
            <th>時点</th>
            <th>種類</th>
            <th>取得手段</th>
            <th>状態</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const a = rowAction(r);
            const text = expanded === r.seq && a.kind === 'expand' ? a.text : rowError?.seq === r.seq ? rowError.text : null;
            return (
              <Fragment key={r.seq}>
                <tr data-seq={r.seq} data-status={r.status}>
                  <td className="num">{r.seq}</td>
                  <td>{r.label}</td>
                  <td>{AT_LABEL[r.at]}</td>
                  <td>{kindLabel(r)}</td>
                  <td>{useLabel(r)}</td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </td>
                  <td className="nowrap">
                    {a.kind === 'none' ? (
                      <span className="muted">{a.note}</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          data-testid="evidence-open"
                          aria-expanded={a.kind === 'expand' ? expanded === r.seq : undefined}
                          ref={(b) => {
                            if (b) openButtons.current.set(r.seq, b);
                            else openButtons.current.delete(r.seq);
                          }}
                          onClick={() => open(r)}
                        >
                          開く
                        </button>{' '}
                        {a.kind === 'dialog' && (
                          <button type="button" data-testid="evidence-save" onClick={() => void saveRow(r)}>
                            保存
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
                {text && (
                  <tr data-seq={r.seq} className="evidence-reason">
                    <td colSpan={7}>
                      <p className="error" data-testid="evidence-error">
                        {text}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {current && dialog.phase !== 'closed' && (
        <EvidenceDialog
          record={current}
          fileIndex={dialog.target.file}
          state={dialog}
          canStep={navigable(records).length > 1}
          onClose={close}
          onMove={move}
          onFile={(file) => dispatch({ type: 'switch', target: { seq: current.seq, file } })}
          onSave={(f, blob) => {
            dispatch({ type: 'save' });
            void saveEvidence(f, blob);
          }}
        />
      )}
    </>
  );
}

function EvidenceDialog({
  record: r,
  fileIndex,
  state,
  canStep,
  onClose,
  onMove,
  onFile,
  onSave,
}: {
  record: TraceEvidence;
  fileIndex: number;
  state: ReturnType<typeof reduceDialog>;
  canStep: boolean;
  onClose(): void;
  onMove(dir: 1 | -1): void;
  onFile(i: number): void;
  onSave(f: EvidenceFile, blob: Blob): void;
}) {
  const f = r.files[fileIndex];
  const [rows, setRows] = useState<number | undefined>(undefined);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  useEffect(() => setRows(undefined), [state.token]);
  const note = evidenceNote(r, { file: f, writtenRows: rows });
  return (
    <div className="evidence-backdrop" onClick={onClose}>
      <div className="evidence-dialog" role="dialog" aria-modal="true" aria-label={r.label} data-testid="evidence-dialog" data-state={state.phase} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong data-testid="evidence-title">{r.label}</strong>
          <span className="muted">{titleDetail(r)}</span>
          <span className="spacer" />
          <button type="button" data-testid="evidence-close" ref={closeRef} onClick={onClose}>
            閉じる
          </button>
        </div>
        {r.files.length > 1 && (
          <div className="row evidence-tabs" role="tablist">
            {r.files.map((x, i) => (
              <button key={x.path} type="button" role="tab" aria-selected={i === fileIndex} disabled={!!x.omitted || i === fileIndex || state.phase !== 'shown'} onClick={() => onFile(i)}>
                {baseName(x.path)}
              </button>
            ))}
          </div>
        )}
        <div className="evidence-body">
          {state.phase === 'loading' && <p className="muted">読み込み中…</p>}
          {state.phase === 'failed' && (
            <p className="error" data-testid="evidence-load-error">
              {state.error}
            </p>
          )}
          {state.phase === 'shown' && f && <EvidenceBody file={f} blob={state.blob} onRows={setRows} />}
        </div>
        {note && (
          <p className="note muted" data-testid="evidence-note">
            {note}
          </p>
        )}
        <div className="row">
          <button type="button" data-testid="evidence-save" disabled={!canSave(state) || !f} onClick={() => state.phase === 'shown' && f && onSave(f, state.blob)}>
            {f?.kind === 'table' ? '保存（CSV）' : '保存'}
          </button>
          <button type="button" data-testid="evidence-prev" disabled={!canStep || state.phase === 'loading'} onClick={() => onMove(-1)} title="前の証跡（←）">
            ← 前の証跡
          </button>
          <button type="button" data-testid="evidence-next" disabled={!canStep || state.phase === 'loading'} onClick={() => onMove(1)} title="次の証跡（→）">
            次の証跡 →
          </button>
        </div>
      </div>
    </div>
  );
}

/** Body of one file by kind (evidence-trace.md「種類の表示」). Everything is rendered as React text. */
function EvidenceBody({ file, blob, onRows }: { file: EvidenceFile; blob: Blob; onRows(n: number | undefined): void }) {
  const [text, setText] = useState<{ value: string; more: boolean } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  useEffect(() => {
    let alive = true;
    setText(null);
    if (file.kind === 'image') {
      if (!IMAGE_MIMES.has(file.mime)) return;
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => {
        alive = false;
        URL.revokeObjectURL(u);
      };
    }
    if (file.kind === 'file') return;
    const more = file.kind === 'text' && blob.size > TEXT_LIMIT;
    (more ? blob.slice(0, TEXT_LIMIT) : blob).text().then((value) => alive && setText({ value, more }));
    return () => {
      alive = false;
    };
  }, [file, blob]);
  const table = file.kind === 'table' && text ? parseTable(text.value) : null;
  useEffect(() => onRows(table ? table.rows.length : undefined), [table?.rows.length, onRows]);

  if (file.kind === 'image')
    return url ? (
      <img data-testid="evidence-image" className={`evidence-image${fit ? ' fit' : ''}`} src={url} alt={baseName(file.path)} onClick={() => setFit(!fit)} title="クリックで原寸 / 幅合わせ" />
    ) : (
      <p className="muted" data-testid="evidence-file">
        {baseName(file.path)}（{file.mime}・{file.bytes} バイト）
      </p>
    );
  if (file.kind === 'file')
    return (
      <p data-testid="evidence-file">
        {baseName(file.path)}（{file.mime}・{file.bytes} バイト）
      </p>
    );
  if (!text) return <p className="muted">読み込み中…</p>;
  if (file.kind === 'table') return table ? <EvidenceTableView t={table} /> : <pre data-testid="evidence-text">{text.value}</pre>;
  if (file.kind === 'json') {
    let v: unknown;
    try {
      v = JSON.parse(text.value);
    } catch {
      return <pre data-testid="evidence-text">{text.value}</pre>;
    }
    return (
      <pre className="evidence-json" data-testid="evidence-json">
        <JsonNode value={v} depth={0} />
      </pre>
    );
  }
  return (
    <>
      <pre className="evidence-text" data-testid="evidence-text">
        {text.value}
      </pre>
      {text.more && <p className="muted">続きは保存して確認してください</p>}
    </>
  );
}

function EvidenceTableView({ t }: { t: EvidenceTable }) {
  return (
    <div className="evidence-scroll">
      <table className="trace-table" data-testid="evidence-table">
        <thead>
          <tr>
            {t.columns.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j}>{v === null || v === undefined ? <span className="muted">null</span> : typeof v === 'string' ? v : JSON.stringify(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** JSON tree: open up to depth 2, deeper objects / arrays in `<details>`. */
function JsonNode({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || typeof value !== 'object') return <>{JSON.stringify(value)}</>;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const [o, c] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const inner = (
    <>
      {entries.map(([k, v]) => (
        <div key={k} className="json-entry">
          {!Array.isArray(value) && <span className="json-key">{JSON.stringify(k)}: </span>}
          <JsonNode value={v} depth={depth + 1} />
        </div>
      ))}
    </>
  );
  if (depth >= 2)
    return (
      <details>
        <summary>
          {o}…{c}（{entries.length}）
        </summary>
        {inner}
      </details>
    );
  return (
    <>
      {o}
      {inner}
      {c}
    </>
  );
}

/** Live view: the planned evidence of the step (label・時点・取得手段 only) and that the player does not capture. */
export function EvidencePlanList({ plan }: { plan: Array<{ label: string; at: 'before' | 'after'; use: string }> }) {
  if (!plan.length) return null;
  return (
    <>
      <h4>証跡</h4>
      <table className="trace-table evidence-list" data-testid="evidence-list">
        <thead>
          <tr>
            <th>#</th>
            <th>表示名</th>
            <th>時点</th>
            <th>種類</th>
            <th>取得手段</th>
            <th>状態</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plan.map((p, i) => (
            <tr key={i} data-seq={i + 1}>
              <td className="num">{i + 1}</td>
              <td>{p.label}</td>
              <td>{AT_LABEL[p.at]}</td>
              <td />
              <td>{p.use}</td>
              <td />
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note muted">{LIVE_NOTE}</p>
    </>
  );
}
