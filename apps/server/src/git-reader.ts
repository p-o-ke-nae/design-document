import { BaseRepoReader, listedUnder, normalizeRepoPath, notFound, type RepoEntry } from '@ddv/services';
import type { GitCache } from './git.ts';

interface TreeItem {
  sha: string;
  size: number;
}

/** The part of GitCache a GitRevReader uses (`git`/`repoDir` list the tree; without them only `show` is used). */
export type GitRevSource = Pick<GitCache, 'show'> & Partial<Pick<GitCache, 'git' | 'repoDir'>>;

/** One commit (e.g. the merge base) read with `git show <sha>:<path>` / `git ls-tree -r <sha>`. `revision` = the commit SHA. */
export class GitRevReader extends BaseRepoReader {
  private tree: Promise<Map<string, TreeItem> | null> | null = null;

  constructor(
    private readonly git: GitRevSource,
    readonly owner: string,
    readonly repo: string,
    readonly sha: string,
  ) {
    super();
  }

  get revision(): string {
    return this.sha;
  }

  private files(): Promise<Map<string, TreeItem> | null> {
    if (!this.tree) {
      const { git, repoDir } = this.git;
      this.tree =
        git && repoDir
          ? git
              .call(this.git, [`--git-dir=${repoDir.call(this.git, this.owner, this.repo)}`, '-c', 'core.quotePath=false', 'ls-tree', '-r', '-l', '-z', this.sha])
              .then((out) => {
                const map = new Map<string, TreeItem>();
                for (const rec of out.split('\0')) {
                  const m = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/s.exec(rec);
                  if (m) map.set(m[3], { sha: m[1], size: m[2] === '-' ? 0 : Number(m[2]) });
                }
                return map;
              })
              .catch(() => null)
          : Promise.resolve(null);
    }
    return this.tree;
  }

  async listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]> {
    const d = normalizeRepoPath(dir);
    const tree = await this.files();
    if (!tree) return [];
    return [...tree.keys()].filter((p) => listedUnder(p, d) && (!filter || filter(p))).sort();
  }

  async stat(rel: string): Promise<RepoEntry | null> {
    const p = normalizeRepoPath(rel);
    const tree = await this.files();
    if (tree) {
      const e = tree.get(p);
      return e ? { path: p, sha: e.sha, size: e.size } : null;
    }
    const text = await this.git.show(this.owner, this.repo, this.sha, p);
    return text === null ? null : { path: p };
  }

  async readBinary(rel: string): Promise<Uint8Array> {
    const p = normalizeRepoPath(rel);
    const text = await this.git.show(this.owner, this.repo, this.sha, p);
    if (text === null) throw notFound(p);
    return new TextEncoder().encode(text);
  }

  async readText(rel: string): Promise<string> {
    const p = normalizeRepoPath(rel);
    const text = await this.git.show(this.owner, this.repo, this.sha, p);
    if (text === null) throw notFound(p);
    return text;
  }
}
