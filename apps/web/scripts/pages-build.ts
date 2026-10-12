import { existsSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { PagesConfigSchema, type PagesConfig } from '../../../packages/core/src/pages-config.ts';

/** Build-time helpers of the Pages edition (pat.md「ビルドの版」). Node side: used by vite.config.ts only. */

/** One line. Only the Pages edition's index.html gets it; the local edition's index.html is unchanged. */
export const PAGES_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline' blob: data:; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; img-src 'self' data: blob: https://*.githubusercontent.com; font-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

export const PAGES_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PAGES_CSP}">`;

export type Edition = 'local' | 'pages';

export function resolveEdition(value: string | undefined): Edition {
  if (value === undefined || value === '' || value === 'local') return 'local';
  if (value === 'pages') return 'pages';
  throw new Error(`DDV_EDITION は local か pages です: ${value}`);
}

/** `DDV_BASE` → starts and ends with `/` (empty = `/`). */
export function normalizeBase(value: string | undefined): string {
  const v = (value ?? '').trim().replace(/^\/+|\/+$/g, '');
  return v ? `/${v}/` : '/';
}

/** pages.config.json → validated `PagesConfig`. A missing file gives the defaults; broken JSON or schema violations stop the build. */
export function loadPagesConfig(file: string): PagesConfig {
  let json: unknown = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`pages.config.json: ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const r = PagesConfigSchema.safeParse(json);
  if (!r.success) throw new Error(`pages.config.json: ${file}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' / ')}`);
  return r.data;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** CSP meta at the top of `<head>` and `<title>` from `pagesConfig.title`. */
export function transformPagesHtml(html: string, config: Pick<PagesConfig, 'title'>): string {
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n    ${PAGES_CSP_META}`).replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(config.title)}</title>`);
}

/** Applied to both `vite build` and `vite dev` (trying the Pages edition on the dev server uses the same CSP). */
export function ddvPagesHtml(config: Pick<PagesConfig, 'title'>): Plugin {
  return {
    name: 'ddv-pages-html',
    transformIndexHtml: { order: 'pre', handler: (html) => transformPagesHtml(html, config) },
  };
}
