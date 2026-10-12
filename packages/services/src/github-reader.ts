import { GitHubError, type GitHubClient } from '@ddv/github';
import { normalizeRepoPath } from './repo-path.ts';
import { BaseRepoReader, listedUnder, notFound, type RepoEntry } from './repo-reader.ts';

/** Blob contents keyed by blob SHA (Pages: IndexedDB `BlobCache`; tests: `MemoryBlobStore`). */
export interface BlobStore {
  /** `null` when absent. */
  get(sha: string): Promise<Uint8Array | null>;
  /** Never throws (a failed write only loses the cache entry). */
  put(sha: string, bytes: Uint8Array): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async get(sha: string): Promise<Uint8Array | null> {
    return this.blobs.get(sha) ?? null;
  }

  async put(sha: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(sha, bytes);
  }
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
  mode: string;
}

interface RawTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  mode: string;
  sha: string;
  size?: number;
}

interface RawTree {
  sha: string;
  tree: RawTreeEntry[];
  truncated?: boolean;
}

/** The tree was truncated even per root (too many files). */
export class TreeTooLargeError extends Error {
  constructor(readonly root: string) {
    super(`tree too large: ${root}`);
    this.name = 'TreeTooLargeError';
  }
}

/** Like the local `walk`: nothing under `node_modules` / `.git` is in the index (other IGNORED_DIRS are only skipped by `listFiles`). */
const ignored = (p: string) => p.split('/').some((s) => s === 'node_modules' || s === '.git');
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Blobs of one commit (`type: blob`, no symlinks, no ignored directories). */
export class TreeIndex {
  constructor(
    readonly sha: string,
    readonly entries: Map<string, TreeEntry>,
  ) {}

  static async load(gh: Pick<GitHubClient, 'rest'>, owner: string, repo: string, sha: string, roots: string[] = []): Promise<TreeIndex> {
    const base = `/repos/${owner}/${repo}/git/trees`;
    const entries = new Map<string, TreeEntry>();
    const add = (prefix: string, list: RawTreeEntry[]) => {
      for (const e of list) {
        const p = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type !== 'blob' || e.mode === '120000' || ignored(p)) continue;
        entries.set(p, { path: p, sha: e.sha, size: e.size ?? 0, mode: e.mode });
      }
    };
    const full = await gh.rest<RawTree>('GET', `${base}/${sha}?recursive=1`);
    if (!full.truncated) {
      add('', full.tree);
      return new TreeIndex(sha, entries);
    }
    for (const root of [...new Set(roots.map((r) => normalizeRepoPath(r)))]) {
      if (!root) throw new TreeTooLargeError('.');
      let treeSha: string | null = sha;
      let walked = '';
      for (const seg of root.split('/')) {
        const level: RawTree = await gh.rest<RawTree>('GET', `${base}/${treeSha}`);
        const next = level.tree.find((e) => e.path === seg && e.type === 'tree');
        walked = walked ? `${walked}/${seg}` : seg;
        if (!next) {
          treeSha = null;
          break;
        }
        treeSha = next.sha;
      }
      if (!treeSha) continue;
      const sub = await gh.rest<RawTree>('GET', `${base}/${treeSha}?recursive=1`);
      if (sub.truncated) throw new TreeTooLargeError(walked);
      add(root, sub.tree);
    }
    return new TreeIndex(sha, entries);
  }
}

export interface GitHubRepoReaderOptions {
  client: Pick<GitHubClient, 'rest'>;
  owner: string;
  repo: string;
  sha: string;
  tree: TreeIndex;
  store: BlobStore;
  /** Whether a PAT is set (with one: Blobs API; without: raw.githubusercontent.com). */
  hasToken: () => boolean | Promise<boolean>;
  /** `owner/repo` of the PR head (fork): raw is retried there once on 404. */
  headRepo?: string;
  /** Roots for `TreeIndex.load` when `truncated` (used by `at`). */
  roots?: string[];
  fetch?: typeof fetch;
  rawBase?: string;
}

const MAX_CONCURRENT = 6;

/** Limits concurrent fetches (shared by `at` readers). */
class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One commit read from GitHub (Trees API → BlobStore → raw / Blobs API). `revision` = commit SHA, `stat().sha` = blob SHA. */
export class GitHubRepoReader extends BaseRepoReader {
  readonly owner: string;
  readonly repo: string;
  readonly sha: string;
  readonly tree: TreeIndex;
  readonly store: BlobStore;
  private readonly inflight: Map<string, Promise<Uint8Array>>;
  private readonly limiter: Limiter;
  private readonly bases = new Map<string, Promise<GitHubRepoReader>>();

  constructor(
    private readonly opts: GitHubRepoReaderOptions,
    shared?: { inflight: Map<string, Promise<Uint8Array>>; limiter: Limiter },
  ) {
    super();
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.sha = opts.sha;
    this.tree = opts.tree;
    this.store = opts.store;
    this.inflight = shared?.inflight ?? new Map();
    this.limiter = shared?.limiter ?? new Limiter();
  }

  get revision(): string {
    return this.sha;
  }

  async listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]> {
    const d = normalizeRepoPath(dir);
    const out: string[] = [];
    for (const p of this.tree.entries.keys()) if (listedUnder(p, d) && (!filter || filter(p))) out.push(p);
    return out.sort();
  }

  async stat(path: string): Promise<RepoEntry | null> {
    const e = this.tree.entries.get(normalizeRepoPath(path));
    return e ? { path: e.path, size: e.size, sha: e.sha } : null;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const p = normalizeRepoPath(path);
    const e = this.tree.entries.get(p);
    if (!e) throw notFound(p);
    return this.blob(e);
  }

  /** Reads the given files into the store (stage 1 of loading). */
  async prefetch(paths: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    await Promise.all(
      paths.map(async (p) => {
        await this.readBinary(p);
        onProgress?.(++done, paths.length);
      }),
    );
  }

  /** Another commit of the same repository sharing the BlobStore (PR base side). */
  at(sha: string): Promise<GitHubRepoReader> {
    if (sha === this.sha) return Promise.resolve(this);
    let p = this.bases.get(sha);
    if (!p) {
      p = TreeIndex.load(this.opts.client, this.owner, this.repo, sha, this.opts.roots).then(
        (tree) => new GitHubRepoReader({ ...this.opts, sha, tree }, { inflight: this.inflight, limiter: this.limiter }),
      );
      this.bases.set(sha, p);
      p.catch(() => this.bases.delete(sha));
    }
    return p;
  }

  private blob(e: TreeEntry): Promise<Uint8Array> {
    let p = this.inflight.get(e.sha);
    if (!p) {
      p = this.load(e).finally(() => this.inflight.delete(e.sha));
      this.inflight.set(e.sha, p);
    }
    return p;
  }

  private async load(e: TreeEntry): Promise<Uint8Array> {
    const cached = await this.store.get(e.sha).catch(() => null);
    if (cached) return cached;
    const bytes = await this.limiter.run(async () => ((await this.opts.hasToken()) ? this.fromApi(e) : this.fromRaw(e)));
    await this.store.put(e.sha, bytes).catch(() => undefined);
    return bytes;
  }

  private async fromApi(e: TreeEntry): Promise<Uint8Array> {
    const r = await this.opts.client.rest<{ content: string; encoding: string }>('GET', `/repos/${this.owner}/${this.repo}/git/blobs/${e.sha}`);
    return r.encoding === 'base64' ? fromBase64(r.content) : new TextEncoder().encode(r.content);
  }

  private async fromRaw(e: TreeEntry): Promise<Uint8Array> {
    const doFetch = this.opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const base = this.opts.rawBase ?? 'https://raw.githubusercontent.com';
    const get = (full: string) =>
      doFetch(`${base}/${full}/${this.sha}/${encodePath(e.path)}`, { credentials: 'omit', referrerPolicy: 'no-referrer' }).catch((err: unknown) => {
        throw new GitHubError('network', 0, err instanceof Error ? err.message : String(err));
      });
    let res = await get(`${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`);
    const head = this.opts.headRepo;
    if (res.status === 404 && head && head.toLowerCase() !== `${this.owner}/${this.repo}`.toLowerCase()) res = await get(head.split('/').map(encodeURIComponent).join('/'));
    if (res.status === 404) throw new GitHubError('notFound', 404, `not found: ${e.path}`);
    if (!res.ok) throw new GitHubError('network', res.status, `raw ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
