import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { checkRequest, devOriginsFromEnv, guard } from './guard.ts';

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
