export type GitHubErrorKind = 'auth' | 'forbidden' | 'notFound' | 'validation' | 'rateLimit' | 'network';

export class GitHubError extends Error {
  /** 403: value of `x-accepted-github-permissions` (fine-grained PAT). */
  acceptedPermissions?: string;
  /** 403: value of `x-github-sso` (SSO authorization required). */
  sso?: string;

  constructor(
    readonly kind: GitHubErrorKind,
    readonly status: number,
    message: string,
    readonly resetAt?: Date,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

interface ErrorBody {
  message?: string;
  errors?: ({ message?: string; code?: string; field?: string } | string)[];
}

/** Maps a non-2xx response to a GitHubError (APIERR). Only GitHub's `message` is used, never request headers. */
export function toGitHubError(res: { status: number; headers: Headers }, body: unknown): GitHubError {
  const b = (body && typeof body === 'object' ? body : {}) as ErrorBody;
  const msg = typeof b.message === 'string' && b.message ? b.message : `HTTP ${res.status}`;
  const s = res.status;
  if (s === 401) return new GitHubError('auth', s, `GitHub の認証に失敗しました: ${msg}`);
  if (s === 403 || s === 429) {
    if (s === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
      return new GitHubError('rateLimit', s, `GitHub API の利用上限に達しました${at ? `（${at.toLocaleTimeString()} に再開）` : ''}`, at);
    }
    const e = new GitHubError('forbidden', s, `権限がありません: ${msg}`);
    const accepted = res.headers.get('x-accepted-github-permissions');
    const sso = res.headers.get('x-github-sso');
    if (accepted) e.acceptedPermissions = accepted;
    if (sso) e.sso = sso;
    return e;
  }
  if (s === 404) return new GitHubError('notFound', s, `見つかりません: ${msg}`);
  if (s === 422) {
    const details = (b.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message ?? [e.field, e.code].filter(Boolean).join(' '))).filter(Boolean);
    return new GitHubError('validation', s, details.length ? `${msg}: ${details.join(' / ')}` : msg);
  }
  return new GitHubError('network', s, `GitHub との通信に失敗しました: ${msg}`);
}
