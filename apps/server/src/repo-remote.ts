import { execFile } from 'node:child_process';
import { parseGitHubRemote, type RepoRef } from '@ddv/services';
import { REPO_STATE_TIMEOUT_MS, type GitRunner } from './repo-state.ts';

export const REMOTE_CACHE_MS = 30_000;

const defaultGit: GitRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** GitHub repository of a local folder from its git remote (actions-run.md「リモートの判定」). Cached for 30 s. */
export class RepoRemote {
  private cache = new Map<string, { at: number; value: RepoRef | null }>();

  constructor(
    private readonly git: GitRunner = defaultGit,
    private readonly now: () => number = Date.now,
  ) {}

  async read(repoRoot: string): Promise<RepoRef | null> {
    const hit = this.cache.get(repoRoot);
    if (hit && this.now() - hit.at < REMOTE_CACHE_MS) return hit.value;
    const value = await this.load(repoRoot);
    this.cache.set(repoRoot, { at: this.now(), value });
    return value;
  }

  private async load(repoRoot: string): Promise<RepoRef | null> {
    try {
      const names = (await this.git(['-C', repoRoot, 'remote'], REPO_STATE_TIMEOUT_MS))
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (names.length === 0) return null;
      const name = names.includes('origin') ? 'origin' : names[0]!;
      const url = (await this.git(['-C', repoRoot, 'remote', 'get-url', name], REPO_STATE_TIMEOUT_MS)).trim();
      return parseGitHubRemote(url);
    } catch {
      return null;
    }
  }
}
