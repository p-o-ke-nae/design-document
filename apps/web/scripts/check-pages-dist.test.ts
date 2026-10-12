import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPagesDist } from './check-pages-dist.ts';
import { PAGES_CSP, PAGES_CSP_META } from './pages-build.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const indexHtml = (o: { meta?: string; base?: string } = {}) =>
  `<!doctype html><html><head>${o.meta ?? PAGES_CSP_META}<title>ddv</title><script type="module" crossorigin src="${o.base ?? '/ddv/'}assets/index-abc.js"></script><link rel="stylesheet" href="${o.base ?? '/ddv/'}assets/index-abc.css"></head><body><div id="root"></div></body></html>`;

/** A small dist: index.html + assets/index-abc.js. */
function dist(o: { index?: string; js?: string } = {}) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ddv-pages-dist-'));
  dirs.push(d);
  mkdirSync(path.join(d, 'assets'));
  writeFileSync(path.join(d, 'index.html'), o.index ?? indexHtml());
  writeFileSync(path.join(d, 'assets', 'index-abc.js'), o.js ?? 'fetch("https://api.github.com/repos/"+o+"/"+r);fetch(`https://raw.githubusercontent.com/${o}`);');
  return d;
}

const kinds = (d: string, base = '/ddv/') => checkPagesDist(d, base).map((p) => p.kind);

describe('checkPagesDist (DD-PAT-DIST)', () => {
  it('[DD-PAT-DIST-P001] [DD-PAT-DIST-T001] [DD-PAT-DIST-T002] CSP の meta が無い・connect-src が違うと csp', () => {
    expect(kinds(dist({ index: indexHtml({ meta: '' }) }))).toEqual(['csp']);
    const wide = PAGES_CSP.replace('connect-src \'self\' https://api.github.com', 'connect-src \'self\' https://api.github.com https://evil.example');
    expect(kinds(dist({ index: indexHtml({ meta: `<meta http-equiv="Content-Security-Policy" content="${wide}">` }) }))).toEqual(['csp']);
    expect(checkPagesDist(dist({ index: indexHtml({ meta: '' }) }), '/ddv/')[0]).toMatchObject({ file: 'index.html' });
  });

  it('[DD-PAT-DIST-P002] [DD-PAT-DIST-T003] [DD-PAT-DIST-T004] JS・HTML にローカルサーバの /api/・/raw/・/w/ への要求の文字列があると httpBackend', () => {
    for (const js of ['fetch("/api/docs")', "fetch('/raw/'+p)", 'fetch(`/w/${id}/api/x`)']) {
      const problems = checkPagesDist(dist({ js }), '/ddv/');
      expect(problems.map((p) => p.kind)).toEqual(['httpBackend']);
      expect(problems[0].file).toBe('assets/index-abc.js');
    }
  });

  it('[DD-PAT-DIST-P003] [DD-PAT-DIST-T005] [DD-PAT-DIST-T006] 127.0.0.1・localhost・EventSource の文字列があると localServer', () => {
    for (const js of ['x="http://127.0.0.1:5178"', 'x="http://localhost:5173"', 'x="ws://localhost/"', 'new EventSource(u)']) expect(kinds(dist({ js }))).toEqual(['localServer']);
    expect(kinds(dist({ js: 'throw TypeError(`File URL host must be "localhost" or empty on darwin`)' }))).toEqual([]);
  });

  it('[DD-PAT-DIST-P004] [DD-PAT-DIST-T007] [DD-PAT-DIST-T008] index.html の資産のパスが base で始まらないと base', () => {
    const problems = checkPagesDist(dist({ index: indexHtml({ base: '/' }) }), '/ddv/');
    expect(problems.map((p) => p.kind)).toEqual(['base', 'base']);
    expect(problems[0].detail).toContain('/assets/index-abc.js');
  });

  it('[DD-PAT-DIST-P005] [DD-PAT-DIST-T009] 問題なし（GitHub の API・raw の URL は数えない）', () => {
    expect(checkPagesDist(dist(), '/ddv/')).toEqual([]);
    expect(checkPagesDist(dist({ index: indexHtml({ base: '/' }) }), '/')).toEqual([]);
  });
});
