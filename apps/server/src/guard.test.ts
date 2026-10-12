import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { authorize, checkRequest, devOriginsFromEnv, guard, SESSION_REQUIRED_MESSAGE, SessionAuth, StartTokenError, startToken, TOKEN_ENV_MESSAGE } from './guard.ts';

const req = (method: string, headers: Record<string, string>) => ({ method, headers: new Headers(headers) });
const opts = { port: 5178 };

describe('checkRequest (GUARD)', () => {
  it('[DD-WSPACE-GUARD-P001] [DD-WSPACE-GUARD-T001] [DD-WSPACE-GUARD-T002] Host が loopback:port 以外なら 400', () => {
    for (const host of ['evil.example:5178', '127.0.0.1:9999', '', 'localhost']) {
      expect(checkRequest(req('GET', host ? { host } : {}), opts)).toMatchObject({ ok: false, status: 400 });
    }
  });
  it('[DD-WSPACE-GUARD-P002] [DD-WSPACE-GUARD-T003] [DD-WSPACE-GUARD-T004] GET / HEAD は通す', () => {
    for (const host of ['127.0.0.1:5178', 'localhost:5178', '[::1]:5178']) {
      expect(checkRequest(req('GET', { host, origin: 'https://evil.example' }), opts).ok).toBe(true);
    }
    expect(checkRequest(req('HEAD', { host: 'localhost:5178' }), opts).ok).toBe(true);
  });
  it('[DD-WSPACE-GUARD-P003] [DD-WSPACE-GUARD-T005] [DD-WSPACE-GUARD-T006] [DD-WSPACE-GUARD-T007] Origin が無く Sec-Fetch-Site が same-origin か無いなら通す（CLI・テスト）', () => {
    expect(checkRequest(req('POST', { host: '127.0.0.1:5178' }), opts).ok).toBe(true);
    expect(checkRequest(req('POST', { host: '127.0.0.1:5178', 'sec-fetch-site': 'same-origin' }), opts).ok).toBe(true);
  });
  it('[DD-WSPACE-GUARD-P004] [DD-WSPACE-GUARD-T008] Origin が無く Sec-Fetch-Site が cross-site なら 403', () => {
    expect(checkRequest(req('POST', { host: '127.0.0.1:5178', 'sec-fetch-site': 'cross-site' }), opts)).toMatchObject({ ok: false, status: 403 });
  });
  it('[DD-WSPACE-GUARD-P005] [DD-WSPACE-GUARD-T009] [DD-WSPACE-GUARD-T010] Origin が自身の http://Host と一致すれば通す', () => {
    expect(checkRequest(req('DELETE', { host: '127.0.0.1:5178', origin: 'http://127.0.0.1:5178' }), opts).ok).toBe(true);
    expect(checkRequest(req('POST', { host: 'localhost:5173', origin: 'http://localhost:5173' }), { port: 5178, devOrigins: ['http://localhost:5173'] }).ok).toBe(true);
  });
  it('[DD-WSPACE-GUARD-P006] [DD-WSPACE-GUARD-T011] Origin が違えば 403', () => {
    expect(checkRequest(req('POST', { host: '127.0.0.1:5178', origin: 'https://evil.example' }), opts)).toMatchObject({ ok: false, status: 403 });
    expect(checkRequest(req('POST', { host: '127.0.0.1:5178', origin: 'http://localhost:5178' }), opts)).toMatchObject({ ok: false, status: 403 });
  });
  it('DDV_DEV_ORIGIN はカンマ区切り', () => {
    expect(devOriginsFromEnv({ DDV_DEV_ORIGIN: 'http://localhost:5173, http://127.0.0.1:5173' })).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });
  it('middleware は拒否を JSON で返す', async () => {
    const app = new Hono();
    app.use('*', guard(opts));
    app.post('/api/x', (c) => c.json({ ok: true }));
    const bad = await app.request('http://127.0.0.1:5178/api/x', { method: 'POST', headers: { host: '127.0.0.1:5178', origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    const good = await app.request('http://127.0.0.1:5178/api/x', { method: 'POST', headers: { host: '127.0.0.1:5178' } });
    expect(good.status).toBe(200);
  });
});

describe('起動トークンとセッション Cookie（DD-LOCALF-AUTH）', () => {
  const TOKEN = 'test-token-0123456789';
  const HOST = '127.0.0.1:5178';
  const make = () => new SessionAuth(TOKEN, 5178);
  const ar = (auth: SessionAuth, method: string, url: string, headers: Record<string, string> = {}, devOrigins?: string[]) =>
    authorize({ method, url: `http://${HOST}${url}`, headers: new Headers({ host: HOST, ...headers }) }, { port: 5178, auth, devOrigins });
  const login = (auth: SessionAuth) => {
    const r = ar(auth, 'GET', `/?ddv-token=${TOKEN}`);
    if (!('redirect' in r)) throw new Error('no redirect');
    return r.cookie.split(';')[0]!;
  };

  it('[DD-LOCALF-AUTH-P001] [DD-LOCALF-AUTH-T001] [DD-LOCALF-AUTH-T002] Host が違えば 400 bad-host（トークンが正しくても）', () => {
    const auth = make();
    expect(ar(auth, 'GET', `/?ddv-token=${TOKEN}`, { host: 'evil.example:5178' })).toMatchObject({ ok: false, status: 400, code: 'bad-host' });
  });

  it('[DD-LOCALF-AUTH-P002] [DD-LOCALF-AUTH-T003] 変更系で Sec-Fetch-Site が cross-site なら 403 forbidden-origin', () => {
    const auth = make();
    const cookie = login(auth);
    expect(ar(auth, 'POST', '/api/local/open', { cookie, 'sec-fetch-site': 'cross-site' })).toMatchObject({ ok: false, status: 403, code: 'forbidden-origin' });
  });

  it('[DD-LOCALF-AUTH-P003] [DD-LOCALF-AUTH-T004] [DD-LOCALF-AUTH-T005] GET・SSE でも他の Origin（null を含む）は 403、devOrigins は通す', () => {
    const auth = make();
    const cookie = login(auth);
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:9999']) {
      expect(ar(auth, 'GET', '/api/events', { cookie, origin })).toMatchObject({ ok: false, status: 403, code: 'forbidden-origin' });
      expect(ar(auth, 'GET', `/?ddv-token=${TOKEN}`, { origin })).toMatchObject({ ok: false, status: 403 });
    }
    expect(ar(auth, 'GET', '/api/config', { cookie, origin: `http://${HOST}/` })).toEqual({ ok: true, session: true });
    expect(ar(auth, 'GET', '/api/config', { cookie, origin: 'HTTP://LOCALHOST:5173' }, ['http://localhost:5173'])).toEqual({ ok: true, session: true });
  });

  it('[DD-LOCALF-AUTH-P004] [DD-LOCALF-AUTH-T006] [DD-LOCALF-AUTH-T007] [DD-LOCALF-AUTH-T008] 正しいトークンは Cookie を発行して ddv-token を除いた URL へ 302（/api/session も）', () => {
    const auth = make();
    const r = ar(auth, 'GET', `/?a=1&ddv-token=${TOKEN}&b=2`);
    expect(r).toMatchObject({ ok: true, redirect: '/?a=1&b=2' });
    const cookie = (r as { cookie: string }).cookie;
    expect(cookie).toMatch(/^ddv-session-5178=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(cookie).not.toContain(TOKEN);
    expect(auth.valid(cookie.split(';')[0])).toBe(true);
    expect(ar(auth, 'GET', `/api/session?ddv-token=${TOKEN}`)).toMatchObject({ ok: true, redirect: '/' });
    expect(auth.startUrl('http://127.0.0.1:5178/', '#/folder')).toBe(`http://127.0.0.1:5178/?ddv-token=${TOKEN}#/folder`);
  });

  it('[DD-LOCALF-AUTH-P005] [DD-LOCALF-AUTH-T009] 違うトークンは 401 bad-token（長さが違っても）', () => {
    const auth = make();
    for (const t of ['x', `${TOKEN}0`, 'test-token-0123456780', '']) {
      expect(ar(auth, 'GET', `/?ddv-token=${t}`)).toEqual({ ok: false, status: 401, code: 'bad-token', reason: SESSION_REQUIRED_MESSAGE });
    }
  });

  it('[DD-LOCALF-AUTH-P006] [DD-LOCALF-AUTH-T010] [DD-LOCALF-AUTH-T011] /api/ /raw/ /w/ 以外の GET・HEAD は静的ファイルとして通し、session に Cookie の結果を返す', () => {
    const auth = make();
    expect(ar(auth, 'GET', '/')).toEqual({ ok: true, session: false });
    expect(ar(auth, 'HEAD', '/assets/index.js')).toEqual({ ok: true, session: false });
    expect(ar(auth, 'GET', '/folder', { cookie: login(auth) })).toEqual({ ok: true, session: true });
    // A token on other paths is not a start URL.
    expect(ar(auth, 'GET', `/other?ddv-token=${TOKEN}`)).toEqual({ ok: true, session: false });
  });

  it('[DD-LOCALF-AUTH-P007] [DD-LOCALF-AUTH-T012] [DD-LOCALF-AUTH-T013] 有効な Cookie があれば API・raw・変更系を通す', () => {
    const auth = make();
    const cookie = `other=1; ${login(auth)}`;
    for (const [m, u] of [['GET', '/api/config'], ['GET', '/raw/a.md'], ['GET', '/w/x/raw/a.md'], ['POST', '/api/local/open'], ['DELETE', '/api/local/recent']] as const) {
      expect(ar(auth, m, u, { cookie })).toEqual({ ok: true, session: true });
    }
  });

  it('[DD-LOCALF-AUTH-P008] [DD-LOCALF-AUTH-T014] Cookie が無い・知らない値・別のポートの名前なら 401 session-required', () => {
    const auth = make();
    const value = login(auth).split('=')[1];
    for (const cookie of [undefined, 'ddv-session-5178=unknown', `ddv-session-5179=${value}`]) {
      expect(ar(auth, 'GET', '/api/config', cookie ? { cookie } : {})).toEqual({ ok: false, status: 401, code: 'session-required', reason: SESSION_REQUIRED_MESSAGE });
    }
    expect(ar(auth, 'POST', '/', {})).toMatchObject({ ok: false, code: 'session-required' });
    // Another server's sessions are not accepted.
    expect(ar(make(), 'GET', '/api/config', { cookie: `ddv-session-5178=${value}` })).toMatchObject({ ok: false, code: 'session-required' });
  });

  it('[DD-LOCALF-AUTH-P004] セッションは 100 件まで（古いものから消す）', () => {
    const auth = make();
    const first = auth.issue();
    for (let i = 0; i < 100; i++) auth.issue();
    expect(auth.valid(`ddv-session-5178=${first}`)).toBe(false);
  });

  it('[DD-LOCALF-AUTH-P004] startToken は DDV_TOKEN を検査して使い、無ければ 43 文字の乱数', () => {
    expect(startToken({})).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(startToken({})).not.toBe(startToken({}));
    expect(startToken({ DDV_TOKEN: 'ddv-e2e-0123456789abcdef' })).toBe('ddv-e2e-0123456789abcdef');
    for (const bad of ['short', 'has space 0123456789', 'x'.repeat(129)]) expect(() => startToken({ DDV_TOKEN: bad })).toThrow(new StartTokenError(TOKEN_ENV_MESSAGE));
  });

  it('[DD-LOCALF-AUTH-P004] [DD-LOCALF-AUTH-P005] guard は 302・Set-Cookie と、開始 URL の bad-token に案内画面、API の 401 に JSON を返す', async () => {
    const auth = make();
    const app = new Hono();
    app.use('*', guard({ port: 5178, auth, tokenPage: async () => '<html><head><meta name="ddv-auth" content="required"></head></html>' }));
    app.get('*', (c) => c.text('ok'));
    const get = (u: string, headers: Record<string, string> = {}) => app.request(`http://${HOST}${u}`, { headers: { host: HOST, ...headers } });
    const r = await get(`/?ddv-token=${TOKEN}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    expect(await (await get('/api/config', { cookie })).text()).toBe('ok');
    const bad = await get('/?ddv-token=wrong-token-000000');
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain('ddv-auth');
    const api = await get('/api/config');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: SESSION_REQUIRED_MESSAGE, code: 'session-required' });
    expect(await (await get('/api/session?ddv-token=wrong-token-000000')).json()).toMatchObject({ code: 'bad-token' });
  });
});