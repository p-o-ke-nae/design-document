import { RepoReadError } from './errors.ts';

/** Directories `listFiles` does not descend into (same as `walk` of `@ddv/core/node`). */
export const IGNORED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', '.ddv', 'test-results', 'playwright-report']);

/** A path outside the repository (`RepoReadError` 404, same message as `safeJoin`). */
export class RepoPathError extends RepoReadError {
  constructor(rel: string) {
    super(404, 'not-found', `path escapes repository: ${rel}`);
    this.name = 'RepoPathError';
  }
}

/**
 * Repository-relative posix path (`''` = the root) for `rel`, judged without the OS (DD-SVC-REPOPATH).
 * Accepts the same range as `safeJoin`: `\` → `/`, leading `/` removed, `.` and empty segments dropped, `..` resolved inside the root.
 */
export function normalizeRepoPath(rel: string): string {
  if (rel.includes('\u0000')) throw new RepoPathError(rel);
  const p = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[A-Za-z]:/.test(p)) throw new RepoPathError(rel);
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) throw new RepoPathError(rel);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** Whether normalized `path` is `dir` itself or inside it (`dir` = `''` is the root). */
export function isUnder(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}
