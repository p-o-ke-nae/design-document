import type { ApiRouter } from './router.ts';

type FetchFn = typeof fetch;

/** Replaces `window.fetch`; requests under `base` (same origin) go to the router, others to the original fetch. */
export class FetchInterceptor {
  private original: FetchFn | null = null;
  private raw: FetchFn | null = null;

  constructor(private readonly win: Window & typeof globalThis) {}

  /** The fetch before install (bound to the window). */
  get originalFetch(): FetchFn {
    return this.original ?? this.win.fetch.bind(this.win);
  }

  install(router: ApiRouter, base: string): void {
    this.uninstall();
    this.raw = this.win.fetch;
    const original = this.win.fetch.bind(this.win);
    this.original = original;
    const win = this.win;
    const prefix = base === '/' ? '' : base;
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = typeof input === 'object' && 'url' in input && !(input instanceof URL) ? (input as Request) : null;
      const url = new URL(req ? req.url : String(input), win.location.href);
      const under = url.origin === win.location.origin && (prefix === '' || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
      if (!under) return original(input as RequestInfo, init);
      const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
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
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const res = await router.handle({ method, path: url.pathname.slice(prefix.length) || '/', query, body });
      const empty = res.status === 204 || res.status === 304 || res.body === undefined;
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
  }
}
