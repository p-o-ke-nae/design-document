import { describe, expect, it } from 'vitest';
import {
  analyzeMockHtml,
  inferValue,
  inferInput,
  matchPath,
  mergeScenario,
  parseScenarioFile,
  scaffoldScenario,
  ScreenMapSchema,
  type FieldModel,
  type PathSpec,
  type Scenario,
} from './index.ts';
import { executeStep, runStep, StepError, type Driver } from './step.ts';
import { resolveLocator } from './resolve.ts';

const path: PathSpec = {
  id: 'BD-ORDER-SCREEN-P001',
  title: '開始 → 一覧 → [新規] 入力 → [次へ [入力OK]] 確認',
  start: 'List',
  edges: [0, 1, 2],
  transitions: [
    { from: 'List', to: 'Input', event: '新規', guard: '', edge: 1 },
    { from: 'Input', to: 'Confirm', event: '次へ', guard: '入力OK', edge: 2 },
  ],
};

const scenario = (patch: Partial<Scenario> = {}): Scenario => ({
  id: path.id,
  title: path.title,
  fixtures: [],
  start: 'List',
  steps: [
    { event: '新規', click: 'new', expect: { screen: 'Input' } },
    { event: '次へ  [ 入力OK ]', click: 'next', expect: { screen: 'Confirm' } },
  ],
  ...patch,
});

describe('matchPath', () => {
  it('[DD-SCENARIO-MATCH-P001][DD-SCENARIO-MATCH-T001][DD-SCENARIO-MATCH-T002] start が経路の最初の状態と違えば不一致: start', () => {
    const r = matchPath(scenario({ start: 'Input' }), path);
    expect(r).toMatchObject({ ok: false, kind: 'start', expected: 'List', actual: 'Input' });
  });
  it('[DD-SCENARIO-MATCH-P002][DD-SCENARIO-MATCH-T003][DD-SCENARIO-MATCH-T004] ステップ数が違えば不一致: ステップ数', () => {
    const s = scenario();
    s.steps.pop();
    expect(matchPath(s, path)).toMatchObject({ ok: false, kind: 'count', expected: '2', actual: '1' });
  });
  it('[DD-SCENARIO-MATCH-P003][DD-SCENARIO-MATCH-T005][DD-SCENARIO-MATCH-T006] event がイベントとガードに一致しなければ不一致: event とステップ番号', () => {
    const s = scenario();
    s.steps[1].event = '次へ [入力NG]';
    expect(matchPath(s, path)).toMatchObject({ ok: false, kind: 'event', step: 1, expected: '次へ [入力OK]' });
  });
  it('[DD-SCENARIO-MATCH-P004][DD-SCENARIO-MATCH-T007][DD-SCENARIO-MATCH-T008] expect.screen が遷移先と違えば不一致: 画面とステップ番号', () => {
    const s = scenario();
    s.steps[0].expect.screen = 'List';
    expect(matchPath(s, path)).toMatchObject({ ok: false, kind: 'screen', step: 0, expected: 'Input', actual: 'List' });
  });
  it('[DD-SCENARIO-MATCH-P005][DD-SCENARIO-MATCH-T009] すべて一致すれば一致（空白は正規化）', () => {
    expect(matchPath(scenario(), path)).toEqual({ ok: true });
  });
});

const field = (patch: Partial<FieldModel>): FieldModel => ({ key: 'f', kind: 'text', required: false, options: [], ...patch });

describe('inferValue', () => {
  it('[DD-SCENARIO-INFER-P001][DD-SCENARIO-INFER-T001][DD-SCENARIO-INFER-T002] ng で最初の required 項目は空文字', () => {
    expect(inferValue(field({ required: true, sample: '山田' }), 'ng', true)).toEqual({ value: '', todo: false });
  });
  it('[DD-SCENARIO-INFER-P002][DD-SCENARIO-INFER-T003][DD-SCENARIO-INFER-T004] data-sample があればその値', () => {
    expect(inferValue(field({ sample: '山田 太郎' }), 'ok')).toEqual({ value: '山田 太郎', todo: false });
    expect(inferValue(field({ kind: 'number', sample: '3' }), 'ok')).toEqual({ value: 3, todo: false });
    expect(inferValue(field({ required: true, sample: 'x' }), 'ng', false)).toEqual({ value: 'x', todo: false });
  });
  it('[DD-SCENARIO-INFER-P003][DD-SCENARIO-INFER-T005][DD-SCENARIO-INFER-T006] number は min があれば min、なければ 1', () => {
    expect(inferValue(field({ kind: 'number', min: 5 }), 'ok').value).toBe(5);
    expect(inferValue(field({ kind: 'number' }), 'ok').value).toBe(1);
  });
  it('[DD-SCENARIO-INFER-P004][DD-SCENARIO-INFER-T007] select は空でない最初の選択肢（なければ要確認）', () => {
    expect(inferValue(field({ kind: 'select', options: ['A-100', 'B-200'] }), 'ok')).toEqual({ value: 'A-100', todo: false });
    expect(inferValue(field({ kind: 'select', options: [] }), 'ok')).toEqual({ value: '', todo: true });
  });
  it('[DD-SCENARIO-INFER-P005][DD-SCENARIO-INFER-T008] checkbox は required なら true、それ以外 false', () => {
    expect(inferValue(field({ kind: 'checkbox', required: true }), 'ok').value).toBe(true);
    expect(inferValue(field({ kind: 'checkbox' }), 'ok').value).toBe(false);
  });
  it('[DD-SCENARIO-INFER-P006][DD-SCENARIO-INFER-T009][DD-SCENARIO-INFER-T010] text で pattern があれば要確認の空文字', () => {
    expect(inferValue(field({ pattern: '\\d+' }), 'ok')).toEqual({ value: '', todo: true });
  });
  it('[DD-SCENARIO-INFER-P007][DD-SCENARIO-INFER-T011] text は「テスト」を maxLength で切り詰め', () => {
    expect(inferValue(field({}), 'ok').value).toBe('テスト');
    expect(inferValue(field({ maxLength: 2 }), 'ok').value).toBe('テス');
  });
  it('ng で required 項目がなければ input を空にして要確認', () => {
    expect(inferInput([field({ key: 'a' })], 'ng')).toEqual({ input: {}, todos: [], todoAll: true });
    const r = inferInput([field({ key: 'a', sample: 'x' }), field({ key: 'b', required: true }), field({ key: 'c', required: true })], 'ng');
    expect(r).toEqual({ input: { a: 'x', b: '', c: 'テスト' }, todos: [], todoAll: false });
  });
});

describe('mergeScenario', () => {
  const generated = (): Scenario => ({
    id: path.id,
    title: '新しい題名',
    fixtures: ['default'],
    start: 'List',
    steps: [
      { event: '新規', click: 'new', expect: { screen: 'Input' } },
      { event: '次へ [入力OK]', input: { customer: 'テスト' }, click: 'next2', expect: { screen: 'Confirm' } },
    ],
  });

  it('[DD-SCENARIO-MERGE-P001][DD-SCENARIO-MERGE-T001][DD-SCENARIO-MERGE-T002] 既存に対応がなければ生成値をそのまま採用', () => {
    const r = mergeScenario(undefined, generated());
    expect(r.scenario).toEqual(generated());
    expect(r.unchanged).toBe(false);
    const ex = generated();
    ex.steps = [{ event: '別', expect: { screen: 'X' } }];
    const r2 = mergeScenario(ex, generated());
    expect(r2.scenario.steps).toEqual(generated().steps);
    expect(r2.removed).toBe(1);
  });
  it('[DD-SCENARIO-MERGE-P002][DD-SCENARIO-MERGE-T003][DD-SCENARIO-MERGE-T004][DD-SCENARIO-MERGE-T006][DD-SCENARIO-MERGE-T008] input は既存を採用し、追加の期待値を保持', () => {
    const ex = generated();
    ex.fixtures = ['many'];
    ex.title = '古い';
    ex.steps[1] = { event: '次へ [入力OK]', input: { customer: '山田' }, click: 'old', wait: 100, do: 'x', expect: { screen: 'Confirm', text: { c: '山田' } } };
    const r = mergeScenario(ex, generated());
    expect(r.scenario.title).toBe('新しい題名');
    expect(r.scenario.fixtures).toEqual(['many']);
    expect(r.scenario.steps[1]).toEqual({ event: '次へ [入力OK]', input: { customer: '山田' }, click: 'next2', wait: 100, do: 'x', expect: { screen: 'Confirm', text: { c: '山田' } } });
    expect(r.sources[1]).toEqual({ step: 1, input: 'existing' });
  });
  it('[DD-SCENARIO-MERGE-P003][DD-SCENARIO-MERGE-T009] input は既存、expect は生成値', () => {
    const ex = generated();
    ex.steps[1] = { event: '次へ [入力OK]', input: { customer: '山田' }, click: 'next2', expect: { screen: 'Confirm' } };
    const r = mergeScenario(ex, generated());
    expect(r.scenario.steps[1]).toEqual({ event: '次へ [入力OK]', input: { customer: '山田' }, click: 'next2', expect: { screen: 'Confirm' } });
  });
  it('[DD-SCENARIO-MERGE-P004][DD-SCENARIO-MERGE-T005][DD-SCENARIO-MERGE-T007] input は生成値、追加の期待値を保持', () => {
    const ex = generated();
    ex.steps[1] = { event: '次へ [入力OK]', click: 'next2', expect: { screen: 'Confirm', visible: ['ok'] } };
    const r = mergeScenario(ex, generated());
    expect(r.scenario.steps[1]).toEqual({ event: '次へ [入力OK]', input: { customer: 'テスト' }, click: 'next2', expect: { screen: 'Confirm', visible: ['ok'] } });
    expect(r.sources[1]).toEqual({ step: 1, input: 'generated' });
  });
  it('[DD-SCENARIO-MERGE-P005] input も expect も生成値。結果が同じなら unchanged', () => {
    const ex = generated();
    ex.steps[1] = { event: '次へ [入力OK]', click: 'next2', expect: { screen: 'Confirm' } };
    const r = mergeScenario(ex, generated());
    expect(r.scenario.steps[1]).toEqual(generated().steps[1]);
    expect(r.unchanged).toBe(false);
    expect(mergeScenario(r.scenario, generated()).unchanged).toBe(true);
  });
  it('同じ event と遷移先の組が複数あれば出現順で対応する', () => {
    const g = generated();
    g.steps = [
      { event: 'a', expect: { screen: 'S' } },
      { event: 'a', expect: { screen: 'S' } },
    ];
    const ex = structuredClone(g);
    ex.steps[0].input = { k: 1 };
    ex.steps[1].input = { k: 2 };
    const r = mergeScenario(ex, g);
    expect(r.scenario.steps.map((s) => s.input)).toEqual([{ k: 1 }, { k: 2 }]);
  });
});

class FakeDriver implements Driver {
  log: string[] = [];
  current = 'List';
  fields: Record<string, 'text' | 'select' | 'checkbox' | 'number'> = { customer: 'text', sku: 'select', agree: 'checkbox' };
  clickable = new Set(['next']);
  visible = new Set<string>();
  texts: Record<string, string> = {};
  nextScreen = 'Confirm';
  fieldKind(key: string) {
    return this.fields[key] ?? null;
  }
  async fill(key: string, value: string | boolean) {
    this.log.push(`fill ${key}=${JSON.stringify(value)}`);
  }
  click(key: string, event: string) {
    if (!this.clickable.has(key)) throw new StepError('notFound', `要素が見つかりません: ${key}`, { key });
    this.log.push(`click ${key} ${event}`);
    setTimeout(() => (this.current = this.nextScreen), 30);
  }
  invoke(name: string) {
    this.log.push(`do ${name}`);
  }
  screen() {
    return this.current;
  }
  isVisible(key: string) {
    return this.visible.has(key);
  }
  text(key: string) {
    return this.texts[key] ?? null;
  }
  count() {
    return 0;
  }
}

describe('executeStep', () => {
  it('[DD-SCENARIO-STEP-P035][DD-SCENARIO-STEP-T017][DD-SCENARIO-STEP-T018] input の要素がなければ notFound で失敗し、何も入力しない', async () => {
    const d = new FakeDriver();
    const err = await executeStep(d, { event: 'x', input: { customer: 'a', missing: 'b' }, expect: { screen: 'List' } }).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err).toMatchObject({ kind: 'notFound', key: 'missing' });
    expect(d.log).toEqual([]);
  });
  it('[DD-SCENARIO-STEP-P036][DD-SCENARIO-STEP-T019][DD-SCENARIO-STEP-T020][DD-SCENARIO-STEP-T021] fill の後、未登録の do は unknownOp で失敗', async () => {
    const d = new FakeDriver();
    const step = { event: 'x', input: { customer: '山田', sku: 'A', agree: 'true' }, do: 'magic', expect: { screen: 'List' } };
    await expect(executeStep(d, step, { hasOp: () => false })).rejects.toMatchObject({ kind: 'unknownOp', key: 'magic' });
    expect(d.log).toEqual(['fill customer="山田"', 'fill sku="A"', 'fill agree=true']);
  });
  it('[DD-SCENARIO-STEP-P037][DD-SCENARIO-STEP-T022][DD-SCENARIO-STEP-T023] 登録済みの do を実行し、click の要素がなければ notFound', async () => {
    const d = new FakeDriver();
    const r = await runStep(d, { event: 'x', do: 'magic', click: 'nope', expect: { screen: 'Confirm' } }, { hasOp: (n) => n === 'magic' });
    expect(r).toMatchObject({ ok: false, error: { kind: 'notFound', key: 'nope' } });
    expect(d.log).toEqual(['do magic']);
  });
  it('[DD-SCENARIO-STEP-P038][DD-SCENARIO-STEP-T015][DD-SCENARIO-STEP-T024][DD-SCENARIO-STEP-T025] expect をタイムアウトまで満たさなければ期待値と実際の値で失敗', async () => {
    const d = new FakeDriver();
    d.texts.title = '確認';
    const err = await executeStep(d, { event: '次へ [OK]', click: 'next', wait: 10, expect: { screen: 'Done', visible: ['msg'], hidden: [], text: { title: '確認画面' } } }, { timeoutMs: 150, retryIntervalMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.kind).toBe('expect');
    expect(err.failures).toEqual([
      { key: 'screen', expected: 'Done', actual: 'Confirm' },
      { key: 'visible:msg', expected: true, actual: false },
      { key: 'text:title', expected: '確認画面', actual: '確認' },
    ]);
    expect(d.log).toEqual(['click next 次へ']);
  });
  it('[DD-SCENARIO-STEP-P039][DD-SCENARIO-STEP-T016] expect を再試行して満たせば成功（click なしも可）', async () => {
    const d = new FakeDriver();
    const r = await executeStep(d, { event: '次へ', click: 'next', expect: { screen: 'Confirm', count: { rows: 0 } } }, { timeoutMs: 1000, retryIntervalMs: 10 });
    expect(r).toEqual({ ok: true, screen: 'Confirm', failures: [] });
    const r2 = await executeStep(d, { event: 'none', expect: { screen: 'Confirm' } }, { timeoutMs: 0 });
    expect(r2.ok).toBe(true);
  });
});

describe('resolveLocator', () => {
  const map = ScreenMapSchema.parse({
    screens: { List: { url: '/orders$' }, Input: { selector: "h1:has-text('注文入力')" } },
    events: { 次へ: 'button[type=submit]' },
    fields: { customer: '#customerName' },
  });
  it('[DD-SCENARIO-RESOLVE-P001][DD-SCENARIO-RESOLVE-T001][DD-SCENARIO-RESOLVE-T002][DD-SCENARIO-RESOLVE-T003] mock の画面は表示中の [data-screen=ID]', () => {
    expect(resolveLocator('screen', 'Input', 'mock')).toEqual({ ok: true, selector: '[data-screen="Input"]', visible: true });
  });
  it('[DD-SCENARIO-RESOLVE-P002][DD-SCENARIO-RESOLVE-T004] mock のイベントは表示中の画面内の [data-testid=click の値]', () => {
    expect(resolveLocator('event', 'next', 'mock', undefined, { screen: 'Input' })).toEqual({ ok: true, selector: '[data-testid="next"]', within: '[data-screen="Input"]' });
  });
  it('[DD-SCENARIO-RESOLVE-P003][DD-SCENARIO-RESOLVE-T005] mock の項目は [data-testid=キー]', () => {
    expect(resolveLocator('field', 'customer', 'mock', map)).toEqual({ ok: true, selector: '[data-testid="customer"]' });
  });
  it('[DD-SCENARIO-RESOLVE-P004][DD-SCENARIO-RESOLVE-T006][DD-SCENARIO-RESOLVE-T007][DD-SCENARIO-RESOLVE-T008] app の画面が対応表になければ失敗', () => {
    expect(resolveLocator('screen', 'Done', 'app', map)).toMatchObject({ ok: false, message: expect.stringContaining('Done') });
    expect(resolveLocator('screen', 'Done', 'app')).toMatchObject({ ok: false });
  });
  it('[DD-SCENARIO-RESOLVE-P005][DD-SCENARIO-RESOLVE-T009] app の画面は url パターンまたはセレクタで判定', () => {
    expect(resolveLocator('screen', 'List', 'app', map)).toEqual({ ok: true, url: '/orders$' });
    expect(resolveLocator('screen', 'Input', 'app', map)).toEqual({ ok: true, selector: "h1:has-text('注文入力')", visible: true });
  });
  it('[DD-SCENARIO-RESOLVE-P006][DD-SCENARIO-RESOLVE-T010][DD-SCENARIO-RESOLVE-T011] app のイベントが対応表になければ失敗', () => {
    expect(resolveLocator('event', '戻る', 'app', map)).toMatchObject({ ok: false, message: expect.stringContaining('戻る') });
  });
  it('[DD-SCENARIO-RESOLVE-P007][DD-SCENARIO-RESOLVE-T012] app のイベントは対応表のセレクタ（ガードは除く）', () => {
    expect(resolveLocator('event', '次へ [入力OK]', 'app', map)).toEqual({ ok: true, selector: 'button[type=submit]' });
  });
  it('[DD-SCENARIO-RESOLVE-P008][DD-SCENARIO-RESOLVE-T013][DD-SCENARIO-RESOLVE-T014] app の項目は対応表のセレクタ', () => {
    expect(resolveLocator('field', 'customer', 'app', map)).toEqual({ ok: true, selector: '#customerName' });
  });
  it('[DD-SCENARIO-RESOLVE-P009][DD-SCENARIO-RESOLVE-T015] app の項目が対応表になければ [data-testid=キー]', () => {
    expect(resolveLocator('field', 'sku', 'app', map)).toEqual({ ok: true, selector: '[data-testid="sku"]' });
  });
});

const HTML = `<!doctype html><html><body>
<section data-screen="List">
  <button data-event="新規" data-testid="new" data-goto="Input">新規</button>
</section>
<section data-screen="Input" data-validate>
  <input data-testid="customer" required maxlength="20" data-sample="山田 太郎">
  <select data-testid="sku" required><option value="">選択</option><option value="A-100">A</option><option>B-200</option></select>
  <input type="number" data-testid="quantity" min="1" max="99">
  <input type="checkbox" data-testid="agree">
  <input type="text" data-testid="zip" pattern="\\d{3}-\\d{4}">
  <input type="hidden" data-testid="h">
  <p data-testid="error" data-error hidden>エラー</p>
  <button data-event="次へ" data-testid="next">次へ</button>
  <button data-event="戻る">戻る</button>
</section>
<section data-screen="Confirm">
  <button data-event="確定" data-testid="submit" data-submit="POST /orders" data-ok="Done">確定</button>
</section>
<section data-screen="Done"></section>
</body></html>`;

describe('analyzeMockHtml / scaffoldScenario', () => {
  it('画面・イベント・入力要素と制約を解析する', () => {
    const m = analyzeMockHtml(HTML);
    expect([...m.screens.keys()]).toEqual(['List', 'Input', 'Confirm', 'Done']);
    const input = m.screens.get('Input')!;
    expect(Object.fromEntries(input.events)).toEqual({ 次へ: 'next', 戻る: '' });
    expect(input.fields).toEqual([
      { key: 'customer', kind: 'text', required: true, maxLength: 20, options: [], sample: '山田 太郎' },
      { key: 'sku', kind: 'select', required: true, options: ['A-100', 'B-200'] },
      { key: 'quantity', kind: 'number', required: false, min: 1, max: 99, options: [] },
      { key: 'agree', kind: 'checkbox', required: false, options: [] },
      { key: 'zip', kind: 'text', required: false, pattern: '\\d{3}-\\d{4}', options: [] },
    ]);
    expect([...input.submitters]).toEqual(['next']);
    expect([...m.screens.get('Confirm')!.submitters]).toEqual(['submit']);
  });

  it('経路から骨組みを作る（click・input・候補値・要確認）', () => {
    const m = analyzeMockHtml(HTML);
    const p: PathSpec = {
      id: 'BD-X-Y-P001',
      title: 't',
      start: 'List',
      edges: [],
      transitions: [
        { from: 'List', to: 'Input', event: '新規', guard: '', edge: 1 },
        { from: 'Input', to: 'Input', event: '次へ', guard: '入力NG', edge: 2 },
        { from: 'Input', to: 'Confirm', event: '次へ', guard: '入力OK', edge: 3 },
        { from: 'Confirm', to: 'List', event: '戻る', guard: '', edge: 4 },
        { from: 'Confirm', to: 'Done', event: '確定', guard: '', edge: 5 },
      ],
    };
    const { scenario: s, todos } = scaffoldScenario(p, m, { fixtures: ['default'] });
    expect(s.id).toBe('BD-X-Y-P001');
    expect(s.fixtures).toEqual(['default']);
    expect(s.steps[0]).toEqual({ event: '新規', click: 'new', expect: { screen: 'Input' } });
    expect(s.steps[1]).toEqual({ event: '次へ [入力NG]', input: { customer: '', sku: 'A-100', quantity: 1, agree: false, zip: '' }, click: 'next', expect: { screen: 'Input' } });
    expect(s.steps[2].input).toEqual({ customer: '山田 太郎', sku: 'A-100', quantity: 1, agree: false, zip: '' });
    expect(s.steps[3]).toEqual({ event: '戻る', click: '', expect: { screen: 'List' } });
    expect(s.steps[4]).toEqual({ event: '確定', click: 'submit', expect: { screen: 'Done' } });
    expect(todos).toEqual([
      ['steps', 1, 'input', 'zip'],
      ['steps', 2, 'input', 'zip'],
      ['steps', 3, 'click'],
    ]);
  });
});

describe('parseScenarioFile', () => {
  it('形式違反は行番号付きの issue、# 要確認 は todos に集める', () => {
    const ok = parseScenarioFile(`id: A-B-C-P001\ntitle: t\nfixtures: []\nstart: List\nsteps:\n  - event: 新規\n    click: "" # 要確認\n    expect: { screen: Input }\n`, 'a.yaml');
    expect(ok.issues).toEqual([]);
    expect(ok.scenario?.steps[0].click).toBe('');
    expect(ok.todos).toEqual([{ line: 7, key: 'click' }]);
    const ng = parseScenarioFile(`id: A\ntitle: t\nstart: List\nsteps:\n  - event: x\n    input: { a: [1] }\n    expect: {}\n`, 'b.yaml');
    expect(ng.scenario).toBeUndefined();
    expect(ng.issues.map((i) => i.line).sort()).toEqual([6, 7]);
    const bad = parseScenarioFile(`id: [\n`, 'c.yaml');
    expect(bad.issues[0].line).toBeGreaterThanOrEqual(1);
  });
});
