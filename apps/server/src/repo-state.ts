import { execFile } from 'node:child_process';

export interface RepoState {
  commit: string;
  dirty: boolean;
}

/** Runs git with the given args; resolves stdout, rejects on a non-zero exit, a missing git or the timeout. */
export type GitRunner = (args: string[], timeoutMs: number) => Promise<string>;

export const REPO_STATE_TIMEOUT_MS = 5000;

const defaultGit: GitRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** Path of a `git status --porcelain=v1` line (the destination of a rename), unquoted. */
export function porcelainPath(line: string): string {
  let p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  if (arrow >= 0) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, '$1');
  return p;
}

/** Commit and uncommitted-change state of a repository at the start of a run (DD-RUNREC-REPOSTATE). */
export class RepoStateReader {
  constructor(private git: GitRunner = defaultGit) {}

  /** null = unknown (not a git repository, git missing, a command failed or timed out). */
  async read(repoRoot: string): Promise<RepoState | null> {
    let head: string;
    try {
      // --show-prefix: porcelain paths are relative to the top level, so `.ddv/` of a sub-directory repository root is `<prefix>.ddv/`.
      head = await this.git(['-C', repoRoot, 'rev-parse', '--show-prefix', 'HEAD'], REPO_STATE_TIMEOUT_MS);
    } catch {
      return null;
    }
    const lines = head.split(/\r?\n/);
    const commit = lines[1]?.trim() ?? '';
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) return null;
    const prefix = lines[0]?.trim() ?? '';
    let status: string;
    try {
      status = await this.git(['-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=normal'], REPO_STATE_TIMEOUT_MS);
    } catch {
      return null;
    }
    const own = [`${prefix}.ddv/`, '.ddv/'];
    const dirty = status
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .some((l) => {
        const p = porcelainPath(l);
        return !own.some((d) => p.startsWith(d));
      });
    return { commit, dirty };
  }
}
