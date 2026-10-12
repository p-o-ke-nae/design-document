// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { MemoryDb } from './db.ts';
import { FetchInterceptor } from './fetch.ts';
import { detectHostMode, HostedFiles, type HostInfo } from './host.ts';
import { ApiRouter } from './router.ts';
import { MockRuntime } from './runtime.ts';
import { HostBridge, type BridgeEngine, type OutMessage } from './bridge.ts';

const ORIGIN = 'http://localhost:5173';
const BASE = 'https://mock.ddv.invalid/docs/mocks/order/';

const fakeWin = (over: Record<string, unknown> = {}) => {
  const win = { location: { origin: 'null', href: 'about:srcdoc' }, ...over } as Record<string, unknown>;
  if (!('parent' in over)) win.parent = { postMessage: () => {} };
  return win as unknown as Window & typeof globalThis;
};

describe('detectHostMode', () => {
  it('[DD-MOCKSB-HOSTMODE-T001] [DD-MOCKSB-HOSTMODE-T002] [DD-MOCKSB-HOSTMODE-P001] 親が自分なら standalone（別タブ・Playwright）', () => {
    const win = { location: { origin: 'http://localhost:5178' } } as Record<string, unknown>;
    win.parent = win;
    win.__ddvHost = { mode: 'srcdoc', origin: ORIGIN, base: BASE };
    expect(detectHostMode(win as unknown as Window)).toEqual({ mode: 'standalone', origin: 'http://localhost:5178' });
  });

  it('[DD-MOCKSB-HOSTMODE-T003] [DD-MOCKSB-HOSTMODE-T004] [DD-MOCKSB-HOSTMODE-P002] 親があり __ddvHost が無ければ embedded（従来どおり location.origin）', () => {
    const win = fakeWin({ location: { origin: 'http://localhost:5178' } });
    expect(detectHostMode(win)).toEqual({ mode: 'embedded', origin: 'http://localhost:5178' });
  });

  it('[DD-MOCKSB-HOSTMODE-T005] [DD-MOCKSB-HOSTMODE-T006] [DD-MOCKSB-HOSTMODE-P003] __ddvHost の形式が正しくなければ standalone として起動し console.error', () => {
    const bad: unknown[] = [
      'srcdoc',
      { mode: 'embedded', origin: ORIGIN, base: BASE },
      { mode: 'srcdoc', origin: 'not a url', base: BASE },
      { mode: 'srcdoc', origin: `${ORIGIN}/path`, base: BASE },
      { mode: 'srcdoc', origin: 'javascript:alert(1)', base: BASE },
      { mode: 'srcdoc', origin: ORIGIN, base: 'relative/' },
      { mode: 'srcdoc', origin: ORIGIN },
    ];
    for (const spec of bad) {
      const log = { error: vi.fn() };
      expect(detectHostMode(fakeWin({ __ddvHost: spec }), log)).toEqual({ mode: 'standalone', origin: 'null' });
      expect(log.error).toHaveBeenCalledTimes(1);
    }
  });

  it('[DD-MOCKSB-HOSTMODE-T007] [DD-MOCKSB-HOSTMODE-P004] __ddvHost が正しければ srcdoc（origin は __ddvHost.origin、URL は仮想 base）', () => {
    const log = { error: vi.fn() };
    expect(detectHostMode(fakeWin({ __ddvHost: { mode: 'srcdoc', origin: ORIGIN, base: BASE } }), log)).toEqual({ mode: 'srcdoc', origin: ORIGIN, virtualBase: BASE });
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('FetchInterceptor（srcdoc）', () => {
  const host: HostInfo = { mode: 'srcdoc', origin: ORIGIN, virtualBase: BASE };
  function setup() {
    const original = vi.fn(async () => new Response('net', { status: 599 }));
    const win = fakeWin({ fetch: original });
    const files = new HostedFiles();
    files.set({ 'data/items.json': '[1,2]', 'notes.txt': 'memo', 'api.yaml': 'base: /api' });
    const router = new ApiRouter(new MemoryDb());
    router.route('GET /orders', () => ({ status: 200, body: [{ id: 1 }] }));
    const fi = new FetchInterceptor(win, host, files);
    const calls: string[] = [];
    fi.onCall = (c) => calls.push(`${c.method} ${c.path}`);
    fi.install(router, '/api');
    return { win, original, fi, calls };
  }

  it('[DD-MOCKSB-VFETCH-T001] [DD-MOCKSB-VFETCH-T002] [DD-MOCKSB-VFETCH-P001] 仮想 base と違うオリジンは元の fetch に渡す（CSP で失敗する）', async () => {
    const t = setup();
    expect(t.fi.route(new URL('https://api.github.com/user'), 'GET')).toEqual({ kind: 'original' });
    const res = await t.win.fetch('https://api.github.com/user');
    expect(res.status).toBe(599);
    expect(t.original).toHaveBeenCalledTimes(1);
    expect(t.calls).toEqual([]);
  });

  it('[DD-MOCKSB-VFETCH-T003] [DD-MOCKSB-VFETCH-T004] [DD-MOCKSB-VFETCH-P002] api.yaml の base 配下は ApiRouter が応答し、トレースに記録する', async () => {
    const t = setup();
    const res = await t.win.fetch('/api/orders');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1 }]);
    expect(t.original).not.toHaveBeenCalled();
    expect(t.calls).toEqual(['GET /api/orders']);
  });

  it('[DD-MOCKSB-VFETCH-T005] [DD-MOCKSB-VFETCH-T006] [DD-MOCKSB-VFETCH-P003] API 以外への GET・HEAD 以外は 405', async () => {
    const t = setup();
    const res = await t.win.fetch('data/items.json', { method: 'POST', body: '{}' });
    expect(res.status).toBe(405);
    expect(t.original).not.toHaveBeenCalled();
  });

  it('[DD-MOCKSB-VFETCH-T007] [DD-MOCKSB-VFETCH-T008] [DD-MOCKSB-VFETCH-P004] HostedFiles に無ければ 404', async () => {
    const t = setup();
    expect((await t.win.fetch('missing.json')).status).toBe(404);
    expect((await t.win.fetch('/other/data/items.json')).status).toBe(404);
    expect(t.original).not.toHaveBeenCalled();
  });

  it('[DD-MOCKSB-VFETCH-T009] [DD-MOCKSB-VFETCH-P005] HostedFiles にあれば 200 と拡張子の content-type（トレースには記録しない）', async () => {
    const t = setup();
    const res = await t.win.fetch('data/items.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual([1, 2]);
    const head = await t.win.fetch(`${BASE}notes.txt`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(t.calls).toEqual([]);
  });

  it('embedded では従来どおり location で解決し、API 以外は元の fetch', async () => {
    const original = vi.fn(async () => new Response('raw', { status: 200 }));
    const win = fakeWin({ fetch: original, location: { origin: 'http://localhost:5178', href: 'http://localhost:5178/raw/docs/mocks/order/index.html' } });
    const router = new ApiRouter(new MemoryDb());
    router.route('GET /orders', () => ({ status: 200, body: [] }));
    const fi = new FetchInterceptor(win, { mode: 'embedded', origin: 'http://localhost:5178' }, new HostedFiles());
    fi.install(router, '/api');
    expect((await win.fetch('/api/orders')).status).toBe(200);
    expect(await (await win.fetch('data.json')).text()).toBe('raw');
    expect(original).toHaveBeenCalledWith('data.json', undefined);
  });
});

describe('HostBridge（プロトコル 2）', () => {
  const engine = (): BridgeEngine & { inits: Array<Record<string, string>> } => {
    const inits: Array<Record<string, string>> = [];
    return { version: '9.9.9', inits, boot: async () => ({ screen: 'List' }), exec: async () => ({ ok: true, screen: 'List', failures: [] }), cancel: () => {}, screen: () => 'List', init: (f) => void inits.push(f) };
  };
  const setup = (host: HostInfo) => {
    const posted: Array<{ msg: OutMessage; target: string }> = [];
    const parent = { postMessage: (msg: OutMessage, target: string) => posted.push({ msg, target }) };
    const win = { parent, location: { origin: 'null' }, addEventListener: () => {} } as unknown as Window;
    const e = engine();
    return { bridge: new HostBridge(win, e, host), posted, parent, e };
  };

  it('srcdoc: listen で ddv:hello を親のオリジン宛てに送り、ddv:init のファイルを渡し、ddv:ready に protocol を付ける', async () => {
    const t = setup({ mode: 'srcdoc', origin: ORIGIN, virtualBase: BASE });
    t.bridge.listen();
    expect(t.posted).toEqual([{ msg: { type: 'ddv:hello', protocol: 2, version: '9.9.9' }, target: ORIGIN }]);
    t.bridge.onMessage({ source: t.parent, origin: ORIGIN, data: { type: 'ddv:init', protocol: 2, files: { 'api.yaml': 'x' } } } as unknown as MessageEvent);
    t.bridge.onMessage({ source: t.parent, origin: 'null', data: { type: 'ddv:init', protocol: 2, files: { 'api.yaml': 'evil' } } } as unknown as MessageEvent);
    expect(t.e.inits).toEqual([{ 'api.yaml': 'x' }]);
    // Warnings before the first ready are held so that the viewer does not take them as a boot failure
    t.bridge.error('api.yaml の警告');
    await t.bridge.start();
    expect(t.posted.slice(1).map((p) => p.msg)).toEqual([
      { type: 'ddv:ready', screen: 'List', version: '9.9.9', protocol: 2 },
      { type: 'ddv:error', message: 'api.yaml の警告' },
    ]);
  });

  it('embedded: ddv:hello を送るが ddv:init は無視する', async () => {
    const t = setup({ mode: 'embedded', origin: 'http://localhost:5178' });
    t.bridge.listen();
    expect(t.posted[0]).toEqual({ msg: { type: 'ddv:hello', protocol: 2, version: '9.9.9' }, target: 'http://localhost:5178' });
    t.bridge.onMessage({ source: t.parent, origin: 'http://localhost:5178', data: { type: 'ddv:init', protocol: 2, files: {} } } as unknown as MessageEvent);
    expect(t.e.inits).toEqual([]);
  });

  it('standalone: 何も送らない', () => {
    const t = setup({ mode: 'standalone', origin: 'null' });
    t.bridge.listen();
    t.bridge.error('x');
    expect(t.posted).toEqual([]);
  });
});

describe('MockRuntime（srcdoc）', () => {
  let rt: MockRuntime | null = null;
  afterEach(() => rt?.dispose());

  it('ddv:init を待って api.yaml・fixtures を files から読み、ddv:ready を返す', async () => {
    const win = new HappyWindow({ url: 'https://example.invalid/' }) as unknown as Window & typeof globalThis;
    win.document.body.innerHTML = '<section data-screen="List"><ul data-testid="orders"></ul></section>';
    const posted: OutMessage[] = [];
    const parent = { postMessage: (m: OutMessage) => posted.push(m) };
    const host: HostInfo = { mode: 'srcdoc', origin: ORIGIN, virtualBase: BASE };
    Object.defineProperty(win, 'parent', { value: parent });
    rt = new MockRuntime({ win, host });
    const started = rt.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(posted.map((m) => m.type)).toEqual(['ddv:hello']);
    rt.bridge.onMessage({ source: parent, origin: ORIGIN, data: { type: 'ddv:init', protocol: 2, files: { 'api.yaml': 'tables: [orders]\nroutes:\n  - { method: GET, path: /orders, op: list, table: orders }\n', 'fixtures/default.yaml': 'orders:\n  - { id: 1 }\n' } } } as unknown as MessageEvent);
    await started;
    expect(posted.at(-1)).toEqual({ type: 'ddv:ready', screen: 'List', version: rt.version, protocol: 2 });
    const res = await win.fetch('/api/orders');
    expect(await res.json()).toEqual([{ id: 1 }]);
  });
});
