// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDb } from './db.ts';
import { evalCondition } from './expr.ts';
import { FetchInterceptor } from './fetch.ts';
import { ApiRouter, matchPath, parseApiSpec } from './router.ts';

const API = {
  base: '/api',
  tables: ['orders', { name: 'stock', key: 'sku' }],
  routes: [
    { method: 'GET', path: '/orders', op: 'list', table: 'orders' },
    { method: 'GET', path: '/orders/:id', op: 'get', table: 'orders' },
    {
      method: 'POST',
      path: '/orders',
      when: [{ if: 'stock[body.sku].qty < body.quantity', status: 409, body: { message: '在庫が不足しています' } }],
      op: 'insert',
      table: 'orders',
      set: { status: 'Submitted' },
      status: 201,
    },
    { method: 'PUT', path: '/orders/:id', op: 'update', table: 'orders' },
    { method: 'DELETE', path: '/orders/:id', op: 'delete', table: 'orders' },
  ],
};

describe('ApiRouter / FetchInterceptor', () => {
  let db: MemoryDb;
  let router: ApiRouter;
  let interceptor: FetchInterceptor;
  let original: ReturnType<typeof vi.fn>;
  let errors: string[];

  beforeEach(() => {
    errors = [];
    const { spec, errors: specErrors } = parseApiSpec(API);
    expect(specErrors).toEqual([]);
    db = new MemoryDb();
    db.reset(spec.tables, [{ orders: [{ id: 1, customer: '既存', sku: 'A-100', quantity: 1 }], stock: [{ sku: 'A-100', qty: 5 }] }]);
    router = new ApiRouter(db, (m) => errors.push(m));
    router.setRoutes(spec.routes);
    original = vi.fn(async () => new Response('original', { status: 200 }));
    window.fetch = original as unknown as typeof fetch;
    interceptor = new FetchInterceptor(window);
    interceptor.install(router, spec.base);
  });
  afterEach(() => interceptor.uninstall());

  it('[DD-MOCKRT-ROUTE-P001] [DD-MOCKRT-ROUTE-T001] [DD-MOCKRT-ROUTE-T002] base 配下でない URL は元の fetch へ渡す', async () => {
    const res = await fetch('/static/data.json');
    expect(await res.text()).toBe('original');
    expect(original).toHaveBeenCalledTimes(1);
    await fetch('https://example.com/api/orders');
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('[DD-MOCKRT-ROUTE-P002] [DD-MOCKRT-ROUTE-T003] [DD-MOCKRT-ROUTE-T004] base 配下で一致するルートがなければ 404', async () => {
    const res = await fetch('/api/unknown', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toContain('ルートがありません');
    expect((await fetch('/api/orders', { method: 'PATCH' })).status).toBe(404);
    expect(original).not.toHaveBeenCalled();
  });

  it('[DD-MOCKRT-ROUTE-P003] [DD-MOCKRT-ROUTE-T005] [DD-MOCKRT-ROUTE-T006] JS ハンドラが登録済みならその戻り値を返す（when / op より優先）', async () => {
    router.route('POST /orders', (req, d) => ({ status: 202, body: { echo: req.body, count: d.list('orders').length } }));
    router.route('GET /hello/:name', (req) => ({ hi: req.params.name }));
    const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ sku: 'A-100', quantity: 99 }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ echo: { sku: 'A-100', quantity: 99 }, count: 1 });
    const hi = await fetch('/api/hello/taro');
    expect(hi.status).toBe(200);
    expect(await hi.json()).toEqual({ hi: 'taro' });
  });

  it('[DD-MOCKRT-ROUTE-P004] [DD-MOCKRT-ROUTE-T007] [DD-MOCKRT-ROUTE-T008] when が真ならその応答を返す', async () => {
    const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ customer: 'x', sku: 'A-100', quantity: 6 }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ message: '在庫が不足しています' });
    expect(db.list('orders')).toHaveLength(1);
  });

  it('[DD-MOCKRT-ROUTE-P005] [DD-MOCKRT-ROUTE-T009] [DD-MOCKRT-ROUTE-T010] [DD-MOCKRT-ROUTE-T011] when が偽で op のキーがなければ 404', async () => {
    expect((await fetch('/api/orders/99')).status).toBe(404);
    expect((await fetch('/api/orders/99', { method: 'PUT', body: '{"customer":"y"}' })).status).toBe(404);
    expect((await fetch('/api/orders/99', { method: 'DELETE' })).status).toBe(404);
  });

  it('[DD-MOCKRT-ROUTE-P006] [DD-MOCKRT-ROUTE-T012] op が成功すれば status と結果を返す', async () => {
    const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ customer: '山田', sku: 'A-100', quantity: '2' }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ customer: '山田', sku: 'A-100', quantity: '2', status: 'Submitted', id: 2 });
    const list = await fetch('/api/orders');
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(2);
    expect(await (await fetch('/api/orders/2')).json()).toMatchObject({ customer: '山田' });
    expect(await (await fetch('/api/orders/2', { method: 'PUT', body: '{"customer":"佐藤","id":7}' })).json()).toMatchObject({ id: 2, customer: '佐藤' });
    expect((await fetch('/api/orders/2', { method: 'DELETE' })).status).toBe(204);
    expect(db.list('orders')).toHaveLength(1);
    expect(original).not.toHaveBeenCalled();
  });

  it('評価できない when.if はエラーを通知して偽として扱う', async () => {
    router.setRoutes(parseApiSpec({ routes: [{ method: 'GET', path: '/x', when: [{ if: 'nope.x ==', status: 500 }], status: 200, body: { ok: true } }] }).spec.routes);
    const res = await fetch('/api/x');
    expect(res.status).toBe(200);
    expect(errors[0]).toContain('条件式を評価できません');
  });

  it('uninstall で元の fetch に戻す', async () => {
    interceptor.uninstall();
    await fetch('/api/orders');
    expect(original).toHaveBeenCalledTimes(1);
  });
});

describe('evalCondition', () => {
  const scope = {
    body: { sku: 'A-100', quantity: 3, name: '太郎', flag: true },
    params: { id: '2' },
    query: { q: 'x' },
    hasTable: (t: string) => t === 'stock',
    lookup: (_t: string, k: unknown) => (k === 'A-100' ? { sku: 'A-100', qty: 2 } : undefined),
  };
  it.each([
    ['stock[body.sku].qty < body.quantity', true],
    ['stock[body.sku].qty >= body.quantity', false],
    ['stock["B-200"].qty < 1', false],
    ['params.id == 2', true],
    ["params.id == '2' && query.q != 'y'", true],
    ['!(body.quantity > 2) || body.flag == false', false],
    ['body.name == "太郎"', true],
    ['body.quantity <= -1', false],
    ['body.flag', true],
  ])('%s → %s', (expr, value) => {
    expect(evalCondition(expr, scope)).toEqual({ value });
  });
  it.each(['foo.bar', 'body.', 'body.x ==', 'orders[1].x', '(body.x', 'body.x === 1', 'alert(1)'])('評価できない式 %s は偽＋エラー', (expr) => {
    const r = evalCondition(expr, scope);
    expect(r.value).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('parseApiSpec / matchPath / MemoryDb', () => {
  it('形式違反を報告し、正しい項目だけ残す', () => {
    const { spec, errors } = parseApiSpec({ base: 'api', tables: ['a', 3], routes: [{ method: 'GET' }, { method: 'get', path: '/a', op: 'list', table: 'a' }, { method: 'GET', path: '/b', op: 'bad', table: 'a' }] });
    expect(spec.base).toBe('/api');
    expect(spec.tables).toEqual([{ name: 'a', key: 'id' }]);
    expect(spec.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /a']);
    expect(errors).toHaveLength(4);
  });
  it('パスのパラメータ', () => {
    expect(matchPath('/orders/:id', '/orders/3')).toEqual({ id: '3' });
    expect(matchPath('/orders/:id', '/orders')).toBeNull();
    expect(matchPath('/drafts/current', '/drafts/current')).toEqual({});
  });
  it('fixtures を順に重ね、キーなしの insert は採番する', () => {
    const db = new MemoryDb();
    db.reset([{ name: 'stock', key: 'sku' }], [{ stock: [{ sku: 'A', qty: 1 }], orders: [{ id: 5 }] }, { stock: [{ sku: 'A', qty: 9 }] }]);
    expect(db.get('stock', 'A')).toEqual({ sku: 'A', qty: 9 });
    expect(db.insert('orders', { x: 1 })).toEqual({ x: 1, id: 6 });
    expect(db.insert('orders', { id: 5, x: 2 })).toEqual({ id: 5, x: 2 });
    expect(db.list('orders')).toHaveLength(2);
    expect(db.list('orders', { x: 2 })).toEqual([{ id: 5, x: 2 }]);
  });
});
