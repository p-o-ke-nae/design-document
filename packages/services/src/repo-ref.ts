/** `owner/repo` and branch / tag names (shared by the server's open request and the Pages edition's target check). */

export class RepoRefError extends Error {
  readonly status = 400;
  constructor(
    readonly code: 'repo' | 'ref',
    message: string,
  ) {
    super(message);
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Mirrors `git check-ref-format --branch` plus the extra rules for use in args and paths. */
export function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref === '@') return false;
  if (ref.includes('..') || ref.includes('~') || ref.includes('//') || ref.includes('@{')) return false;
  if (/[\x00-\x20\x7f^:?*[\\<>"|]/.test(ref)) return false;
  return ref.split('/').every((c) => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

export const REPO_MESSAGE = 'owner/repo の形式で入力してください';

/** Validates `owner/repo` (null when invalid). */
export function repoOf(full: unknown): { owner: string; repo: string } | null {
  const repoFull = typeof full === 'string' ? full.trim() : '';
  const [owner, repo, ...rest] = repoFull.split('/');
  if (rest.length || !owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** Validates `owner/repo`; throws `RepoRefError('repo')`. */
export function parseRepo(full: unknown): { owner: string; repo: string } {
  const r = repoOf(full);
  if (!r) throw new RepoRefError('repo', REPO_MESSAGE);
  return r;
}
