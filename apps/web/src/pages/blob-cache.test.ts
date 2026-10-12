import { describe, expect, it } from 'vitest';
import { BLOB_CACHE_LIMIT, BlobCache } from './blob-cache.ts';
import type { BlobDb, BlobMeta } from './hosted-db.ts';

const quota = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });

class FakeDb implements BlobDb {
  blobs = new Map<string, Uint8Array>();
  meta = new Map<string, BlobMeta>();
  writes = 0;
  /** Errors thrown by the next writes (in order). */
  failures: unknown[] = [];
  removed: string[][] = [];
  async read(sha: string) {
    return this.blobs.get(sha) ?? null;
  }
  async write(sha: string, bytes: Uint8Array, lastUsedAt: number) {
    this.writes++;
    const f = this.failures.shift();
    if (f) throw f;
    this.blobs.set(sha, bytes);
    this.meta.set(sha, { sha, size: bytes.byteLength, lastUsedAt });
  }
  async touch(sha: string, lastUsedAt: number) {
    const m = this.meta.get(sha);
    if (m) this.meta.set(sha, { ...m, lastUsedAt });
  }
  async remove(shas: string[]) {
    this.removed.push(shas);
    for (const s of shas) {
      this.blobs.delete(s);
      this.meta.delete(s);
    }
  }
  async metas() {
    return [...this.meta.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }
  seed(sha: string, size: number, lastUsedAt: number) {
    this.blobs.set(sha, new Uint8Array(size));
    this.meta.set(sha, { sha, size, lastUsedAt });
  }
}

const bytes = (n: number) => new Uint8Array(n);

describe('BlobCache.put（DD-PAGESV-EVICT）', () => {
  it('上限は 50 MB', () => {
    expect(BLOB_CACHE_LIMIT).toBe(52_428_800);
  });

  it('[DD-PAGESV-EVICT-P001] [DD-PAGESV-EVICT-T001] [DD-PAGESV-EVICT-T002] 上限を超える blob はメモリにだけ持つ', async () => {
    const db = new FakeDb();
    const c = new BlobCache(db, { limitBytes: 100 });
    await c.put('big', bytes(101));
    expect(db.writes).toBe(0);
    expect(await c.get('big')).toHaveLength(101);
  });

  it('[DD-PAGESV-EVICT-P002] [DD-PAGESV-EVICT-T003] [DD-PAGESV-EVICT-T004] IndexedDB を使えないときはメモリにだけ持つ', async () => {
    const c = new BlobCache(null, { limitBytes: 100 });
    await c.put('a', bytes(10));
    expect(c.memory.has('a')).toBe(true);
    expect(await c.get('a')).toHaveLength(10);
    const rejected = new BlobCache(Promise.reject(new Error('blocked')), { limitBytes: 100 });
    await rejected.put('b', bytes(10));
    expect(rejected.memory.has('b')).toBe(true);
  });

  it('[DD-PAGESV-EVICT-P003] [DD-PAGESV-EVICT-T005] [DD-PAGESV-EVICT-T006] [DD-PAGESV-EVICT-T007] [DD-PAGESV-EVICT-T008] [DD-PAGESV-EVICT-T009] Quota で 50% まで空けて書き直しも失敗したらメモリにだけ持つ', async () => {
    const db = new FakeDb();
    db.seed('old1', 30, 1);
    db.seed('old2', 30, 2);
    db.failures = [quota(), quota()];
    const c = new BlobCache(db, { limitBytes: 100, now: () => 10 });
    await c.put('new', bytes(20));
    expect(db.writes).toBe(2);
    // 60 → 50 以下：古い old1 だけ消す
    expect(db.removed).toEqual([['old1']]);
    expect(c.memory.has('new')).toBe(true);
    expect(c.total).toBe(30);
  });

  it('[DD-PAGESV-EVICT-P004] [DD-PAGESV-EVICT-T010] [DD-PAGESV-EVICT-T012] 書き直しが成功し total が上限以内なら終わり', async () => {
    const db = new FakeDb();
    db.seed('old1', 40, 1);
    db.seed('old2', 30, 2);
    db.failures = [quota()];
    const c = new BlobCache(db, { limitBytes: 100, now: () => 10 });
    await c.put('new', bytes(20));
    expect(db.writes).toBe(2);
    expect(db.removed).toEqual([['old1']]);
    expect(db.blobs.has('new')).toBe(true);
    expect(c.memory.has('new')).toBe(false);
    expect(c.total).toBe(50);
  });

  it('[DD-PAGESV-EVICT-P005] [DD-PAGESV-EVICT-T013] [DD-PAGESV-EVICT-T014] 書き直し後に total が上限を超えるときは 80% まで空ける（pinned は消さない）', async () => {
    const db = new FakeDb();
    db.seed('p1', 60, 1);
    db.seed('p2', 50, 2);
    db.seed('o3', 10, 3);
    db.failures = [quota()];
    const c = new BlobCache(db, { limitBytes: 100, now: () => 10 });
    // p1・p2 はこのタブで使った（pinned）
    await c.get('p1');
    await c.get('p2');
    await c.put('new', bytes(5));
    // 50% 目標：o3 だけ消せる（pinned だけで超えたまま）／80% 目標：消せるものが無い
    expect(db.removed).toEqual([['o3']]);
    expect(db.blobs.has('new')).toBe(true);
    expect(c.total).toBe(115);
  });

  it('[DD-PAGESV-EVICT-P006] [DD-PAGESV-EVICT-T011] Quota でなく total が上限以内なら終わり', async () => {
    const db = new FakeDb();
    db.seed('old', 10, 1);
    const c = new BlobCache(db, { limitBytes: 100, now: () => 5 });
    await c.put('a', bytes(20));
    expect(db.writes).toBe(1);
    expect(db.removed).toEqual([]);
    expect(c.total).toBe(30);
    expect(await c.get('a')).toHaveLength(20);
  });

  it('[DD-PAGESV-EVICT-P007] total が上限を超えたら古い順に 80% まで空ける', async () => {
    const db = new FakeDb();
    db.seed('o1', 40, 1);
    db.seed('o2', 30, 2);
    db.seed('o3', 20, 3);
    const c = new BlobCache(db, { limitBytes: 100, now: () => 10 });
    await c.put('a', bytes(30));
    // 120 → 80 以下：o1 を消して 80
    expect(db.removed).toEqual([['o1']]);
    expect(c.total).toBe(80);
  });

  it('QuotaExceededError 以外の失敗はメモリにだけ持つ・get は lastUsedAt を 1 回だけ更新する', async () => {
    const db = new FakeDb();
    db.failures = [new Error('io')];
    const c = new BlobCache(db, { limitBytes: 100, now: () => 99 });
    await c.put('a', bytes(1));
    expect(db.writes).toBe(1);
    expect(c.memory.has('a')).toBe(true);
    db.seed('b', 1, 1);
    await c.get('b');
    expect(db.meta.get('b')?.lastUsedAt).toBe(99);
    db.meta.set('b', { sha: 'b', size: 1, lastUsedAt: 2 });
    await c.get('b');
    expect(db.meta.get('b')?.lastUsedAt).toBe(2);
  });
});
