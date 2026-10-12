import type { DataIssue, FixtureTables, MockField, StepValue, TdRow, TdValue, TestDataBundle, TestDataDraft } from './api.ts';

// --- 編集の状態（DD-TDEDIT-DRAFT） ---

/** 表示 / 編集中 / 再生中 / 保存中 / 離脱の確認 */
export type DraftState = 'View' | 'Editing' | 'Previewing' | 'Saving' | 'Leaving';
/** 編集 / 値を変更 / 再生 / 再生終了 / 保存 / 応答 / 取消 / 他へ移る / 破棄 / 留まる */
export type DraftEvent = 'edit' | 'change' | 'preview' | 'previewEnd' | 'save' | 'response' | 'cancel' | 'leave' | 'discard' | 'stay';

export const DRAFT_INITIAL: DraftState = 'View';

/**
 * `guard`: 再生 = 形式OK、保存 = 変更あり・エラーなし、応答 = 成功、他へ移る = 変更あり.
 * null = not accepted (the button does nothing; 他へ移る in 表示 leaves without confirming).
 */
export function nextDraftState(state: DraftState, event: DraftEvent, guard = true): DraftState | null {
  switch (state) {
    case 'View':
      return event === 'edit' ? 'Editing' : null;
    case 'Editing':
      if (event === 'change') return 'Editing';
      if (event === 'preview') return guard ? 'Previewing' : null;
      if (event === 'save') return guard ? 'Saving' : null;
      if (event === 'cancel') return 'View';
      if (event === 'leave') return guard ? 'Leaving' : null;
      return null;
    case 'Previewing':
      return event === 'previewEnd' ? 'Editing' : null;
    case 'Saving':
      return event === 'response' ? (guard ? 'View' : 'Editing') : null;
    case 'Leaving':
      return event === 'discard' ? 'View' : event === 'stay' ? 'Editing' : null;
  }
}

// --- 値の型 ---

export const NEED_NUMBER = '数値を入力してください';
export const NEED_COUNT = '0 以上の整数を入力してください';
export const DUP_KEY = 'キーが重複しています';
export const CONFIRM_DISCARD = '変更を破棄しますか';

export type InputKind = 'text' | 'number' | 'checkbox' | 'select';

/** Input control for `steps[i].input[key]`: the mock element's kind (unknown → text). */
export function inputKind(field: MockField | undefined): InputKind {
  return field?.kind ?? 'text';
}

/** Options of a select: the mock's option values, keeping a current value that is not among them. */
export function selectOptions(field: MockField | undefined, current: StepValue | undefined): string[] {
  const opts = [...(field?.options ?? [])];
  const cur = current === undefined ? '' : String(current);
  if (cur !== '' && !opts.includes(cur)) opts.push(cur);
  return opts;
}

export type Converted = { ok: true; value: StepValue | TdValue } | { ok: false; message: string };

/** Value to store for an `input` control: number (empty → ''), checkbox → boolean, others → string. */
export function inputValue(kind: InputKind, raw: string | boolean): Converted {
  if (kind === 'checkbox') return { ok: true, value: raw === true || raw === 'true' };
  const s = String(raw);
  if (kind !== 'number') return { ok: true, value: s };
  if (s.trim() === '') return { ok: true, value: '' };
  const n = Number(s);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: NEED_NUMBER };
}

export function countValue(raw: string): Converted {
  const s = raw.trim();
  const n = Number(s);
  return s !== '' && Number.isInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false, message: NEED_COUNT };
}

export type FieldType = 'string' | 'number' | 'boolean';

/** Type of a fixtures field: the current value's (new fields / null → string). */
export function fieldType(v: TdValue | undefined): FieldType {
  return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
}

export function fieldValue(type: FieldType, raw: string | boolean): Converted {
  if (type === 'boolean') return { ok: true, value: raw === true || raw === 'true' };
  const s = String(raw);
  if (type === 'string') return { ok: true, value: s };
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: NEED_NUMBER };
}

/** Key field of a row: api.yaml `tables[].key` (default `id`), or the row's first field when it lacks it. */
export function rowKeyField(tables: Array<{ name: string; key: string }>, table: string, row: TdRow): string {
  const key = tables.find((t) => t.name === table)?.key ?? 'id';
  if (key in row) return key;
  return Object.keys(row)[0] ?? key;
}

// --- 編集中のデータ ---

export type DraftPath = Array<string | number>;

export interface DraftSnapshot {
  base: TestDataBundle | null;
  draft: TestDataDraft | null;
  dirty: boolean;
  /** Client-side input errors: cell id (`cellId`) → message. */
  errors: Record<string, string>;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export function draftOf(bundle: TestDataBundle, comment?: string): TestDataDraft {
  return {
    scenarioId: bundle.scenario.data.id,
    scenario: clone(bundle.scenario.data),
    fixtures: Object.fromEntries(bundle.fixtures.map((f) => [f.name, clone(f.data)])),
    base: Object.fromEntries([bundle.scenario, ...bundle.fixtures].map((f) => [f.path, f.hash])),
    ...(bundle.headSha ? { headSha: bundle.headSha } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

/** Cell id shared by the editor and server issues: `<file>|<path>` (path as in DataIssue). */
export function cellId(file: string, path: string): string {
  return `${file}|${path}`;
}

export function pathString(segs: DraftPath): string {
  let s = '';
  for (const p of segs) s += typeof p === 'number' ? `[${p}]` : s ? `.${p}` : p;
  return s;
}

/** The cell (`file|path`) a draft path points at. */
export function cellOf(bundle: TestDataBundle, path: DraftPath): string {
  if (path[0] === 'fixtures') {
    const f = bundle.fixtures.find((x) => x.name === path[1]);
    return cellId(f?.path ?? `fixtures/${String(path[1])}.yaml`, pathString(path.slice(2)));
  }
  return cellId(bundle.scenario.path, pathString(path.slice(1)));
}

export function issueCell(i: DataIssue): string {
  return cellId(i.file, i.path);
}

const EMPTIABLE = new Set(['input', 'text', 'count', 'visible']);

function setIn(obj: unknown, path: DraftPath, value: unknown): unknown {
  if (!path.length) return value;
  const [head, ...rest] = path;
  if (Array.isArray(obj)) {
    const a = [...obj];
    const i = head as number;
    if (value === undefined && !rest.length) a.splice(i, 1);
    else a[i] = setIn(a[i], rest, value);
    return a;
  }
  const o: Record<string, unknown> = { ...((obj as Record<string, unknown>) ?? {}) };
  if (value === undefined && !rest.length) {
    delete o[head as string];
    return o;
  }
  const next = setIn(o[head as string] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value);
  // A key map / list emptied by a removal disappears with it
  if (value === undefined && rest.length === 1 && EMPTIABLE.has(head as string) && next && typeof next === 'object' && Object.keys(next).length === 0) delete o[head as string];
  else o[head as string] = next;
  return o;
}

export function getIn(obj: unknown, path: DraftPath): unknown {
  let cur = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Framework-free store of the data being edited; React reads it with useSyncExternalStore. */
export class DraftStore {
  private snap: DraftSnapshot = { base: null, draft: null, dirty: false, errors: {} };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): DraftSnapshot => this.snap;

  get base(): TestDataBundle | null {
    return this.snap.base;
  }

  get draft(): TestDataDraft | null {
    return this.snap.draft;
  }

  get dirty(): boolean {
    return this.snap.dirty;
  }

  begin(bundle: TestDataBundle, comment?: string) {
    this.emit({ base: bundle, draft: draftOf(bundle, comment), dirty: false, errors: {} });
  }

  /**
   * Sets the value at `path` (`['scenario', 'steps', 1, 'input', 'customer']`, `['fixtures', 'default', 'orders', 0, 'id']`);
   * `undefined` removes the key. `error` records a client-side input error for that cell instead.
   */
  set(path: DraftPath, value: unknown, error?: string) {
    const { base, draft } = this.snap;
    if (!base || !draft) return;
    const cell = cellOf(base, path);
    const errors = { ...this.snap.errors };
    delete errors[cell];
    if (error) {
      errors[cell] = error;
      this.emit({ errors });
      return;
    }
    this.update(setIn(draft, path, value) as TestDataDraft, errors);
  }

  setComment(comment: string) {
    if (this.snap.draft) this.emit({ draft: { ...this.snap.draft, comment } });
  }

  /** Adds an empty row with the same fields as the table's last row (key empty). */
  addRow(fixture: string, table: string) {
    const draft = this.snap.draft;
    if (!draft) return;
    const rows = draft.fixtures[fixture]?.[table] ?? [];
    const last = rows.at(-1) ?? {};
    const row: TdRow = Object.fromEntries(Object.entries(last).map(([k, v]) => [k, typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : '']));
    this.update(setIn(draft, ['fixtures', fixture, table, rows.length], row) as TestDataDraft, this.snap.errors);
  }

  removeRow(fixture: string, table: string, i: number) {
    const draft = this.snap.draft;
    if (!draft) return;
    const rows = [...(draft.fixtures[fixture]?.[table] ?? [])];
    rows.splice(i, 1);
    const errors = Object.fromEntries(Object.entries(this.snap.errors).filter(([k]) => !k.includes(`|${table}[`)));
    this.update(setIn(draft, ['fixtures', fixture, table], rows) as TestDataDraft, errors);
  }

  /** Back to the loaded data. */
  discard() {
    if (this.snap.base) this.begin(this.snap.base, this.snap.draft?.comment);
  }

  /** Whether the client found an input error (the draft then lacks the bad value). */
  get hasInputErrors(): boolean {
    return Object.keys(this.snap.errors).length > 0;
  }

  private update(draft: TestDataDraft, errors: Record<string, string>) {
    const base = this.snap.base!;
    const orig = draftOf(base);
    const dirty = !sameJson(draft.scenario, orig.scenario) || !sameJson(draft.fixtures, orig.fixtures);
    this.emit({ draft, dirty, errors });
  }

  private emit(p: Partial<DraftSnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }
}

/** The fixtures data to send with `ddv:reset` while previewing (only the fixtures the draft uses). */
export function previewData(draft: TestDataDraft): Record<string, FixtureTables> {
  const names = draft.scenario.fixtures ?? ['default'];
  return Object.fromEntries(names.filter((n) => draft.fixtures[n]).map((n) => [n, draft.fixtures[n]]));
}

/** Cells (testid-ish keys) of a failed step to emphasise: `text:x` → ex-x, `count:t` → exc-t, `visible:*` → exv. */
export function failedCells(failures: Array<{ key: string }>): string[] {
  const out = new Set<string>();
  for (const f of failures) {
    const [kind, ...rest] = f.key.split(':');
    const k = rest.join(':');
    if (kind === 'text') out.add(`ex-${k}`);
    else if (kind === 'count') out.add(`exc-${k}`);
    else if (kind === 'visible' || kind === 'hidden') out.add('exv');
    else if (kind === 'screen') out.add('screen');
  }
  return [...out];
}

/** `テストデータ：<ID> の <変えた項目>` (the default suggestion comment). */
export function defaultComment(draft: TestDataDraft, base: TestDataBundle): string {
  const orig = draftOf(base);
  const items: string[] = [];
  const steps = draft.scenario.steps ?? [];
  if (draft.scenario.title !== orig.scenario.title) items.push('title');
  if (!sameJson(draft.scenario.fixtures, orig.scenario.fixtures)) items.push('fixtures');
  steps.forEach((s, i) => {
    if (!sameJson(s, orig.scenario.steps[i])) items.push(`steps[${i}]`);
  });
  for (const [name, tables] of Object.entries(draft.fixtures)) if (!sameJson(tables, orig.fixtures[name])) items.push(`fixtures/${name}`);
  return `テストデータ：${draft.scenarioId} の ${items.join('・') || '変更'}`;
}
