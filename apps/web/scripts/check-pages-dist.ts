import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeBase } from './pages-build.ts';

/** Checks the Pages edition's dist (pat.md「成果物の検査」, DD-PAT-DIST). `npm run check:pages-dist` after the Pages build. */

export type DistProblemKind = 'csp' | 'httpBackend' | 'localServer' | 'base';

export interface DistProblem {
  kind: DistProblemKind;
  /** Relative to the dist directory. */
  file: string;
  detail: string;
}

const EXPECTED_CONNECT_SRC = ["'self'", 'https://api.github.com', 'https://raw.githubusercontent.com'];

/** A request string to the local server's HTTP API: a quote right before `/api/`, `/raw/` or `/w/` (`https://api.github.com/...` is not counted). */
const HTTP_BACKEND = /["'`]\/(?:api|raw|w)\//g;
/** `localhost` only as a URL host (`//localhost`, `localhost:<port>`): vfile's bundled `fileURLToPath` has the message `File URL host must be "localhost"`. */
const LOCAL_SERVER = /127\.0\.0\.1|\/\/localhost\b|\blocalhost:\d|\bEventSource\b/g;

function walkFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else if (/\.(?:js|mjs|html)$/.test(e.name)) out.push(r);
  }
  return out;
}

function cspOf(html: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag)) continue;
    const c = /content\s*=\s*"([^"]*)"/i.exec(tag) ?? /content\s*=\s*'([^']*)'/i.exec(tag);
    return c ? c[1] : '';
  }
  return null;
}

function checkCsp(html: string): string | null {
  const csp = cspOf(html);
  if (csp === null) return 'index.html に Content-Security-Policy の meta がありません';
  const directive = csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src');
  if (!directive) return 'CSP に connect-src がありません';
  const values = directive.slice(1);
  const same = values.length === EXPECTED_CONNECT_SRC.length && EXPECTED_CONNECT_SRC.every((v) => values.includes(v));
  return same ? null : `connect-src が想定と違います: ${values.join(' ')}`;
}

/** `src` / `href` of `<script>` and `<link>` in index.html that are paths (not URLs with a scheme, `data:` etc.). */
function assetPaths(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const a = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (a && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(a[1])) out.push(a[1]);
  }
  return out;
}

export function checkPagesDist(distDir: string, base = '/'): DistProblem[] {
  const problems: DistProblem[] = [];
  const indexFile = path.join(distDir, 'index.html');
  if (!existsSync(indexFile)) return [{ kind: 'csp', file: 'index.html', detail: 'index.html がありません' }];
  const index = readFileSync(indexFile, 'utf8');
  const csp = checkCsp(index);
  if (csp) problems.push({ kind: 'csp', file: 'index.html', detail: csp });
  for (const file of walkFiles(distDir)) {
    const text = readFileSync(path.join(distDir, file), 'utf8');
    const http = [...text.matchAll(HTTP_BACKEND)].map((m) => m[0].slice(1));
    if (http.length) problems.push({ kind: 'httpBackend', file, detail: `ローカルサーバの API への要求の文字列が ${http.length} 件あります（${[...new Set(http)].join('、')}）` });
    const local = [...text.matchAll(LOCAL_SERVER)].map((m) => m[0]);
    if (local.length) problems.push({ kind: 'localServer', file, detail: `ローカルサーバを指す文字列が ${local.length} 件あります（${[...new Set(local)].join('、')}）` });
  }
  for (const p of assetPaths(index)) {
    if (!p.startsWith(base)) problems.push({ kind: 'base', file: 'index.html', detail: `資産のパスが base（${base}）で始まりません: ${p}` });
  }
  return problems;
}

function main(argv: string[]): number {
  const dir = path.resolve(argv[0] ?? 'apps/web/dist');
  const base = normalizeBase(process.env.DDV_BASE);
  const problems = checkPagesDist(dir, base);
  if (!problems.length) {
    console.log(`check-pages-dist: 問題はありません（${dir}、base ${base}）`);
    return 0;
  }
  console.error(`check-pages-dist: Pages 版の成果物に問題が ${problems.length} 件あります（${dir}、base ${base}）`);
  for (const p of problems) console.error(`  [${p.kind}] ${p.file}: ${p.detail}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
