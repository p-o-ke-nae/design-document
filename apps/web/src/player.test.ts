import { describe, expect, it } from 'vitest';
import type { Step } from './api.ts';
import { NO_RESPONSE, PlayerController, SPEEDS, highlightHoldMs, nextState, type PlayerScenario, type PlayerState, type PlayerTimer, type PlayerTransport, type StepResult } from './player.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: Error): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const step = (event: string, screen: string): Step => ({ event, click: event, expect: { screen } });
const SCENARIO: PlayerScenario = {
  id: 'BD-ORDER-SCREEN-P001',
  fixtures: ['default'],
  start: 'List',
  steps: [step('新規', 'Input'), step('次へ', 'Confirm'), step('確定', 'Done')],
};
const OK = (screen: string): StepResult => ({ ok: true, screen, failures: [] });
const NG: StepResult = { ok: false, screen: 'Input', failures: [{ key: 'screen', expected: 'Confirm', actual: 'Input' }] };

/** Steps resolve automatically from `results` unless `manual` is set. */
class FakeTransport implements PlayerTransport {
  resets: Array<{ fixtures: string[]; start?: string; data?: unknown }> = [];
  steps: Array<{ index: number; d: Deferred<StepResult>; highlight?: { holdMs: number }; trace?: boolean }> = [];
  manual = false;
  hangReset = false;
  results: (i: number) => StepResult = (i) => OK(SCENARIO.steps[i].expect.screen);
  reset(fixtures: string[], start?: string, data?: unknown) {
    this.resets.push({ fixtures, start, ...(data ? { data } : {}) });
    return this.hangReset ? new Promise<{ screen: string | null }>(() => {}) : Promise.resolve({ screen: start ?? null });
  }
  step(index: number, _step: Step, highlight?: { holdMs: number }, trace?: boolean) {
    const d = deferred<StepResult>();
    this.steps.push({ index, d, highlight, trace });
    if (!this.manual) d.resolve(this.results(index));
    return d.promise;
  }
}

class FakeTimer implements PlayerTimer {
  now = 0;
  seq = 0;
  waits: number[] = [];
  tasks: Array<{ id: number; at: number; fn: () => void }> = [];
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.waits.push(ms);
    this.tasks.push({ id, at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const t = this.tasks.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!t) break;
      this.tasks = this.tasks.filter((x) => x !== t);
      this.now = t.at;
      t.fn();
      await flush();
    }
    this.now = end;
  }
  /** Speed waits only (response timeouts are 10s). */
  get speedWaits() {
    return this.waits.filter((w) => w !== 10_000);
  }
}

function setup(opts: { speed?: number; manual?: boolean } = {}) {
  const transport = new FakeTransport();
  transport.manual = !!opts.manual;
  const timer = new FakeTimer();
  const finished: Array<{ id: string; ok: boolean }> = [];
  const c = new PlayerController(transport, { timer, speed: opts.speed ?? 0, onFinish: (r) => finished.push({ id: r.id, ok: r.ok }) });
  c.load(SCENARIO);
  const states: PlayerState[] = [];
  c.subscribe(() => {
    const s = c.getSnapshot().state;
    if (states.at(-1) !== s) states.push(s);
  });
  return { c, transport, timer, finished, states, state: () => c.getSnapshot().state, snap: () => c.getSnapshot() };
}

async function toPaused(cursor = 1) {
  const t = setup();
  t.c.step();
  await flush();
  for (let i = 0; i < cursor; i++) {
    t.c.step();
    await flush();
  }
  expect(t.state()).toBe('Paused');
  expect(t.snap().cursor).toBe(cursor);
  return t;
}

async function toDone() {
  const t = setup();
  t.c.play();
  await flush();
  expect(t.state()).toBe('Done');
  return t;
}

async function toFailed() {
  const t = setup();
  t.transport.results = (i) => (i === 1 ? NG : OK(SCENARIO.steps[i].expect.screen));
  t.c.play();
  await flush();
  expect(t.state()).toBe('Failed');
  return t;
}

async function toPlaying() {
  const t = setup({ manual: true });
  t.c.play();
  await flush();
  expect(t.state()).toBe('Playing');
  expect(t.snap().running).toBe(0);
  return t;
}

describe('PlayerController', () => {
  it('[BD-MOCK-PLAYER-T001] 開始時（シナリオ読込時）は停止', () => {
    const c = new PlayerController(new FakeTransport());
    expect(c.getSnapshot().state).toBe('Idle');
    c.load(SCENARIO);
    expect(c.getSnapshot()).toMatchObject({ state: 'Idle', cursor: 0, total: 3, scenarioId: SCENARIO.id });
  });

  it('[BD-MOCK-PLAYER-T002] 停止で再生すると再生中になり、DBリセット後に先頭ステップを送る', async () => {
    const t = setup({ manual: true });
    expect(t.c.play()).toBe(true);
    expect(t.state()).toBe('Playing');
    await flush();
    expect(t.transport.resets).toEqual([{ fixtures: ['default'], start: 'List' }]);
    expect(t.transport.steps.map((s) => s.index)).toEqual([0]);
  });

  it('[BD-MOCK-PLAYER-T003] 停止で1ステップを押すと、モックをリセットして先頭の手前で一時停止', async () => {
    const t = setup();
    expect(t.c.step()).toBe(true);
    expect(t.state()).toBe('Paused');
    await flush();
    expect(t.transport.resets).toHaveLength(1);
    expect(t.transport.steps).toHaveLength(0);
    expect(t.snap()).toMatchObject({ cursor: 0, busy: false });
  });

  it('[BD-MOCK-PLAYER-T004][BD-MOCK-PLAYER-X010] 再生中に一時停止すると一時停止になり、実行中ステップの終了では状態が変わらない', async () => {
    const t = await toPlaying();
    expect(t.c.pause()).toBe(true);
    expect(t.state()).toBe('Paused');
    t.transport.steps[0].d.resolve(OK('Input'));
    await flush();
    expect(t.state()).toBe('Paused');
    expect(t.snap().cursor).toBe(1);
    expect(t.transport.steps).toHaveLength(1);
    expect(nextState('Paused', 'stepEnd', 'remaining')).toBeNull();
    expect(nextState('Paused', 'stepEnd', 'last')).toBeNull();
    expect(nextState('Paused', 'stepEnd', 'mismatch')).toBeNull();
  });

  it('[BD-MOCK-PLAYER-T005] 再生中にステップ終了（残りあり）なら速度ぶん待って次のステップへ', async () => {
    const t = setup({ speed: 2000, manual: true });
    t.c.play();
    await flush();
    t.transport.steps[0].d.resolve(OK('Input'));
    await flush();
    expect(t.state()).toBe('Playing');
    expect(t.snap().cursor).toBe(1);
    expect(t.timer.speedWaits).toEqual([2000]);
    expect(t.transport.steps).toHaveLength(1);
    await t.timer.advance(1999);
    expect(t.transport.steps).toHaveLength(1);
    await t.timer.advance(1);
    expect(t.transport.steps.map((s) => s.index)).toEqual([0, 1]);
  });

  it('[BD-MOCK-PLAYER-T006] 再生中に最終ステップが終了すると完了', async () => {
    const t = await toDone();
    expect(t.states).toEqual(['Playing', 'Done']);
    expect(t.snap()).toMatchObject({ cursor: 3, total: 3, failure: null, busy: false });
    expect(t.finished).toEqual([{ id: SCENARIO.id, ok: true }]);
  });

  it('[BD-MOCK-PLAYER-T007] 再生中に期待値不一致なら失敗となり、失敗ステップと期待値/実際を保持', async () => {
    const t = await toFailed();
    const f = t.snap().failure!;
    expect(f.index).toBe(1);
    expect(f.event).toBe('次へ');
    expect(f.expectedScreen).toBe('Confirm');
    expect(f.failures).toEqual(NG.failures);
    expect(t.snap().cursor).toBe(1);
    expect(t.finished).toEqual([{ id: SCENARIO.id, ok: false }]);
  });

  it('[BD-MOCK-PLAYER-T007] 応答が10秒ないと「モックが応答しません」で失敗', async () => {
    const t = setup({ manual: true });
    t.c.play();
    await flush();
    await t.timer.advance(9_999);
    expect(t.state()).toBe('Playing');
    await t.timer.advance(1);
    expect(t.state()).toBe('Failed');
    expect(t.snap().failure?.message).toBe(NO_RESPONSE);
  });

  it('[BD-MOCK-PLAYER-T008] 一時停止で再生すると再生中になり続きから実行', async () => {
    const t = await toPaused(1);
    t.transport.manual = true;
    expect(t.c.play()).toBe(true);
    expect(t.state()).toBe('Playing');
    await flush();
    expect(t.transport.resets).toHaveLength(1);
    expect(t.transport.steps.at(-1)!.index).toBe(1);
  });

  it('[BD-MOCK-PLAYER-T009] 一時停止で1ステップ（残りあり）は一時停止のまま1つ進む', async () => {
    const t = await toPaused(0);
    expect(t.c.step()).toBe(true);
    await flush();
    expect(t.state()).toBe('Paused');
    expect(t.snap().cursor).toBe(1);
    expect(t.timer.speedWaits).toEqual([]);
  });

  it('[BD-MOCK-PLAYER-T010] 一時停止で1ステップ（最終）は完了', async () => {
    const t = await toPaused(2);
    t.c.step();
    await flush();
    expect(t.state()).toBe('Done');
    expect(t.snap().cursor).toBe(3);
  });

  it('[BD-MOCK-PLAYER-T011] 一時停止で1ステップ（期待値不一致）は失敗', async () => {
    const t = await toPaused(1);
    t.transport.results = () => NG;
    t.c.step();
    await flush();
    expect(t.state()).toBe('Failed');
    expect(t.snap().failure?.index).toBe(1);
  });

  it('[BD-MOCK-PLAYER-T012] 一時停止で巻き戻すとDBリセット→先頭から待機なしで再実行して一時停止', async () => {
    const t = await toPaused(2);
    const before = t.transport.steps.length;
    t.c.setSpeed(2000);
    expect(t.c.rewind(1)).toBe(true);
    expect(t.state()).toBe('Paused');
    await flush();
    expect(t.transport.resets).toHaveLength(2);
    expect(t.transport.steps.slice(before).map((s) => s.index)).toEqual([0]);
    expect(t.snap()).toMatchObject({ state: 'Paused', cursor: 1, busy: false });
    expect(t.timer.speedWaits).toEqual([]);
  });

  it('[BD-MOCK-PLAYER-T013] 完了で巻き戻すと一時停止', async () => {
    const t = await toDone();
    const before = t.transport.steps.length;
    expect(t.c.rewind(2)).toBe(true);
    await flush();
    expect(t.snap()).toMatchObject({ state: 'Paused', cursor: 2 });
    expect(t.transport.steps.slice(before).map((s) => s.index)).toEqual([0, 1]);
  });

  it('[BD-MOCK-PLAYER-T014] 失敗で巻き戻すと一時停止になり失敗表示が消える', async () => {
    const t = await toFailed();
    t.transport.results = (i) => OK(SCENARIO.steps[i].expect.screen);
    expect(t.c.rewind(1)).toBe(true);
    await flush();
    expect(t.snap()).toMatchObject({ state: 'Paused', cursor: 1, failure: null });
  });

  it('[BD-MOCK-PLAYER-T015] 一時停止でリセットすると停止に戻る', async () => {
    const t = await toPaused(1);
    expect(t.c.reset()).toBe(true);
    expect(t.snap()).toMatchObject({ state: 'Idle', cursor: 0 });
    expect(t.transport.resets).toHaveLength(2);
  });

  it('[BD-MOCK-PLAYER-T016] 完了でリセットすると停止に戻る', async () => {
    const t = await toDone();
    expect(t.c.reset()).toBe(true);
    expect(t.snap()).toMatchObject({ state: 'Idle', cursor: 0 });
  });

  it('[BD-MOCK-PLAYER-T017] 失敗でリセットすると停止に戻り失敗表示が消える', async () => {
    const t = await toFailed();
    expect(t.c.reset()).toBe(true);
    expect(t.snap()).toMatchObject({ state: 'Idle', cursor: 0, failure: null });
  });

  it('[BD-MOCK-PLAYER-X001][BD-MOCK-PLAYER-X003][BD-MOCK-PLAYER-X004] 停止では一時停止・巻き戻し・リセットを無視', () => {
    const t = setup();
    expect(t.c.pause()).toBe(false);
    expect(t.c.rewind(1)).toBe(false);
    expect(t.c.reset()).toBe(false);
    expect(t.state()).toBe('Idle');
    expect(t.transport.resets).toHaveLength(0);
    expect(t.states).toEqual([]);
  });

  it('[BD-MOCK-PLAYER-X002] 停止ではステップ終了を無視（リセット後に遅れて届いた結果）', async () => {
    const t = await toPlaying();
    t.c.pause();
    t.c.reset();
    expect(t.state()).toBe('Idle');
    t.transport.steps[0].d.resolve(OK('Input'));
    await flush();
    expect(t.snap()).toMatchObject({ state: 'Idle', cursor: 0, running: null });
    expect(nextState('Idle', 'stepEnd', 'remaining')).toBeNull();
    expect(nextState('Idle', 'stepEnd', 'last')).toBeNull();
    expect(nextState('Idle', 'stepEnd', 'mismatch')).toBeNull();
  });

  it('[BD-MOCK-PLAYER-X005][BD-MOCK-PLAYER-X006][BD-MOCK-PLAYER-X007][BD-MOCK-PLAYER-X008] 再生中は再生・1ステップ・巻き戻し・リセットを無視', async () => {
    const t = await toPlaying();
    expect(t.c.play()).toBe(false);
    expect(t.c.step()).toBe(false);
    expect(t.c.rewind(0)).toBe(false);
    expect(t.c.reset()).toBe(false);
    expect(t.state()).toBe('Playing');
    expect(t.transport.resets).toHaveLength(1);
    expect(t.transport.steps).toHaveLength(1);
    expect(t.states).toEqual(['Playing']);
  });

  it('[BD-MOCK-PLAYER-X009] 一時停止では一時停止を無視', async () => {
    const t = await toPaused(1);
    expect(t.c.pause()).toBe(false);
    expect(t.snap()).toMatchObject({ state: 'Paused', cursor: 1 });
  });

  it('[BD-MOCK-PLAYER-X011][BD-MOCK-PLAYER-X012][BD-MOCK-PLAYER-X013][BD-MOCK-PLAYER-X014] 完了では再生・1ステップ・一時停止・ステップ終了を無視', async () => {
    const t = await toDone();
    const n = t.transport.steps.length;
    expect(t.c.play()).toBe(false);
    expect(t.c.step()).toBe(false);
    expect(t.c.pause()).toBe(false);
    await flush();
    expect(t.state()).toBe('Done');
    expect(t.transport.steps).toHaveLength(n);
    for (const g of ['remaining', 'last', 'mismatch'] as const) expect(nextState('Done', 'stepEnd', g)).toBeNull();
  });

  it('[BD-MOCK-PLAYER-X015][BD-MOCK-PLAYER-X016][BD-MOCK-PLAYER-X017][BD-MOCK-PLAYER-X018] 失敗では再生・1ステップ・一時停止・ステップ終了を無視', async () => {
    const t = await toFailed();
    const n = t.transport.steps.length;
    expect(t.c.play()).toBe(false);
    expect(t.c.step()).toBe(false);
    expect(t.c.pause()).toBe(false);
    await flush();
    expect(t.state()).toBe('Failed');
    expect(t.transport.steps).toHaveLength(n);
    for (const g of ['remaining', 'last', 'mismatch'] as const) expect(nextState('Failed', 'stepEnd', g)).toBeNull();
  });

  it('速度は状態を変えない設定で、最速は待機しない', async () => {
    const t = setup({ speed: 500 });
    t.c.setSpeed(0);
    expect(t.state()).toBe('Idle');
    t.c.play();
    await flush();
    expect(t.state()).toBe('Done');
    expect(t.timer.speedWaits).toEqual([]);
  });

  it('リセットが応答しないと再生は失敗になる', async () => {
    const t = setup();
    t.transport.hangReset = true;
    t.c.play();
    await t.timer.advance(10_000);
    expect(t.state()).toBe('Failed');
    expect(t.snap().failure).toMatchObject({ index: null, message: NO_RESPONSE });
  });
});

describe('速度とハイライト（設定）', () => {
  it('速度は 0.25×〜4× と最速の 8 段で、待機は 1000ms ÷ 倍率', () => {
    expect(SPEEDS.map((s) => s.label)).toEqual(['0.25×', '0.5×', '0.75×', '1×', '1.5×', '2×', '4×', '最速']);
    expect(SPEEDS.map((s) => s.ms)).toEqual([4000, 2000, 1333, 1000, 667, 500, 250, 0]);
    expect(highlightHoldMs(1000)).toBe(400);
    expect(highlightHoldMs(4000)).toBe(1600);
    expect(highlightHoldMs(0)).toBe(0);
  });

  it('ハイライトをオンにすると再生・1ステップの step に holdMs を付け、巻き戻しの再実行には付けない。状態は変えない', async () => {
    const t = setup({ speed: 0 });
    t.c.setHighlight(true);
    t.c.setSpeed(500);
    expect(t.state()).toBe('Idle');
    t.c.step();
    await flush();
    t.c.step();
    await flush();
    expect(t.transport.steps.at(-1)!.highlight).toEqual({ holdMs: 200 });
    t.c.rewind(1);
    await flush();
    await flush();
    expect(t.transport.steps.at(-1)!.highlight).toBeUndefined();
    t.c.setHighlight(false);
    t.c.step();
    await flush();
    expect(t.transport.steps.at(-1)!.highlight).toBeUndefined();
  });

  it('ハイライト時の応答待ち上限は 10 秒＋保持時間 × 操作数', async () => {
    const t = setup({ speed: 1000, manual: true });
    t.c.setHighlight(true);
    t.c.step();
    await flush();
    t.c.step();
    await flush();
    // step('新規') has a click only → 1 operation × 400ms
    expect(t.timer.waits.at(-1)).toBe(10_400);
  });
});

describe('ライブ表示（LiveTrace）', () => {
  const TRACE = (i: number) => ({ screenBefore: i ? SCENARIO.steps[i - 1].expect.screen : 'List', calls: [{ method: 'GET', path: '/api/x', status: 200, durationMs: 1 }], db: [], expects: [{ kind: 'screen' as const, key: '', expected: SCENARIO.steps[i].expect.screen, actual: SCENARIO.steps[i].expect.screen, ok: true }] });

  it('各ステップを trace: true で送り、結果から TraceStep を作る（screenAfter = screen、error = message）', async () => {
    const t = setup();
    t.transport.results = (i) => (i === 1 ? { ...NG, message: '期待と違います', trace: { ...TRACE(1), expects: [] } } : { ...OK(SCENARIO.steps[i].expect.screen), trace: TRACE(i) });
    t.c.play();
    await flush();
    expect(t.transport.steps.every((s) => s.trace === true)).toBe(true);
    const lt = t.c.liveTrace;
    expect(lt.supported).toBe(true);
    expect(lt.steps.map((s) => [s.index, s.event, s.ok])).toEqual([
      [1, '新規', true],
      [2, '次へ', false],
    ]);
    expect(lt.steps[0]).toMatchObject({ click: '新規', screenBefore: 'List', screenAfter: 'Input', calls: [{ path: '/api/x' }], db: [], expects: [{ kind: 'screen', ok: true }] });
    expect(lt.steps[1]).toMatchObject({ screenAfter: 'Input', error: '期待と違います' });
    expect(lt.steps[1].screenshot).toBeUndefined();
  });

  it('trace の無い結果（古い runtime）なら supported = false。応答なしでは変えない', async () => {
    const t = setup();
    t.c.play();
    await flush();
    expect(t.c.liveTrace.steps).toHaveLength(3);
    expect(t.c.liveTrace.supported).toBe(false);
    expect(t.c.liveTrace.steps[0].db).toBeNull();

    const u = setup({ manual: true });
    u.c.play();
    await flush();
    await u.timer.advance(10_000);
    expect(u.c.liveTrace.steps).toMatchObject([{ index: 1, ok: false, error: NO_RESPONSE }]);
    expect(u.c.liveTrace.supported).toBe(true);
  });

  it('リセット・シナリオの切り替え・巻き戻しで消え、巻き戻しの再実行の結果も同じ index で入る', async () => {
    const t = setup();
    t.transport.results = (i) => ({ ...OK(SCENARIO.steps[i].expect.screen), trace: TRACE(i) });
    t.c.play();
    await flush();
    expect(t.c.liveTrace.steps).toHaveLength(3);
    let notified = 0;
    t.c.liveTrace.subscribe(() => notified++);
    t.c.rewind(2);
    await flush();
    expect(t.c.liveTrace.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(notified).toBeGreaterThan(0);
    t.c.reset();
    expect(t.c.liveTrace.steps).toEqual([]);
    t.c.step();
    await flush();
    t.c.step();
    await flush();
    expect(t.c.liveTrace.steps).toHaveLength(1);
    t.c.load(SCENARIO);
    expect(t.c.liveTrace.getSnapshot()).toEqual({ steps: [], supported: true, draft: false });
  });

  it('リセット後に遅れて届いた結果は記録しない。所要時間はビューアで計る', async () => {
    let now = 0;
    const transport = new FakeTransport();
    transport.manual = true;
    const c = new PlayerController(transport, { timer: new FakeTimer(), speed: 0, now: () => now });
    c.load(SCENARIO);
    c.step();
    await flush();
    c.step();
    await flush();
    now = 25;
    transport.steps[0].d.resolve({ ...OK('Input'), trace: TRACE(0) });
    await flush();
    expect(c.liveTrace.steps).toMatchObject([{ index: 1, durationMs: 25 }]);
    c.step();
    await flush();
    c.reset();
    transport.steps[1].d.resolve({ ...OK('Confirm'), trace: TRACE(1) });
    await flush();
    expect(c.liveTrace.steps).toEqual([]);
  });

  it('clear(true) は編集中のデータの再生（draft）として始める', () => {
    const c = new PlayerController(new FakeTransport());
    c.liveTrace.clear(true);
    expect(c.liveTrace.draft).toBe(true);
    c.liveTrace.clear();
    expect(c.liveTrace.draft).toBe(false);
  });
});

describe('編集中の再生（playDraft・DD-TDEDIT）', () => {
  const DATA = { default: { orders: [{ id: 'A-1', customer: '編集中' }] } };

  it('ddv:reset に data を付けて先頭から再生し、ライブ表示を「編集中」にする。完了は onDraftFinish（played に送らない）', async () => {
    const transport = new FakeTransport();
    const timer = new FakeTimer();
    const finished: string[] = [];
    const drafts: Array<{ id: string; ok: boolean }> = [];
    const c = new PlayerController(transport, { timer, speed: 0, onFinish: (r) => finished.push(r.id), onDraftFinish: (r) => drafts.push({ id: r.id, ok: r.ok }) });
    c.load(SCENARIO);
    expect(c.playDraft(SCENARIO, DATA)).toBe(true);
    expect(c.getSnapshot()).toMatchObject({ state: 'Playing', draft: true });
    expect(c.liveTrace.draft).toBe(true);
    await flush();
    expect(transport.resets).toEqual([{ fixtures: ['default'], start: 'List', data: DATA }]);
    expect(transport.steps.every((s) => s.trace)).toBe(true);
    expect(c.getSnapshot().state).toBe('Done');
    expect(c.liveTrace.draft).toBe(true);
    expect(c.liveTrace.steps).toHaveLength(3);
    expect(drafts).toEqual([{ id: SCENARIO.id, ok: true }]);
    expect(finished).toEqual([]);
  });

  it('失敗も onDraftFinish に渡し、load で通常の再生（data なし・onFinish）に戻る', async () => {
    const transport = new FakeTransport();
    transport.results = (i) => (i === 1 ? NG : OK(SCENARIO.steps[i].expect.screen));
    const finished: boolean[] = [];
    const drafts: Array<{ ok: boolean; keys: string[] }> = [];
    const c = new PlayerController(transport, { timer: new FakeTimer(), speed: 0, onFinish: (r) => finished.push(r.ok), onDraftFinish: (r) => drafts.push({ ok: r.ok, keys: r.failures.map((f) => f.key) }) });
    c.playDraft(SCENARIO, DATA);
    await flush();
    expect(c.getSnapshot()).toMatchObject({ state: 'Failed', draft: true, failure: { index: 1 } });
    expect(drafts).toEqual([{ ok: false, keys: ['screen'] }]);
    c.load(SCENARIO);
    expect(c.getSnapshot().draft).toBe(false);
    expect(c.liveTrace.draft).toBe(false);
    transport.results = (i) => OK(SCENARIO.steps[i].expect.screen);
    c.play();
    await flush();
    expect(transport.resets.at(-1)).toEqual({ fixtures: ['default'], start: 'List' });
    expect(finished).toEqual([true]);
  });
});