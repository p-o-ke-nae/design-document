import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError, redact, toGitHubError, TokenResolver } from './index.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function userApi(status = 200, login = 'alice') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (status === 200 ? json(200, { login }) : json(status, { message: 'Bad credentials' })));
}

describe('TokenResolver (TOKEN)', () => {
  it('[DD-WSPACE-TOKEN-P001] [DD-WSPACE-TOKEN-T001] [DD-WSPACE-TOKEN-T002] キャッシュがあれば gh も API も呼ばずに返す', async () => {
    const runGh = vi.fn(async () => ({ code: 0, stdout: 'gho_abc\n' }));
    const fetch = userApi();
    const r = new TokenResolver({ runGh, env: {}, fetch });
    await r.resolve();
    const again = await r.resolve();
    expect(again).toMatchObject({ source: 'gh', token: 'gho_abc', login: 'alice' });
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('[DD-WSPACE-TOKEN-P002] [DD-WSPACE-TOKEN-T003] [DD-WSPACE-TOKEN-T004] [DD-WSPACE-TOKEN-T005] [DD-WSPACE-TOKEN-T009] [DD-WSPACE-TOKEN-T011] [DD-WSPACE-TOKEN-T012] gh のトークンが 401 なら none（無効）でキャッシュしない', async () => {
    const runGh = vi.fn(async () => ({ code: 0, stdout: 'gho_bad' }));
    const r = new TokenResolver({ runGh, env: {}, fetch: userApi(401) });
    expect(await r.resolve()).toEqual({ source: 'none', token: '', login: '' });
    expect(await r.status()).toEqual({ source: 'none', login: '', reason: 'invalid' });
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it('[DD-WSPACE-TOKEN-P003] [DD-WSPACE-TOKEN-T013] gh のトークンを GET /user で確かめてキャッシュする', async () => {
    const fetch = userApi(200, 'bob');
    const r = new TokenResolver({ runGh: async () => ({ code: 0, stdout: 'gho_ok\n' }), env: { GITHUB_TOKEN: 'ghp_env' }, fetch });
    expect(await r.status()).toEqual({ source: 'gh', login: 'bob' });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.github.com/user');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer gho_ok');
  });

  it('[DD-WSPACE-TOKEN-P004] [DD-WSPACE-TOKEN-T006] [DD-WSPACE-TOKEN-T007] [DD-WSPACE-TOKEN-T010] gh が失敗し GITHUB_TOKEN が 401 なら none（無効）', async () => {
    const r = new TokenResolver({ runGh: async () => ({ code: 1, stdout: '' }), env: { GITHUB_TOKEN: 'ghp_bad' }, fetch: userApi(401) });
    expect(await r.status()).toEqual({ source: 'none', login: '', reason: 'invalid' });
  });

  it('[DD-WSPACE-TOKEN-P005] gh が無い（null）とき GITHUB_TOKEN を使う', async () => {
    const r = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: ' ghp_env ' }, fetch: userApi(200, 'carol') });
    expect(await r.resolve()).toEqual({ source: 'env', token: 'ghp_env', login: 'carol' });
  });

  it('[DD-WSPACE-TOKEN-P006] [DD-WSPACE-TOKEN-T008] どちらも無ければ none（未設定）で API を呼ばない', async () => {
    const fetch = userApi();
    const r = new TokenResolver({ runGh: async () => ({ code: 0, stdout: '  ' }), env: { GITHUB_TOKEN: '' }, fetch });
    expect(await r.status()).toEqual({ source: 'none', login: '', reason: 'missing' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gitEnv はトークンを extraheader の環境変数だけで渡し、redact で隠せる', async () => {
    const r = new TokenResolver({ runGh: async () => ({ code: 0, stdout: 'gho_secret' }), env: {}, fetch: userApi() });
    const { env, redact: hide } = await r.gitEnv();
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader' });
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from('x-access-token:gho_secret').toString('base64')}`);
    expect(hide(`fatal: ${env.GIT_CONFIG_VALUE_0} gho_secret`)).toBe('fatal: Authorization: Basic *** ***');
  });

  it('status はトークンを含まない', async () => {
    const r = new TokenResolver({ runGh: async () => ({ code: 0, stdout: 'gho_secret' }), env: {}, fetch: userApi() });
    expect(JSON.stringify(await r.status())).not.toContain('gho_secret');
  });
});

describe('toGitHubError (APIERR)', () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it('[DD-WSPACE-APIERR-P001] [DD-WSPACE-APIERR-T001] [DD-WSPACE-APIERR-T002] 2xx は JSON を返す', async () => {
    const tokens = new TokenResolver({ runGh: async () => ({ code: 0, stdout: 't' }), env: {}, fetch: userApi() });
    const c = new GitHubClient(tokens, { fetch: async () => json(200, { number: 12 }) });
    expect(await c.rest('GET', '/repos/o/r/pulls/12')).toEqual({ number: 12 });
  });
  it('[DD-WSPACE-APIERR-P002] [DD-WSPACE-APIERR-T003] 401 は auth', () => {
    expect(toGitHubError({ status: 401, headers: h() }, { message: 'Bad credentials' }).kind).toBe('auth');
  });
  it('[DD-WSPACE-APIERR-P003] [DD-WSPACE-APIERR-T004] [DD-WSPACE-APIERR-T005] 403 で残り 0、または 429 は rateLimit（再開時刻付き）', () => {
    const e = toGitHubError({ status: 403, headers: h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }) }, { message: 'API rate limit exceeded' });
    expect(e.kind).toBe('rateLimit');
    expect(e.resetAt?.getTime()).toBe(1800000000 * 1000);
    expect(toGitHubError({ status: 429, headers: h() }, {}).kind).toBe('rateLimit');
  });
  it('[DD-WSPACE-APIERR-P004] [DD-WSPACE-APIERR-T006] 403 で残りがあれば forbidden', () => {
    expect(toGitHubError({ status: 403, headers: h({ 'x-ratelimit-remaining': '10' }) }, { message: 'Resource not accessible' }).kind).toBe('forbidden');
  });
  it('[DD-WSPACE-APIERR-P005] [DD-WSPACE-APIERR-T007] 404 は notFound', () => {
    expect(toGitHubError({ status: 404, headers: h() }, { message: 'Not Found' }).kind).toBe('notFound');
  });
  it('[DD-WSPACE-APIERR-P006] [DD-WSPACE-APIERR-T008] 422 は validation で errors の message を連結', () => {
    const e = toGitHubError({ status: 422, headers: h() }, { message: 'Unprocessable Entity', errors: [{ message: 'body is empty' }, 'line is outside the diff'] });
    expect(e.kind).toBe('validation');
    expect(e.message).toBe('Unprocessable Entity: body is empty / line is outside the diff');
  });
  it('[DD-WSPACE-APIERR-P007] [DD-WSPACE-APIERR-T009] その他は network。fetch の失敗も network', async () => {
    expect(toGitHubError({ status: 502, headers: h() }, {}).kind).toBe('network');
    const tokens = new TokenResolver({ runGh: async () => ({ code: 0, stdout: 't' }), env: {}, fetch: userApi() });
    const c = new GitHubClient(tokens, { fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(c.rest('GET', '/x')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('GitHubClient', () => {
  const tokensWith = (stdouts: string[]) => {
    const runGh = vi.fn(async () => ({ code: 0, stdout: stdouts.shift() ?? '' }));
    return { runGh, tokens: new TokenResolver({ runGh, env: {}, fetch: userApi() }) };
  };

  it('401 なら invalidate して 1 回だけやり直す', async () => {
    const { runGh, tokens } = tokensWith(['old', 'new']);
    const seen: string[] = [];
    const c = new GitHubClient(tokens, {
      fetch: async (_u, init) => {
        const a = (init?.headers as Record<string, string>).authorization;
        seen.push(a);
        return a === 'Bearer new' ? json(200, { ok: 1 }) : json(401, { message: 'Bad credentials' });
      },
    });
    expect(await c.rest('GET', '/x')).toEqual({ ok: 1 });
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it('やり直しても 401 なら auth', async () => {
    const { tokens } = tokensWith(['a', 'b']);
    const c = new GitHubClient(tokens, { fetch: async () => json(401, { message: 'Bad credentials' }) });
    await expect(c.rest('GET', '/x')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('未認証なら API を呼ばず auth', async () => {
    const fetch = vi.fn();
    const c = new GitHubClient(new TokenResolver({ runGh: async () => null, env: {}, fetch: userApi() }), { fetch });
    await expect(c.rest('GET', '/x')).rejects.toBeInstanceOf(GitHubError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('paginate は Link の next をたどり、上限ページで止まる', async () => {
    const { tokens } = tokensWith(['t']);
    const urls: string[] = [];
    const c = new GitHubClient(tokens, {
      maxPages: 3,
      fetch: async (u) => {
        const url = String(u);
        urls.push(url);
        const n = Number(new URL(url).searchParams.get('page') ?? '1');
        return json(200, [n], { link: `<https://api.github.com/x?page=${n + 1}>; rel="next", <https://api.github.com/x?page=9>; rel="last"` });
      },
    });
    expect(await c.paginate('/x?page=1')).toEqual([1, 2, 3]);
    expect(urls).toHaveLength(3);
  });

  it('graphql の errors は validation', async () => {
    const { tokens } = tokensWith(['t']);
    const c = new GitHubClient(tokens, { fetch: async () => json(200, { errors: [{ message: 'Field x' }] }) });
    await expect(c.graphql('{ x }')).rejects.toMatchObject({ kind: 'validation', message: 'Field x' });
  });

  it('エラーのメッセージに要求のヘッダ（トークン）を含めない', async () => {
    const { tokens } = tokensWith(['gho_secret']);
    const c = new GitHubClient(tokens, { fetch: async () => json(403, { message: 'Must have admin rights' }) });
    const e = await c.rest('GET', '/x').catch((x: Error) => x);
    expect((e as Error).message).not.toContain('gho_secret');
  });
});

describe('redact', () => {
  it('トークンと base64 化した値を *** にする', () => {
    const b64 = Buffer.from('x-access-token:tok').toString('base64');
    expect(redact(`a tok b ${b64} c`, ['tok', undefined])).toBe('a *** b *** c');
  });
});
