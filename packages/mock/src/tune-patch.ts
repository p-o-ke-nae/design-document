// Browser-safe part of the mock tune mode (DD-TUNE): types shared by the runtime (Tuner), the viewer (TunePanel)
// and the server (SourceLocator / SuggestionBuilder), and the validation of an ElementPatch. No Node imports.

export interface OptionPatch {
  value: string;
  label: string;
}

/** Desired state of an element relative to its source (each send replaces the previous one). */
export interface ElementPatch {
  text?: string;
  set: Record<string, string>;
  remove: string[];
  options?: OptionPatch[];
}

/** Element picked in the mock (`ddv:picked`). */
export interface PickedElement {
  /** Element-child indexes from `document.documentElement` (template contents / data-item / ddv UI are not counted). */
  path: number[];
  tag: string;
  testid?: string;
  /** Direct text (trimmed). */
  text?: string;
  /** Number of non-blank direct text nodes: the text can be edited only when it is 1. */
  textCount: number;
  /** Current values of the editable attributes that are present. */
  attrs: Record<string, string>;
  /** `select` only. */
  options?: OptionPatch[];
  /** Rendered by data-bind (or inside such an element): there is no source line. */
  generated: boolean;
}

export const TEXT_ATTRS = ['placeholder', 'title', 'aria-label', 'value', 'pattern'] as const;
export const NUMBER_ATTRS = ['maxlength', 'minlength', 'min', 'max', 'step'] as const;
export const BOOLEAN_ATTRS = ['required'] as const;
export const EDITABLE_ATTRS: readonly string[] = [...TEXT_ATTRS, ...NUMBER_ATTRS, ...BOOLEAN_ATTRS, 'type'];
export const INPUT_TYPES = ['text', 'number', 'email', 'tel', 'date', 'password', 'checkbox'] as const;
export const TUNE_VALUE_MAX = 200;

const INTEGER_ATTRS = new Set(['maxlength', 'minlength']);
const FORM_TAGS = new Set(['input', 'textarea', 'select']);

/** Attributes the viewer offers for an element (input fields are shown in this order). */
export function editableAttrsFor(tag: string): string[] {
  const t = tag.toLowerCase();
  if (t === 'input') return [...EDITABLE_ATTRS];
  if (t === 'textarea') return ['placeholder', 'title', 'aria-label', 'maxlength', 'minlength', 'required'];
  if (t === 'select') return ['title', 'aria-label', 'required'];
  return ['title', 'aria-label'];
}

export interface PatchIssue {
  /** Input the issue belongs to (`t-<field>` in the viewer). */
  field: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function numberOf(name: string, v: string): number | null {
  if (v.trim() === '') return null;
  if (name === 'step' && v === 'any') return null;
  if ((name === 'min' || name === 'max') && DATE.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validRegExp(p: string): boolean {
  for (const flags of ['v', 'u']) {
    try {
      new RegExp(p, flags);
      return true;
    } catch {
      // try the next flag set (older engines lack 'v')
    }
  }
  return false;
}

/**
 * Checks an ElementPatch from the network / the viewer. `tag` is the element's tag and `current` its current
 * attribute values (used for the range checks across the patch and the unchanged attributes).
 */
export function validatePatch(input: unknown, tag: string, current: Record<string, string> = {}): { patch: ElementPatch; issues: PatchIssue[] } {
  const issues: PatchIssue[] = [];
  const patch: ElementPatch = { set: {}, remove: [] };
  if (!isObj(input)) return { patch, issues: [{ field: 'patch', message: 'patch は { text?, set, remove, options? } で指定してください' }] };
  const t = tag.toLowerCase();
  const allowed = new Set(editableAttrsFor(t));

  if (input.text !== undefined) {
    if (typeof input.text !== 'string') issues.push({ field: 'text', message: '文言は文字列で指定してください' });
    else if (input.text.length > TUNE_VALUE_MAX) issues.push({ field: 'text', message: `文言は ${TUNE_VALUE_MAX} 文字以内で入力してください` });
    else if (FORM_TAGS.has(t) && t !== 'textarea') issues.push({ field: 'text', message: 'この要素の文言は変えられません' });
    else patch.text = input.text;
  }

  const set = input.set === undefined ? {} : input.set;
  if (!isObj(set)) issues.push({ field: 'patch', message: 'set は { 属性名: 値 } で指定してください' });
  else {
    for (const [name, v] of Object.entries(set)) {
      if (!allowed.has(name)) {
        issues.push({ field: name, message: `この属性は変更できません: ${name}` });
        continue;
      }
      if (typeof v !== 'string') {
        issues.push({ field: name, message: `${name} の値は文字列で指定してください` });
        continue;
      }
      if (v.length > TUNE_VALUE_MAX) {
        issues.push({ field: name, message: `${name} は ${TUNE_VALUE_MAX} 文字以内で入力してください` });
        continue;
      }
      patch.set[name] = v;
    }
  }

  const remove = input.remove === undefined ? [] : input.remove;
  if (!Array.isArray(remove)) issues.push({ field: 'patch', message: 'remove は属性名の配列で指定してください' });
  else {
    for (const name of remove) {
      if (typeof name !== 'string' || !allowed.has(name)) issues.push({ field: String(name), message: `この属性は変更できません: ${String(name)}` });
      else if (name in patch.set) issues.push({ field: name, message: `${name} の変更と削除が重なっています` });
      else if (!patch.remove.includes(name)) patch.remove.push(name);
    }
  }

  for (const [name, v] of Object.entries(patch.set)) {
    if ((NUMBER_ATTRS as readonly string[]).includes(name)) {
      const n = numberOf(name, v);
      if (Number.isNaN(n) || (n !== null && INTEGER_ATTRS.has(name) && (!Number.isInteger(n) || n < 0)))
        issues.push({ field: name, message: INTEGER_ATTRS.has(name) ? `${name} は 0 以上の整数で入力してください` : `${name} は数値で入力してください` });
    }
    if (name === 'required' && v !== '') issues.push({ field: name, message: 'required は値なしの属性です' });
    if (name === 'type' && !(INPUT_TYPES as readonly string[]).includes(v)) issues.push({ field: name, message: `type は ${INPUT_TYPES.join(' / ')} のいずれかです` });
    if (name === 'pattern' && !validRegExp(v)) issues.push({ field: name, message: '正規表現を確認してください' });
  }

  const after = { ...current, ...patch.set };
  for (const name of patch.remove) delete after[name];
  for (const [lo, hi] of [
    ['minlength', 'maxlength'],
    ['min', 'max'],
  ] as const) {
    if (!(lo in patch.set || hi in patch.set)) continue;
    const a = after[lo] !== undefined ? numberOf(lo, after[lo]) : null;
    const b = after[hi] !== undefined ? numberOf(hi, after[hi]) : null;
    if (a !== null && b !== null && !Number.isNaN(a) && !Number.isNaN(b) && a > b) issues.push({ field: lo in patch.set ? lo : hi, message: '範囲を確認してください' });
  }

  if (input.options !== undefined) {
    if (t !== 'select') issues.push({ field: 'options', message: '選択肢は select だけで変更できます' });
    else if (!Array.isArray(input.options) || !input.options.every((o) => isObj(o) && typeof o.value === 'string' && typeof o.label === 'string'))
      issues.push({ field: 'options', message: '選択肢は { value, label } の配列で指定してください' });
    else {
      const options = (input.options as Array<Record<string, string>>).map((o) => ({ value: o.value, label: o.label }));
      const values = options.map((o) => o.value);
      if (new Set(values).size !== values.length) issues.push({ field: 'options', message: '選択肢の値が重複しています' });
      else if (options.some((o) => o.value.length > TUNE_VALUE_MAX || o.label.length > TUNE_VALUE_MAX)) issues.push({ field: 'options', message: `選択肢は ${TUNE_VALUE_MAX} 文字以内で入力してください` });
      else patch.options = options;
    }
  }
  return { patch, issues };
}

/** True when the patch changes nothing relative to the picked element. */
export function isNoopPatch(patch: ElementPatch, el: Pick<PickedElement, 'text' | 'attrs' | 'options'>): boolean {
  if (patch.text !== undefined && patch.text !== (el.text ?? '')) return false;
  for (const [k, v] of Object.entries(patch.set)) if (el.attrs[k] !== v) return false;
  for (const k of patch.remove) if (k in el.attrs) return false;
  if (patch.options && JSON.stringify(patch.options) !== JSON.stringify(el.options ?? [])) return false;
  return true;
}

/** `testid` when present, else the tag (`<button>`). */
export function elementLabel(el: Pick<PickedElement, 'tag' | 'testid'>): string {
  return el.testid ? `${el.testid}（${el.tag}）` : `<${el.tag}>`;
}

/** Names of the changed items, for the default comment body. */
export function changedItems(patch: ElementPatch, el: Pick<PickedElement, 'text' | 'attrs' | 'options'>): string[] {
  const out: string[] = [];
  if (patch.text !== undefined && patch.text !== (el.text ?? '')) out.push('文言');
  for (const [k, v] of Object.entries(patch.set)) if (el.attrs[k] !== v) out.push(k);
  for (const k of patch.remove) if (k in el.attrs) out.push(k);
  if (patch.options && JSON.stringify(patch.options) !== JSON.stringify(el.options ?? [])) out.push('選択肢');
  return out;
}

/** Default body of the pending comment (people can add to it). */
export function defaultTuneBody(el: Pick<PickedElement, 'tag' | 'testid' | 'text' | 'attrs' | 'options'>, patch: ElementPatch): string {
  return `モック調整：${elementLabel(el)} の ${changedItems(patch, el).join('・') || '変更'}`;
}
