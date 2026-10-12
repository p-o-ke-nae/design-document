import { GitHubError, toGitHubError } from './errors.ts';
import type { TokenProvider } from './provider.ts';

export interface GitHubClientOptions {
  fetch?: typeof fetch;
  apiBase?: string;
  /** Upper bound for `paginate` (pages of 100). */
  maxPages?: number;
  /** Send requests without Authorization when no token is available (Pages edition). */
  anonymous?: boolean;
}

export interface RestResult<T> {
  data: T;
  headers: Headers;
}

export const MAX_PAGES = 20;

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** Thin REST/GraphQL client on `fetch`. A 401 asks the TokenProvider whether to retry once (APIERR). */
export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  readonly apiBase: string;
  private readonly maxPages: number;
  private readonly anonymous: boolean;

  constructor(
    private readonly tokens: TokenProvider,
    opts: GitHubClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.maxPages = opts.maxPages ?? MAX_PAGES;
    this.anonymous = opts.anonymous ?? false;
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request<T>(method, this.url(path), body)).data;
  }

  /** Like `rest` but also returns the response headers (x-oauth-scopes, x-ratelimit-*). */
  restWithHeaders<T>(method: string, path: string, body?: unknown): Promise<RestResult<T>> {
    return this.request<T>(method, this.url(path), body);
  }

  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = this.url(path);
    for (let i = 0; url && i < this.maxPages; i++) {
      const r: RestResult<T[] | T> = await this.request<T[] | T>('GET', url);
      if (Array.isArray(r.data)) out.push(...r.data);
      url = nextLink(r.headers.get('link'));
    }
    return out;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await this.rest<{ data?: T; errors?: { message: string }[] }>('POST', '/graphql', { query, variables });
    if (r.errors?.length) throw new GitHubError('validation', 200, r.errors.map((e) => e.message).join(' / '));
    return r.data as T;
  }

  private url(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${this.apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private isApiUrl(url: string): boolean {
    let u: URL;
    let base: URL;
    try {
      u = new URL(url);
      base = new URL(this.apiBase);
    } catch {
      return false;
    }
    if (u.origin !== base.origin) return false;
    const prefix = base.pathname.replace(/\/+$/, '');
    return !prefix || u.pathname === prefix || u.pathname.startsWith(prefix + '/');
  }

  /** Authorization for one request (AUTHZ): only for the API origin; null = send without it. */
  private async authorizationFor(url: string): Promise<string | null> {
    if (!this.isApiUrl(url)) return null;
    const auth = await this.tokens.authorization();
    if (auth) return auth;
    if (this.anonymous) return null;
    throw new GitHubError('auth', 401, 'GitHub にログインしてください（gh auth login または GITHUB_TOKEN）');
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<RestResult<T>> {
    for (let attempt = 0; ; attempt++) {
      const auth = await this.authorizationFor(url);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            ...(auth ? { authorization: auth } : {}),
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
      } catch (e) {
        throw new GitHubError('network', 0, `GitHub に接続できません: ${(e as Error).message}`);
      }
      if (res.status === 401 && auth && attempt === 0 && this.tokens.unauthorized()) continue;
      if (!res.ok) throw toGitHubError(res, await res.json().catch(() => ({})));
      const text = await res.text();
      return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
    }
  }
}
