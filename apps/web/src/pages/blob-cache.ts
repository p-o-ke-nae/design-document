/**
 * `BlobStore` over IndexedDB (pages-viewer.md「キャッシュ」, DD-PAGESV-EVICT). Never throws: a failed write keeps the blob in memory.
 * The blobs this tab used are pinned (never evicted by this tab).
 */
import type { BlobStore } from '@ddv/services';
import type { BlobDb } from './hosted-db.ts';

export const BLOB_CACHE_LIMIT = 52_428_800;

export interface BlobCacheOptions {
  limitBytes?: number;
  now?: () => number;
}

const isQuota = (e: unknown) => (e as { name?: string } | null)?.name === 'QuotaExceededError';

export class BlobCache implements BlobStore {
  readonly limitBytes: number;
  private readonly now: () => number;
  private readonly db: Promise<BlobDb | null>;
  /** Sizes of the blobs in IndexedDB (loaded from `blobMeta` on first use). */
  private sizes: Map<string, number> | null = null;
  private readonly pinned = new Set<string>();
  private readonly touched = new Set<string>();
  readonly memory = new Map<string, Uint8Array>();

  constructor(db: BlobDb | null | Promise<BlobDb | null>, opts: BlobCacheOptions = {}) {
    this.db = Promise.resolve(db).catch(() => null);
    this.limitBytes = opts.limitBytes ?? BLOB_CACHE_LIMIT;
    this.now = opts.now ?? Date.now;
  }

  get total(): number {
    let t = 0;
    for (const s of this.sizes?.values() ?? []) t += s;
    return t;
  }

  async get(sha: string): Promise<Uint8Array | null> {
    const m = this.memory.get(sha);
    if (m) {
      this.pinned.add(sha);
      return m;
    }
    const db = await this.db;
    if (!db) return null;
    const bytes = await db.read(sha).catch(() => null);
    if (!bytes) return null;
    this.pinned.add(sha);
    if (!this.touched.has(sha)) {
      this.touched.add(sha);
      await db.touch(sha, this.now()).catch(() => undefined);
    }
    return bytes;
  }

  async put(sha: string, bytes: Uint8Array): Promise<void> {
    this.pinned.add(sha);
    if (bytes.byteLength > this.limitBytes) return this.keep(sha, bytes);
    const db = await this.db;
    if (!db) return this.keep(sha, bytes);
    const sizes = await this.loadSizes(db);
    try {
      await db.write(sha, bytes, this.now());
    } catch (e) {
      if (!isQuota(e)) return this.keep(sha, bytes);
      await this.evict(db, this.limitBytes * 0.5);
      try {
        await db.write(sha, bytes, this.now());
      } catch {
        return this.keep(sha, bytes);
      }
    }
    sizes.set(sha, bytes.byteLength);
    this.touched.add(sha);
    if (this.total > this.limitBytes) await this.evict(db, this.limitBytes * 0.8);
  }

  private keep(sha: string, bytes: Uint8Array): void {
    this.memory.set(sha, bytes);
  }

  private async loadSizes(db: BlobDb): Promise<Map<string, number>> {
    if (this.sizes) return this.sizes;
    const metas = await db.metas().catch(() => []);
    this.sizes ??= new Map(metas.map((m) => [m.sha, m.size]));
    return this.sizes;
  }

  /** Oldest `lastUsedAt` first, skipping the pinned ones, until `total <= target` (pinned blobs alone may stay over). */
  private async evict(db: BlobDb, target: number): Promise<void> {
    const sizes = await this.loadSizes(db);
    const metas = await db.metas().catch(() => []);
    const victims: string[] = [];
    let total = this.total;
    for (const m of metas) {
      if (total <= target) break;
      if (this.pinned.has(m.sha)) continue;
      victims.push(m.sha);
      total -= sizes.get(m.sha) ?? m.size;
    }
    if (!victims.length) return;
    try {
      await db.remove(victims);
      for (const v of victims) sizes.delete(v);
    } catch {
      // Left as is: the next put tries again.
    }
  }
}
