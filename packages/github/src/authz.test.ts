import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, redact, toGitHubError, type TokenProvider } from './browser.ts';

interface Sent {
  url: string;
  init: RequestInit;
}

function stub(status = 200, body: unknown = { ok: 1 }, headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

function provider(token: string | null): TokenProvider & { unauthorizedCalls: number } {
  return {
    unauthorizedCalls: 0,
    async authorization() {
      return token ? `Bearer ${token}` : null;
    },
    unauthorized() {
      this.unauthorizedCalls++;
      return false;
    },
  };
}

const authOf = (s: Sent) => (s.init.headers as Record<string, string>).authorization;

describe('authorizationFor（AUTHZ）', () => {
  it('[DD-PAT-AUTHZ-P001] [DD-PAT-AUTHZ-T001] [DD-PAT-AUTHZ-T002] apiBase と別オリジン・別パスの URL には Authorization を付けない', async () => {
    const { sent, fetchImpl } = stub();
    const c = new GitHubClient(provider('ghp_secret'), { fetch: fetchImpl });
    await c.rest('GET', 'https://raw.githubusercontent.com/o/r/sha/a.md');
    await c.rest('GET', 'https://github.com/o/r');
    await c.rest('GET', 'https://api.github.com.evil.example/repos/o/r');
    expect(sent.map(authOf)).toEqual([undefined, undefined, undefined]);
    const g = stub();
    const ghe = new GitHubClient(provider('ghp_secret'), { fetch: g.fetchImpl, apiBase: 'https://ghe.example/api/v3' });
    await ghe.rest('GET', 'https://ghe.example/other/x');
    await ghe.rest('GET', 'https://ghe.example/api/v3x/x');
    expect(g.sent.map(authOf)).toEqual([undefined, undefined]);
  });

  it('[DD-PAT-AUTHZ-P002] [DD-PAT-AUTHZ-T003] [DD-PAT-AUTHZ-T004] API の URL にはトークンを付け、credentials omit・no-referrer で送る', async () => {
    const { sent, fetchImpl } = stub(200, [], { link: '<https://api.github.com/repos/o/r/pulls?page=2>; rel="next"' });
    const c = new GitHubClient(provider('ghp_secret'), { fetch: fetchImpl, maxPages: 2 });
    await c.rest('GET', '/repos/o/r');
    await c.paginate('/repos/o/r/pulls');
    expect(sent.map(authOf)).toEqual(['Bearer ghp_secret', 'Bearer ghp_secret', 'Bearer ghp_secret']);
    expect(sent[2].url).toBe('https://api.github.com/repos/o/r/pulls?page=2');
    expect(sent[0].init.credentials).toBe('omit');
    expect(sent[0].init.referrerPolicy).toBe('no-referrer');
    const g = stub();
    await new GitHubClient(provider('t'), { fetch: g.fetchImpl, apiBase: 'https://ghe.example/api/v3/' }).rest('GET', '/repos/o/r');
    expect(g.sent[0].url).toBe('https://ghe.example/api/v3/repos/o/r');
    expect(authOf(g.sent[0])).toBe('Bearer t');
  });

  it('[DD-PAT-AUTHZ-P003] [DD-PAT-AUTHZ-T005] [DD-PAT-AUTHZ-T006] トークンが無く anonymous でなければ送らずに auth 401（従来の文言）', async () => {
    const { sent, fetchImpl } = stub();
    const c = new GitHubClient(provider(null), { fetch: fetchImpl });
    const e = (await c.rest('GET', '/repos/o/r').catch((x) => x)) as GitHubError;
    expect(e).toBeInstanceOf(GitHubError);
    expect(e.kind).toBe('auth');
    expect(e.status).toBe(401);
    expect(e.message).toBe('GitHub にログインしてください（gh auth login または GITHUB_TOKEN）');
    expect(sent).toHaveLength(0);
  });

  it('[DD-PAT-AUTHZ-P004] [DD-PAT-AUTHZ-T007] トークンが無く anonymous なら Authorization なしで送る', async () => {
    const { sent, fetchImpl } = stub();
    const c = new GitHubClient(provider(null), { fetch: fetchImpl, anonymous: true });
    expect(await c.rest('GET', '/repos/o/r')).toEqual({ ok: 1 });
    expect(authOf(sent[0])).toBeUndefined();
  });

  it('401 で unauthorized() が false なら取り直さない。Authorization を付けなかった要求の 401 では unauthorized を呼ばない', async () => {
    const { sent, fetchImpl } = stub(401, { message: 'Bad credentials' });
    const p = provider('ghp_x');
    const c = new GitHubClient(p, { fetch: fetchImpl });
    expect(((await c.rest('GET', '/user').catch((x) => x)) as GitHubError).kind).toBe('auth');
    expect(sent).toHaveLength(1);
    expect(p.unauthorizedCalls).toBe(1);
    const a = stub(401, { message: 'Bad credentials' });
    const anon = provider(null);
    await new GitHubClient(anon, { fetch: a.fetchImpl, anonymous: true }).rest('GET', '/user').catch(() => null);
    expect(anon.unauthorizedCalls).toBe(0);
  });

  it('restWithHeaders は data と headers を返す', async () => {
    const { fetchImpl } = stub(200, { id: 1 }, { 'x-oauth-scopes': 'repo, read:org' });
    const r = await new GitHubClient(provider('t'), { fetch: fetchImpl }).restWithHeaders<{ id: number }>('GET', '/repos/o/r');
    expect(r.data).toEqual({ id: 1 });
    expect(r.headers.get('x-oauth-scopes')).toBe('repo, read:org');
  });

  it('403 は acceptedPermissions・sso を持ち message は変えない', () => {
    const e = toGitHubError({ status: 403, headers: new Headers({ 'x-accepted-github-permissions': 'contents=write; pull_requests=write', 'x-github-sso': 'required; url=https://github.com/orgs/o/sso' }) }, { message: 'Resource not accessible' });
    expect(e.kind).toBe('forbidden');
    expect(e.message).toBe('権限がありません: Resource not accessible');
    expect(e.acceptedPermissions).toBe('contents=write; pull_requests=write');
    expect(e.sso).toBe('required; url=https://github.com/orgs/o/sso');
    expect(toGitHubError({ status: 403, headers: new Headers() }, {}).acceptedPermissions).toBeUndefined();
  });

  it('redact は Buffer と同じ base64 形も伏せる（非 ASCII を含む）', () => {
    const t = 'ghp_ÄbcToken';
    const b64 = Buffer.from(`x-access-token:${t}`).toString('base64');
    expect(redact(`a ${t} b ${b64} c ${Buffer.from(t).toString('base64')}`, [t])).toBe('a *** b *** c ***');
  });
});
