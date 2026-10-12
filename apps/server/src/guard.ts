import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export interface GuardOptions {
  /** Port the server listens on (Host must carry it). */
  port: number;
  /** Extra allowed origins, e.g. the vite dev server (DDV_DEV_ORIGIN, comma separated). */
  devOrigins?: string[];
  /** Start token / session cookie check; absent = Host / Origin only (unit tests). */
  auth?: SessionAuth;
  /** The viewer's index.html with the `ddv-auth` marker, returned with 401 for a wrong start token. */
  tokenPage?: () => Promise<string | null>;
}

export type GuardResult = { ok: true } | { ok: false; status: 400 | 403; reason: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostOk(host: string, port: number, devHosts: Set<string>): boolean {
  if (devHosts.has(host.toLowerCase())) return true;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.toLowerCase());
  if (!m) return false;
  const p = m[2] ? Number(m[2]) : 80;
  return LOOPBACK.has(m[1]) && p === port;
}

/** Host / Origin check (GUARD): blocks DNS rebinding and cross-site writes. */
export function checkRequest(req: { method: string; headers: Headers }, opts: GuardOptions): GuardResult {
  const devOrigins = (opts.devOrigins ?? []).map((o) => o.replace(/\/+$/, '').toLowerCase());
  const devHosts = new Set(devOrigins.map((o) => o.replace(/^https?:\/\//, '')));
  const host = req.headers.get('host') ?? '';
  if (!hostOk(host, opts.port, devHosts)) return { ok: false, status: 400, reason: `許可されていない Host です: ${host || '(なし)'}` };
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return { ok: true };
  const origin = req.headers.get('origin');
  if (!origin) {
    const site = req.headers.get('sec-fetch-site');
    return !site || site === 'same-origin' ? { ok: true } : { ok: false, status: 403, reason: '別のサイトからの要求は受け付けません' };
  }
  const o = origin.replace(/\/+$/, '').toLowerCase();
  if (o === `http://${host.toLowerCase()}` || devOrigins.includes(o)) return { ok: true };
  return { ok: false, status: 403, reason: `許可されていない Origin です: ${origin}` };
}

export function devOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.DDV_DEV_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const MAX_SESSIONS = 100;

/** Start token (memory only, hashed) and the session cookies issued for it (AUTH). */
export class SessionAuth {
  readonly cookieName: string;
  private readonly tokenHash: Buffer;
  private readonly sessions = new Set<string>();

  constructor(
    private readonly token: string,
    readonly port: number,
  ) {
    this.cookieName = `ddv-session-${port}`;
    this.tokenHash = sha256(token);
  }

  tokenMatches(given: string): boolean {
    return timingSafeEqual(sha256(given), this.tokenHash);
  }

  /** A new session value (unrelated to the token); the oldest is dropped beyond 100. */
  issue(): string {
    const v = randomBytes(32).toString('base64url');
    this.sessions.add(v);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.values().next().value!);
    return v;
  }

  valid(cookieHeader: string | null | undefined): boolean {
    if (!cookieHeader) return false;
    for (const part of cookieHeader.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === this.cookieName && this.sessions.has(part.slice(i + 1).trim())) return true;
    }
    return false;
  }

  setCookie(value: string): string {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict`;
  }

  /** `<base>/?ddv-token=<token><hash>` */
  startUrl(base: string, hash = ''): string {
    return `${base.replace(/\/+$/, '')}/?ddv-token=${this.token}${hash}`;
  }
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const TOKEN_ENV_MESSAGE = 'DDV_TOKEN は 16〜128 文字の英数字・-・_ で指定してください';
export const TOKEN_ENV_WARNING = '[ddv] 警告: DDV_TOKEN の固定トークンを使います（テスト用）';

export class StartTokenError extends Error {}

/** The start token: `DDV_TOKEN` (tests) or 32 random bytes in base64url (43 characters). */
export function startToken(env: Record<string, string | undefined> = process.env): string {
  const fixed = env.DDV_TOKEN;
  if (fixed !== undefined && fixed !== '') {
    if (!TOKEN_PATTERN.test(fixed)) throw new StartTokenError(TOKEN_ENV_MESSAGE);
    return fixed;
  }
  return randomBytes(32).toString('base64url');
}

export const SESSION_REQUIRED_MESSAGE = 'ddv serve が表示した URL から開いてください';

export type AuthResult =
  | { ok: true; session: boolean }
  | { ok: true; redirect: string; cookie: string }
  | { ok: false; status: 400 | 403 | 401; code: 'bad-host' | 'forbidden-origin' | 'bad-token' | 'session-required'; reason: string };

const PROTECTED = /^\/(api|raw|w)\//;

/** Host / Origin (all methods) / start token / session cookie (AUTH). */
export function authorize(req: { method: string; url: string; headers: Headers }, opts: GuardOptions & { auth: SessionAuth }): AuthResult {
  const base = checkRequest(req, opts);
  if (!base.ok) return { ok: false, status: base.status, code: base.status === 400 ? 'bad-host' : 'forbidden-origin', reason: base.reason };
  const origin = req.headers.get('origin');
  if (origin !== null) {
    const host = (req.headers.get('host') ?? '').toLowerCase();
    const o = origin.replace(/\/+$/, '').toLowerCase();
    const allowed = (opts.devOrigins ?? []).map((d) => d.replace(/\/+$/, '').toLowerCase());
    if (o !== `http://${host}` && !allowed.includes(o)) return { ok: false, status: 403, code: 'forbidden-origin', reason: `許可されていない Origin です: ${origin}` };
  }
  const url = new URL(req.url, 'http://localhost');
  const method = req.method.toUpperCase();
  const token = url.searchParams.get('ddv-token');
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/api/session') && token !== null) {
    if (!opts.auth.tokenMatches(token)) return { ok: false, status: 401, code: 'bad-token', reason: SESSION_REQUIRED_MESSAGE };
    url.searchParams.delete('ddv-token');
    const q = url.searchParams.toString();
    return { ok: true, redirect: `/${q ? `?${q}` : ''}`, cookie: opts.auth.setCookie(opts.auth.issue()) };
  }
  const session = opts.auth.valid(req.headers.get('cookie'));
  if ((method === 'GET' || method === 'HEAD') && !PROTECTED.test(url.pathname)) return { ok: true, session };
  if (session) return { ok: true, session };
  return { ok: false, status: 401, code: 'session-required', reason: SESSION_REQUIRED_MESSAGE };
}

export function guard(opts: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!opts.auth) {
      const r = checkRequest(c.req.raw, opts);
      if (!r.ok) return c.json({ error: r.reason, code: r.status === 400 ? 'bad-host' : 'forbidden-origin' }, r.status);
      await next();
      return;
    }
    const r = authorize(c.req.raw, { ...opts, auth: opts.auth });
    if (!r.ok) {
      if (r.code === 'bad-token' && !PROTECTED.test(c.req.path)) {
        const page = await opts.tokenPage?.();
        if (page !== undefined && page !== null) return c.html(page, 401, { 'cache-control': 'no-store' });
      }
      return c.json({ error: r.reason, code: r.code }, r.status);
    }
    if ('redirect' in r) {
      return new Response(null, {
        status: 302,
        headers: { location: r.redirect, 'set-cookie': r.cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      });
    }
    await next();
  };
}
