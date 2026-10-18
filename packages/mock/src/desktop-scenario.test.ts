import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { normalizeScreenMap, parseScreenMap, createScreenMap, ScreenMapError, type PlatformMap } from './map.ts';
import { expandOnly, planSteps, stepApplies, type Platform } from './platform.ts';
import { desktopNotFoundMessage, desktopScreenCandidates, resolveDesktopName, type DesktopName } from './resolve.ts';
import { runScenarioWith, stepLabel, type Capture, type ScenarioSession } from './run-scenario.ts';
import { matchPath } from './match.ts';
import { parseScenarioFile, validateScenario } from './scenario.ts';
import { StepError, type Driver } from './step.ts';
import { TraceRecorder, type TraceFile } from './trace.ts';
import type { FieldKind, Scenario, Step } from './types.ts';

const scenarioOf = (steps: Step[], start = 'List'): Scenario => ({ id: 'BD-X-SCREEN-P001', title: 't', fixtures: [], start, steps });

describe('validateScenario（DD-DSCN-STEPVAL）', () => {
  const issues = (step: Step) => validateScenario(scenarioOf([{ event: '新規', click: 'new', expect: { screen: 'Input' } }, step]));

  it('[DD-DSCN-STEPVAL-P001][DD-DSCN-STEPVAL-T001][DD-DSCN-STEPVAL-T002] only に不明な値があれば error（空の配列も同じ扱い）', () => {
    const r = issues({ click: 'x', only: ['wpf', 'mac' as never] });
    expect(r).toEqual([{ path: 'steps.1.only', message: 'シナリオ BD-X-SCREEN-P001 のステップ 2: 不明なプラットフォームです: mac（web / wpf / winforms / desktop）' }]);
    expect(issues({ click: 'x', only: [] })[0].message).toContain('only が空です');
  });
  it('[DD-DSCN-STEPVAL-P002][DD-DSCN-STEPVAL-T003][DD-DSCN-STEPVAL-T004][DD-DSCN-STEPVAL-T005] 遷移のステップに only は error', () => {
    const r = issues({ event: '次へ', click: 'next', only: 'web', expect: { screen: 'Done' } });
    expect(r.map((i) => [i.path, i.message])).toEqual([['steps.1.only', 'シナリオ BD-X-SCREEN-P001 のステップ 2: 遷移のステップに only は付けられません（図とシナリオを分けてください）']]);
  });
  it('[DD-DSCN-STEPVAL-P003][DD-DSCN-STEPVAL-T006][DD-DSCN-STEPVAL-T007] 遷移のステップに expect.screen が無ければ error', () => {
    expect(issues({ event: '次へ', click: 'next', expect: { visible: ['a'] } }).map((i) => i.message)).toEqual(['シナリオ BD-X-SCREEN-P001 のステップ 2: 遷移のステップには expect.screen が必要です']);
    expect(issues({ event: '次へ', click: 'next' })[0].path).toBe('steps.1.expect');
  });
  it('[DD-DSCN-STEPVAL-P004][DD-DSCN-STEPVAL-T008] 遷移のステップに expect.screen があれば正しい', () => {
    expect(issues({ event: '次へ', click: 'next', expect: { screen: 'Done' } })).toEqual([]);
  });
  it('[DD-DSCN-STEPVAL-P005][DD-DSCN-STEPVAL-T009][DD-DSCN-STEPVAL-T010] 操作も期待も無い補助ステップは error', () => {
    expect(issues({ only: 'desktop' })).toEqual([{ path: 'steps.1', message: 'シナリオ BD-X-SCREEN-P001 のステップ 2: 補助ステップに操作も期待もありません' }]);
  });
  it('[DD-DSCN-STEPVAL-P006][DD-DSCN-STEPVAL-T011] click・input・do・wait・expect のどれかがある補助ステップは正しい', () => {
    for (const s of [{ click: 'x' }, { input: { a: 1 } }, { do: 'op' }, { wait: 10 }, { expect: { visible: ['a'] } }, { click: 'x', only: ['wpf', 'desktop'] }] as Step[]) expect(issues(s)).toEqual([]);
  });
  it('parseScenarioFile は形の検査に続けて validateScenario を行い、行番号を付ける', () => {
    const text = `id: A\ntitle: t\nstart: List\nsteps:\n  - event: x\n    click: a\n    only: web\n    expect: { screen: B }\n  - only: desktop\n`;
    const r = parseScenarioFile(text, 'a.yaml');
    expect(r.scenario).toBeUndefined();
    expect(r.issues.map((i) => [i.line, i.message])).toEqual([
      [7, 'シナリオ A のステップ 1: 遷移のステップに only は付けられません（図とシナリオを分けてください）'],
      [9, 'シナリオ A のステップ 2: 補助ステップに操作も期待もありません'],
    ]);
    const ok = parseScenarioFile(`id: A\ntitle: t\nstart: List\nsteps:\n  - click: closeDialog\n    only: [ wpf ]\n  - event: x\n    click: a\n    expect: { screen: B }\n`, 'b.yaml');
    expect(ok.issues).toEqual([]);
    expect(ok.scenario?.steps[0]).toEqual({ click: 'closeDialog', only: ['wpf'] });
  });
});

describe('expandOnly / stepApplies / planSteps（DD-DSCN-APPLY）', () => {
  it('expandOnly は desktop を広げ、重複を除いて PLATFORMS の順で返す', () => {
    expect(expandOnly('desktop')).toEqual(['wpf', 'winforms']);
    expect(expandOnly(['winforms', 'web', 'desktop'])).toEqual(['web', 'wpf', 'winforms']);
    expect(expandOnly(undefined)).toEqual([]);
    expect(stepApplies({}, 'wpf')).toBe(true);
    expect(stepApplies({ only: 'desktop' }, 'web')).toBe(false);
  });

  const steps: Step[] = [
    { click: 'closeDialog', only: 'wpf' },
    { event: '新規', click: 'new', expect: { screen: 'Input' } },
    { click: 'tab', expect: { screen: 'Input2', visible: ['a'] } },
    { input: { customer: 'x' }, expect: { visible: ['b'] } },
    { click: 'tab3', only: 'desktop', expect: { screen: 'Never' } },
  ];
  const web = planSteps(scenarioOf(steps), 'web');

  it('[DD-DSCN-APPLY-P001][DD-DSCN-APPLY-T001][DD-DSCN-APPLY-T002] 含まれないステップは飛ばし、画面は直前のまま', () => {
    expect(web[0]).toMatchObject({ index: 0, run: false, expect: { screen: 'List' } });
    expect(web[4]).toMatchObject({ index: 4, run: false, expect: { screen: 'Input2' } });
  });
  it('[DD-DSCN-APPLY-P002][DD-DSCN-APPLY-T003][DD-DSCN-APPLY-T004] 遷移のステップは expect をそのまま使い、画面を expect.screen にする', () => {
    expect(web[1]).toMatchObject({ run: true, expect: { screen: 'Input' } });
    expect(web[1].expect).toEqual(steps[1].expect);
  });
  it('[DD-DSCN-APPLY-P003][DD-DSCN-APPLY-T005][DD-DSCN-APPLY-T006] expect.screen のある補助ステップはそのまま使い、画面を変える', () => {
    expect(web[2]).toMatchObject({ run: true, expect: { screen: 'Input2', visible: ['a'] } });
  });
  it('[DD-DSCN-APPLY-P004][DD-DSCN-APPLY-T007] expect.screen の無い補助ステップは直前の画面を screen として補う', () => {
    expect(web[3].expect).toEqual({ screen: 'Input2', visible: ['b'] });
    expect(steps[3].expect).toEqual({ visible: ['b'] });
    const wpf = planSteps(scenarioOf(steps), 'wpf');
    expect(wpf.map((p) => p.run)).toEqual([true, true, true, true, true]);
    expect(wpf[0].expect).toEqual({ screen: 'List' });
    expect(wpf[4].expect.screen).toBe('Never');
  });
});

describe('normalizeScreenMap（DD-DSCN-MAPNORM）', () => {
  const issuesOf = (raw: unknown) => {
    const r = normalizeScreenMap(raw);
    return r.ok ? [] : r.issues.map((i) => i.message);
  };

  it('[DD-DSCN-MAPNORM-P001][DD-DSCN-MAPNORM-T001][DD-DSCN-MAPNORM-T002][DD-DSCN-MAPNORM-T003] 従来の形式とプラットフォームの節は同時に書けない', () => {
    const r = normalizeScreenMap({ screens: {}, wpf: { fields: {} } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toEqual([{ path: ['wpf'], message: expect.stringContaining('同時に書けません') }]);
  });
  it('[DD-DSCN-MAPNORM-P002][DD-DSCN-MAPNORM-T004][DD-DSCN-MAPNORM-T008][DD-DSCN-MAPNORM-T010] 従来の形式（web とみなす）で画面の規則が合わなければ error', () => {
    const r = normalizeScreenMap({ screens: { List: { automationId: 'ListView' } } });
    expect(r).toMatchObject({ ok: false, legacy: true });
    expect(issuesOf({ screens: { List: { automationId: 'ListView' } } })).toEqual(['_map.yaml の web.screens.List: web では url か selector で画面を指定してください']);
  });
  it('[DD-DSCN-MAPNORM-P003][DD-DSCN-MAPNORM-T011] 従来の形式は web の節になり、他の節は空', () => {
    const map = parseScreenMap('screens:\n  List: { url: "/orders$" }\nevents:\n  新規: "#add"\nfields:\n  customer: "#name"\n');
    expect(map.web).toEqual({ screens: { List: { url: '/orders$' } }, events: { 新規: '#add' }, fields: { customer: '#name' }, ignore: [] });
    expect(map.wpf).toEqual({ screens: {}, events: {}, fields: {}, ignore: [] });
    expect(map.of('winforms')).toBe(map.winforms);
    expect(normalizeScreenMap(undefined)).toMatchObject({ ok: true, legacy: false });
  });
  it('[DD-DSCN-MAPNORM-P004][DD-DSCN-MAPNORM-T005][DD-DSCN-MAPNORM-T006] web・wpf・winforms 以外のキーは error', () => {
    const r = normalizeScreenMap({ wpf: {}, mac: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toEqual([{ path: ['mac'], message: '_map.yaml の mac: 不明なキーです' }]);
  });
  it('[DD-DSCN-MAPNORM-P005][DD-DSCN-MAPNORM-T007][DD-DSCN-MAPNORM-T009][DD-DSCN-MAPNORM-T010] 節の画面の規則がプラットフォームに合わなければ error（デスクトップは automationId か title のどちらか 1 つ）', () => {
    expect(issuesOf({ wpf: { screens: { List: { url: '/x' } } } })).toEqual(['_map.yaml の wpf.screens.List: wpf では automationId か title のどちらか 1 つ で画面を指定してください']);
    expect(issuesOf({ winforms: { screens: { List: { automationId: 'a', title: 't' } } } })).toHaveLength(1);
    expect(issuesOf({ web: { screens: { List: { title: 't' } } } })).toHaveLength(1);
    expect(issuesOf({ web: { ignore: ['x'] } })[0]).toContain('web.ignore');
    expect(() => parseScreenMap('wpf:\n  screens:\n    List: { url: x }\n')).toThrow(ScreenMapError);
  });
  it('[DD-DSCN-MAPNORM-P006][DD-DSCN-MAPNORM-T007][DD-DSCN-MAPNORM-T009][DD-DSCN-MAPNORM-T011] 節ごとに読み、無い節は空', () => {
    const map = parseScreenMap(
      YAML.stringify({
        web: { screens: { List: { selector: 'h1' } } },
        wpf: { screens: { List: { automationId: 'OrderListView' }, Input: { title: '注文入力' } }, events: { 新規: 'NewButton' }, fields: { customer: 'CustomerNameBox' }, ignore: ['legacyOnly'] },
      }),
    );
    expect(map.web.screens).toEqual({ List: { selector: 'h1' } });
    expect(map.wpf).toEqual({ screens: { List: { automationId: 'OrderListView' }, Input: { title: '注文入力' } }, events: { 新規: 'NewButton' }, fields: { customer: 'CustomerNameBox' }, ignore: ['legacyOnly'] });
    expect(map.winforms).toEqual({ screens: {}, events: {}, fields: {}, ignore: [] });
  });
});

/** Desktop app window as a fake FlaUI would see it: AutomationIds (with the time they appear) and the title. */
interface FakeWindow {
  title: string;
  /** AutomationId → ms after `open` when it appears (0 = from the start). */
  ids: Record<string, number>;
  text?: Record<string, string>;
}

/** Driver resolving names like the desktop driver (resolveDesktopName) and retrying until the deadline. */
class FakeDesktopDriver implements Driver {
  log: string[] = [];
  opened = Date.now();
  windows: Record<string, FakeWindow>;
  current: string;
  /** AutomationId clicked → next window. */
  nav: Record<string, string> = {};
  previous: string | null = null;

  constructor(
    readonly platform: Platform,
    readonly map: PlatformMap,
    readonly scenario: Scenario,
    windows: Record<string, FakeWindow>,
    start: string,
    readonly deadlineMs = 150,
  ) {
    this.windows = windows;
    this.current = start;
  }

  private present(name: DesktopName): boolean {
    const w = this.windows[this.current];
    if (name.by === 'title') return w.title === name.name;
    const at = w.ids[name.name];
    return at !== undefined && Date.now() - this.opened >= at;
  }

  private async find(kind: 'event' | 'field', key: string, event?: string): Promise<DesktopName> {
    const name = resolveDesktopName(kind, key, this.map, event);
    const end = Date.now() + this.deadlineMs;
    while (!this.present(name)) {
      if (Date.now() >= end) throw new StepError('notFound', desktopNotFoundMessage(key, name, this.platform), { key });
      await new Promise((r) => setTimeout(r, 10));
    }
    return name;
  }

  fieldKind(key: string): Promise<FieldKind | null> {
    return this.find('field', key).then(() => 'text' as const);
  }
  async fill(key: string, value: string | boolean) {
    const n = await this.find('field', key);
    this.log.push(`fill:${n.name}=${value}`);
  }
  async click(key: string, event?: string) {
    const n = await this.find(event !== undefined ? 'event' : 'field', key, event);
    this.log.push(`click:${n.name}`);
    const next = this.nav[n.name];
    if (next) {
      this.current = next;
      this.opened = Date.now();
    }
  }
  invoke(name: string) {
    this.log.push(`do:${name}`);
  }
  screen(): string | null {
    for (const id of desktopScreenCandidates(this.scenario, this.map, this.previous)) {
      const n = resolveDesktopName('screen', id, this.map);
      if (this.present(n)) return (this.previous = id);
    }
    return null;
  }
  isVisible(key: string) {
    return this.present(resolveDesktopName('field', key, this.map));
  }
  text(key: string) {
    const n = resolveDesktopName('field', key, this.map);
    return this.present(n) ? (this.windows[this.current].text?.[n.name] ?? '') : null;
  }
  count(key: string) {
    return this.present(resolveDesktopName('field', key, this.map)) ? 1 : 0;
  }
}

class FakeSession implements ScenarioSession {
  readonly target = 'app' as const;
  events: string[] = [];
  shots: string[] = [];
  constructor(
    readonly platform: Platform,
    readonly driver: Driver,
  ) {}
  async open(s: Scenario) {
    this.events.push(`open:${s.id}`);
  }
  async capture(): Promise<Capture> {
    return { take: async () => ({ calls: [], db: null }) };
  }
  async close() {
    this.events.push('close');
  }
  async screenshot(p: string) {
    this.shots.push(path.basename(p));
  }
  async screenshotElement() {}
  async mockTables() {
    return null;
  }
  hookContext() {
    return {};
  }
}

const WPF = createScreenMap({
  wpf: {
    screens: { List: { automationId: 'OrderListView' }, Input: { title: '注文入力' }, Done: { automationId: 'DoneView' } },
    events: { 新規: 'NewOrderButton' },
    fields: { customer: 'CustomerNameBox', closeDialog: 'CloseButton', message: 'MessageText' },
  },
}).wpf;

const desktopScenario = scenarioOf([
  { click: 'closeDialog', only: 'desktop' },
  { event: '新規', click: 'new', expect: { screen: 'Input' } },
  { input: { customer: '山田' }, only: ['wpf'], expect: { text: { message: 'OK' } } },
  { click: 'webOnly', only: 'web' },
  { event: '確定 [入力OK]', click: 'ok', expect: { screen: 'Done' } },
]);

const desktopWindows = (late: Record<string, number> = {}): Record<string, FakeWindow> => ({
  List: { title: '注文一覧', ids: { OrderListView: 0, CloseButton: 0, NewOrderButton: 0, ...late } },
  Input: { title: '注文入力', ids: { CustomerNameBox: 0, MessageText: 0, ok: 0, ...late }, text: { MessageText: 'OK' } },
  Done: { title: '完了', ids: { DoneView: 0 } },
});

function desktopRun(late: Record<string, number> = {}, map = WPF, deadlineMs = 150) {
  const driver = new FakeDesktopDriver('wpf', map, desktopScenario, desktopWindows(late), 'List', deadlineMs);
  driver.nav = { NewOrderButton: 'Input', new: 'Input', ok: 'Done' };
  return { driver, session: new FakeSession('wpf', driver) };
}

describe('resolveDesktopName（DD-DSCN-DRES）', () => {
  it('[DD-DSCN-DRES-P001][DD-DSCN-DRES-T001][DD-DSCN-DRES-T002][DD-DSCN-DRES-T003][DD-DSCN-DRES-T004] 画面の規則が automationId なら、その要素が今のウィンドウにある画面', () => {
    expect(resolveDesktopName('screen', 'List', WPF)).toEqual({ by: 'automationId', name: 'OrderListView', mapped: true });
    const { driver } = desktopRun();
    expect(driver.screen()).toBe('List');
  });
  it('[DD-DSCN-DRES-P002][DD-DSCN-DRES-T005] 画面の規則が title なら、前面のウィンドウのタイトルが一致する画面', () => {
    expect(resolveDesktopName('screen', 'Input', WPF)).toEqual({ by: 'title', name: '注文入力', mapped: true });
    const { driver } = desktopRun();
    driver.current = 'Input';
    expect(driver.screen()).toBe('Input');
  });
  it('[DD-DSCN-DRES-P003][DD-DSCN-DRES-T006] map.screens に無い画面は論理名の AutomationId', () => {
    expect(resolveDesktopName('screen', 'Confirm', WPF)).toEqual({ by: 'automationId', name: 'Confirm', mapped: false });
    expect(resolveDesktopName('screen', 'List')).toEqual({ by: 'automationId', name: 'List', mapped: false });
    expect(desktopScreenCandidates(desktopScenario, WPF, 'Done')).toEqual(['Done', 'List', 'Input']);
  });
  it('[DD-DSCN-DRES-P004][DD-DSCN-DRES-T007][DD-DSCN-DRES-T008] 遷移のクリックは map.events のイベント名（ガードを除く）の読み替え先', () => {
    expect(resolveDesktopName('event', 'new', WPF, '新規')).toEqual({ by: 'automationId', name: 'NewOrderButton', mapped: true });
    expect(resolveDesktopName('event', 'new', createScreenMap({ wpf: { events: { 確定: 'OkButton' } } }).wpf, '確定')).toMatchObject({ name: 'OkButton' });
  });
  it('[DD-DSCN-DRES-P005][DD-DSCN-DRES-T009] map.events に無ければ click の値の AutomationId', () => {
    expect(resolveDesktopName('event', 'ok', WPF, '確定')).toEqual({ by: 'automationId', name: 'ok', mapped: false });
  });
  it('[DD-DSCN-DRES-P006][DD-DSCN-DRES-T010][DD-DSCN-DRES-T011] 入力・期待・補助のクリックは map.fields の読み替え先', () => {
    expect(resolveDesktopName('field', 'customer', WPF)).toEqual({ by: 'automationId', name: 'CustomerNameBox', mapped: true });
    expect(resolveDesktopName('field', 'closeDialog', WPF)).toMatchObject({ name: 'CloseButton', mapped: true });
    // An auxiliary click (no event) is a field even when the map has a same-named event.
    expect(resolveDesktopName('event', '新規', WPF)).toEqual({ by: 'automationId', name: '新規', mapped: false });
  });
  it('[DD-DSCN-DRES-P007][DD-DSCN-DRES-T012] map.fields に無ければ論理名の AutomationId', () => {
    expect(resolveDesktopName('field', 'note', WPF)).toEqual({ by: 'automationId', name: 'note', mapped: false });
    expect(resolveDesktopName('field', 'note')).toEqual({ by: 'automationId', name: 'note', mapped: false });
  });
});

describe('only の適用（BD-DESKRUN-ONLY）', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-dscn-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const traceRun = async (platform: Platform, steps: Step[], driver: Driver) => {
    const rec = new TraceRecorder(path.join(dir, platform), { runId: 'r', testId: 'T', title: 't', mock: 'm', target: 'app', platform });
    const session = new FakeSession(platform, driver);
    await runScenarioWith(session, scenarioOf(steps), { trace: rec, timeout: 100 });
    return { session, trace: JSON.parse(await fs.readFile(path.join(dir, platform, 'T.json'), 'utf8')) as TraceFile };
  };

  it('[BD-DESKRUN-ONLY-P001][BD-DESKRUN-ONLY-T001][BD-DESKRUN-ONLY-T002][BD-DESKRUN-ONLY-S001] only の無いステップはどのプラットフォームでも実行する', () => {
    for (const p of ['web', 'wpf', 'winforms'] as const) expect(planSteps(scenarioOf([{ click: 'a' }, { event: 'e', click: 'b', expect: { screen: 'X' } }]), p).every((s) => s.run)).toBe(true);
  });
  it('[BD-DESKRUN-ONLY-P002][BD-DESKRUN-ONLY-T003][BD-DESKRUN-ONLY-T004][BD-DESKRUN-ONLY-S002][BD-DESKRUN-ONLY-S003] 遷移のステップの only は lint の error になり、実行もしない', async () => {
    const s = scenarioOf([{ event: '新規', click: 'new', only: 'wpf', expect: { screen: 'Input' } }]);
    expect(validateScenario(s).map((i) => i.message)).toEqual(['シナリオ BD-X-SCREEN-P001 のステップ 1: 遷移のステップに only は付けられません（図とシナリオを分けてください）']);
    const { driver } = desktopRun();
    const session = new FakeSession('wpf', driver);
    await expect(runScenarioWith(session, s)).rejects.toThrow('遷移のステップに only は付けられません');
    expect(session.events).toEqual([]);
  });
  it('[BD-DESKRUN-ONLY-P003][BD-DESKRUN-ONLY-T005][BD-DESKRUN-ONLY-T006][BD-DESKRUN-ONLY-S004][BD-DESKRUN-ONLY-S005] 今のプラットフォームが only に含まれる補助ステップは実行する', async () => {
    const { driver } = desktopRun();
    const { trace } = await traceRun('wpf', desktopScenario.steps, driver);
    expect(driver.log).toEqual(['click:CloseButton', 'click:NewOrderButton', 'fill:CustomerNameBox=山田', 'click:ok']);
    expect(trace.steps.map((s) => [s.index, s.event, s.skipped ?? false, s.ok])).toEqual([
      [1, '', false, true],
      [2, '新規', false, true],
      [3, '', false, true],
      [4, '', true, true],
      [5, '確定 [入力OK]', false, true],
    ]);
    expect(trace.steps[0]).toMatchObject({ only: ['wpf', 'winforms'], click: 'closeDialog', screenBefore: 'List', screenAfter: 'List' });
    expect(trace.steps[2].expects).toEqual([
      { kind: 'screen', key: '', expected: 'Input', actual: 'Input', ok: true },
      { kind: 'text', key: 'message', expected: 'OK', actual: 'OK', ok: true },
    ]);
  });
  it('[BD-DESKRUN-ONLY-P004][BD-DESKRUN-ONLY-T007][BD-DESKRUN-ONLY-S006] 含まれないステップは飛ばし、トレースに skip を残し、成功の判定に影響しない', async () => {
    const { driver } = desktopRun();
    const { trace, session } = await traceRun('wpf', desktopScenario.steps, driver);
    expect(trace.status).toBe('passed');
    expect(trace.platform).toBe('wpf');
    expect(trace.steps[3]).toEqual({ index: 4, event: '', only: ['web'], click: 'webOnly', screenBefore: 'Input', skipped: true, screenAfter: 'Input', expects: [], ok: true, durationMs: 0, calls: [], db: null });
    expect(driver.log).not.toContain('click:webOnly');
    expect(session.shots).toEqual(['1.png', '2.png', '3.png', '5.png']);

    // winforms: the wpf-only input step is skipped too; web-like fake (no map) skips the desktop ones.
    const wf = new FakeDesktopDriver('winforms', createScreenMap({ winforms: WPF }).winforms, desktopScenario, desktopWindows(), 'List');
    wf.nav = { NewOrderButton: 'Input', ok: 'Done' };
    const r2 = await traceRun('winforms', desktopScenario.steps, wf);
    expect(r2.trace.steps.map((s) => s.skipped ?? false)).toEqual([false, false, true, true, false]);
    expect(wf.log).toEqual(['click:CloseButton', 'click:NewOrderButton', 'click:ok']);
  });
});

describe('名前の解決（BD-DESKRUN-RESOLVE）', () => {
  const steps: Step[] = [{ input: { customer: '山田' }, expect: { visible: ['customer'] } }];
  const inInput = (late: Record<string, number>, map: PlatformMap) => {
    const r = desktopRun(late, map, 150);
    r.driver.current = 'Input';
    return r;
  };
  const run = (late: Record<string, number>, map: PlatformMap) => {
    const r = inInput(late, map);
    return { ...r, done: runScenarioWith(r.session, scenarioOf(steps, 'Input'), { timeout: 100 }) };
  };
  const UNMAPPED = createScreenMap({ wpf: { screens: { Input: { title: '注文入力' } } } }).wpf;

  it('[BD-DESKRUN-RESOLVE-P001][BD-DESKRUN-RESOLVE-T001][BD-DESKRUN-RESOLVE-T002][BD-DESKRUN-RESOLVE-T004][BD-DESKRUN-RESOLVE-T006][BD-DESKRUN-RESOLVE-S001][BD-DESKRUN-RESOLVE-S003][BD-DESKRUN-RESOLVE-S005] 読み替えがあれば読み替え先の名前で探し、期限までに見つかれば操作・判定する', async () => {
    const { driver, done } = run({ CustomerNameBox: 60 }, WPF);
    await done;
    expect(driver.log).toEqual(['fill:CustomerNameBox=山田']);
  });
  it('[BD-DESKRUN-RESOLVE-P002][BD-DESKRUN-RESOLVE-T007][BD-DESKRUN-RESOLVE-S006] 読み替え先が見つからなければ論理名・探した名前・プラットフォームを表示して失敗', async () => {
    const { done, session } = run({ CustomerNameBox: 10_000 }, WPF);
    const err = await done.catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.kind).toBe('notFound');
    expect(err.message).toBe('ステップ 1（補助）: 要素が見つかりません: 論理名 customer（対応表で CustomerNameBox）（探した名前: CustomerNameBox、wpf）');
    expect(session.events).toEqual(['open:BD-X-SCREEN-P001', 'close']);
  });
  it('[BD-DESKRUN-RESOLVE-P003][BD-DESKRUN-RESOLVE-T003][BD-DESKRUN-RESOLVE-T005][BD-DESKRUN-RESOLVE-T006][BD-DESKRUN-RESOLVE-S002][BD-DESKRUN-RESOLVE-S004][BD-DESKRUN-RESOLVE-S007] 読み替えが無ければ論理名と同じ名前で探し、期限までに見つかれば操作・判定する', async () => {
    const r = inInput({ customer: 60 }, UNMAPPED);
    await runScenarioWith(r.session, scenarioOf(steps, 'Input'), { timeout: 100 });
    expect(r.driver.log).toEqual(['fill:customer=山田']);
  });
  it('[BD-DESKRUN-RESOLVE-P004][BD-DESKRUN-RESOLVE-T007][BD-DESKRUN-RESOLVE-S008] 論理名でも見つからなければ論理名・探した名前・プラットフォームを表示して失敗', async () => {
    const err = await run({}, UNMAPPED).done.catch((e) => e);
    expect(err.message).toBe('ステップ 1（補助）: 要素が見つかりません: 論理名 customer（探した名前: customer、wpf）');
    expect(desktopNotFoundMessage('Input', resolveDesktopName('screen', 'Input', WPF), 'winforms')).toBe('要素が見つかりません: 論理名 Input（対応表で 注文入力）（探した名前: タイトル 注文入力、winforms）');
  });
});

describe('runScenarioWith（ドライバに依存しない実行器）', () => {
  it('ステップの番号はファイル上の 1 始まりで、補助ステップは「補助・click/do」と表示する', () => {
    expect(stepLabel({ event: '次へ', click: 'n', expect: { screen: 'A' } }, 2)).toBe('ステップ 3（次へ）');
    expect(stepLabel({ click: 'closeDialog' }, 3)).toBe('ステップ 4（補助・closeDialog）');
    expect(stepLabel({ do: 'op' }, 0)).toBe('ステップ 1（補助・op）');
  });
  it('補助ステップの期待の不一致は補助ステップの番号で失敗し、補った画面も判定する', async () => {
    const { session } = desktopRun();
    const s = scenarioOf([
      { click: 'closeDialog', only: 'desktop' },
      { event: '新規', click: 'new', expect: { screen: 'Input' } },
      { click: 'customer', expect: { text: { message: 'NG' } } },
    ]);
    const err = await runScenarioWith(session, s, { timeout: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.message).toMatch(/^ステップ 3（補助・customer）: 期待値と一致しません/);
    expect(err.failures.map((f: { key: string }) => f.key)).toEqual(['text:message']);
    // The filled screen (Input) is judged too: a step that leaves the screen fails on it.
    const moved = scenarioOf([{ event: '新規', click: 'new', expect: { screen: 'Input' } }, { click: 'ok' }]);
    const err2 = await runScenarioWith(desktopRun().session, moved, { timeout: 50 }).catch((e) => e);
    expect(err2.failures).toEqual([{ key: 'screen', expected: 'Input', actual: 'Done' }]);
  });
  it('onStep は実行したステップだけファイル上の番号で呼び、最後に close する', async () => {
    const { session } = desktopRun();
    const seen: number[] = [];
    await runScenarioWith(session, desktopScenario, { onStep: (i) => void seen.push(i), timeout: 100 });
    expect(seen).toEqual([0, 1, 2, 4]);
    expect(session.events).toEqual(['open:BD-X-SCREEN-P001', 'close']);
  });
  it('open の失敗はトレースに failedStep 0 を書いてから投げる', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-dscn-open-'));
    try {
      const { driver } = desktopRun();
      const session = new FakeSession('wpf', driver);
      session.open = async () => {
        throw new Error('起動できません');
      };
      const rec = new TraceRecorder(dir, { runId: 'r', testId: 'T', title: 't', mock: 'm', target: 'app', platform: 'wpf' });
      await expect(runScenarioWith(session, desktopScenario, { trace: rec })).rejects.toThrow('起動できません');
      expect(JSON.parse(await fs.readFile(path.join(dir, 'T.json'), 'utf8'))).toMatchObject({ status: 'failed', failedStep: 0, error: '起動できません', steps: [] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('matchPath は補助ステップを除いた遷移のステップで経路と照合し、番号はファイル上の番号', () => {
    const spec = { id: 'BD-X-SCREEN-P001', start: 'List', title: '', edges: [], transitions: [{ from: 'List', event: '新規', guard: '', to: 'Input', edge: 0 }, { from: 'Input', event: '確定', guard: '入力OK', to: 'Done', edge: 1 }] };
    expect(matchPath(desktopScenario, spec).ok).toBe(true);
    const bad = scenarioOf([{ click: 'a' }, { event: '新規', click: 'new', expect: { screen: 'Input' } }, { event: '確定', click: 'ok', expect: { screen: 'X' } }]);
    const m = matchPath(bad, spec);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.message).toContain('ステップ 3');
  });
});
