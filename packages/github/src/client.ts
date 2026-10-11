import { GitHubError, toGitHubError } from './errors.ts';
import type { TokenResolver } from './token.ts';

export interface GitHubClientOptions {
  fetch?: typeof fetch;
  apiBase?: string;
  /** Upper bound for `paginate` (pages of 100). */
  maxPages?: number;
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

/** Thin REST/GraphQL client on `fetch`. A 401 invalidates the token and retries once (APIERR). */
export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  readonly apiBase: string;
  private readonly maxPages: number;

  constructor(
    private readonly tokens: TokenResolver,
    opts: GitHubClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.maxPages = opts.maxPages ?? MAX_PAGES;
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request<T>(method, this.url(path), body)).data;
  }

  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = this.url(path);
    for (let i = 0; url && i < this.maxPages; i++) {
      const r: { data: T[] | T; headers: Headers } = await this.request<T[] | T>('GET', url);
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

  private async request<T>(method: string, url: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    for (let attempt = 0; ; attempt++) {
      const auth = await this.tokens.authorization();
      if (!auth) throw new GitHubError('auth', 401, 'GitHub にログインしてください（gh auth login または GITHUB_TOKEN）');
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: auth,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new GitHubError('network', 0, `GitHub に接続できません: ${(e as Error).message}`);
      }
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      if (!res.ok) throw toGitHubError(res, await res.json().catch(() => ({})));
      const text = await res.text();
      return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
    }
  }
}
