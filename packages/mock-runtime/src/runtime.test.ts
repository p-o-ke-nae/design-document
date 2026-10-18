// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { executeStep, type Step } from '@ddv/mock/step';
import { submitTransition } from './binder.ts';
import { MockRuntime } from './runtime.ts';

const API = `
tables: [orders, { name: stock, key: sku }]
routes:
  - { method: GET, path: /orders, op: list, table: orders }
  - method: POST
    path: /orders
    when:
      - if: "stock[body.sku].qty < body.quantity"
        status: 409
        body: { message: 在庫が不足しています }
    op: insert
    table: orders
    set: { status: Submitted }
  - { method: POST, path: /fail, status: 500, body: { message: サーバエラー } }
`;

const FIXTURE = `
orders:
  - { id: 1, customer: 既存, sku: A-100, quantity: 1 }
stock:
  - { sku: A-100, qty: 5 }
`;

const HTML = `
<section data-screen="List">
  <ul data-testid="orders" data-bind="/orders"><template><li>{{id}}: {{customer}}</li></template></ul>
  <button data-testid="new" data-event="新規" data-goto="Input">新規</button>
</section>
<section data-screen="Input" hidden>
  <input data-testid="customer" required maxlength="10" />
  <select data-testid="sku"><option value="">-</option><option value="A-100">A-100 ペン</option></select>
  <input data-testid="quantity" type="number" min="1" max="99" required />
  <input data-testid="gift" type="checkbox" />
  <p data-testid="error" data-error hidden>入力内容を確認してください</p>
  <button data-testid="next" data-event="確定" data-validate data-submit="POST /orders" data-ok="Done">確定</button>
  <button data-testid="plain" data-submit="POST /orders" data-ok="Done">検査なし</button>
  <button data-testid="ng" data-submit="POST /fail" data-ng="List">NG画面へ</button>
  <button data-testid="cancel" data-event="キャンセル" data-goto="List">キャンセル</button>
</section>
<section data-screen="Done" hidden>
  <p data-testid="done-message">注文を受け付けました</p>
  <button data-testid="back" data-goto="List">一覧へ</button>
</section>`;

let rt: MockRuntime | null = null;
afterEach(() => {
  rt?.dispose();
  rt = null;
  document.body.innerHTML = '';
});

async function boot(files: Record<string, string> = { 'api.yaml': API, 'fixtures/default.yaml': FIXTURE }, html = HTML) {
  document.body.innerHTML = html;
  rt = new MockRuntime({ win: window, load: async (rel) => files[rel] ?? null });
  await rt.start();
  return rt;
}

const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const val = (id: string, v: string) => ((el(id) as HTMLInputElement).value = v);
const visible = (id: string) => !el(id).hasAttribute('hidden');

async function click(r: MockRuntime, id: string) {
  el(id).click();
  await r.binder.settled();
}

describe('submitTransition', () => {
  it('[DD-MOCKRT-SUBMIT-X001] [DD-MOCKRT-SUBMIT-X002] [DD-MOCKRT-SUBMIT-X003] [DD-MOCKRT-SUBMIT-X004] [DD-MOCKRT-SUBMIT-X005] [DD-MOCKRT-SUBMIT-X006] [DD-MOCKRT-SUBMIT-X007] [DD-MOCKRT-SUBMIT-X008] 図にないイベントは無視する', () => {
    expect(submitTransition('Idle', { type: 'check', ok: true })).toBeNull();
    expect(submitTransition('Idle', { type: 'response', ok: true })).toBeNull();
    expect(submitTransition('Validating', { type: 'click', validate: true })).toBeNull();
    expect(submitTransition('Validating', { type: 'response', ok: true })).toBeNull();
    expect(submitTransition('Sending', { type: 'click', validate: false })).toBeNull();
    expect(submitTransition('Sending', { type: 'check', ok: true })).toBeNull();
    expect(submitTransition('ShowError', { type: 'check', ok: false })).toBeNull();
    expect(submitTransition('ShowError', { type: 'response', ok: true })).toBeNull();
  });
});

describe('DeclarativeBinder', () => {
  it('[DD-MOCKRT-SUBMIT-T001] [DD-MOCKRT-SUBMIT-T002] [DD-MOCKRT-SUBMIT-T004] data-validate ありで検査 NG ならエラーを表示して留まる', async () => {
    const r = await boot();
    await click(r, 'new');
    expect(r.binder.submitState(el('next'))).toBe('Idle');
    val('customer', '');
    await click(r, 'next');
    expect(r.screens.current).toBe('Input');
    expect(visible('error')).toBe(true);
    expect(el('error').textContent).toBe('入力内容を確認してください');
    expect(r.binder.submitState(el('next'))).toBe('ShowError');
    expect(r.db.list('orders')).toHaveLength(1);
  });

  it('[DD-MOCKRT-SUBMIT-T005] [DD-MOCKRT-SUBMIT-T006] 検査 OK なら送信し、2xx で data-ok の画面へ', async () => {
    const r = await boot();
    await click(r, 'new');
    val('customer', '山田');
    val('sku', 'A-100');
    val('quantity', '2');
    (el('gift') as HTMLInputElement).checked = true;
    await click(r, 'next');
    expect(r.screens.current).toBe('Done');
    expect(r.binder.submitState(el('next'))).toBe('Idle');
    expect(r.db.list('orders')[1]).toEqual({ id: 2, customer: '山田', sku: 'A-100', quantity: 2, gift: true, status: 'Submitted' });
  });

  it('[DD-MOCKRT-SUBMIT-T003] [DD-MOCKRT-SUBMIT-T007] data-validate なしは検査せず送信し、2xx 以外は data-error に message を表示する', async () => {
    const r = await boot();
    await click(r, 'new');
    val('customer', '');
    val('sku', 'A-100');
    val('quantity', '9');
    await click(r, 'plain');
    expect(r.screens.current).toBe('Input');
    expect(r.binder.submitState(el('plain'))).toBe('ShowError');
    expect(visible('error')).toBe(true);
    expect(el('error').textContent).toBe('在庫が不足しています');
  });

  it('[DD-MOCKRT-SUBMIT-T008] [DD-MOCKRT-SUBMIT-T009] エラー表示から再クリックすると検査（data-validate あり）または送信（なし）に進む', async () => {
    const r = await boot();
    await click(r, 'new');
    val('customer', '');
    val('sku', 'A-100');
    val('quantity', '1');
    await click(r, 'next');
    expect(r.binder.submitState(el('next'))).toBe('ShowError');
    val('customer', '佐藤');
    await click(r, 'next');
    expect(r.screens.current).toBe('Done');
    expect(r.binder.submitState(el('next'))).toBe('Idle');

    await click(r, 'back');
    await click(r, 'new');
    val('quantity', '50');
    await click(r, 'plain');
    expect(r.binder.submitState(el('plain'))).toBe('ShowError');
    val('quantity', '1');
    await click(r, 'plain');
    expect(r.screens.current).toBe('Done');
    expect(r.binder.submitState(el('plain'))).toBe('Idle');
  });

  it('[DD-MOCKRT-SUBMIT-X005] 送信中の再クリックは無視する', async () => {
    const r = await boot();
    let calls = 0;
    let release!: () => void;
    r.route('POST /orders', () => {
      calls++;
      return new Promise((res) => (release = () => res({ status: 201, body: {} })));
    });
    await click(r, 'new');
    el('plain').click();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.binder.submitState(el('plain'))).toBe('Sending');
    el('plain').click();
    await new Promise((res) => setTimeout(res, 0));
    expect(calls).toBe(1);
    release();
    await r.binder.settled();
    expect(r.screens.current).toBe('Done');
  });

  it('2xx 以外で data-ng があればその画面へ', async () => {
    const r = await boot();
    await click(r, 'new');
    await click(r, 'ng');
    expect(r.screens.current).toBe('List');
  });

  it('data-bind は表示のたびに取り直し、{{列}} はテキストとして置換する', async () => {
    const r = await boot({ 'api.yaml': API, 'fixtures/default.yaml': 'orders:\n  - { id: 1, customer: "<b>x</b>" }\n' });
    expect(r.driver.count('orders')).toBe(1);
    expect(el('orders').querySelector('b')).toBeNull();
    expect(el('orders').textContent).toContain('1: <b>x</b>');
    r.db.insert('orders', { customer: '追加' });
    await click(r, 'new');
    await click(r, 'cancel');
    expect(r.driver.count('orders')).toBe(2);
  });
});

describe('MockRuntime + DomDriver', () => {
  it('2 画面のモックを executeStep で入力 → 送信 → 画面遷移 → 期待値まで実行できる', async () => {
    const r = await boot();
    expect(r.state).toBe('Ready');
    expect(r.screens.current).toBe('List');
    const steps: Step[] = [
      { event: '新規', click: 'new', expect: { screen: 'Input', hidden: ['error'] } },
      { event: '確定 [入力NG]', input: { customer: '', sku: 'A-100', quantity: 1 }, click: 'next', expect: { screen: 'Input', visible: ['error'] } },
      { event: '確定 [入力OK]', input: { customer: '山田 太郎', sku: 'A-100', quantity: 2, gift: true }, click: 'next', expect: { screen: 'Done', text: { 'done-message': '注文を受け付けました' } } },
    ];
    for (const s of steps) await executeStep(r.driver, s, { timeoutMs: 0 });
    expect(r.db.list('orders').map((o) => o.customer)).toEqual(['既存', '山田 太郎']);
  });

  it('window.__ddv 互換の reset / step（fixtures を重ね、start を表示）と on / op', async () => {
    const r = await boot({ 'api.yaml': API, 'fixtures/default.yaml': FIXTURE, 'fixtures/more.yaml': 'orders:\n  - { id: 2, customer: 追加 }\n' });
    const shown: string[] = [];
    r.on('screen:Input', (ctx) => void shown.push(ctx.screen));
    r.op('fill-sample', ({ root }) => {
      (root.querySelector('[data-testid="customer"]') as HTMLInputElement).value = 'サンプル';
    });
    expect(await r.reset(['default', 'more'])).toEqual({ screen: 'List' });
    expect(r.driver.count('orders')).toBe(2);
    const a = await r.step({ event: '新規', click: 'new', expect: { screen: 'Input' } });
    expect(a).toEqual({ ok: true, screen: 'Input', failures: [] });
    expect(shown).toEqual(['Input']);
    const b = await r.step({ event: 'x', do: 'fill-sample', expect: { screen: 'Input', text: { customer: 'サンプル' } } });
    expect(b.ok).toBe(true);
    const c = await r.step({ event: 'キャンセル', click: 'cancel', expect: { screen: 'Input', count: { orders: 5 } } });
    expect(c.ok).toBe(false);
    expect(c.screen).toBe('List');
    expect(c.failures).toEqual([
      { key: 'screen', expected: 'Input', actual: 'List' },
      { key: 'count:orders', expected: 5, actual: 2 },
    ]);
    const d = await r.step({ event: 'x', click: 'missing', expect: { screen: 'List' } });
    expect(d.error).toMatchObject({ kind: 'notFound', key: 'missing' });
    expect(await r.reset([], 'Done')).toEqual({ screen: 'Done' });
    await expect(r.reset(['nothing'])).rejects.toThrow('fixtures/nothing.yaml');
    expect(r.state).toBe('Broken');
  });

  it('reset の data は fixtures のファイルを読まずにその内容を使う（編集中の再生・DD-TDEDIT）', async () => {
    const r = await boot({ 'api.yaml': API, 'fixtures/default.yaml': FIXTURE, 'fixtures/more.yaml': 'orders:\n  - { id: 2, customer: 追加 }\n' });
    expect(await r.reset(['default', 'more'], undefined, { default: { orders: [{ id: 7, customer: '編集中' }] } })).toEqual({ screen: 'List' });
    expect(r.db.list('orders').map((o) => o.customer)).toEqual(['編集中', '追加']);
    expect(await r.reset(['draft-only'], undefined, { 'draft-only': { orders: [] } })).toEqual({ screen: 'List' });
    expect(r.driver.count('orders')).toBe(0);
  });

  it('dump は全テーブルの写しを定義の順に返す（証跡の db: mock）', async () => {
    const r = await boot({ 'api.yaml': API, 'fixtures/default.yaml': FIXTURE });
    const d = r.dump();
    expect(d.map((t) => [t.name, t.key])).toEqual(r.db.all().map((t) => [t.name, t.key]));
    const orders = d.find((t) => t.name === 'orders')!;
    expect(orders.rows).toEqual(r.db.list('orders'));
    orders.rows[0].customer = '書き換え';
    expect(r.db.list('orders')[0].customer).not.toBe('書き換え');
  });

  it('api.yaml がなければルートなし（404）、fixtures/default.yaml がなければ空の DB で起動する', async () => {
    const r = await boot({});
    expect(r.state).toBe('Ready');
    expect(r.driver.count('orders')).toBe(0);
    expect((await fetch('/api/orders')).status).toBe(404);
  });
});

describe('操作のハイライト', () => {
  async function bootWithSleep(log: Array<{ ms: number; lit: string[] }>) {
    document.getElementById('ddv-highlight-style')?.remove();
    document.body.innerHTML = HTML;
    rt = new MockRuntime({
      win: window,
      load: async (rel) => ({ 'api.yaml': API, 'fixtures/default.yaml': FIXTURE })[rel] ?? null,
      sleep: async (ms) => {
        log.push({ ms, lit: Array.from(document.querySelectorAll('[data-ddv-highlight]')).map((e) => e.getAttribute('data-testid') ?? '') });
      },
    });
    await rt.start();
    return rt;
  }
  const step: Step = { event: '確定', input: { customer: '山田', quantity: 2 }, click: 'next', expect: { screen: 'Done' } };

  it('highlight ありなら入力・クリックする要素を 1 つずつ枠で示して holdMs 待ってから操作し、終われば外す', async () => {
    const log: Array<{ ms: number; lit: string[] }> = [];
    const r = await bootWithSleep(log);
    await r.exec({ event: '新規', click: 'new', expect: { screen: 'Input' } });
    log.length = 0;
    const res = await r.exec(step, { highlight: { holdMs: 300 } });
    expect(res.ok).toBe(true);
    expect(log).toEqual([
      { ms: 300, lit: ['customer'] },
      { ms: 300, lit: ['quantity'] },
      { ms: 300, lit: ['next'] },
    ]);
    expect(document.querySelectorAll('[data-ddv-highlight]').length).toBe(0);
    expect(document.getElementById('ddv-highlight-style')).not.toBeNull();
  });

  it('holdMs 0（最速）は枠を付けるが待たない。highlight なしは枠を付けない', async () => {
    const log: Array<{ ms: number; lit: string[] }> = [];
    const r = await bootWithSleep(log);
    const seen: string[] = [];
    const orig = r.driver.click.bind(r.driver);
    await r.exec({ event: '新規', click: 'new', expect: { screen: 'Input' } });
    expect(document.getElementById('ddv-highlight-style')).toBeNull();
    r.driver.click = async (k: string) => {
      el(k).addEventListener('click', () => seen.push(el(k).hasAttribute('data-ddv-highlight') ? 'lit' : 'plain'), { once: true });
      return orig(k);
    };
    await r.exec({ event: 'キャンセル', click: 'cancel', expect: { screen: 'List' } }, { highlight: { holdMs: 0 } });
    await r.exec({ event: '新規', click: 'new', expect: { screen: 'Input' } });
    expect(seen).toEqual(['lit', 'plain']);
    expect(log).toEqual([]);
  });
});

describe('TraceTap（DD-TRREC mock-runtime の記録）', () => {
  it('begin から take までの API 呼び出し（本文付き）と DB の変化を返し、begin していなければ記録しない', async () => {
    const r = await boot();
    await click(r, 'new');
    val('customer', '山田');
    val('sku', 'A-100');
    val('quantity', '2');
    await click(r, 'next');
    expect(r.trace.recording).toBe(false);
    expect(r.trace.take().calls).toEqual([]);

    await click(r, 'back');
    await click(r, 'new');
    val('customer', '佐藤');
    val('sku', 'A-100');
    val('quantity', '1');
    r.trace.begin();
    expect(r.trace.recording).toBe(true);
    await click(r, 'next');
    const t = r.trace.take();
    expect(r.trace.recording).toBe(false);
    const post = t.calls.find((c) => c.method === 'POST')!;
    expect(post).toMatchObject({ path: '/api/orders', status: 201 });
    expect(JSON.parse(post.requestBody!)).toMatchObject({ customer: '佐藤', quantity: 1 });
    expect(JSON.parse(post.responseBody!)).toMatchObject({ id: 3, status: 'Submitted' });
    expect(post.durationMs).toBeGreaterThanOrEqual(0);
    expect(t.db).toEqual([{ table: 'orders', kind: 'added', key: '3', after: expect.objectContaining({ id: 3, customer: '佐藤' }) }]);
  });

  it('BridgeEngine の traceBegin / traceTake / observe（ライブ表示）', async () => {
    const r = await boot();
    const s: Step = { event: '新規', click: 'new', expect: { screen: 'Input', visible: ['customer'] } };
    r.traceBegin();
    const res = await r.exec(s);
    expect(res.ok).toBe(true);
    expect(r.traceTake()).toEqual({ calls: [], db: [] });
    expect(await r.observe(s)).toEqual([
      { kind: 'screen', key: '', expected: 'Input', actual: 'Input', ok: true },
      { kind: 'visible', key: 'customer', expected: true, actual: true, ok: true },
    ]);
  });
});
