import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeJoin, walk } from '@ddv/core/node';
import { BaseRepoReader, normalizeRepoPath, notFound, type RepoEntry, type RepoWriter } from '@ddv/services';

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '');

/** Reads the working folder / PR worktree. `revision` = `worktree:<counter>`; the file watcher calls `invalidate`. Nothing is cached. */
export class FsRepoReader extends BaseRepoReader {
  readonly root: string;
  private counter = 0;

  constructor(root: string) {
    super();
    this.root = path.resolve(root);
  }

  get revision(): string {
    return `worktree:${this.counter}`;
  }

  invalidate(_paths?: string[]): void {
    this.counter++;
  }

  /** Absolute path of a repository-relative path (rejects paths outside the root). */
  abs(rel: string): string {
    return safeJoin(this.root, normalizeRepoPath(rel));
  }

  async listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]> {
    const d = normalizeRepoPath(dir);
    const st = await fs.stat(this.abs(d)).catch(() => null);
    if (!st?.isDirectory()) return [];
    return (await walk(this.root, d, (rel) => !filter || filter(rel))).sort();
  }

  async stat(rel: string): Promise<RepoEntry | null> {
    const p = normalizeRepoPath(rel);
    const st = await fs.stat(this.abs(p)).catch(() => null);
    return st?.isFile() ? { path: p, size: st.size, mtimeMs: st.mtimeMs } : null;
  }

  async readBinary(rel: string): Promise<Uint8Array> {
    const p = normalizeRepoPath(rel);
    try {
      return new Uint8Array(await fs.readFile(this.abs(p)));
    } catch (e) {
      if (isMissing(e)) throw notFound(p);
      throw e;
    }
  }
}

/** Writes files of the working folder through a temp file + rename. */
export class FsRepoWriter implements RepoWriter {
  constructor(private readonly reader: Pick<FsRepoReader, 'abs' | 'invalidate'>) {}

  async writeText(rel: string, text: string): Promise<void> {
    const abs = this.reader.abs(rel);
    const tmp = `${abs}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, abs);
    this.reader.invalidate([normalizeRepoPath(rel)]);
  }
}
