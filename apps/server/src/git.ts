import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

export interface GitAuth {
  gitEnv(): Promise<{ env: Record<string, string>; redact: (s: string) => string }>;
}

export interface NameStatus {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Serializes operations per key (`owner/repo`); different keys run concurrently. */
export class RepoLock {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export interface GitCacheOptions {
  /** Clone URL for a repository (tests point this at a local bare repository). */
  remoteUrl?: (owner: string, repo: string) => string;
  gitBin?: string;
}

/** Bare clones and worktrees under DDV_HOME, driven by the git CLI (no shell, token only via env). */
export class GitCache {
  readonly lock = new RepoLock();
  private readonly remoteUrl: (owner: string, repo: string) => string;
  private readonly gitBin: string;

  constructor(
    readonly home: string,
    private readonly auth: GitAuth,
    opts: GitCacheOptions = {},
  ) {
    this.remoteUrl = opts.remoteUrl ?? ((o, r) => `https://github.com/${o}/${r}.git`);
    this.gitBin = opts.gitBin ?? 'git';
  }

  repoDir(owner: string, repo: string): string {
    return path.join(this.home, 'repos', owner, `${repo}.git`);
  }

  worktreeDir(owner: string, repo: string, name: string): string {
    return path.join(this.home, 'worktrees', owner, repo, name);
  }

  async ensureClone(owner: string, repo: string): Promise<void> {
    await this.lock.run(`${owner}/${repo}`, async () => {
      const dir = this.repoDir(owner, repo);
      if (existsSync(path.join(dir, 'HEAD'))) return;
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await this.git(['clone', '--bare', '--filter=blob:none', '--', this.remoteUrl(owner, repo), dir]);
    });
  }

  async fetch(owner: string, repo: string, refspecs: string[]): Promise<void> {
    await this.lock.run(`${owner}/${repo}`, () => this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'fetch', '--no-tags', 'origin', '--', ...refspecs]));
  }

  async revParse(owner: string, repo: string, ref: string): Promise<string | null> {
    try {
      return (await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  }

  async hasCommit(owner: string, repo: string, sha: string): Promise<boolean> {
    return (await this.revParse(owner, repo, sha)) !== null;
  }

  async addWorktree(owner: string, repo: string, name: string, sha: string): Promise<string> {
    const dir = this.worktreeDir(owner, repo, name);
    await this.lock.run(`${owner}/${repo}`, async () => {
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'worktree', 'prune']);
      await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'worktree', 'add', '--detach', '--', dir, sha]);
    });
    return dir;
  }

  async checkout(owner: string, repo: string, dir: string, sha: string): Promise<void> {
    await this.lock.run(`${owner}/${repo}`, () => this.git(['-C', dir, 'checkout', '--detach', sha]));
  }

  async removeWorktree(owner: string, repo: string, dir: string): Promise<void> {
    await this.lock.run(`${owner}/${repo}`, async () => {
      if (existsSync(this.repoDir(owner, repo))) {
        await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'worktree', 'remove', '--force', '--', dir]).catch(() => undefined);
        await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'worktree', 'prune']).catch(() => undefined);
      }
      await fs.rm(dir, { recursive: true, force: true });
    });
  }

  async listWorktrees(owner: string, repo: string): Promise<string[]> {
    if (!existsSync(this.repoDir(owner, repo))) return [];
    const out = await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'worktree', 'list', '--porcelain']);
    return out
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => path.resolve(l.slice('worktree '.length)))
      .filter((d) => d !== path.resolve(this.repoDir(owner, repo)));
  }

  async mergeBase(owner: string, repo: string, a: string, b: string): Promise<string> {
    return (await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'merge-base', a, b])).trim();
  }

  async show(owner: string, repo: string, sha: string, file: string): Promise<string | null> {
    try {
      return await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'show', `${sha}:${file}`]);
    } catch {
      return null;
    }
  }

  async diff(owner: string, repo: string, a: string, b: string, paths: string[]): Promise<string> {
    return this.git([`--git-dir=${this.repoDir(owner, repo)}`, '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--unified=3', a, b, '--', ...paths]);
  }

  /** Changed files between two commits (renames detected). */
  async nameStatus(owner: string, repo: string, a: string, b: string): Promise<NameStatus[]> {
    const out = await this.git([`--git-dir=${this.repoDir(owner, repo)}`, 'diff', '--no-color', '--name-status', '-M', '-z', a, b]);
    const parts = out.split('\0');
    const files: NameStatus[] = [];
    for (let i = 0; i < parts.length && parts[i]; ) {
      const code = parts[i++];
      const status = code[0];
      if (status === 'R' || status === 'C') {
        const oldPath = parts[i++];
        files.push({ status: 'R', oldPath, path: parts[i++] });
      } else files.push({ status: status === 'A' || status === 'D' ? status : 'M', path: parts[i++] });
    }
    return files;
  }

  /** Runs git with auth env for this command only; output and errors are redacted. */
  async git(args: string[]): Promise<string> {
    const { env, redact } = await this.auth.gitEnv();
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBin, args, { shell: false, windowsHide: true, env: { ...process.env, ...env } });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.stderr.on('data', (d: Buffer) => errChunks.push(d));
      child.on('error', (e) => reject(new GitError(redact(`git を実行できません: ${e.message}`), -1)));
      child.on('close', (code) => {
        const out = Buffer.concat(chunks).toString('utf8');
        const err = Buffer.concat(errChunks).toString('utf8');
        if (code === 0) resolve(redact(out));
        else reject(new GitError(redact(`git ${args.find((a) => !a.startsWith('-') && !path.isAbsolute(a)) ?? ''} に失敗しました: ${err.trim() || `exit ${code}`}`), code ?? 1));
      });
    });
  }
}
