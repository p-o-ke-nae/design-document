import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PAGES_CSP, loadPagesConfig, normalizeBase, resolveEdition, transformPagesHtml } from './pages-build.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function file(content?: string) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ddv-pages-config-'));
  dirs.push(d);
  const f = path.join(d, 'pages.config.json');
  if (content !== undefined) writeFileSync(f, content);
  return f;
}

describe('Pages 版のビルド（pat.md「ビルドの版」）', () => {
  it('DDV_EDITION は local（既定）か pages', () => {
    expect(resolveEdition(undefined)).toBe('local');
    expect(resolveEdition('local')).toBe('local');
    expect(resolveEdition('pages')).toBe('pages');
    expect(() => resolveEdition('hosted')).toThrow('DDV_EDITION は local か pages です: hosted');
  });

  it('DDV_BASE は / で始まり / で終わる形にする（空は /）', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('/design-document')).toBe('/design-document/');
    expect(normalizeBase('design-document/')).toBe('/design-document/');
  });

  it('index.html の <head> の先頭に CSP の meta を入れ、<title> を置き換える', () => {
    const html = '<!doctype html>\n<html lang="ja">\n  <head>\n    <meta charset="UTF-8" />\n    <title>ddv - Design Doc Viewer</title>\n  </head>\n</html>';
    const out = transformPagesHtml(html, { title: 'acme <docs>' });
    expect(out).toContain(`<head>\n    <meta http-equiv="Content-Security-Policy" content="${PAGES_CSP}">\n    <meta charset`);
    expect(out).toContain('<title>acme &lt;docs&gt;</title>');
    expect(PAGES_CSP).toContain("connect-src 'self' https://api.github.com https://raw.githubusercontent.com;");
    expect(PAGES_CSP).not.toContain('\n');
  });

  it('CSP はモックの srcdoc（親の CSP を継承）の data: の JS と仮想 base を許し、それ以外の base は止める', () => {
    const directive = (name: string) => PAGES_CSP.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1);
    expect(directive('script-src')).toEqual(["'self'", "'unsafe-inline'", 'blob:', 'data:']);
    expect(directive('base-uri')).toEqual(["'self'", 'https://mock.ddv.invalid']);
  });

  it('pages.config.json：既定のファイル・無いときは既定値・壊れていればビルドを止める', () => {
    expect(loadPagesConfig(path.join(import.meta.dirname, '..', 'pages.config.json'))).toEqual({ title: 'ddv', recentTargets: [] });
    expect(loadPagesConfig(file())).toEqual({ title: 'ddv', recentTargets: [] });
    expect(loadPagesConfig(file('{"title":"acme","allowedOwners":["acme"],"recentTargets":[{"repo":"acme/app","pr":1}]}'))).toMatchObject({ title: 'acme', allowedOwners: ['acme'] });
    expect(() => loadPagesConfig(file('{'))).toThrow(/^pages\.config\.json: .*pages\.config\.json: /);
    expect(() => loadPagesConfig(file('{"allowedOwners":["acme"],"recentTargets":[{"repo":"other/app"}]}'))).toThrow('allowedOwners に無い owner です: other/app');
    expect(() => loadPagesConfig(file('{"unknown":1}'))).toThrow(/pages\.config\.json/);
  });
});
