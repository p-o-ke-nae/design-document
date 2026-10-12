import { execFile } from 'node:child_process';

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CiGitLike {
  run(args: string[], opts: GitRunOptions): Promise<GitOutput>;
}

/** Runs git without a shell. Never throws on a non-zero exit (callers inspect `code` and `stderr`); a missing git / timeout is code -1. */
export class CiGit implements CiGitLike {
  run(args: string[], opts: GitRunOptions): Promise<GitOutput> {
    return new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, timeout: opts.timeoutMs ?? 300_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const raw = (err as { code?: unknown } | null)?.code;
          const code = !err ? 0 : typeof raw === 'number' ? raw : -1;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === -1 ? err.message : '') });
        },
      );
    });
  }
}

/** Author / committer of the commits made by the workflow. */
export const BOT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};

/** A push rejected because the remote moved (lease mismatch / non-fast-forward), as opposed to auth / network failures. */
export function isPushRejected(stderr: string): boolean {
  return /stale info|\[rejected\]|fetch first/.test(stderr);
}

/** One-line reason from git's stderr (hints dropped). */
export function gitReason(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^hint:/.test(l))
      .join(' / ')
      .slice(0, 500) || '不明なエラー'
  );
}
