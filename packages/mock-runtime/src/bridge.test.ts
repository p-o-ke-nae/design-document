import { describe, expect, it } from 'vitest';
import type { Step, StepResult } from '@ddv/mock/step';
import { bridgeTransition, HostBridge, validData, validHighlight, SupersededError, type BridgeEngine, type OutMessage } from './bridge.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const step = (screen: string): Step => ({ event: 'x', expect: { screen } });

/** Fake window: embedded in a parent that records posted messages. */
function setup() {
  const posted: OutMessage[] = [];
  const parent = { postMessage: (m: OutMessage) => posted.push(m) };
  const win = { parent, location: { origin: 'http://localhost' }, addEventListener: () => {} } as unknown as Window;
  const boots: Array<ReturnType<typeof deferred<{ screen: string | null }>>> = [];
  const execs: Array<{ step: Step; opts?: { highlight?: { holdMs: number } | null }; d: ReturnType<typeof deferred<StepResult>> }> = [];
  let cancelled = 0;
  const bootArgs: unknown[][] = [];
  const engine: BridgeEngine = {
    version: '9.9.9',
    boot: (...args) => {
      bootArgs.push(args);
      const d = deferred<{ screen: string | null }>();
      boots.push(d);
      return d.promise;
    },
    exec: (s, opts) => {
      const d = deferred<StepResult>();
      execs.push({ step: s, opts, d });
      return d.promise;
    },
    cancel: () => void cancelled++,
    screen: () => 'S',
  };
  const bridge = new HostBridge(win, engine);
  const ok = (screen: string): StepResult => ({ ok: true, screen, failures: [] });
  return { bridge, posted, boots, bootArgs, execs, ok, parent, win, cancelled: () => cancelled };
}

async function ready(t: ReturnType<typeof setup>) {
  const p = t.bridge.start();
  t.boots.at(-1)!.resolve({ screen: 'List' });
  await p;
  expect(t.bridge.state).toBe('Ready');
}

describe('bridgeTransition', () => {
  it('[DD-MOCKRT-BRIDGE-X002] [DD-MOCKRT-BRIDGE-X004] [DD-MOCKRT-BRIDGE-X005] [DD-MOCKRT-BRIDGE-X006] [DD-MOCKRT-BRIDGE-X007] [DD-MOCKRT-BRIDGE-X008] [DD-MOCKRT-BRIDGE-X010] [DD-MOCKRT-BRIDGE-X011] [DD-MOCKRT-BRIDGE-X013] 図にない遷移は状態を変えない', () => {
    expect(bridgeTransition('Booting', 'done')).toBeNull();
    expect(bridgeTransition('Ready', 'loaded')).toBeNull();
    expect(bridgeTransition('Ready', 'failed')).toBeNull();
    expect(bridgeTransition('Ready', 'done')).toBeNull();
    expect(bridgeTransition('Running', 'loaded')).toBeNull();
    expect(bridgeTransition('Running', 'failed')).toBeNull();
    expect(bridgeTransition('Broken', 'loaded')).toBeNull();
    expect(bridgeTransition('Broken', 'failed')).toBeNull();
    expect(bridgeTransition('Broken', 'done')).toBeNull();
    expect(bridgeTransition('Booting', 'step')).toBeNull();
    expect(bridgeTransition('Running', 'step')).toBeNull();
    expect(bridgeTransition('Broken', 'step')).toBeNull();
    expect(bridgeTransition('Booting', 'reset')).toBeNull();
  });
});

describe('HostBridge', () => {
  it('[DD-MOCKRT-BRIDGE-T001] [DD-MOCKRT-BRIDGE-T002] 起動中から読込完了で待機になり ddv:ready を送る', async () => {
    const t = setup();
    expect(t.bridge.state).toBe('Booting');
    const p = t.bridge.start();
    t.boots[0].resolve({ screen: 'List' });
    await expect(p).resolves.toEqual({ screen: 'List' });
    await expect(t.bridge.ready).resolves.toBeUndefined();
    expect(t.bridge.state).toBe('Ready');
    expect(t.posted).toEqual([{ type: 'ddv:ready', screen: 'List', version: '9.9.9' }]);
  });

  it('[DD-MOCKRT-BRIDGE-T003] 読込失敗で異常になり ddv:error を送る', async () => {
    const t = setup();
    const p = t.bridge.start();
    t.boots[0].reject(new Error('api.yaml を読めません'));
    await expect(p).rejects.toThrow('api.yaml');
    await expect(t.bridge.ready).rejects.toThrow('api.yaml');
    expect(t.bridge.state).toBe('Broken');
    expect(t.posted).toEqual([{ type: 'ddv:error', message: 'api.yaml を読めません' }]);
  });

  it('[DD-MOCKRT-BRIDGE-T004] [DD-MOCKRT-BRIDGE-T005] 待機で step を受けると実行中になり、完了で待機に戻って ddv:result を送る', async () => {
    const t = setup();
    await ready(t);
    const p = t.bridge.step(step('Input'), 0);
    expect(t.bridge.state).toBe('Running');
    t.execs[0].d.resolve(t.ok('Input'));
    await expect(p).resolves.toEqual(t.ok('Input'));
    await flush();
    expect(t.bridge.state).toBe('Ready');
    expect(t.posted.at(-1)).toEqual({ type: 'ddv:result', index: 0, ok: true, screen: 'Input', failures: [] });
  });

  it('[DD-MOCKRT-BRIDGE-T006] 待機で reset を受けると起動中になり、読込後に ddv:ready を送る', async () => {
    const t = setup();
    await ready(t);
    const p = t.bridge.reset(['default', 'many'], 'Input');
    expect(t.bridge.state).toBe('Booting');
    t.boots[1].resolve({ screen: 'Input' });
    await expect(p).resolves.toEqual({ screen: 'Input' });
    expect(t.bridge.state).toBe('Ready');
    expect(t.posted.at(-1)).toEqual({ type: 'ddv:ready', screen: 'Input', version: '9.9.9' });
  });

  it('[DD-MOCKRT-BRIDGE-T007] 実行中の reset は実行中のステップを破棄し、その結果を送らない', async () => {
    const t = setup();
    await ready(t);
    const running = t.bridge.step(step('Input'), 0);
    const queued = t.bridge.step(step('Confirm'), 1);
    expect(t.bridge.state).toBe('Running');
    const p = t.bridge.reset([]);
    expect(t.bridge.state).toBe('Booting');
    expect(t.cancelled()).toBe(1);
    expect((await running).ok).toBe(false);
    expect((await queued).error?.message).toContain('破棄');
    t.execs[0].d.resolve(t.ok('Input'));
    t.boots[1].resolve({ screen: 'List' });
    await p;
    await flush();
    expect(t.execs).toHaveLength(1);
    expect(t.posted.filter((m) => m.type === 'ddv:result')).toEqual([]);
    expect(t.bridge.state).toBe('Ready');
  });

  it('[DD-MOCKRT-BRIDGE-T008] 異常で reset を受けると起動中になり、読込できれば待機になる', async () => {
    const t = setup();
    const p0 = t.bridge.start();
    t.boots[0].reject(new Error('NG'));
    await p0.catch(() => {});
    expect(t.bridge.state).toBe('Broken');
    const p = t.bridge.reset(['default']);
    expect(t.bridge.state).toBe('Booting');
    t.boots[1].resolve({ screen: 'List' });
    await p;
    expect(t.bridge.state).toBe('Ready');
  });

  it('[DD-MOCKRT-BRIDGE-X001] 起動中の step は実行せず ok:false を返す', async () => {
    const t = setup();
    void t.bridge.start();
    const r = await t.bridge.step(step('List'), 3);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('起動中');
    expect(t.execs).toHaveLength(0);
    expect(t.bridge.state).toBe('Booting');
    expect(t.posted.at(-1)).toMatchObject({ type: 'ddv:result', index: 3, ok: false });
  });

  it('[DD-MOCKRT-BRIDGE-X012] 異常の step は実行せず ok:false を返す', async () => {
    const t = setup();
    const p0 = t.bridge.start();
    t.boots[0].reject(new Error('NG'));
    await p0.catch(() => {});
    const r = await t.bridge.step(step('List'));
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('読込に失敗');
    expect(t.bridge.state).toBe('Broken');
    expect(t.execs).toHaveLength(0);
  });

  it('[DD-MOCKRT-BRIDGE-X009] 実行中の step は待ち行列に入れて順に実行する', async () => {
    const t = setup();
    await ready(t);
    const a = t.bridge.step(step('Input'), 0);
    const b = t.bridge.step(step('Confirm'), 1);
    expect(t.bridge.state).toBe('Running');
    expect(t.execs).toHaveLength(1);
    t.execs[0].d.resolve(t.ok('Input'));
    await a;
    await flush();
    expect(t.execs).toHaveLength(2);
    expect(t.execs[1].step.expect?.screen).toBe('Confirm');
    expect(t.bridge.state).toBe('Running');
    t.execs[1].d.resolve(t.ok('Confirm'));
    await b;
    await flush();
    expect(t.bridge.state).toBe('Ready');
    expect(t.posted.filter((m) => m.type === 'ddv:result').map((m) => (m as { index: number }).index)).toEqual([0, 1]);
  });

  it('[DD-MOCKRT-BRIDGE-X003] [DD-MOCKRT-BRIDGE-X004] [DD-MOCKRT-BRIDGE-X007] 起動中の reset は起動をやり直し、古い読込完了は無視する', async () => {
    const t = setup();
    const first = t.bridge.start();
    const second = t.bridge.reset(['a']);
    expect(t.bridge.state).toBe('Booting');
    t.boots[1].resolve({ screen: 'Input' });
    await second;
    expect(t.bridge.state).toBe('Ready');
    const running = t.bridge.step(step('Input'));
    expect(t.bridge.state).toBe('Running');
    t.boots[0].resolve({ screen: 'List' });
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    expect(t.bridge.state).toBe('Running');
    expect(t.posted.filter((m) => m.type === 'ddv:ready')).toHaveLength(1);
    t.execs[0].d.resolve(t.ok('Input'));
    await running;
  });

  it('[DD-MOCKRT-BRIDGE-X005] [DD-MOCKRT-BRIDGE-X008] [DD-MOCKRT-BRIDGE-X011] 古い読込失敗は待機・実行中・異常のいずれでも無視する', async () => {
    const t = setup();
    const a = t.bridge.start();
    const b = t.bridge.reset([]);
    t.boots[1].resolve({ screen: 'List' });
    await b;
    t.boots[0].reject(new Error('old'));
    await expect(a).rejects.toBeInstanceOf(SupersededError);
    expect(t.bridge.state).toBe('Ready');

    const c = t.bridge.reset([]);
    const d = t.bridge.reset([]);
    t.boots[3].resolve({ screen: 'List' });
    await d;
    const s = t.bridge.step(step('List'));
    t.boots[2].reject(new Error('old'));
    await c.catch(() => {});
    expect(t.bridge.state).toBe('Running');
    t.execs[0].d.resolve(t.ok('List'));
    await s;

    const e = t.bridge.reset([]);
    const f = t.bridge.reset([]);
    t.boots[5].reject(new Error('new'));
    await f.catch(() => {});
    expect(t.bridge.state).toBe('Broken');
    t.boots[4].reject(new Error('old'));
    await e.catch(() => {});
    expect(t.bridge.state).toBe('Broken');
    expect(t.posted.filter((m) => m.type === 'ddv:error')).toEqual([{ type: 'ddv:error', message: 'new' }]);
  });

  it('[DD-MOCKRT-BRIDGE-X010] 異常で古い読込完了が来ても待機にならない', async () => {
    const t = setup();
    const a = t.bridge.start();
    const b = t.bridge.reset([]);
    t.boots[1].reject(new Error('NG'));
    await b.catch(() => {});
    expect(t.bridge.state).toBe('Broken');
    t.boots[0].resolve({ screen: 'List' });
    await a.catch(() => {});
    expect(t.bridge.state).toBe('Broken');
  });

  it('[DD-MOCKRT-BRIDGE-X002] [DD-MOCKRT-BRIDGE-X006] [DD-MOCKRT-BRIDGE-X013] 破棄したステップの完了は起動中・待機・異常のどこでも無視する', async () => {
    for (const end of ['Booting', 'Ready', 'Broken'] as const) {
      const t = setup();
      await ready(t);
      const s = t.bridge.step(step('Input'), 0);
      const r = t.bridge.reset([]);
      if (end === 'Ready') t.boots[1].resolve({ screen: 'List' });
      if (end === 'Broken') t.boots[1].reject(new Error('NG'));
      if (end !== 'Booting') await r.catch(() => {});
      t.execs[0].d.resolve(t.ok('Input'));
      await s;
      await flush();
      expect(t.bridge.state).toBe(end);
      expect(t.posted.filter((m) => m.type === 'ddv:result')).toEqual([]);
    }
  });

  it('ddv:reset の data（fixtures の内容）を boot に渡す。形の合わない部分は捨てる', async () => {
    const t = setup();
    await ready(t);
    const data = { default: { orders: [{ id: 1 }, 'x'], bad: 1 }, junk: [] };
    t.bridge.onMessage({ origin: 'http://localhost', source: t.parent, data: { type: 'ddv:reset', fixtures: ['default'], start: 'List', data } } as unknown as MessageEvent);
    expect(t.bootArgs.at(-1)).toEqual([['default'], 'List', { default: { orders: [{ id: 1 }] } }]);
    expect(validData(null)).toBeUndefined();
  });

  it('origin と source が親でないメッセージは無視し、親が自分なら送らない', async () => {
    const t = setup();
    await ready(t);
    t.bridge.onMessage({ origin: 'http://evil', source: t.parent, data: { type: 'ddv:reset', fixtures: [] } } as unknown as MessageEvent);
    t.bridge.onMessage({ origin: 'http://localhost', source: {}, data: { type: 'ddv:reset', fixtures: [] } } as unknown as MessageEvent);
    expect(t.boots).toHaveLength(1);
    t.bridge.onMessage({ origin: 'http://localhost', source: t.parent, data: { type: 'ddv:step', index: 4, step: step('List') } } as unknown as MessageEvent);
    expect(t.execs).toHaveLength(1);
    t.execs[0].d.resolve(t.ok('List'));
    await flush();
    expect(t.posted.at(-1)).toMatchObject({ type: 'ddv:result', index: 4, ok: true });
    t.bridge.onMessage({ origin: 'http://localhost', source: t.parent, data: { type: 'ddv:reset', fixtures: ['x'], start: 'Input' } } as unknown as MessageEvent);
    expect(t.boots).toHaveLength(2);

    const self = { location: { origin: 'http://localhost' }, postMessage: () => { throw new Error('should not post'); } } as unknown as Window & { parent: Window };
    (self as { parent: Window }).parent = self;
    const solo = new HostBridge(self, { version: '1', boot: async () => ({ screen: 'A' }), exec: async () => t.ok('A'), cancel() {}, screen: () => 'A' });
    await solo.start();
    expect(solo.state).toBe('Ready');
  });
});

describe('ハイライト指定', () => {
  it('ddv:step の highlight を runtime の exec に渡し、不正な値は無視する', async () => {
    const t = setup();
    await ready(t);
    const msg = (index: number, highlight?: unknown) =>
      t.bridge.onMessage({ origin: 'http://localhost', source: t.parent, data: { type: 'ddv:step', index, step: step('List'), highlight } } as unknown as MessageEvent);
    msg(0, { holdMs: 400 });
    msg(1);
    msg(2, { holdMs: -1 });
    for (let i = 0; i < 3; i++) {
      await flush();
      t.execs[i].d.resolve(t.ok('List'));
    }
    await flush();
    expect(t.execs.map((e) => e.opts?.highlight ?? null)).toEqual([{ holdMs: 400 }, null, null]);
    expect(validHighlight({ holdMs: 99_999 })).toEqual({ holdMs: 10_000 });
    expect(validHighlight({ holdMs: 'x' })).toBeNull();
  });
});
describe('ddv:step の trace（DD-TRREC ライブ表示）', () => {
  function traced() {
    const t = setup();
    const log: string[] = [];
    const engine = (t.bridge as unknown as { engine: BridgeEngine }).engine;
    engine.traceBegin = () => void log.push('begin');
    engine.traceTake = () => {
      log.push('take');
      return { calls: [{ method: 'POST', path: '/api/orders', status: 201, durationMs: 1 }], db: [] };
    };
    engine.observe = async (s) => {
      log.push('observe');
      return [{ kind: 'screen', key: '', expected: s.expect?.screen ?? null, actual: 'S', ok: s.expect?.screen === 'S' }];
    };
    return { ...t, log };
  }

  it('trace: true なら exec の前後で begin・take し、observe の結果と実行前の画面を ddv:result に付ける', async () => {
    const t = traced();
    await ready(t);
    const p = t.bridge.step(step('Confirm'), 3, null, true);
    expect(t.log).toEqual(['begin']);
    t.execs[0].d.resolve({ ok: false, screen: 'S', failures: [], error: { kind: 'expect', message: 'NG' } });
    await p;
    expect(t.log).toEqual(['begin', 'take', 'observe']);
    expect(t.posted.at(-1)).toEqual({
      type: 'ddv:result',
      index: 3,
      ok: false,
      screen: 'S',
      failures: [],
      message: 'NG',
      trace: { screenBefore: 'S', calls: [{ method: 'POST', path: '/api/orders', status: 201, durationMs: 1 }], db: [], expects: [{ kind: 'screen', key: '', expected: 'Confirm', actual: 'S', ok: false }] },
    });
  });

  it('trace なし・記録に対応しない runtime・実行しなかったステップ（起動中）には trace を付けない', async () => {
    const t = traced();
    const booting = await t.bridge.step(step('A'), 1, null, true);
    expect(booting.ok).toBe(false);
    expect(t.posted.at(-1)).not.toHaveProperty('trace');
    await ready(t);
    const p = t.bridge.step(step('A'), 2);
    t.execs[0].d.resolve(t.ok('A'));
    await p;
    expect(t.posted.at(-1)).not.toHaveProperty('trace');
    expect(t.log).toEqual([]);

    const old = setup();
    await ready(old);
    const q = old.bridge.step(step('A'), 1, null, true);
    old.execs[0].d.resolve(old.ok('A'));
    await q;
    expect(old.posted.at(-1)).toMatchObject({ type: 'ddv:result', index: 1, ok: true });
    expect(old.posted.at(-1)).not.toHaveProperty('trace');
  });
});
