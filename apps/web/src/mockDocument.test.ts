// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { MOCK_CSP, MockDocumentBuilder, normalizeRef, virtualUrl, type MockRepoReader } from './mockDocument.ts';

beforeAll(() => {
  // happy-dom would otherwise try to load scripts/styles/iframes of parsed documents
  const settings = (window as unknown as { happyDOM?: { settings: Record<string, unknown> } }).happyDOM?.settings;
  if (settings) Object.assign(settings, { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
    const nav = settings?.navigation as Record<string, unknown> | undefined;
    if (nav) nav.disableChildFrameNavigation = true;
  });

const RUNTIME = '// @ddv/mock-runtime 0.1.0\nexport const mock = {};';
const ORIGIN = 'http://localhost:5173';

class MemReader implements MockRepoReader {
  reads: string[] = [];
  constructor(
    private files: Record<string, string | Uint8Array>,
    private sizes: Record<string, number> = {},
  ) {}
  async listFiles(dir: string, filter?: (p: string) => boolean) {
    return Object.keys(this.files)
      .filter((p) => p.startsWith(dir ? `${dir}/` : ''))
      .filter((p) => !filter || filter(p))
      .sort();
  }
  async stat(path: string) {
    const f = this.files[path];
    if (f === undefined) return null;
    return { path, size: this.sizes[path] ?? (typeof f === 'string' ? f.length : f.byteLength) };
  }
  async tryReadText(path: string) {
    this.reads.push(path);
    const f = this.files[path];
    return typeof f === 'string' ? f : f ? new TextDecoder().decode(f) : null;
  }
  async readBinary(path: string) {
    this.reads.push(path);
    const f = this.files[path];
    if (f === undefined) throw new Error('not found');
    return typeof f === 'string' ? new TextEncoder().encode(f) : f;
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const decodeData = (url: string) => {
  const m = /^data:[^,]*;base64,(.*)$/.exec(url);
  if (!m) throw new Error(`not a base64 data URL: ${url.slice(0, 40)}`);
  return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
};
const parse = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, 'text/html');
const H = 'docs/mocks/order/index.html';

describe('normalizeRef', () => {
  it('posix で正規化し、ルートを越える .. は null', () => {
    expect(normalizeRef('docs/mocks/order', './a/../b.css')).toBe('docs/mocks/order/b.css');
    expect(normalizeRef('docs/mocks/order', '../../../x')).toBe('x');
    expect(normalizeRef('docs/mocks/order', '../../../../x')).toBeNull();
    expect(normalizeRef('docs/mocks/order', '/img/a.png')).toBe('img/a.png');
  });
});

describe('MockDocumentBuilder.resolveRef', () => {
  const b = (files: Record<string, string | Uint8Array> = {}, sizes: Record<string, number> = {}) => {
    const reader = new MemReader(files, sizes);
    return { reader, builder: new MockDocumentBuilder(reader, RUNTIME, ORIGIN) };
  };

  it('[DD-MOCKSB-ASSET-T001] [DD-MOCKSB-ASSET-T002] [DD-MOCKSB-ASSET-P001] 空・ハッシュだけ・data:・blob: はそのまま（警告なし）', async () => {
    const { builder, reader } = b();
    for (const ref of ['', '#top', 'data:image/png;base64,AAAA', 'blob:http://x/1']) expect(await builder.resolveRef(ref, H, 'binary')).toEqual({ url: ref });
    expect(reader.reads).toEqual([]);
  });

  it('[DD-MOCKSB-ASSET-T003] [DD-MOCKSB-ASSET-T004] [DD-MOCKSB-ASSET-P002] スキームがあるか // で始まる参照はそのまま・external', async () => {
    const { builder } = b();
    expect(await builder.resolveRef('https://cdn.example/a.css', H, 'style')).toEqual({ url: 'https://cdn.example/a.css', issue: 'external' });
    expect(await builder.resolveRef('//cdn.example/a.js', H, 'script')).toEqual({ url: '//cdn.example/a.js', issue: 'external' });
  });

  it('[DD-MOCKSB-ASSET-T005] [DD-MOCKSB-ASSET-T006] [DD-MOCKSB-ASSET-P003] _ddv/mock-runtime.js はリポジトリを読まず同梱の runtime の data: URL', async () => {
    const { builder, reader } = b({ 'docs/mocks/_ddv/mock-runtime.js': '// old runtime' });
    const r = await builder.resolveRef('../_ddv/mock-runtime.js?v=1', H, 'script');
    expect(r.issue).toBeUndefined();
    expect(decodeData(r.url)).toBe(RUNTIME);
    expect(reader.reads).toEqual([]);
  });

  it('[DD-MOCKSB-ASSET-T007] [DD-MOCKSB-ASSET-T008] [DD-MOCKSB-ASSET-P004] 正規化するとリポジトリの外に出る参照はそのまま・outsideRepo', async () => {
    const { builder } = b();
    expect(await builder.resolveRef('../../../../etc/passwd', H, 'binary')).toEqual({ url: '../../../../etc/passwd', issue: 'outsideRepo' });
  });

  it('[DD-MOCKSB-ASSET-T009] [DD-MOCKSB-ASSET-T010] [DD-MOCKSB-ASSET-P005] RepoReader.stat が無ければそのまま・notFound', async () => {
    const { builder } = b();
    expect(await builder.resolveRef('img/none.png', H, 'binary')).toEqual({ url: 'img/none.png', issue: 'notFound' });
  });

  it('[DD-MOCKSB-ASSET-T011] [DD-MOCKSB-ASSET-T012] [DD-MOCKSB-ASSET-P006] 5 MB を超えるファイルは読まずにそのまま・tooLarge', async () => {
    const { builder, reader } = b({ 'docs/mocks/order/big.png': PNG }, { 'docs/mocks/order/big.png': 5 * 1024 * 1024 + 1 });
    expect(await builder.resolveRef('big.png', H, 'binary')).toEqual({ url: 'big.png', issue: 'tooLarge' });
    expect(reader.reads).toEqual([]);
  });

  it('[DD-MOCKSB-ASSET-T013] [DD-MOCKSB-ASSET-T014] [DD-MOCKSB-ASSET-T015] [DD-MOCKSB-ASSET-P007] CSS の @import が循環したら空の CSS・cycle', async () => {
    const { builder } = b({ 'docs/mocks/order/a.css': '@import "b.css"; .a{}', 'docs/mocks/order/b.css': '@import url(./a.css); .b{}' });
    const r = await builder.resolveRef('a.css', H, 'style');
    expect(r.issue).toBeUndefined();
    const a = decodeData(r.url);
    expect(a).toContain('.a{}');
    const bUrl = /@import url\("([^"]+)"\)/.exec(a)![1];
    const bCss = decodeData(bUrl);
    expect(bCss).toContain('.b{}');
    // b.css → a.css closes the chain: a.css is replaced by an empty stylesheet
    expect(bCss).toContain('@import url("data:text/css;base64,")');
    expect(builder['issues']).toEqual([{ ref: './a.css', from: 'docs/mocks/order/b.css', kind: 'cycle' }]);
  });

  it('[DD-MOCKSB-ASSET-T016] [DD-MOCKSB-ASSET-P008] CSS は url() と @import を再帰で置換した data: text/css', async () => {
    const { builder } = b({
      'docs/mocks/order/style.css': '@import "parts/base.css";\nbody { background: url("img/bg.png?x#y") }',
      'docs/mocks/order/parts/base.css': '@font-face { src: url(../fonts/a.woff2) } .x { background: url(https://cdn/x.png) }',
      'docs/mocks/order/img/bg.png': PNG,
      'docs/mocks/order/fonts/a.woff2': PNG,
    });
    const r = await builder.resolveRef('style.css', H, 'style');
    expect(r.url.startsWith('data:text/css;charset=utf-8;base64,')).toBe(true);
    const css = decodeData(r.url);
    expect(css).toContain(`url("data:image/png;base64,${btoa(String.fromCharCode(...PNG))}")`);
    const base = decodeData(/@import url\("([^"]+)"\)/.exec(css)![1]);
    expect(base).toContain('url("data:font/woff2;base64,');
    expect(base).toContain('url(https://cdn/x.png)');
  });

  it('[DD-MOCKSB-ASSET-T017] [DD-MOCKSB-ASSET-P009] JS は指定子を仮想 URL にした data: text/javascript を importmap に登録する', async () => {
    const reader = new MemReader({
      [H]: '<html><head><script type="module" src="mock.js"></script></head><body></body></html>',
      'docs/mocks/order/mock.js': "import { mock } from '../_ddv/mock-runtime.js';\nimport { f } from './lib/util.js';\nconst later = () => import('./lib/late.js');\nimport x from 'bare';\nexport { f };",
      'docs/mocks/order/lib/util.js': "import { mock } from '../mock.js';\nexport const f = 1;",
      'docs/mocks/order/lib/late.js': 'export default 2;',
    });
    const built = await new MockDocumentBuilder(reader, RUNTIME, ORIGIN).build(H);
    const doc = parse(built.srcdoc);
    const map = JSON.parse(doc.querySelector('script[type=importmap]')!.textContent!) as { imports: Record<string, string> };
    const mockUrl = doc.querySelector('script[src]')!.getAttribute('src')!;
    expect(mockUrl.startsWith('data:text/javascript;charset=utf-8;base64,')).toBe(true);
    const mockJs = decodeData(mockUrl);
    expect(mockJs).toContain(`from '${virtualUrl('docs/mocks/_ddv/mock-runtime.js')}'`);
    expect(mockJs).toContain(`from '${virtualUrl('docs/mocks/order/lib/util.js')}'`);
    expect(mockJs).toContain(`import("${virtualUrl('docs/mocks/order/lib/late.js')}")`);
    expect(mockJs).toContain("from 'bare'");
    expect(map.imports[virtualUrl('docs/mocks/order/mock.js')]).toBe(mockUrl);
    expect(decodeData(map.imports[virtualUrl('docs/mocks/_ddv/mock-runtime.js')])).toBe(RUNTIME);
    expect(decodeData(map.imports[virtualUrl('docs/mocks/order/lib/util.js')])).toContain(`from '${virtualUrl('docs/mocks/order/mock.js')}'`);
    expect(decodeData(map.imports[virtualUrl('docs/mocks/order/lib/late.js')])).toBe('export default 2;');
    expect(built.issues).toEqual([]);
  });

  it('[DD-MOCKSB-ASSET-T018] [DD-MOCKSB-ASSET-P010] 画像・フォントは拡張子の MIME の data: base64（不明は octet-stream）', async () => {
    const { builder } = b({ 'docs/mocks/order/a.svg': '<svg/>', 'docs/mocks/order/a.bin': PNG });
    expect(await builder.resolveRef('a.svg', H, 'binary')).toEqual({ url: `data:image/svg+xml;base64,${b64('<svg/>')}` });
    expect((await builder.resolveRef('a.bin', H, 'binary')).url.startsWith('data:application/octet-stream;base64,')).toBe(true);
  });
});

describe('MockDocumentBuilder.build', () => {
  const HTML = `<!doctype html>
<html lang="ja"><head>
<base href="https://evil.example/">
<link rel="stylesheet" href="style.css">
<link rel="icon" href="favicon.ico">
<style>.hero { background: url(img/a.png) }</style>
<script type="module" src="../_ddv/mock-runtime.js"></script>
</head><body>
<section data-screen="List" style="background-image: url('img/a.png')">
  <img data-testid="logo" src="img/a.png" srcset="img/a.png 1x, img/b.png 2x">
  <img src="https://example.com/x.png">
  <a href="https://example.com/">外部</a>
  <embed src="other.html">
  <template><img src="img/b.png"></template>
</section>
</body></html>`;
  const files = {
    [H]: HTML,
    'docs/mocks/order/style.css': 'body{color:red}',
    'docs/mocks/order/favicon.ico': PNG,
    'docs/mocks/order/img/a.png': PNG,
    'docs/mocks/order/img/b.png': PNG,
    'docs/mocks/order/api.yaml': 'base: /api',
    'docs/mocks/order/fixtures/default.yaml': 'orders: []',
    'docs/mocks/order/data/list.json': '[]',
    'docs/mocks/order/scenarios/a.yaml': 'steps: []',
    'docs/mocks/order/notes.md': '# x',
    'docs/mocks/other/api.yaml': 'base: /x',
  };

  it('CSP・base・__ddvHost・importmap を data-ddv-ui 付きで head の先頭に入れ、参照を data: URL にする', async () => {
    const reader = new MemReader(files);
    const built = await new MockDocumentBuilder(reader, RUNTIME, ORIGIN).build(H);
    expect(built.virtualBase).toBe('https://mock.ddv.invalid/docs/mocks/order/');
    expect(built.srcdoc.startsWith('<!doctype html>')).toBe(true);
    const doc = parse(built.srcdoc);
    const head = [...doc.head.children];
    expect(head.slice(0, 4).map((e) => `${e.tagName}:${e.hasAttribute('data-ddv-ui')}`)).toEqual(['META:true', 'BASE:true', 'SCRIPT:true', 'SCRIPT:true']);
    expect(head[0].getAttribute('content')).toBe(MOCK_CSP);
    expect(head[1].getAttribute('href')).toBe(built.virtualBase);
    expect(head[2].textContent).toBe(`window.__ddvHost = {"mode":"srcdoc","origin":"${ORIGIN}","base":"${built.virtualBase}"};`);
    expect(head[3].getAttribute('type')).toBe('importmap');
    expect(doc.querySelectorAll('base')).toHaveLength(1);
    // Element-for-element replacement: tags, order, data-testid are kept
    expect(head.slice(4).map((e) => e.tagName)).toEqual(['LINK', 'LINK', 'STYLE', 'SCRIPT']);
    expect(decodeData(head[4].getAttribute('href')!)).toBe('body{color:red}');
    expect(head[5].getAttribute('href')!.startsWith('data:image/x-icon;base64,')).toBe(true);
    expect(head[6].textContent).toContain('url("data:image/png;base64,');
    expect(decodeData(head[7].getAttribute('src')!)).toBe(RUNTIME);
    const logo = doc.querySelector('[data-testid=logo]')!;
    expect(logo.getAttribute('src')!.startsWith('data:image/png;base64,')).toBe(true);
    expect(logo.getAttribute('srcset')).toMatch(/^data:image\/png;base64,\S+ 1x, data:image\/png;base64,\S+ 2x$/);
    expect(doc.querySelector('section')!.getAttribute('style')).toContain('url("data:image/png;base64,');
    expect(doc.querySelector('a')!.getAttribute('href')).toBe('https://example.com/');
    expect((doc.querySelector('template') as HTMLTemplateElement).content.querySelector('img')!.getAttribute('src')!.startsWith('data:image/png;base64,')).toBe(true);
    expect(built.files).toEqual({ 'api.yaml': 'base: /api', 'data/list.json': '[]', 'fixtures/default.yaml': 'orders: []' });
    expect(built.issues).toEqual([
      { ref: 'https://evil.example/', from: H, kind: 'baseTag' },
      { ref: 'https://example.com/x.png', from: H, kind: 'external' },
      { ref: 'other.html', from: H, kind: 'unsupported' },
    ]);
    // The same path is read once
    expect(reader.reads.filter((p) => p === 'docs/mocks/order/img/a.png')).toHaveLength(1);
  });

  it('HTML が無ければ失敗する', async () => {
    await expect(new MockDocumentBuilder(new MemReader({}), RUNTIME, ORIGIN).build(H)).rejects.toThrow(`${H} がありません`);
  });

  it('__ddvHost の JSON の < はエスケープする', async () => {
    const built = await new MockDocumentBuilder(new MemReader({ [H]: '<p>x</p>' }), RUNTIME, 'http://a</script>').build(H);
    expect(built.srcdoc).not.toContain('a</script>');
    expect(built.srcdoc).toContain('a\\u003c/script>');
  });
});
