import { describe, expect, it, vi } from 'vitest';
import { followRunEvents, nextFeedState, SseFeed, type EventSourceLike, type FeedInput, type FeedState } from './http.ts';
import type { BackendEvent } from './types.ts';

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  private readonly handlers = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  fire(type: string, data = ''): void {
    if (type === 'hello') this.readyState = 1;
    for (const fn of this.handlers.get(type) ?? []) fn({ data } as MessageEvent);
  }
  /** `error`: `retrying` = the browser reconnects by itself (CONNECTING), otherwise it gave up (CLOSED). */
  fail(retrying: boolean): void {
    this.readyState = retrying ? 0 : 2;
    this.fire('error');
  }
}

function setup() {
  const sources: FakeEventSource[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const onError = vi.fn();
  const feed = new SseFeed('/api/events', {
    open: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    retryMs: 3000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    onError,
  });
  const events: BackendEvent[] = [];
  const last = () => sources[sources.length - 1];
  return { feed, sources, timers, onError, events, last, listen: () => feed.add((e) => events.push(e)) };
}

describe('nextFeedState (DD-SVC-SSEFEED)', () => {
  const ignored: Array<[string, FeedState, FeedInput]> = [
    ['DD-SVC-SSEFEED-X001', 'Stopped', 'hello'],
    ['DD-SVC-SSEFEED-X002', 'Stopped', 'error'],
    ['DD-SVC-SSEFEED-X004', 'Stopped', 'reconnect'],
    ['DD-SVC-SSEFEED-X005', 'Stopped', 'unsubscribeLast'],
    ['DD-SVC-SSEFEED-X006', 'Connecting', 'subscribe'],
    ['DD-SVC-SSEFEED-X008', 'Connecting', 'reconnect'],
    ['DD-SVC-SSEFEED-X009', 'Open', 'subscribe'],
    ['DD-SVC-SSEFEED-X010', 'Open', 'hello'],
    ['DD-SVC-SSEFEED-X011', 'Open', 'reconnect'],
    ['DD-SVC-SSEFEED-X012', 'Retrying', 'subscribe'],
    ['DD-SVC-SSEFEED-X013', 'Retrying', 'hello'],
    ['DD-SVC-SSEFEED-X014', 'Retrying', 'error'],
    ['DD-SVC-SSEFEED-X016', 'Stopped', 'event'],
    ['DD-SVC-SSEFEED-X017', 'Connecting', 'event'],
    ['DD-SVC-SSEFEED-X018', 'Retrying', 'event'],
  ];
  it.each(ignored)('[%s] %s で %s は無視する（null）', (_id, state, input) => {
    expect(nextFeedState(state, input)).toBeNull();
  });
});

describe('SseFeed (DD-SVC-SSEFEED)', () => {
  it('[DD-SVC-SSEFEED-T001] 作った直後は停止で、接続しない', () => {
    const { feed, sources } = setup();
    expect(feed.state).toBe('Stopped');
    expect(sources).toHaveLength(0);
  });

  it('[DD-SVC-SSEFEED-T002] 最初の subscribe で接続中になり、URL に接続する', () => {
    const { feed, sources, listen } = setup();
    listen();
    expect(feed.state).toBe('Connecting');
    expect(sources.map((s) => s.url)).toEqual(['/api/events']);
  });

  it('[DD-SVC-SSEFEED-T003] 初回の hello で受信中になり、resync は配らない', () => {
    const { feed, last, events, listen } = setup();
    listen();
    last().fire('hello', '{}');
    expect(feed.state).toBe('Open');
    expect(events).toEqual([]);
  });

  it('[DD-SVC-SSEFEED-T004] [DD-SVC-SSEFEED-T007] [DD-SVC-SSEFEED-T008] ブラウザの自動再接続（CONNECTING）の後の hello で resync を配る', () => {
    const { feed, sources, last, events, timers, listen } = setup();
    listen();
    last().fire('hello');
    last().fail(true);
    // 受信中 → 再接続待ち → 再接続の開始（同じ EventSource のまま）→ 接続中
    expect(feed.state).toBe('Connecting');
    expect(sources).toHaveLength(1);
    expect(timers).toHaveLength(0);
    last().fire('hello');
    expect(feed.state).toBe('Open');
    expect(events).toEqual([{ type: 'resync' }]);
  });

  it('[DD-SVC-SSEFEED-T005] [DD-SVC-SSEFEED-T008] 接続中の error（ブラウザが諦めた）で再接続待ちになり、待ってから新しく接続する', () => {
    const { feed, sources, last, timers, onError, events, listen } = setup();
    listen();
    const first = last();
    first.fail(false);
    expect(feed.state).toBe('Retrying');
    expect(first.closed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(timers.map((t) => t.ms)).toEqual([3000]);
    timers[0].fn();
    expect(feed.state).toBe('Connecting');
    expect(sources).toHaveLength(2);
    // Never opened before: the first hello is not a reconnection
    last().fire('hello');
    expect(events).toEqual([]);
  });

  it('[DD-SVC-SSEFEED-T007] 受信中の error で再接続待ちになる', () => {
    const { feed, last, listen, onError } = setup();
    listen();
    last().fire('hello');
    last().fail(false);
    expect(feed.state).toBe('Retrying');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('[DD-SVC-SSEFEED-T012] 受信中は change・run・run-end・actions（と local）を配る', () => {
    const { feed, last, events, listen } = setup();
    listen();
    const es = last();
    es.fire('hello');
    es.fire('change', JSON.stringify(['docs/a.md']));
    es.fire('run', JSON.stringify({ id: 'r1', kind: 'test', rerunOf: 'r0', attempt: 1, times: 2 }));
    es.fire('run-end', JSON.stringify({ id: 'r1', kind: 'test' }));
    es.fire('actions', JSON.stringify({ type: 'update', runId: 7 }));
    es.fire('local', JSON.stringify({ root: 'C:/repo', repoName: 'repo', generation: 3 }));
    expect(feed.state).toBe('Open');
    expect(events).toEqual([
      { type: 'change', paths: ['docs/a.md'] },
      { type: 'run', id: 'r1', kind: 'test', rerunOf: 'r0', attempt: 1, times: 2 },
      { type: 'run-end', id: 'r1', kind: 'test' },
      { type: 'actions', data: { type: 'update', runId: 7 } },
      { type: 'local', root: 'C:/repo', repoName: 'repo', generation: 3 },
    ]);
  });

  it('[DD-SVC-SSEFEED-T009] 接続中に最後の購読を解除すると停止し、接続を閉じる', () => {
    const { feed, last, listen } = setup();
    const off = listen();
    off();
    expect(feed.state).toBe('Stopped');
    expect(last().closed).toBe(true);
  });

  it('[DD-SVC-SSEFEED-T010] 受信中に最後の購読を解除すると停止し、次の subscribe の hello は初回として扱う', () => {
    const { feed, sources, last, events, listen } = setup();
    const off = listen();
    last().fire('hello');
    off();
    expect(feed.state).toBe('Stopped');
    expect(sources[0].closed).toBe(true);
    listen();
    expect(sources).toHaveLength(2);
    last().fire('hello');
    expect(events).toEqual([]);
  });

  it('[DD-SVC-SSEFEED-T011] 再接続待ちで最後の購読を解除すると停止し、再接続のタイマーを止める', () => {
    const { feed, sources, last, timers, listen } = setup();
    const off = listen();
    last().fail(false);
    off();
    expect(feed.state).toBe('Stopped');
    expect(timers[0].cleared).toBe(true);
    expect(sources).toHaveLength(1);
  });

  it('[DD-SVC-SSEFEED-X001] [DD-SVC-SSEFEED-X002] [DD-SVC-SSEFEED-X016] 停止の後に閉じた接続から届いたものは無視する', () => {
    const { feed, last, events, onError, listen } = setup();
    const off = listen();
    const es = last();
    es.fire('hello');
    off();
    es.fire('hello');
    es.fire('change', '[]');
    es.fail(false);
    expect(feed.state).toBe('Stopped');
    expect(events).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('[DD-SVC-SSEFEED-X005] 解除を 2 回呼んでも停止のまま（他の購読者は残る）', () => {
    const { feed, events, last, listen } = setup();
    const off = listen();
    const keep = listen();
    off();
    off();
    expect(feed.size).toBe(1);
    expect(feed.state).toBe('Connecting');
    keep();
    keep();
    expect(feed.state).toBe('Stopped');
    expect(last().closed).toBe(true);
    expect(events).toEqual([]);
  });

  it('[DD-SVC-SSEFEED-X006] [DD-SVC-SSEFEED-X009] [DD-SVC-SSEFEED-X012] 2 つ目以降の subscribe は購読者を足すだけ（接続も状態も変えない）', () => {
    const { feed, sources, last, timers, listen } = setup();
    const a: BackendEvent[] = [];
    const b: BackendEvent[] = [];
    feed.add((e) => a.push(e));
    listen();
    expect(feed.state).toBe('Connecting');
    last().fire('hello');
    feed.add((e) => b.push(e));
    expect(feed.state).toBe('Open');
    last().fail(false);
    listen();
    expect(feed.state).toBe('Retrying');
    expect(sources).toHaveLength(1);
    expect(timers).toHaveLength(1);
    expect(feed.size).toBe(4);
    timers[0].fn();
    last().fire('hello');
    last().fire('change', '["x.md"]');
    expect(a).toEqual([{ type: 'resync' }, { type: 'change', paths: ['x.md'] }]);
    expect(b).toEqual(a);
  });

  it('[DD-SVC-SSEFEED-X010] 受信中の hello は無視する（resync を配らない）', () => {
    const { feed, last, events, listen } = setup();
    listen();
    last().fire('hello');
    last().fire('hello');
    expect(feed.state).toBe('Open');
    expect(events).toEqual([]);
  });

  it('[DD-SVC-SSEFEED-X013] [DD-SVC-SSEFEED-X014] [DD-SVC-SSEFEED-X018] 再接続待ちでは hello・error・イベントを無視する', () => {
    const { feed, last, events, onError, timers, listen } = setup();
    listen();
    const es = last();
    es.fire('hello');
    es.fail(false);
    expect(feed.state).toBe('Retrying');
    // The closed connection's late messages
    es.fire('hello');
    es.fail(false);
    es.fire('change', '[]');
    es.fire('actions', '{"type":"update"}');
    expect(feed.state).toBe('Retrying');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('[DD-SVC-SSEFEED-X017] 接続中に届いた change・run・run-end・actions は配らない', () => {
    const { feed, last, events, listen } = setup();
    listen();
    const es = last();
    es.fire('change', '["a.md"]');
    es.fire('run', '{"id":"r1"}');
    es.fire('run-end', '{"id":"r1"}');
    es.fire('actions', '{"type":"update"}');
    expect(feed.state).toBe('Connecting');
    expect(events).toEqual([]);
  });

  it('[DD-SVC-SSEFEED-X004] [DD-SVC-SSEFEED-X008] [DD-SVC-SSEFEED-X011] 再接続の開始は再接続待ちでだけ効く（停止の後のタイマーは接続しない）', () => {
    const { feed, sources, last, timers, listen } = setup();
    const off = listen();
    last().fail(false);
    off();
    timers[0].fn();
    expect(feed.state).toBe('Stopped');
    expect(sources).toHaveLength(1);
  });

  it('購読者の例外は他の購読者への配信を止めない', () => {
    const { feed, last } = setup();
    const got: BackendEvent[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    feed.add(() => {
      throw new Error('boom');
    });
    feed.add((e) => got.push(e));
    last().fire('hello');
    last().fire('change', '[]');
    expect(got).toEqual([{ type: 'change', paths: [] }]);
    err.mockRestore();
  });
});

describe('followRunEvents', () => {
  it('log・実行のイベント・end（status）を渡し、end の後は閉じる', () => {
    let es!: FakeEventSource;
    const log: string[] = [];
    const ev: Array<[string, string]> = [];
    const end = vi.fn();
    followRunEvents('/api/runs/r1/events', { onLog: (l) => log.push(l), onEvent: (n, d) => ev.push([n, d]), onEnd: end }, (url) => (es = new FakeEventSource(url)));
    es.fire('log', 'line 1');
    es.fire('step', '{"id":"s"}');
    es.fire('message', 'x');
    es.fire('end', '{"status":"failed"}');
    es.fire('log', 'late');
    expect(es.url).toBe('/api/runs/r1/events');
    expect(log).toEqual(['line 1']);
    expect(ev).toEqual([
      ['step', '{"id":"s"}'],
      ['message', 'x'],
    ]);
    expect(end).toHaveBeenCalledWith('failed');
    expect(es.closed).toBe(true);
  });

  it('error では status なしで終わり、解除では onEnd を呼ばない', () => {
    let es!: FakeEventSource;
    const end = vi.fn();
    followRunEvents('/u', { onEnd: end }, (url) => (es = new FakeEventSource(url)));
    es.fail(true);
    expect(end).toHaveBeenCalledWith('');
    const end2 = vi.fn();
    const off = followRunEvents('/u', { onEnd: end2 }, (url) => (es = new FakeEventSource(url)));
    off();
    es.fire('end', '{"status":"passed"}');
    expect(end2).not.toHaveBeenCalled();
    expect(es.closed).toBe(true);
  });
});
