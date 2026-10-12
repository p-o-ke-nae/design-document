import type { HostedFiles, HostInfo } from './host.ts';
import type { ApiRouter } from './router.ts';
import type { RawCall } from './trace-tap.ts';

type FetchFn = typeof fetch;

/** Where a request goes (DD-MOCKSB VFETCH for srcdoc; embedded / standalone: api or original as in Phase 5). */
export type Route = { kind: 'original' } | { kind: 'api'; prefix: string } | { kind: 'file'; rel: string; text: string } | { kind: 'status'; status: 404 | 405 };

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

export const contentTypeOf = (path: string) => CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'text/plain; charset=utf-8';

/** Replaces `window.fetch`; requests under `base` (same origin) go to the router, others to the original fetch. */
export class FetchInterceptor {
  private original: FetchFn | null = null;
  private raw: FetchFn | null = null;
  private prefix: string | null = null;
  /** Called with each request answered by the router (TraceTap.record). */
  onCall: ((call: RawCall) => void) | null = null;

  constructor(
    private readonly win: Window & typeof globalThis,
    private readonly host?: HostInfo,
    private readonly files?: HostedFiles,
  ) {}

  private get srcdoc(): boolean {
    return this.host?.mode === 'srcdoc' && !!this.host.virtualBase;
  }

  /** URL the request's relative URLs are resolved against. */
  private get baseUrl(): string {
    return this.srcdoc ? this.host!.virtualBase! : this.win.location.href;
  }

  /** The fetch before install (bound to the window). */
  get originalFetch(): FetchFn {
    return this.original ?? this.win.fetch.bind(this.win);
  }

  /** Resolves a request URL (relative to the page) to its absolute form. */
  resolve(input: string): URL {
    return new URL(input, this.baseUrl);
  }

  route(url: URL, method: string): Route {
    const prefix = this.prefix ?? '';
    const origin = this.srcdoc ? new URL(this.host!.virtualBase!).origin : this.win.location.origin;
    if (url.origin !== origin) return { kind: 'original' };
    if (this.prefix !== null && (prefix === '' || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return { kind: 'api', prefix };
    if (!this.srcdoc) return { kind: 'original' };
    if (method !== 'GET' && method !== 'HEAD') return { kind: 'status', status: 405 };
    const dir = new URL(this.host!.virtualBase!).pathname;
    const rel = url.pathname.startsWith(dir) ? safeDecode(url.pathname.slice(dir.length)) : null;
    const text = rel === null ? undefined : this.files?.get(rel);
    return text === undefined || rel === null ? { kind: 'status', status: 404 } : { kind: 'file', rel, text };
  }

  install(router: ApiRouter, base: string): void {
    this.uninstall();
    this.raw = this.win.fetch;
    const original = this.win.fetch.bind(this.win);
    this.original = original;
    const win = this.win;
    this.prefix = base === '/' ? '' : base;
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = typeof input === 'object' && 'url' in input && !(input instanceof URL) ? (input as Request) : null;
      const url = this.resolve(req ? req.url : String(input));
      const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
      const r = this.route(url, method);
      if (r.kind === 'original') return original(input as RequestInfo, init);
      if (r.kind === 'status') return new Response(null, { status: r.status });
      if (r.kind === 'file') return new Response(method === 'HEAD' ? null : r.text, { status: 200, headers: { 'content-type': contentTypeOf(r.rel) } });
      const prefix = r.prefix;
      let text: string | null = null;
      if (init?.body !== undefined && init.body !== null) text = typeof init.body === 'string' ? init.body : await new Response(init.body as BodyInit).text();
      else if (req && method !== 'GET' && method !== 'HEAD') text = await req.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const t0 = performance.now();
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const res = await router.handle({ method, path: url.pathname.slice(prefix.length) || '/', query, body });
      const empty = res.status === 204 || res.status === 304 || res.body === undefined;
      this.onCall?.({ method, path: url.pathname + url.search, status: res.status, requestBody: text, responseBody: res.body === undefined ? null : JSON.stringify(res.body), durationMs: Math.round(performance.now() - t0) });
      return new Response(empty ? null : JSON.stringify(res.body), {
        status: res.status,
        headers: empty ? {} : { 'content-type': 'application/json; charset=utf-8' },
      });
    };
  }

  uninstall(): void {
    if (this.original) {
      this.win.fetch = this.raw ?? this.original;
      this.original = null;
      this.raw = null;
    }
    this.prefix = null;
  }
}
