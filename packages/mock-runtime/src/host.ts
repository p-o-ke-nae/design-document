// How the runtime is hosted (DD-MOCKSB HOSTMODE): top-level page, iframe of the local viewer, or sandboxed srcdoc of the Pages viewer.

declare global {
  interface Window {
    /** Written at the top of the srcdoc by the viewer's MockDocumentBuilder. */
    __ddvHost?: unknown;
  }
}

/** srcdoc = Pages viewer (sandbox, files by ddv:init); embedded = local viewer (/raw/); standalone = no parent (new tab, Playwright). */
export type HostMode = 'srcdoc' | 'embedded' | 'standalone';

export interface HostInfo {
  mode: HostMode;
  /** Origin of the parent the messages are exchanged with (embedded / standalone: location.origin). */
  origin: string;
  /** srcdoc only: virtual base URL the page's relative URLs resolve against. */
  virtualBase?: string;
}

const isUrl = (s: unknown, base = false): s is string => {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && (!base || u.href === s);
  } catch {
    return false;
  }
};

export function detectHostMode(win: Window, log: Pick<Console, 'error'> = console): HostInfo {
  const origin = win.location.origin;
  if (win.parent === win || !win.parent) return { mode: 'standalone', origin };
  const spec = (win as Window & { __ddvHost?: unknown }).__ddvHost;
  if (spec === undefined || spec === null) return { mode: 'embedded', origin };
  const s = spec as { mode?: unknown; origin?: unknown; base?: unknown };
  if (typeof spec === 'object' && s.mode === 'srcdoc' && isUrl(s.origin) && new URL(s.origin as string).origin === s.origin && isUrl(s.base, true)) {
    return { mode: 'srcdoc', origin: s.origin as string, virtualBase: s.base as string };
  }
  log.error('[ddv] __ddvHost の形式が正しくないため、親との通信をせずに起動します', spec);
  return { mode: 'standalone', origin };
}

/** Files sent by the viewer with ddv:init (keys are relative to the mock's HTML). `read` waits for the first set. */
export class HostedFiles {
  private files: Record<string, string> | null = null;
  private waiters: Array<() => void> = [];

  set(files: Record<string, string>): void {
    this.files = { ...files };
    const ws = this.waiters;
    this.waiters = [];
    ws.forEach((f) => f());
  }

  get received(): boolean {
    return this.files !== null;
  }

  get(rel: string): string | undefined {
    return this.files ? (Object.hasOwn(this.files, rel) ? this.files[rel] : undefined) : undefined;
  }

  async read(rel: string): Promise<string | null> {
    if (!this.files) await new Promise<void>((r) => this.waiters.push(r));
    return this.get(rel) ?? null;
  }
}
