import { RepoReadError } from './errors.ts';
import { IGNORED_DIRS, isUnder, normalizeRepoPath } from './repo-path.ts';

export interface RepoEntry {
  /** Normalized repository-relative posix path. */
  path: string;
  /** Blob SHA (GitHub / git readers). */
  sha?: string;
  size?: number;
  /** Modification time (worktree only; others answer undefined = 0). */
  mtimeMs?: number;
}

/** Reads one version of a repository (a working folder or one commit). All paths go through `normalizeRepoPath`. */
export interface RepoReader {
  /** Changes when the content may have changed (cache key for the service results). */
  readonly revision: string;
  /** Files under `dir` (posix, repository-relative, sorted); `[]` when `dir` does not exist. */
  listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]>;
  stat(path: string): Promise<RepoEntry | null>;
  exists(path: string): Promise<boolean>;
  /** UTF-8 text (BOM and line endings kept). Throws `RepoReadError` 404 when missing. */
  readText(path: string): Promise<string>;
  /** `null` when missing or when the path is rejected. */
  tryReadText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<Uint8Array>;
}

export const notFound = (path: string) => new RepoReadError(404, 'not-found', `not found: ${path}`);

/** Whether `file` is listed under `dir` (IGNORED_DIRS below `dir` are skipped, `dir` itself is not checked). */
export function listedUnder(file: string, dir: string): boolean {
  if (!isUnder(file, dir) || file === dir) return false;
  const rest = dir === '' ? file : file.slice(dir.length + 1);
  const segs = rest.split('/');
  return segs.slice(0, -1).every((s) => !IGNORED_DIRS.has(s));
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
export const decodeText = (bytes: Uint8Array) => decoder.decode(bytes);

/** Base for readers that keep the files in a path → bytes source. */
export abstract class BaseRepoReader implements RepoReader {
  abstract readonly revision: string;
  abstract listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]>;
  abstract stat(path: string): Promise<RepoEntry | null>;
  abstract readBinary(path: string): Promise<Uint8Array>;

  async exists(path: string): Promise<boolean> {
    try {
      return (await this.stat(path)) !== null;
    } catch (e) {
      if (e instanceof RepoReadError) return false;
      throw e;
    }
  }

  async readText(path: string): Promise<string> {
    return decodeText(await this.readBinary(path));
  }

  async tryReadText(path: string): Promise<string | null> {
    try {
      return await this.readText(path);
    } catch (e) {
      if (e instanceof RepoReadError) return null;
      throw e;
    }
  }
}

/** In-memory reader for unit tests. `revision` is `memory:<counter>` (bumped by `set` / `delete`). */
export class MemoryRepoReader extends BaseRepoReader {
  private readonly files = new Map<string, Uint8Array>();
  private readonly mtimes = new Map<string, number>();
  private counter = 0;

  constructor(files: Record<string, string | Uint8Array> = {}) {
    super();
    for (const [p, v] of Object.entries(files)) this.put(p, v);
  }

  get revision(): string {
    return `memory:${this.counter}`;
  }

  private put(path: string, content: string | Uint8Array, mtimeMs?: number) {
    const p = normalizeRepoPath(path);
    this.files.set(p, typeof content === 'string' ? new TextEncoder().encode(content) : content);
    if (mtimeMs !== undefined) this.mtimes.set(p, mtimeMs);
  }

  set(path: string, content: string | Uint8Array, mtimeMs?: number): void {
    this.put(path, content, mtimeMs);
    this.counter++;
  }

  delete(path: string): void {
    this.files.delete(normalizeRepoPath(path));
    this.counter++;
  }

  async listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]> {
    const d = normalizeRepoPath(dir);
    return [...this.files.keys()].filter((p) => listedUnder(p, d) && (!filter || filter(p))).sort();
  }

  async stat(path: string): Promise<RepoEntry | null> {
    const p = normalizeRepoPath(path);
    const f = this.files.get(p);
    if (!f) return null;
    const mtimeMs = this.mtimes.get(p);
    return { path: p, size: f.byteLength, ...(mtimeMs !== undefined ? { mtimeMs } : {}) };
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const p = normalizeRepoPath(path);
    const f = this.files.get(p);
    if (!f) throw notFound(p);
    return f;
  }
}

/** Writes files of the working folder (server: `FsRepoWriter`; absent in the Pages edition). */
export interface RepoWriter {
  writeText(path: string, text: string): Promise<void>;
}
