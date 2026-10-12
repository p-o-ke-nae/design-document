/**
 * IndexedDB of the Pages edition (pages-viewer.md「IndexedDB」): DB `ddv-pages` v1 with `blobs`・`blobMeta`・`reviews`.
 * `null` when it cannot be opened (private browsing etc.): the cache stays in memory and pending reviews are not kept.
 */

export const HOSTED_DB_NAME = 'ddv-pages';
export const HOSTED_DB_VERSION = 1;

export interface BlobMeta {
  sha: string;
  size: number;
  /** Epoch milliseconds. */
  lastUsedAt: number;
}

/** What `BlobCache` uses of the `blobs`・`blobMeta` stores (an interface so that the cache rules are unit tested). */
export interface BlobDb {
  read(sha: string): Promise<Uint8Array | null>;
  /** `blobs` and `blobMeta` in one transaction. Rejects with the transaction's error (`QuotaExceededError`). */
  write(sha: string, bytes: Uint8Array, lastUsedAt: number): Promise<void>;
  touch(sha: string, lastUsedAt: number): Promise<void>;
  /** Removes from both stores in one transaction. */
  remove(shas: string[]): Promise<void>;
  /** Oldest `lastUsedAt` first. */
  metas(): Promise<BlobMeta[]>;
}

/** What `IdbPendingStore` uses of the `reviews` store. */
export interface ReviewDb {
  get(key: string): Promise<unknown>;
  put(key: string, review: unknown, updatedAt: string): Promise<void>;
}

export function openHostedDb(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<IDBDatabase | null> {
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(HOSTED_DB_NAME, HOSTED_DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'sha' });
      if (!db.objectStoreNames.contains('blobMeta')) db.createObjectStore('blobMeta', { keyPath: 'sha' }).createIndex('lastUsedAt', 'lastUsedAt');
      if (!db.objectStoreNames.contains('reviews')) db.createObjectStore('reviews', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

let shared: Promise<IDBDatabase | null> | null = null;

/** One connection per tab. */
export function hostedDb(): Promise<IDBDatabase | null> {
  return (shared ??= openHostedDb().catch(() => null));
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('aborted', 'AbortError'));
  });

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function idbBlobDb(db: IDBDatabase): BlobDb {
  return {
    async read(sha) {
      const v = (await request(db.transaction('blobs').objectStore('blobs').get(sha))) as { bytes?: ArrayBuffer } | undefined;
      return v?.bytes ? new Uint8Array(v.bytes) : null;
    },
    async write(sha, bytes, lastUsedAt) {
      const tx = db.transaction(['blobs', 'blobMeta'], 'readwrite');
      const buf = bytes.slice().buffer;
      tx.objectStore('blobs').put({ sha, bytes: buf });
      tx.objectStore('blobMeta').put({ sha, size: bytes.byteLength, lastUsedAt } satisfies BlobMeta);
      await done(tx);
    },
    async touch(sha, lastUsedAt) {
      const tx = db.transaction('blobMeta', 'readwrite');
      const store = tx.objectStore('blobMeta');
      const m = (await request(store.get(sha))) as BlobMeta | undefined;
      if (m) store.put({ ...m, lastUsedAt });
      await done(tx);
    },
    async remove(shas) {
      if (!shas.length) return;
      const tx = db.transaction(['blobs', 'blobMeta'], 'readwrite');
      for (const sha of shas) {
        tx.objectStore('blobs').delete(sha);
        tx.objectStore('blobMeta').delete(sha);
      }
      await done(tx);
    },
    async metas() {
      return (await request(db.transaction('blobMeta').objectStore('blobMeta').index('lastUsedAt').getAll())) as BlobMeta[];
    },
  };
}

export function idbReviewDb(db: IDBDatabase): ReviewDb {
  return {
    async get(key) {
      const v = (await request(db.transaction('reviews').objectStore('reviews').get(key))) as { review?: unknown } | undefined;
      return v?.review;
    },
    async put(key, review, updatedAt) {
      const tx = db.transaction('reviews', 'readwrite');
      tx.objectStore('reviews').put({ key, review, updatedAt });
      await done(tx);
    },
  };
}
