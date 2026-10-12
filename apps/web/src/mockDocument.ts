// Builds the srcdoc of a mock for the Pages viewer (DD-MOCKSB srcdoc の組み立て): every asset becomes a data: URL,
// fetch'ed files go to ddv:init, and the document gets its own CSP, a virtual base and window.__ddvHost.
// The asm.js build: the Pages CSP has no 'wasm-unsafe-eval' (pat.md「CSP」)
import { parse as parseModule } from 'es-module-lexer/js';

/** Structural subset of `RepoReader` (@ddv/services) the builder needs. */
export interface MockRepoReader {
  listFiles(dir: string, filter?: (path: string) => boolean): Promise<string[]>;
  stat(path: string): Promise<{ path?: string; size?: number } | null>;
  tryReadText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<Uint8Array>;
}

export type BuildIssueKind = 'external' | 'outsideRepo' | 'notFound' | 'tooLarge' | 'cycle' | 'baseTag' | 'unsupported';

export interface BuildIssue {
  ref: string;
  /** Repository path of the file the reference is written in. */
  from: string;
  kind: BuildIssueKind;
}

export interface BuiltMockDocument {
  srcdoc: string;
  /** Sent with ddv:init: keys are relative to the HTML's directory. */
  files: Record<string, string>;
  virtualBase: string;
  issues: BuildIssue[];
}

export type RefAs = 'style' | 'script' | 'binary';

export interface RefResult {
  url: string;
  issue?: BuildIssueKind;
}

export const ISSUE_LABEL: Record<BuildIssueKind, string> = {
  external: '外部の URL は読み込みません',
  outsideRepo: 'リポジトリの外です',
  notFound: 'ファイルがありません',
  tooLarge: '5 MB を超えています',
  cycle: 'CSS の @import が循環しています',
  baseTag: '<base> は無視しました',
  unsupported: '埋め込みのフレームには対応していません',
};

export const VIRTUAL_ORIGIN = 'https://mock.ddv.invalid';
export const ASSET_MAX = 5 * 1024 * 1024;
export const FILES_MAX = 10 * 1024 * 1024;
export const MOCK_CSP =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'";
const RUNTIME_SUFFIX = '_ddv/mock-runtime.js';
const UI_ATTR = 'data-ddv-ui';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

export const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const textUrl = (mime: string, text: string) => `data:${mime};charset=utf-8;base64,${base64(new TextEncoder().encode(text))}`;
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const isKept = (r: string) => !r || r.startsWith('#') || /^(data|blob):/i.test(r);
const isExternal = (r: string) => SCHEME.test(r) || r.startsWith('//');
const stripQuery = (r: string) => safeDecode(r.replace(/[?#].*$/, ''));
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** posix join of `ref` onto `dir` (a leading `/` = repository root). null when `..` climbs above the root. */
export function normalizeRef(dir: string, ref: string): string | null {
  const out: string[] = [];
  const parts = ref.startsWith('/') ? ref.split('/') : [...(dir ? dir.split('/') : []), ...ref.split('/')];
  for (const s of parts) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join('/');
}

export const virtualUrl = (path: string) => new URL(path, `${VIRTUAL_ORIGIN}/`).href;

async function replaceAsync(s: string, re: RegExp, fn: (m: RegExpMatchArray) => Promise<string>): Promise<string> {
  const ms = [...s.matchAll(re)];
  if (!ms.length) return s;
  const reps = await Promise.all(ms.map(fn));
  let out = '';
  let last = 0;
  ms.forEach((m, i) => {
    out += s.slice(last, m.index) + reps[i];
    last = m.index! + m[0].length;
  });
  return out + s.slice(last);
}

const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)/gi;
const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

export class MockDocumentBuilder {
  private issues: BuildIssue[] = [];
  private issueKeys = new Set<string>();
  private imports: Record<string, string> = {};
  private styles = new Map<string, Promise<string | null>>();
  private binaries = new Map<string, Promise<string>>();
  private scripts = new Map<string, Promise<string | null>>();
  private pending: Array<Promise<unknown>> = [];
  private readonly runtimeUrl: string;

  constructor(
    private readonly reader: MockRepoReader,
    runtimeJs: string,
    /** location.origin of the viewer (the runtime posts to it). */
    private readonly hostOrigin: string,
    private readonly parser: () => Pick<DOMParser, 'parseFromString'> = () => new DOMParser(),
  ) {
    this.runtimeUrl = textUrl('text/javascript', runtimeJs);
  }

  /** `htmlPath`: repository path of the mock's HTML. */
  async build(htmlPath: string): Promise<BuiltMockDocument> {
    this.issues = [];
    this.issueKeys = new Set();
    this.imports = {};
    this.styles = new Map();
    this.binaries = new Map();
    this.scripts = new Map();
    this.pending = [];
    const html = await this.reader.tryReadText(htmlPath);
    if (html === null) throw new Error(`${htmlPath} がありません`);
    const dir = dirname(htmlPath);
    const virtualBase = virtualUrl(dir ? `${dir}/` : '');
    const doc = this.parser().parseFromString(html, 'text/html');
    for (const b of [...doc.querySelectorAll('base')]) {
      this.issue(b.getAttribute('href') ?? '<base>', htmlPath, 'baseTag');
      b.remove();
    }
    await this.rewriteTree(doc, htmlPath);
    while (this.pending.length) await Promise.all(this.pending.splice(0));
    const files = await this.collectFiles(dir);

    const head = doc.head;
    const el = (tag: string, attrs: Record<string, string>, text?: string) => {
      const e = doc.createElement(tag);
      e.setAttribute(UI_ATTR, '');
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text !== undefined) e.textContent = text;
      return e;
    };
    head.prepend(
      el('meta', { 'http-equiv': 'Content-Security-Policy', content: MOCK_CSP }),
      el('base', { href: virtualBase }),
      el('script', {}, `window.__ddvHost = ${scriptJson({ mode: 'srcdoc', origin: this.hostOrigin, base: virtualBase })};`),
      el('script', { type: 'importmap' }, scriptJson({ imports: this.imports })),
    );
    return { srcdoc: `<!doctype html>\n${doc.documentElement.outerHTML}`, files, virtualBase, issues: this.issues };
  }

  /** One reference (DD-MOCKSB ASSET). `from` = repository path of the file it is written in. */
  async resolveRef(ref: string, from: string, as: RefAs, chain: string[] = []): Promise<RefResult> {
    const r = ref.trim();
    if (isKept(r)) return { url: ref };
    if (isExternal(r)) return this.issue(ref, from, 'external');
    const p = stripQuery(r);
    if (p.endsWith(RUNTIME_SUFFIX)) {
      if (as === 'script') this.imports[virtualUrl(normalizeRef(dirname(from), p) ?? RUNTIME_SUFFIX)] = this.runtimeUrl;
      return { url: this.runtimeUrl };
    }
    const path = normalizeRef(dirname(from), p);
    if (path === null) return this.issue(ref, from, 'outsideRepo');
    const st = await this.reader.stat(path);
    if (!st) return this.issue(ref, from, 'notFound');
    if ((st.size ?? 0) > ASSET_MAX) return this.issue(ref, from, 'tooLarge');
    if (as === 'style') {
      if (chain.includes(path)) return { ...this.issue(ref, from, 'cycle'), url: 'data:text/css;base64,' };
      let css = this.styles.get(path);
      if (!css) this.styles.set(path, (css = this.loadStyle(path, [...chain, path])));
      const url = await css;
      return url === null ? this.issue(ref, from, 'notFound') : { url };
    }
    if (as === 'script') {
      const url = await this.script(path);
      return url === null ? this.issue(ref, from, 'notFound') : { url };
    }
    let bin = this.binaries.get(path);
    if (!bin) this.binaries.set(path, (bin = this.reader.readBinary(path).then((b) => `data:${mimeOf(path)};base64,${base64(b)}`)));
    return { url: await bin };
  }

  private issue(ref: string, from: string, kind: BuildIssueKind): RefResult {
    const key = `${kind}\0${from}\0${ref}`;
    if (!this.issueKeys.has(key)) {
      this.issueKeys.add(key);
      this.issues.push({ ref, from, kind });
    }
    return { url: ref, issue: kind };
  }

  private async loadStyle(path: string, chain: string[]): Promise<string | null> {
    const text = await this.reader.tryReadText(path);
    if (text === null) return null;
    return textUrl('text/css', await this.inlineCss(text, path, chain));
  }

  /** Replaces `@import` (recursively, as CSS) and `url()` (as binary) in CSS text. */
  async inlineCss(text: string, from: string, chain: string[] = []): Promise<string> {
    const imported = await replaceAsync(text, IMPORT_RE, async (m) => {
      const ref = m[2] ?? m[4] ?? '';
      const r = await this.resolveRef(ref, from, 'style', chain);
      return (r.issue && r.issue !== 'cycle') || r.url === ref ? m[0] : `@import url("${r.url}")`;
    });
    return replaceAsync(imported, URL_RE, async (m) => {
      const ref = m[2] ?? '';
      const r = await this.resolveRef(ref, from, 'binary', chain);
      return r.issue || r.url === ref ? m[0] : `url("${r.url}")`;
    });
  }

  /** Rewrites relative import specifiers to absolute virtual URLs and queues the imported modules for the import map. */
  async rewriteJs(text: string, from: string): Promise<string> {
    let imports: ReturnType<typeof parseModule>[0];
    try {
      [imports] = parseModule(text);
    } catch {
      return text;
    }
    const edits: Array<{ s: number; e: number; text: string }> = [];
    for (const im of imports) {
      const spec = im.n;
      if (spec === undefined || im.d === -2) continue;
      if (isKept(spec)) continue;
      if (isExternal(spec)) {
        this.issue(spec, from, 'external');
        continue;
      }
      if (!/^(\.{1,2})?\//.test(spec)) continue;
      const target = this.scriptTarget(spec, from);
      if (!target) continue;
      edits.push({ s: im.s, e: im.e, text: im.d >= 0 ? JSON.stringify(target) : target });
    }
    let out = text;
    for (const ed of edits.sort((a, b) => b.s - a.s)) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e);
    return out;
  }

  private scriptTarget(spec: string, from: string): string | null {
    const p = stripQuery(spec);
    if (p.endsWith(RUNTIME_SUFFIX)) {
      const virt = virtualUrl(normalizeRef(dirname(from), p) ?? RUNTIME_SUFFIX);
      this.imports[virt] = this.runtimeUrl;
      return virt;
    }
    const path = normalizeRef(dirname(from), p);
    if (path === null) {
      this.issue(spec, from, 'outsideRepo');
      return null;
    }
    if (!this.scripts.has(path)) {
      this.pending.push(
        (async () => {
          const st = await this.reader.stat(path);
          if (!st) return this.issue(spec, from, 'notFound');
          if ((st.size ?? 0) > ASSET_MAX) return this.issue(spec, from, 'tooLarge');
          if ((await this.script(path)) === null) this.issue(spec, from, 'notFound');
        })(),
      );
    }
    return virtualUrl(path);
  }

  private script(path: string): Promise<string | null> {
    let p = this.scripts.get(path);
    if (!p) {
      p = (async () => {
        const text = await this.reader.tryReadText(path);
        if (text === null) return null;
        const url = textUrl('text/javascript', await this.rewriteJs(text, path));
        this.imports[virtualUrl(path)] = url;
        return url;
      })();
      this.scripts.set(path, p);
    }
    return p;
  }

  private async rewriteTree(root: ParentNode, from: string): Promise<void> {
    const all = (sel: string) => [...root.querySelectorAll(sel)];
    const attr = async (el: Element, name: string, as: RefAs) => {
      const v = el.getAttribute(name);
      if (v === null) return;
      const r = await this.resolveRef(v, from, as);
      if (!r.issue && r.url !== v) el.setAttribute(name, r.url);
    };
    const srcset = async (el: Element) => {
      const v = el.getAttribute('srcset');
      if (v === null) return;
      const parts = await Promise.all(
        v
          .split(/,\s+/)
          .map((c) => c.trim())
          .filter(Boolean)
          .map(async (c) => {
            const [url, ...desc] = c.split(/\s+/);
            const r = await this.resolveRef(url, from, 'binary');
            return [r.issue ? url : r.url, ...desc].join(' ');
          }),
      );
      el.setAttribute('srcset', parts.join(', '));
    };
    const jobs: Array<Promise<unknown>> = [];
    for (const el of all('link[href]')) {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet')) jobs.push(attr(el, 'href', 'style'));
      else if (rel.includes('icon') || rel.includes('preload')) jobs.push(attr(el, 'href', 'binary'));
    }
    for (const el of all('style')) jobs.push(this.inlineCss(el.textContent ?? '', from).then((t) => void (el.textContent = t)));
    for (const el of all('[style]')) jobs.push(this.inlineCss(el.getAttribute('style') ?? '', from).then((t) => el.setAttribute('style', t)));
    for (const el of all('script[src]')) jobs.push(attr(el, 'src', 'script'));
    for (const el of all('script:not([src])')) if ((el.getAttribute('type') ?? '').trim().toLowerCase() === 'module') jobs.push(this.rewriteJs(el.textContent ?? '', from).then((t) => void (el.textContent = t)));
    for (const el of all('img[src], source[src], video[src], audio[src], input[src]')) if (el.tagName !== 'INPUT' || (el.getAttribute('type') ?? '').toLowerCase() === 'image') jobs.push(attr(el, 'src', 'binary'));
    for (const el of all('img[srcset], source[srcset]')) jobs.push(srcset(el));
    for (const el of all('video[poster]')) jobs.push(attr(el, 'poster', 'binary'));
    for (const el of all('iframe, object, embed')) this.issue(el.getAttribute('src') ?? el.getAttribute('data') ?? `<${el.tagName.toLowerCase()}>`, from, 'unsupported');
    for (const t of all('template')) jobs.push(this.rewriteTree((t as HTMLTemplateElement).content, from));
    await Promise.all(jobs);
  }

  /** JSON / YAML / text files under the mock's directory (except scenarios/), read by fetch or by the runtime's boot. */
  private async collectFiles(dir: string): Promise<Record<string, string>> {
    const prefix = dir ? `${dir}/` : '';
    const wanted = (p: string) => p.startsWith(prefix) && /\.(json|ya?ml|txt|csv)$/i.test(p) && !p.slice(prefix.length).startsWith('scenarios/');
    const paths = (await this.reader.listFiles(dir, wanted)).filter(wanted).sort();
    const out: Record<string, string> = {};
    let total = 0;
    for (const p of paths) {
      const text = await this.reader.tryReadText(p);
      if (text === null) continue;
      if (text.length > ASSET_MAX || total + text.length > FILES_MAX) {
        this.issue(p, dir, 'tooLarge');
        continue;
      }
      total += text.length;
      out[p.slice(prefix.length)] = text;
    }
    return out;
  }
}
