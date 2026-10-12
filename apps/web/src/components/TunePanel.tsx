import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BOOLEAN_ATTRS,
  INPUT_TYPES,
  NUMBER_ATTRS,
  defaultTuneBody,
  editableAttrsFor,
  elementLabel,
  isNoopPatch,
  validatePatch,
  type ElementPatch,
  type OptionPatch,
  type PatchIssue,
  type PickedElement,
} from '@ddv/mock/tune-patch';
import { api, workspace } from '../backend/index.ts';
import { ApiError } from '../backend/types.ts';
import type { MockSourceResult, MockSuggestion, PendingComment } from '../api.ts';
import type { TuneMessage } from '../player.ts';
import { usePr } from './Pr.tsx';
import { GateReason, useGate } from '../gate.tsx';

/** BD-GHREV-TUNE: Off (panel hidden) → Picking ⇄ Editing. */
type Mode = 'Picking' | 'Editing';

const GENERATED_MESSAGE = '対応する行なし：data-bind で作られた要素です';
const FORM_TAGS = new Set(['input', 'select']);

interface Form {
  text: string;
  attrs: Record<string, string>;
  required: boolean;
  options: OptionPatch[];
}

interface Selection {
  el: PickedElement;
  source: MockSourceResult;
}

interface Stored {
  el: PickedElement;
  patch: ElementPatch;
}

const isNumberAttr = (a: string) => (NUMBER_ATTRS as readonly string[]).includes(a);
const isBooleanAttr = (a: string) => (BOOLEAN_ATTRS as readonly string[]).includes(a);

export const tuneKey = (mock: string, path: number[]) => `${mock}#${path.join('.')}`;

/** Patches added to the pending review, kept per workspace so that a pending item can be re-applied (comments only hold the suggestion). */
const storeKey = () => `ddv.tune.${workspace() || 'local'}`;
function readStored(): Record<string, Stored> {
  try {
    return JSON.parse(localStorage.getItem(storeKey()) ?? '{}') as Record<string, Stored>;
  } catch {
    return {};
  }
}
function writeStored(key: string, v: Stored | null) {
  const all = readStored();
  if (v) all[key] = v;
  else delete all[key];
  localStorage.setItem(storeKey(), JSON.stringify(all));
}

const showText = (el: PickedElement) => el.textCount === 1 && !FORM_TAGS.has(el.tag);

function formOf(el: PickedElement, patch?: ElementPatch): Form {
  const attrs: Record<string, string> = {};
  for (const a of editableAttrsFor(el.tag)) if (!isBooleanAttr(a)) attrs[a] = el.attrs[a] ?? '';
  if (el.tag === 'input' && !attrs.type) attrs.type = 'text';
  const f: Form = { text: el.text ?? '', attrs, required: 'required' in el.attrs, options: el.options ? el.options.map((o) => ({ ...o })) : [] };
  if (!patch) return f;
  if (patch.text !== undefined) f.text = patch.text;
  for (const [k, v] of Object.entries(patch.set)) {
    if (k === 'required') f.required = true;
    else f.attrs[k] = v;
  }
  for (const k of patch.remove) {
    if (k === 'required') f.required = false;
    else f.attrs[k] = '';
  }
  if (patch.options) f.options = patch.options.map((o) => ({ ...o }));
  return f;
}

/** Form → the ElementPatch relative to the picked element (an empty number field removes the attribute). */
function patchOf(el: PickedElement, f: Form): ElementPatch {
  const p: ElementPatch = { set: {}, remove: [] };
  if (showText(el) && f.text !== (el.text ?? '')) p.text = f.text;
  for (const a of editableAttrsFor(el.tag)) {
    const has = a in el.attrs;
    if (isBooleanAttr(a)) {
      if (f.required && !has) p.set[a] = '';
      if (!f.required && has) p.remove.push(a);
      continue;
    }
    const v = f.attrs[a] ?? '';
    const cur = el.attrs[a] ?? (a === 'type' && el.tag === 'input' ? 'text' : '');
    if (v === cur) continue;
    if (v === '' && has && (isNumberAttr(a) || a === 'type')) p.remove.push(a);
    else if (v !== '' || has) p.set[a] = v;
  }
  if (el.tag === 'select' && JSON.stringify(f.options) !== JSON.stringify(el.options ?? [])) p.options = f.options;
  return p;
}

function SuggestionView({ s, source }: { s: MockSuggestion; source: MockSourceResult }) {
  const { element } = source;
  const before: string[] = [];
  for (let n = s.startLine; n <= s.line; n++) {
    const t = element.source[n - element.sourceStartLine];
    if (t !== undefined) before.push(t);
  }
  return (
    <div className="tune-suggestion">
      <div className="muted">
        {source.file} L{s.startLine}
        {s.line !== s.startLine ? `–${s.line}` : ''}
      </div>
      <pre data-testid="suggestion">
        {before.map((l, i) => (
          <div key={`b${i}`} className="del">
            - {l}
          </div>
        ))}
        {s.lines.map((l, i) => (
          <div key={`a${i}`} className="add">
            + {l}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** モック調整モードのパネル（DD-TUNE / BD-GHREV-TUNE）。`picked` は iframe からの最新の選択。 */
export function TunePanel({ mock, picked, send, onEnd }: { mock: string; picked: { el: PickedElement; seq: number } | null; send: (m: TuneMessage) => void; onEnd: () => void }) {
  const pr = usePr();
  const [mode, setMode] = useState<Mode>('Picking');
  const [pickError, setPickError] = useState('');
  const [notice, setNotice] = useState('');
  const [sel, setSel] = useState<Selection | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<MockSuggestion | null>(null);
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Patches applied to the DOM in this session (`pick` reports the patched DOM, so keep the original element)
  const applied = useRef(new Map<string, Stored>());
  const review = pr?.review;
  const suggestGate = useGate('suggestMock');
  const addGate = pr ? suggestGate : { enabled: true };

  const select = useCallback(
    async (picked: PickedElement, explicit?: ElementPatch) => {
      setPickError('');
      setNotice('');
      if (picked.generated) {
        setPickError(GENERATED_MESSAGE);
        return;
      }
      const k = tuneKey(mock, picked.path);
      const hasPending = !!review?.comments.some((c) => c.anchor.element.kind === 'mockElement' && c.anchor.element.key === k);
      const prev = explicit ? { el: picked, patch: explicit } : (applied.current.get(k) ?? (hasPending ? readStored()[k] : undefined));
      const el = prev?.el ?? picked;
      const patch = prev?.patch;
      const n = ++seq.current;
      try {
        const source = await api.mockSource({ mock, path: el.path, expect: { tag: el.tag, ...(el.testid ? { testid: el.testid } : {}) } });
        if (n !== seq.current) return;
        setSel({ el, source });
        setForm(formOf(el, patch));
        setBody(null);
        setSuggestion(null);
        setServerError('');
        setMode('Editing');
      } catch (e) {
        if (n !== seq.current) return;
        setPickError(e instanceof ApiError && e.code === 'no-source' ? e.message : `対応する行を取得できません: ${(e as Error).message}`);
      }
    },
    [mock, review],
  );

  // Clicks in the mock pick elements only while picking (X011: ignored while editing); a pick from before this panel opened is ignored
  const handled = useRef(picked?.seq ?? 0);
  useEffect(() => {
    if (!picked || picked.seq === handled.current) return;
    handled.current = picked.seq;
    if (modeRef.current === 'Picking') void select(picked.el);
  }, [picked, select]);

  const patch = useMemo(() => (sel && form ? patchOf(sel.el, form) : null), [sel, form]);
  const issues: PatchIssue[] = useMemo(() => (sel && patch ? validatePatch(patch, sel.el.tag, sel.el.attrs).issues : []), [sel, patch]);
  const noop = !sel || !patch || isNoopPatch(patch, sel.el);
  const issueOf = (field: string) => issues.find((i) => i.field === field)?.message;

  // Every change goes to the DOM at once and to the server for the suggestion (debounced)
  useEffect(() => {
    if (!sel || !patch || issues.length) return;
    const k = tuneKey(mock, sel.el.path);
    if (noop) applied.current.delete(k);
    else applied.current.set(k, { el: sel.el, patch });
    send({ type: 'ddv:patch', path: sel.el.path, patch: noop ? null : patch });
    if (noop) {
      setSuggestion(null);
      setServerError('');
      return;
    }
    const n = ++seq.current;
    const h = setTimeout(() => {
      api
        .mockSource({ mock, path: sel.el.path, expect: { tag: sel.el.tag, ...(sel.el.testid ? { testid: sel.el.testid } : {}) }, patch })
        .then((r) => {
          if (n !== seq.current) return;
          setSuggestion(r.suggestion ?? null);
          setServerError('');
        })
        .catch((e: Error) => {
          if (n !== seq.current) return;
          setSuggestion(null);
          setServerError(e.message);
        });
    }, 150);
    return () => clearTimeout(h);
  }, [sel, patch, issues.length, noop, mock, send]);

  const key = sel ? tuneKey(mock, sel.el.path) : '';
  const pendingOf = (k: string): PendingComment | undefined => pr?.review?.comments.find((c) => c.anchor.element.kind === 'mockElement' && c.anchor.element.key === k);
  const pending = (pr?.review?.comments ?? []).filter((c) => c.anchor.element.kind === 'mockElement' && c.anchor.element.key.startsWith(`${mock}#`));
  const autoBody = sel && patch ? defaultTuneBody(sel.el, patch) : '';
  const ready = !!suggestion && !noop && !issues.length && !serverError;

  const toPicking = () => {
    seq.current++;
    setSel(null);
    setForm(null);
    setSuggestion(null);
    setServerError('');
    setBody(null);
    setMode('Picking');
  };

  const add = async () => {
    if (!sel || !patch || !suggestion || !ready) return;
    setBusy(true);
    setServerError('');
    try {
      if (pr) {
        const text = (body ?? autoBody).trim() || autoBody;
        const element = { kind: 'mockElement' as const, key, label: elementLabel(sel.el) };
        const anchor = { path: sel.source.file, side: 'RIGHT' as const, startLine: suggestion.startLine, line: suggestion.line, element };
        const s = suggestion.lines.join('\n');
        const existing = pendingOf(key);
        if (existing) await api.updateComment(existing.id, { anchor, body: text, suggestion: s });
        else await api.addComment({ path: sel.source.file, element, anchor, body: text, suggestion: s });
        writeStored(key, { el: sel.el, patch });
        await pr.reloadReview();
        setNotice(`保留に追加しました：${elementLabel(sel.el)}`);
      } else {
        await navigator.clipboard.writeText(suggestion.lines.join('\n'));
        setNotice(`変更後の HTML をコピーしました（${sel.source.file} L${suggestion.startLine}${suggestion.line !== suggestion.startLine ? `–${suggestion.line}` : ''}）`);
      }
      toPicking();
    } catch (e) {
      setServerError(pr ? (e as Error).message : `コピーできません: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (sel) {
      applied.current.delete(key);
      send({ type: 'ddv:patch', path: sel.el.path, patch: null });
    }
    setNotice('');
    toPicking();
  };

  const end = () => {
    seq.current++;
    applied.current.clear();
    send({ type: 'ddv:tune', on: false });
    onEnd();
  };

  const reapply = (c: PendingComment) => {
    const stored = readStored()[c.anchor.element.key];
    if (!stored) {
      setNotice('');
      setPickError('この変更は再適用できません（この端末で追加したものではありません）');
      return;
    }
    void select(stored.el, stored.patch);
  };

  const setAttr = (a: string, v: string) => setForm((f) => (f ? { ...f, attrs: { ...f.attrs, [a]: v } } : f));
  const setOption = (i: number, o: Partial<OptionPatch>) => setForm((f) => (f ? { ...f, options: f.options.map((x, j) => (j === i ? { ...x, ...o } : x)) } : f));
  const moveOption = (i: number, d: number) =>
    setForm((f) => {
      if (!f || i + d < 0 || i + d >= f.options.length) return f;
      const options = [...f.options];
      [options[i], options[i + d]] = [options[i + d], options[i]];
      return { ...f, options };
    });

  return (
    <div className="tune" data-testid="tune-mode" data-state={mode}>
      <div className="tune-bar">
        <strong>調整中</strong>
        <span className="muted">{mode === 'Picking' ? 'モックの要素をクリックして選んでください' : `${sel ? elementLabel(sel.el) : ''} を編集中（保留に追加・取消で選び直せます）`}</span>
        <span className="spacer" />
        {mode === 'Picking' && (
          <button type="button" data-testid="tune-end" onClick={end}>
            調整終了
          </button>
        )}
      </div>
      {pickError && (
        <div className="notice warn" data-testid="pick-error">
          {pickError}
        </div>
      )}
      {notice && (
        <div className="notice" data-testid="tune-notice">
          {notice}
        </div>
      )}
      {mode === 'Editing' && sel && form && (
        <div className="tune-editor" data-testid="tune-editor">
          {showText(sel.el) && (
            <label className="tune-field">
              文言
              <input data-testid="t-text" value={form.text} maxLength={200} onChange={(e) => setForm({ ...form, text: e.target.value })} />
              {issueOf('text') && <span className="tune-issue">{issueOf('text')}</span>}
            </label>
          )}
          {editableAttrsFor(sel.el.tag).map((a) => {
            if (isBooleanAttr(a))
              return (
                <label key={a} className="tune-field tune-check">
                  <input type="checkbox" data-testid={`t-${a}`} checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />
                  {a}
                </label>
              );
            if (a === 'type')
              return (
                <label key={a} className="tune-field">
                  type
                  <select data-testid="t-type" value={form.attrs.type} onChange={(e) => setAttr('type', e.target.value)}>
                    {!(INPUT_TYPES as readonly string[]).includes(form.attrs.type) && <option value={form.attrs.type}>{form.attrs.type}</option>}
                    {INPUT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  {issueOf(a) && <span className="tune-issue">{issueOf(a)}</span>}
                </label>
              );
            return (
              <label key={a} className="tune-field">
                {a}
                <input
                  data-testid={`t-${a}`}
                  value={form.attrs[a] ?? ''}
                  maxLength={200}
                  inputMode={isNumberAttr(a) ? 'decimal' : undefined}
                  placeholder={isNumberAttr(a) ? '（なし）' : undefined}
                  onChange={(e) => setAttr(a, e.target.value)}
                />
                {issueOf(a) && <span className="tune-issue">{issueOf(a)}</span>}
              </label>
            );
          })}
          {sel.el.tag === 'select' && (
            <div className="tune-field tune-options" data-testid="t-options">
              選択肢
              <table>
                <thead>
                  <tr>
                    <th>値</th>
                    <th>文言</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {form.options.map((o, i) => (
                    <tr key={i}>
                      <td>
                        <input data-testid="t-option-value" value={o.value} maxLength={200} onChange={(e) => setOption(i, { value: e.target.value })} />
                      </td>
                      <td>
                        <input data-testid="t-option-label" value={o.label} maxLength={200} onChange={(e) => setOption(i, { label: e.target.value })} />
                      </td>
                      <td>
                        <button type="button" title="上へ" disabled={i === 0} onClick={() => moveOption(i, -1)}>
                          ↑
                        </button>
                        <button type="button" title="下へ" disabled={i === form.options.length - 1} onClick={() => moveOption(i, 1)}>
                          ↓
                        </button>
                        <button type="button" data-testid="t-option-delete" title="削除" onClick={() => setForm({ ...form, options: form.options.filter((_, j) => j !== i) })}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" data-testid="t-option-add" onClick={() => setForm({ ...form, options: [...form.options, { value: '', label: '' }] })}>
                ＋ 選択肢を追加
              </button>
              {issueOf('options') && <span className="tune-issue">{issueOf('options')}</span>}
            </div>
          )}
          {pr && (
            <label className="tune-field tune-body">
              コメント
              <textarea data-testid="t-body" rows={2} value={body ?? autoBody} onChange={(e) => setBody(e.target.value)} />
            </label>
          )}
          {suggestion && <SuggestionView s={suggestion} source={sel.source} />}
          {serverError && <div className="notice warn">⚠ {serverError}</div>}
          <div className="tune-actions">
            <button type="button" data-testid="t-apply" disabled={noop || issues.length > 0} onClick={() => patch && send({ type: 'ddv:patch', path: sel.el.path, patch })}>
              反映
            </button>
            <button type="button" data-testid="t-cancel" onClick={cancel}>
              取消
            </button>
            <button type="button" className="primary" data-testid="t-add" disabled={!ready || busy || !addGate.enabled} title={addGate.reason} onClick={() => void add()}>
              {pr ? (pendingOf(key) ? '保留を更新' : '保留に追加') : 'HTML をコピー'}
            </button>
            <GateReason gate={addGate} />
          </div>
        </div>
      )}
      {pr && (
        <div className="tune-pending" data-testid="tune-pending">
          <div className="muted">保留中の調整（{pending.length}）</div>
          {pending.length > 0 && (
            <ul>
              {pending.map((c) => (
                <li key={c.id}>
                  <button type="button" data-testid="tune-pending-item" disabled={mode !== 'Picking'} onClick={() => reapply(c)} title="この変更をモックに再適用して編集する">
                    {c.anchor.element.label} <span className="muted">L{c.anchor.startLine}</span> — {c.body}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
