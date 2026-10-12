import { parseDocument } from 'yaml';
import type { DdvConfig } from '@ddv/core';
import { analyzeMockHtml, mocksRootOf, parseScenarioFile, ScenarioSchema, type FieldModel, type PathTransition, type Scenario } from '@ddv/mock/browser';
import { lineHunks, sameValue, YamlPatcher, YamlPatchError, type LineHunk, type PatchChange, type PathSeg } from '@ddv/mock/yaml-patch';
import type { ServiceEnv } from './env.ts';
import { TestDataError } from './errors.ts';
import { findScenarioFilesIn, type MockService } from './mocks.ts';
import { normalizeRepoPath } from './repo-path.ts';
import type { RepoReader, RepoWriter } from './repo-reader.ts';
import type { CommentInput, PendingComment, PendingReview, ReviewTarget } from './review.ts';

export { TestDataError };

/** DD-TDEDIT TestDataService: load / validate / save the scenario and fixtures YAML of one scenario. */

export type WorkspaceKind = 'local' | 'pr' | 'branch';
export type SaveMode = 'file' | 'suggestion';
export type IssueCode = 'schema' | 'generated' | 'duplicateKey' | 'emptyKey' | 'unknownFixture' | 'conflict' | 'unknownElement' | 'unknownTable' | 'sharedFixture';

type Value = string | number | boolean | null;
export type Row = Record<string, Value>;
export type FixtureTables = Record<string, Row[]>;

export interface FileData<T> {
  name: string;
  path: string;
  hash: string;
  data: T;
}

export interface TableDef {
  name: string;
  key: string;
}

export interface MockInfo {
  fields: FieldModel[];
  testids: string[];
  tables: TableDef[];
}

export interface TestDataBundle {
  scenario: FileData<Scenario>;
  fixtures: FileData<FixtureTables>[];
  availableFixtures: string[];
  mock: MockInfo;
  editable: boolean;
  readonlyReason?: string;
  workspace: WorkspaceKind;
  headSha?: string;
  /** Route of the scenario (`ScenarioDetail.transitions`) for the heading. */
  transitions: PathTransition[];
  retired: boolean;
}

export interface TestDataDraft {
  scenarioId: string;
  scenario: Scenario;
  fixtures: Record<string, FixtureTables>;
  /** Repository-relative path → hash of the file the draft started from. */
  base: Record<string, string>;
  headSha?: string;
  comment?: string;
}

export interface DataIssue {
  file: string;
  path: string;
  code: IssueCode;
  message: string;
}

export interface FileDiff {
  path: string;
  hunks: LineHunk[];
}

export interface ValidationResult {
  errors: DataIssue[];
  warnings: DataIssue[];
  diff: FileDiff[];
}

export interface SaveResult {
  mode: SaveMode;
  files: string[];
  comments: string[];
  warnings?: string[];
}

export interface TestDataWorkspace<T extends { headSha: string } = ReviewTarget> {
  kind: WorkspaceKind;
  /** PR workspace (ReviewService target). */
  target?: T;
}

/** The part of ReviewService the suggestion mode uses. */
export interface Reviewer<T extends { headSha: string } = ReviewTarget> {
  get(target: T): Promise<Pick<PendingReview, 'comments'>>;
  add(target: T, input: CommentInput): Promise<PendingComment>;
  update(target: T, id: string, patch: CommentInput): Promise<PendingComment>;
}

export const READONLY_BRANCH = 'PR でない GitHub のワークスペースでは保存できません（編集中の再生はできます）';
export const READONLY_RETIRED = '引退したシナリオです';

export const READONLY_NO_WRITER = 'この表示ではファイルに保存できません';

const SCENARIO_ORDER = ['id', 'title', 'fixtures', 'start', 'steps'];
const STEP_ORDER = ['event', 'input', 'click', 'do', 'wait', 'expect'];
const EXPECT_ORDER = ['screen', 'visible', 'hidden', 'text', 'count'];
const GENERATED = ['event', 'click', 'do', 'wait'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEmpty = (v: unknown) => (Array.isArray(v) ? !v.length : isObj(v) ? !Object.keys(v).some((k) => v[k] !== undefined) : false);

/** `steps.1.input.customer` → `steps[1].input.customer`. */
export function issuePath(segs: readonly PathSeg[] | readonly PropertyKey[]): string {
  let out = '';
  for (const s of segs) out += typeof s === 'number' ? `[${s}]` : out ? `.${String(s)}` : String(s);
  return out;
}

/** api.yaml `tables`: `name` or `{ name, key }` (key defaults to `id`). */
export function tableDefs(apiYaml: string | null): TableDef[] | null {
  if (apiYaml === null) return null;
  const v = parseDocument(apiYaml).toJS() as unknown;
  const list = isObj(v) && Array.isArray(v.tables) ? v.tables : [];
  return list.flatMap((t): TableDef[] => {
    if (typeof t === 'string') return [{ name: t, key: 'id' }];
    if (isObj(t) && typeof t.name === 'string') return [{ name: t.name, key: typeof t.key === 'string' && t.key ? t.key : 'id' }];
    return [];
  });
}

/** Key field of a row: the table's key (default `id`), or the first field when the row has none. */
export function rowKeyField(row: Row, key = 'id'): string | undefined {
  return key in row ? key : Object.keys(row)[0];
}

/** The scenario as written: the draft without defaults the file did not have (title '', fixtures [], empty input / expect lists). */
export function scenarioAfter(raw: unknown, s: Scenario): Obj {
  const r = isObj(raw) ? raw : {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(s as unknown as Obj)) {
    if (v === undefined) continue;
    if (k === 'title' && v === '' && !('title' in r)) continue;
    if (k === 'fixtures' && isEmpty(v) && !('fixtures' in r)) continue;
    if (k === 'steps' && Array.isArray(v)) {
      const rawSteps = Array.isArray(r.steps) ? r.steps : [];
      out.steps = v.map((step, i) => stepAfter(rawSteps[i], step));
      continue;
    }
    out[k] = v;
  }
  return out;
}

function stepAfter(raw: unknown, step: unknown): unknown {
  if (!isObj(step)) return step;
  const r = isObj(raw) ? raw : {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(step)) {
    if (v === undefined) continue;
    if (k === 'input' && isEmpty(v) && !('input' in r)) continue;
    if (k === 'expect' && isObj(v)) {
      const re = isObj(r.expect) ? r.expect : {};
      const ex: Obj = {};
      for (const [ek, ev] of Object.entries(v)) {
        if (ev === undefined) continue;
        if (ek !== 'screen' && isEmpty(ev) && !(ek in re)) continue;
        ex[ek] = ev;
      }
      out.expect = ex;
      continue;
    }
    out[k] = v;
  }
  return out;
}

const scenarioPatcher = new YamlPatcher({
  keyOrder: (p) => (p.length === 0 ? SCENARIO_ORDER : p.length === 2 && p[0] === 'steps' ? STEP_ORDER : p.length === 3 && p[0] === 'steps' && p[2] === 'expect' ? EXPECT_ORDER : undefined),
});

const fixturePatcher = (tables: TableDef[]) =>
  new YamlPatcher({ arrayKey: (p) => (p.length === 1 ? (tables.find((t) => t.name === p[0])?.key ?? 'id') : undefined) });

/** DD-TDEDIT SUGGEST: a hunk → the commented line range and the suggestion text (addition / deletion only: the neighbouring line is included). */
export function suggestionOf(hunk: LineHunk, lines: string[]): { startLine: number; line: number; suggestion: string } {
  if (hunk.before.length && hunk.after.length) return { startLine: hunk.startLine, line: hunk.endLine, suggestion: hunk.after.join('\n') };
  const lastLine = hunk.before.length ? hunk.endLine : hunk.startLine - 1;
  if (hunk.startLine > 1) {
    const prev = lines[hunk.startLine - 2];
    return { startLine: hunk.startLine - 1, line: lastLine, suggestion: [prev, ...hunk.after].join('\n') };
  }
  // at the top of the file: include the next line instead
  const next = lines[lastLine];
  return { startLine: 1, line: lastLine + 1, suggestion: [...hunk.after, next].join('\n') };
}

interface Loaded {
  id: string;
  mock: string;
  file: string;
  retired: boolean;
  text: string;
  raw: unknown;
  scenario: Scenario;
  transitions: PathTransition[];
}

interface Changed {
  file: string;
  key: string;
  label: string;
  before: string;
  after: string;
  changes: PatchChange[];
}

export interface TestDataServiceOptions {
  reader: RepoReader;
  /** Absent = files cannot be saved (Pages). */
  writer?: RepoWriter;
  getConfig: () => DdvConfig;
  env: Pick<ServiceEnv, 'hash'>;
  mocks: Pick<MockService, 'scenario'>;
}

export class TestDataService<T extends { headSha: string } = ReviewTarget> {
  constructor(
    private readonly opts: TestDataServiceOptions,
    private readonly review?: Reviewer<T>,
  ) {}

  private get config(): DdvConfig {
    return this.opts.getConfig();
  }

  private hash(text: string): Promise<string> {
    return this.opts.env.hash(text);
  }

  private read(file: string): Promise<string | null> {
    return this.opts.reader.tryReadText(file).catch(() => null);
  }

  private async fixtureFile(mock: string, name: string): Promise<string | null> {
    const dir = `${mocksRootOf(this.config)}/${mock}/fixtures`;
    for (const ext of ['yaml', 'yml']) {
      const f = `${dir}/${name}.${ext}`;
      if (!/[\\/]/.test(name) && (await this.opts.reader.exists(f).catch(() => false))) return f;
    }
    return null;
  }

  private async availableFixtures(mock: string): Promise<string[]> {
    const dir = `${mocksRootOf(this.config)}/${mock}/fixtures`;
    const base = normalizeRepoPath(dir);
    const files = await this.opts.reader.listFiles(dir).catch(() => [] as string[]);
    const names = files.map((f) => f.slice(base.length + 1)).filter((n) => !n.includes('/'));
    return names.filter((n) => /\.ya?ml$/.test(n) && !n.startsWith('_')).map((n) => n.replace(/\.ya?ml$/, '')).sort();
  }

  private async tables(mock: string): Promise<TableDef[] | null> {
    return tableDefs(await this.read(`${mocksRootOf(this.config)}/${mock}/api.yaml`));
  }

  private async scenario(id: string): Promise<Loaded> {
    const d = await this.opts.mocks.scenario(id);
    if (!d) throw new TestDataError(404, 'not-found', `シナリオが見つかりません: ${id}`);
    const text = (await this.read(d.file)) ?? '';
    const parsed = parseScenarioFile(text, d.file);
    if (!parsed.scenario) throw new TestDataError(422, 'invalid-scenario', 'シナリオの形式が読めないため編集できません', { issues: parsed.issues });
    return { id, mock: d.mock, file: d.file, retired: d.retired, text, raw: parseDocument(text).toJS(), scenario: parsed.scenario, transitions: d.transitions };
  }

  private editable(ws: TestDataWorkspace<T>, s: Loaded): string | undefined {
    if (ws.kind === 'branch') return READONLY_BRANCH;
    if (s.retired) return READONLY_RETIRED;
    return undefined;
  }

  async load(scenarioId: string, ws: TestDataWorkspace<T>): Promise<TestDataBundle> {
    const s = await this.scenario(scenarioId);
    const fixtures: FileData<FixtureTables>[] = [];
    for (const name of s.scenario.fixtures) {
      const f = await this.fixtureFile(s.mock, name);
      const text = f ? await this.read(f) : null;
      if (f === null || text === null) continue;
      const data = parseDocument(text).toJS() as unknown;
      fixtures.push({ name, path: f, hash: await this.hash(text), data: (isObj(data) ? data : {}) as FixtureTables });
    }
    const html = (await this.read(`${mocksRootOf(this.config)}/${s.mock}/index.html`)) ?? '';
    const fields = new Map<string, FieldModel>();
    for (const screen of analyzeMockHtml(html).screens.values()) for (const f of screen.fields) if (!fields.has(f.key)) fields.set(f.key, f);
    const testids = [...new Set([...html.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]))].sort();
    const reason = this.editable(ws, s);
    return {
      scenario: { name: s.id, path: s.file, hash: await this.hash(s.text), data: s.scenario },
      fixtures,
      availableFixtures: await this.availableFixtures(s.mock),
      mock: { fields: [...fields.values()], testids, tables: (await this.tables(s.mock)) ?? [] },
      editable: !reason,
      ...(reason ? { readonlyReason: reason } : {}),
      workspace: ws.kind,
      ...(ws.target ? { headSha: ws.target.headSha } : {}),
      transitions: s.transitions,
      retired: s.retired,
    };
  }

  async validate(draft: TestDataDraft, ws: TestDataWorkspace<T>): Promise<ValidationResult> {
    const r = await this.check(draft, ws);
    if (r.patchError) r.errors.push({ file: r.patchError, path: '', code: 'schema', message: new YamlPatchError().message });
    return { errors: r.errors, warnings: r.warnings, diff: r.diff };
  }

  /** VALIDATE: stops at the first stage with errors (all errors of that stage are collected). */
  private async check(draft: TestDataDraft, ws: TestDataWorkspace<T>): Promise<ValidationResult & { changed: Changed[]; patchError?: string; s?: Loaded }> {
    const empty = { errors: [] as DataIssue[], warnings: [] as DataIssue[], diff: [] as FileDiff[], changed: [] as Changed[] };
    if (!isObj(draft) || typeof draft.scenarioId !== 'string') throw new TestDataError(422, 'bad-request', 'TestDataDraft を指定してください');
    const s = await this.scenario(draft.scenarioId);
    const sFile = s.file;
    const fixtures = isObj(draft.fixtures) ? draft.fixtures : {};
    const out = { ...empty, s };

    // schema
    const after = scenarioAfter(s.raw, (isObj(draft.scenario) ? draft.scenario : {}) as unknown as Scenario);
    const parsed = ScenarioSchema.safeParse(after);
    if (!parsed.success) for (const i of parsed.error.issues) out.errors.push({ file: sFile, path: issuePath(i.path as PropertyKey[]), code: 'schema', message: i.message });
    for (const [name, tables] of Object.entries(fixtures)) {
      const file = (await this.fixtureFile(s.mock, name)) ?? `${mocksRootOf(this.config)}/${s.mock}/fixtures/${name}.yaml`;
      if (!isObj(tables)) {
        out.errors.push({ file, path: '', code: 'schema', message: 'fixtures はテーブルごとの行の配列で書いてください' });
        continue;
      }
      for (const [t, rows] of Object.entries(tables)) {
        if (!Array.isArray(rows)) {
          out.errors.push({ file, path: t, code: 'schema', message: '行の配列で書いてください' });
          continue;
        }
        rows.forEach((row, i) => {
          if (!isObj(row)) out.errors.push({ file, path: `${t}[${i}]`, code: 'schema', message: '行は項目と値の組で書いてください' });
          else for (const [k, v] of Object.entries(row)) if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) out.errors.push({ file, path: `${t}[${i}].${k}`, code: 'schema', message: '値は文字列・数値・真偽のどれかです' });
        });
      }
    }
    if (out.errors.length) return out;
    const next = parsed.data as Scenario;

    // generated
    const gen = (p: string, label: string) => out.errors.push({ file: sFile, path: p, code: 'generated', message: `${label}は生成項目のため変更できません` });
    if (next.id !== s.scenario.id) gen('id', 'id ');
    if (next.start !== s.scenario.start) gen('start', 'start ');
    if (next.steps.length !== s.scenario.steps.length) out.errors.push({ file: sFile, path: 'steps', code: 'generated', message: 'ステップの数は変更できません' });
    else
      next.steps.forEach((step, i) => {
        const was = s.scenario.steps[i];
        for (const k of GENERATED) if (!sameValue(step[k], was[k])) gen(`steps[${i}].${k}`, `${k} `);
        if (step.expect.screen !== was.expect.screen) gen(`steps[${i}].expect.screen`, 'expect.screen ');
        if (!sameValue(step.expect.hidden ?? [], was.expect.hidden ?? [])) gen(`steps[${i}].expect.hidden`, 'expect.hidden ');
      });
    if (out.errors.length) return out;

    // unknownFixture
    for (const [i, name] of next.fixtures.entries()) {
      if (!(await this.fixtureFile(s.mock, name))) out.errors.push({ file: sFile, path: `fixtures[${i}]`, code: 'unknownFixture', message: `fixtures が見つかりません：${name}` });
    }
    for (const name of Object.keys(fixtures))
      if (!(await this.fixtureFile(s.mock, name))) out.errors.push({ file: sFile, path: 'fixtures', code: 'unknownFixture', message: `fixtures が見つかりません：${name}` });
    if (out.errors.length) return out;

    // emptyKey / duplicateKey
    const defs = (await this.tables(s.mock)) ?? [];
    for (const [name, tables] of Object.entries(fixtures)) {
      const file = (await this.fixtureFile(s.mock, name))!;
      for (const [t, rows] of Object.entries(tables)) {
        const key = defs.find((d) => d.name === t)?.key ?? 'id';
        const seen = new Map<string, number>();
        rows.forEach((row, i) => {
          const field = rowKeyField(row, key);
          const v = field === undefined ? undefined : row[field];
          const p = `${t}[${i}].${field ?? key}`;
          if (v === undefined || v === null || String(v).trim() === '') {
            out.errors.push({ file, path: p, code: 'emptyKey', message: 'キーを入力してください' });
            return;
          }
          const k = JSON.stringify(v);
          if (seen.has(k)) out.errors.push({ file, path: p, code: 'duplicateKey', message: `キー ${String(v)} が重複しています` });
          else seen.set(k, i);
        });
      }
    }
    if (out.errors.length) return out;

    // conflict
    const base = isObj(draft.base) ? draft.base : {};
    const texts = new Map<string, string>([[sFile, s.text]]);
    for (const name of Object.keys(fixtures)) {
      const f = (await this.fixtureFile(s.mock, name))!;
      texts.set(f, (await this.read(f)) ?? '');
    }
    for (const [file, text] of texts) {
      if (typeof base[file] === 'string' && base[file] !== (await this.hash(text)))
        out.errors.push({ file, path: '', code: 'conflict', message: `${file} が他で変更されました。開き直してください` });
    }
    if (ws.kind === 'pr' && ws.target && draft.headSha !== undefined && draft.headSha !== ws.target.headSha)
      out.errors.push({ file: sFile, path: '', code: 'conflict', message: 'PR の head が進みました。開き直してください' });
    if (out.errors.length) return out;

    // warnings + diff
    const known = new Set<string>();
    const html = (await this.read(`${mocksRootOf(this.config)}/${s.mock}/index.html`)) ?? '';
    for (const m of html.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)) known.add(m[1]);
    for (const screen of analyzeMockHtml(html).screens.values()) for (const f of screen.fields) known.add(f.key);
    const unknown = (p: string, key: string) => {
      if (!known.has(key)) out.warnings.push({ file: sFile, path: p, code: 'unknownElement', message: `モックに data-testid="${key}" がありません` });
    };
    next.steps.forEach((step, i) => {
      for (const k of Object.keys(step.input ?? {})) unknown(`steps[${i}].input.${k}`, k);
      for (const k of Object.keys(step.expect.text ?? {})) unknown(`steps[${i}].expect.text.${k}`, k);
      for (const k of Object.keys(step.expect.count ?? {})) unknown(`steps[${i}].expect.count.${k}`, k);
      (step.expect.visible ?? []).forEach((k, j) => unknown(`steps[${i}].expect.visible[${j}]`, k));
    });

    const sAfter = scenarioAfter(s.raw, next);
    if (!sameValue(s.raw, sAfter)) this.patch(out, scenarioPatcher, sFile, s.text, s.raw, sAfter, s.id, `${s.id}（シナリオ）`);
    const changedFixtures: string[] = [];
    for (const [name, tables] of Object.entries(fixtures)) {
      const file = (await this.fixtureFile(s.mock, name))!;
      const text = texts.get(file)!;
      const raw = parseDocument(text).toJS() as unknown;
      if (sameValue(raw, tables)) continue;
      changedFixtures.push(name);
      if (defs.length || (await this.opts.reader.exists(`${mocksRootOf(this.config)}/${s.mock}/api.yaml`).catch(() => false)))
        for (const t of Object.keys(tables)) if (!defs.some((d) => d.name === t)) out.warnings.push({ file, path: t, code: 'unknownTable', message: `テーブル ${t} は api.yaml の tables にありません` });
      this.patch(out, fixturePatcher(defs), file, text, raw, tables, `fixtures/${name}`, `fixtures/${name}`);
    }
    if (changedFixtures.length) {
      const others = (await findScenarioFilesIn(this.opts.reader, this.config)).filter((e) => e.mock === s.mock && e.file !== sFile);
      const uses = new Map<string, number>();
      for (const e of others) {
        const text = await this.read(e.file);
        const sc = text === null ? undefined : parseScenarioFile(text, e.file).scenario;
        for (const n of sc?.fixtures ?? []) uses.set(n, (uses.get(n) ?? 0) + 1);
      }
      for (const name of changedFixtures) {
        const n = uses.get(name) ?? 0;
        if (n) out.warnings.push({ file: (await this.fixtureFile(s.mock, name))!, path: '', code: 'sharedFixture', message: `${name} は他の ${n} 本のシナリオでも使われています` });
      }
    }
    return out;
  }

  private patch(out: { diff: FileDiff[]; changed: Changed[]; patchError?: string }, patcher: YamlPatcher, file: string, text: string, raw: unknown, after: unknown, key: string, label: string) {
    try {
      const r = patcher.apply(text, raw, after);
      out.changed.push({ file, key, label, before: text, after: r.text, changes: r.changes });
      out.diff.push({ path: file, hunks: lineHunks(text, r.text) });
    } catch (e) {
      if (!(e instanceof YamlPatchError)) throw e;
      out.patchError ??= file;
    }
  }

  async save(draft: TestDataDraft, ws: TestDataWorkspace<T>): Promise<SaveResult> {
    const r = await this.check(draft, ws);
    const reason = r.s ? this.editable(ws, r.s) : undefined;
    if (reason) throw new TestDataError(403, 'readonly', reason);
    if (r.errors.length) {
      const conflict = r.errors.some((e) => e.code === 'conflict');
      throw new TestDataError(conflict ? 409 : 422, conflict ? 'conflict' : 'invalid', r.errors[0].message, { errors: r.errors, warnings: r.warnings });
    }
    if (r.patchError) throw new TestDataError(500, 'patch-failed', new YamlPatchError().message);
    if (!r.changed.length) throw new TestDataError(422, 'no-change', '変更がありません', { errors: [] });
    if (ws.kind === 'local') {
      if (!this.opts.writer) throw new TestDataError(403, 'readonly', READONLY_NO_WRITER);
      for (const c of r.changed) await this.opts.writer.writeText(c.file, c.after);
      return { mode: 'file', files: r.changed.map((c) => c.file), comments: [] };
    }
    return this.suggest(draft, ws, r.changed);
  }

  private async suggest(draft: TestDataDraft, ws: TestDataWorkspace<T>, changed: Changed[]): Promise<SaveResult> {
    if (!this.review || !ws.target) throw new TestDataError(403, 'readonly', READONLY_BRANCH);
    const pending = (await this.review.get(ws.target)).comments;
    const comments: string[] = [];
    const warnings: string[] = [];
    const failed: Array<{ file: string; path: string; message: string }> = [];
    for (const c of changed) {
      const lines = c.before.replace(/^\uFEFF/, '').split(/\r?\n/);
      const items = [...new Set(c.changes.map((x) => issuePath(x.path)))];
      const body = draft.comment?.trim() || `テストデータ：${draft.scenarioId} の ${items.slice(0, 3).join('、')}${items.length > 3 ? ` ほか ${items.length - 3} 件` : ''}`;
      let inBody = false;
      for (const h of lineHunks(c.before, c.after)) {
        const sg = suggestionOf(h, lines);
        const element = { kind: 'testData' as const, key: c.key, label: c.label };
        try {
          const same = pending.find((p: PendingComment) => p.state === 'Pending' && p.anchor.element.kind === 'testData' && p.anchor.path === c.file && p.anchor.startLine === sg.startLine && p.anchor.line === sg.line);
          const res = same
            ? await this.review.update(ws.target, same.id, { body, suggestion: sg.suggestion })
            : await this.review.add(ws.target, { anchor: { path: c.file, side: 'RIGHT', startLine: sg.startLine, line: sg.line, element }, body, suggestion: sg.suggestion });
          comments.push(res.id);
          if (res.placement === 'body') inBody = true;
        } catch (e) {
          failed.push({ file: c.file, path: `L${sg.startLine}-L${sg.line}`, message: e instanceof Error ? e.message : String(e) });
        }
      }
      if (inBody) warnings.push(`${c.file} は PR の差分に無いため、suggestion はレビューの本文に入ります`);
    }
    if (failed.length) throw new TestDataError(502, 'suggestion-failed', 'suggestion の追加に一部失敗しました', { errors: failed, comments, warnings });
    return { mode: 'suggestion', files: changed.map((c) => c.file), comments, ...(warnings.length ? { warnings } : {}) };
  }
}
