import type { MiddlewareHandler } from 'hono';

export interface GuardOptions {
  /** Port the server listens on (Host must carry it). */
  port: number;
  /** Extra allowed origins, e.g. the vite dev server (DDV_DEV_ORIGIN, comma separated). */
  devOrigins?: string[];
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

export function guard(opts: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const r = checkRequest(c.req.raw, opts);
    if (!r.ok) return c.json({ error: r.reason, code: r.status === 400 ? 'bad-host' : 'forbidden-origin' }, r.status);
    await next();
  };
}
