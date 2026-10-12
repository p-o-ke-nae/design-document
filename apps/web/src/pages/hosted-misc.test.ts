import { describe, expect, it } from 'vitest';
import { HeadWatcher, type HeadWatcherEnv } from './head-watcher.ts';
import { IdbPendingStore } from './pending-store.ts';
import { RECENT_KEY, RecentTargets } from './recent-targets.ts';
import type { ReviewDb } from './hosted-db.ts';

class FakeTarget {
  listeners = new Map<string, Set<() => void>>();
  hidden = false;
  addEventListener(t: string, f: () => void) {
    (this.listeners.get(t) ?? this.listeners.set(t, new Set()).get(t)!).add(f);
  }
  removeEventListener(t: string, f: () => void) {
    this.listeners.get(t)?.delete(f);
  }
  fire(t: string) {
    for (const f of this.listeners.get(t) ?? []) f();
  }
}

function fakeEnv() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let id = 0;
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const env: HeadWatcherEnv = {
    now: () => now,
    setTimeout: (fn, ms) => (timers.push({ at: now + ms, fn, id: ++id }), id),
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    window: win,
    document: doc,
  };
  return {
    env,
    win,
    doc,
    timers,
    async advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

describe('HeadWatcher', () => {
  const setup = (token: boolean, fetchHead: () => Promise<string>) => {
    const f = fakeEnv();
    const changed: string[] = [];
    const calls = { n: 0 };
    const w = new HeadWatcher({
      fetchHead: () => (calls.n++, fetchHead()),
      headSha: () => 'a',
      onChanged: (s) => changed.push(s),
      hasToken: () => token,
      env: f.env,
    });
    return { f, w, changed, calls };
  };

  it('PAT ありは 60 秒ごと・PAT なしは 5 分ごとに確かめ、SHA が違えば onChanged', async () => {
    const { f, w, changed, calls } = setup(true, async () => 'b');
    expect(w.intervalMs).toBe(60_000);
    w.start();
    await f.advance(59_999);
    expect(calls.n).toBe(0);
    await f.advance(1);
    expect(calls.n).toBe(1);
    expect(changed).toEqual(['b']);
    expect(setup(false, async () => 'a').w.intervalMs).toBe(300_000);
    w.stop();
    expect(f.timers).toHaveLength(0);
  });

  it('focus は前回から 30 秒（PAT なしは 5 分）以内なら呼ばない', async () => {
    const { f, w, calls } = setup(true, async () => 'a');
    w.start();
    await f.advance(10_000);
    f.win.fire('focus');
    expect(calls.n).toBe(0);
    await f.advance(25_000);
    f.win.fire('focus');
    expect(calls.n).toBe(1);
    const n = setup(false, async () => 'a');
    n.w.start();
    await n.f.advance(200_000);
    n.f.win.fire('focus');
    expect(n.calls.n).toBe(0);
    w.stop();
    n.w.stop();
  });

  it('document.hidden の間は止め、見えたら 1 回確かめる', async () => {
    const { f, w, calls } = setup(true, async () => 'a');
    w.start();
    f.doc.hidden = true;
    await f.advance(60_000);
    expect(calls.n).toBe(0);
    f.doc.hidden = false;
    f.doc.fire('visibilitychange');
    expect(calls.n).toBe(1);
    w.stop();
  });

  it('rateLimit を受けたら resetAt まで止め、その他の失敗は次の間隔で再試行する', async () => {
    let fail: unknown = Object.assign(new Error('rate'), { kind: 'rateLimit', resetAt: new Date(200_000) });
    const { f, w, calls } = setup(true, async () => {
      if (fail) throw fail;
      return 'a';
    });
    w.start();
    await f.advance(60_000);
    expect(calls.n).toBe(1);
    await f.advance(60_000);
    await f.advance(60_000);
    expect(calls.n).toBe(1);
    fail = new Error('network');
    await f.advance(60_000);
    expect(calls.n).toBe(2);
    fail = null;
    await f.advance(60_000);
    expect(calls.n).toBe(3);
    w.stop();
  });
});

describe('RecentTargets', () => {
  const storage = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('新しい順に最大 10 件・同じ対象は先頭に移す・SHA や PAT を入れない', () => {
    const s = storage();
    const r = new RecentTargets(s, undefined, () => new Date('2025-01-01T00:00:00Z'));
    for (let i = 1; i <= 12; i++) r.add({ owner: 'o', repo: 'r', kind: 'pr', pr: i }, `PR ${i}`);
    r.add({ owner: 'o', repo: 'r', kind: 'pr', pr: 5 }, 'again');
    const list = r.list();
    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({ repo: 'o/r', kind: 'pr', pr: 5, label: 'again', openedAt: '2025-01-01T00:00:00.000Z' });
    expect(list.filter((x) => x.pr === 5)).toHaveLength(1);
    expect(list.map((x) => x.pr)).not.toContain(1);
    r.add({ owner: 'o', repo: 'r', kind: 'ref', ref: 'main' }, 'main');
    r.add({ owner: 'o', repo: 'r', kind: 'ref' }, '既定');
    expect(r.list().slice(0, 2)).toMatchObject([{ kind: 'ref', label: '既定' }, { kind: 'ref', ref: 'main' }]);
    expect(Object.keys(r.list()[0]!)).not.toContain('ref');
  });

  it('読めない値は空として扱い次の add で上書きする・allowedOwners に合わないものは除く', () => {
    const s = storage();
    s.m.set(RECENT_KEY, 'not json');
    const r = new RecentTargets(s, ['o']);
    expect(r.list()).toEqual([]);
    s.m.set(RECENT_KEY, JSON.stringify([{ repo: 'o/r', kind: 'x' }]));
    expect(r.list()).toEqual([]);
    r.add({ owner: 'o', repo: 'r', kind: 'pr', pr: 1 }, 'a');
    expect(JSON.parse(s.m.get(RECENT_KEY)!)).toHaveLength(1);
    new RecentTargets(s).add({ owner: 'other', repo: 'r', kind: 'pr', pr: 1 }, 'b');
    expect(r.list().map((x) => x.repo)).toEqual(['o/r']);
    expect(new RecentTargets(null).list()).toEqual([]);
  });
});

describe('IdbPendingStore', () => {
  const memDb = () => {
    const m = new Map<string, { review: unknown; updatedAt: string }>();
    const db: ReviewDb = { get: async (k) => m.get(k)?.review, put: async (k, review, updatedAt) => void m.set(k, { review, updatedAt }) };
    return { m, db };
  };

  it('キー owner/repo#N に書き BroadcastChannel に reviews-changed を送る', async () => {
    const { m, db } = memDb();
    const sent: unknown[] = [];
    const s = new IdbPendingStore(db, { postMessage: (x: unknown) => sent.push(x) }, () => new Date('2025-01-01T00:00:00Z'));
    const review = { headSha: 'h', mergeBase: 'm', comments: [] };
    await s.write('o', 'r', 3, review);
    expect(m.get('o/r#3')).toEqual({ review, updatedAt: '2025-01-01T00:00:00.000Z' });
    expect(sent).toEqual([{ type: 'reviews-changed', key: 'o/r#3' }]);
    expect(await s.read('o', 'r', 3)).toEqual(review);
    expect(s.persistent).toBe(true);
  });

  it('無い・形が違うときは { headSha: "", comments: [] }・IndexedDB が無ければタブの間だけ持つ', async () => {
    const { m, db } = memDb();
    const s = new IdbPendingStore(db);
    expect(await s.read('o', 'r', 1)).toEqual({ headSha: '', comments: [] });
    m.set('o/r#2', { review: { headSha: 5, comments: 'x' }, updatedAt: '' });
    expect(await s.read('o', 'r', 2)).toEqual({ headSha: '', comments: [] });
    const none = new IdbPendingStore(null);
    expect(none.persistent).toBe(false);
    await none.write('o', 'r', 1, { headSha: 'h', comments: [] });
    expect(await none.read('o', 'r', 1)).toEqual({ headSha: 'h', comments: [] });
  });
});
