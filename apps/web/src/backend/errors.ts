import { GitHubError } from '@ddv/github';
import { ServiceError } from '@ddv/services';
import { formatGitHubError } from '../pages/errors.ts';
import { ApiError, type PatView } from './types.ts';

/** Same as the local server's `host.ts`. */
export const GITHUB_STATUS: Record<GitHubError['kind'], 401 | 403 | 404 | 422 | 429 | 502> = {
  auth: 401,
  forbidden: 403,
  notFound: 404,
  validation: 422,
  rateLimit: 429,
  network: 502,
};

const messageOf = (e: Error, pat: PatView) => (pat.redact ? pat.redact(e.message) : e.message);

/** Exceptions of the service layer → `ApiError` for the Pages edition (DD-SVC-ERRMAP). No side effects. */
export function toApiError(e: unknown, pat: PatView): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ServiceError) return new ApiError(e.message, e.status, e.code || undefined, { error: e.message, ...(e.code ? { code: e.code } : {}), message: e.message, ...e.extra });
  if (!(e instanceof GitHubError)) {
    const message = e instanceof Error ? messageOf(e, pat) : String(e);
    return new ApiError(message, 500, undefined, { error: message });
  }
  const message = formatGitHubError(e, pat);
  const err = (status: number, code: string, extra: Record<string, unknown> = {}) => new ApiError(message, status, code, { error: message, code, message, ...extra });
  switch (e.kind) {
    case 'auth':
      return pat.lastClear === 'invalid' ? err(401, 'pat-invalid') : err(401, 'pat-required');
    case 'notFound':
      return pat.state === 'none' ? err(401, 'pat-required') : err(404, 'github-notFound');
    case 'rateLimit':
      return err(429, 'github-rateLimit', e.resetAt ? { resetAt: e.resetAt.toISOString() } : {});
    default:
      return err(GITHUB_STATUS[e.kind], `github-${e.kind}`);
  }
}