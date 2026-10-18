import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import { BrowserLauncher } from './browser.ts';
import { screenMapFrom } from './map.ts';
import { runScenario } from './run-scenario.ts';
import { startStaticServer, type StaticServer } from './static-server.ts';
import { StepError } from './step.ts';
import { TraceRecorder, type TraceFile } from './trace.ts';
import type { Scenario } from './types.ts';

const MOCK = `<!doctype html><html><body>
<section data-screen="List"><button data-testid="new" data-event="新規">新規</button><ul><li data-testid="row">a</li><li data-testid="row">b</li></ul></section>
<section data-screen="Input" hidden>
  <input data-testid="customer"><input type="number" data-testid="qty"><select data-testid="sku"><option value="">-</option><option value="A-100">A</option></select>
  <input type="checkbox" data-testid="gift"><p data-testid="error" hidden>必須です</p>
  <button data-testid="next" data-event="次へ">次へ</button>
</section>
<section data-screen="Confirm" hidden><span data-testid="out"></span></section>
<script>
const show = (id) => document.querySelectorAll('[data-screen]').forEach((s) => (s.hidden = s.dataset.screen !== id));
const $ = (k) => document.querySelector('[data-testid="' + k + '"]');
$('new').onclick = () => show('Input');
$('next').onclick = () => {
  if (!$('customer').value) { $('error').hidden = false; return; }
  $('out').textContent = [$('customer').value, $('qty').value, $('sku').value, $('gift').checked].join('/');
  show('Confirm');
};
window.__ddv = { ready: Promise.resolve(), async reset(f, start) { window.__fixtures = f; show(start || 'List'); return { screen: start }; } };
</script></body></html>`;

// "Real app": no ddv attributes, screens by URL hash / heading.
const APP = `<!doctype html><html><body>
<h1 id="title">一覧</h1><a id="add" href="#/new">追加</a><input id="name"><button id="go">送信</button><div class="row">x</div>
<script>
const render = () => { const n = location.hash === '#/new'; document.getElementById('title').textContent = n ? '入力' : '一覧'; document.getElementById('name').hidden = !n; };
window.addEventListener('hashchange', render); render();
document.getElementById('go').onclick = () => { document.getElementById('title').textContent = '完了:' + document.getElementById('name').value; history.replaceState(null, '', '#/done'); };
</script></body></html>`;

// Real app for auxiliary clicks: a mapped button, a data-testid button and the transition button.
const AUX = `<!doctype html><html><body>
<h1 id="title">一覧</h1><p id="log"></p><button id="close-x">閉じる</button><button data-testid="dismiss">消す</button><button id="go">送信</button>
<script>
const log = (c) => (document.getElementById('log').textContent += c);
document.getElementById('close-x').onclick = () => log('X');
document.querySelector('[data-testid="dismiss"]').onclick = () => log('D');
document.getElementById('go').onclick = () => { log('G'); document.getElementById('title').textContent = '完了'; };
</script></body></html>`;

// Mock whose runtime exposes a fake `__ddv.trace` (begin / take).
const TRACED = MOCK.replace(
  'window.__ddv = {',
  'window.__ddv = { trace: { begin() { window.__began = (window.__began || 0) + 1; }, take() { return { calls: [{ method: "POST", path: "/api/orders", status: 201, durationMs: 1 }], db: [{ table: "orders", kind: "added", key: "1", after: { id: 1 } }] }; } },',
);

// Real app that calls fetch: same-origin JSON, a failing request and one that never finishes.
const FETCHING = `<!doctype html><html><body><h1 id="title">一覧</h1><button id="load">読込</button>
<script>
document.getElementById('load').onclick = async () => {
  fetch('http://127.0.0.1:1/down').catch(() => {});
  fetch('slow?x=1');
  await fetch('post-me', { method: 'POST', body: '{"q":1}' });
  const d = await (await fetch('data.json?q=1')).json();
  document.getElementById('title').textContent = '読込:' + d.name;
};
</script></body></html>`;

// Launching / closing Chromium can exceed the default 10 s while the whole suite runs in parallel.
const HOOK_TIMEOUT = 60_000;
let dir = '';
let server: StaticServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-pw-'));
  await fs.mkdir(path.join(dir, 'demo'), { recursive: true });
  await fs.writeFile(path.join(dir, 'demo/index.html'), MOCK);
  await fs.writeFile(path.join(dir, 'app.html'), APP);
  await fs.writeFile(path.join(dir, 'aux.html'), AUX);
  await fs.mkdir(path.join(dir, 'traced'), { recursive: true });
  await fs.writeFile(path.join(dir, 'traced/index.html'), TRACED);
  await fs.writeFile(path.join(dir, 'fetching.html'), FETCHING);
  await fs.writeFile(path.join(dir, 'data.json'), '{"name":"太郎"}');
  server = await startStaticServer(dir);
  browser = await new BrowserLauncher(undefined, { env: {} }).launch();
  page = await browser.newPage();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await fs.rm(dir, { recursive: true, force: true });
}, HOOK_TIMEOUT);

describe('runScenario / PlaywrightDriver', () => {
  it('モック: data-screen / data-testid で操作・判定し、各ステップ後に onStep を呼ぶ', async () => {
    const s: Scenario = {
      id: 'BD-X-Y-P001',
      title: 't',
      fixtures: ['default'],
      start: 'List',
      steps: [
        { event: '新規', click: 'new', expect: { screen: 'Input', hidden: ['error'] } },
        { event: '次へ [入力NG]', input: { customer: '' }, click: 'next', expect: { screen: 'Input', visible: ['error'] } },
        { event: '次へ [入力OK]', input: { customer: '山田', qty: 2, sku: 'A-100', gift: true }, click: 'next', expect: { screen: 'Confirm', text: { out: '山田/2/A-100/true' } } },
      ],
    };
    const seen: number[] = [];
    await runScenario(page, s, { kind: 'mock', url: `${server.url}demo/index.html` }, { onStep: (i) => void seen.push(i), timeout: 1000 });
    expect(seen).toEqual([0, 1, 2]);
    expect(await page.evaluate(() => (window as any).__fixtures)).toEqual(['default']);
  });

  it('モック: 期待値の不一致はステップ番号付きの StepError', async () => {
    const s: Scenario = { id: 'x', title: '', fixtures: [], start: 'List', steps: [{ event: '新規', click: 'new', expect: { screen: 'Confirm', count: { row: 2 } } }] };
    const err = await runScenario(page, s, { kind: 'mock', url: `${server.url}demo/index.html` }, { timeout: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.message).toMatch(/^ステップ 1（新規）: 期待値と一致しません/);
    expect(err.failures.map((f: any) => f.key)).toEqual(['screen', 'count:row']);
  });

  it('モック: 表示中の画面にない操作要素は notFound', async () => {
    const s: Scenario = { id: 'x', title: '', fixtures: [], start: 'List', steps: [{ event: '次へ', click: 'next', expect: { screen: 'Confirm' } }] };
    const err = await runScenario(page, s, { kind: 'mock', url: `${server.url}demo/index.html` }, { timeout: 200 }).catch((e) => e);
    expect(err.kind).toBe('notFound');
  });

  it('実アプリ: _map.yaml で画面・イベント・項目を解決し、seed と do を呼ぶ', async () => {
    const map = screenMapFrom({
      screens: { List: { url: '/app\\.html$', selector: "h1:text-is('一覧')" }, Input: { selector: "h1:text-is('入力')" }, Done: { selector: "h1:has-text('完了')" } },
      events: { 新規: '#add', 送信: '#go' },
      fields: { customer: '#name', title: '#title' },
    });
    const calls: string[] = [];
    const hooks = {
      seed: (f: string[]) => void calls.push(`seed:${f.join(',')}`),
      steps: { 印: async (p: Page) => void calls.push(`do:${await p.title()}`) },
    };
    const s: Scenario = {
      id: 'x',
      title: '',
      fixtures: ['default'],
      start: 'List',
      steps: [
        { event: '新規', click: 'new', expect: { screen: 'Input' } },
        { event: '送信 [OK]', input: { customer: '山田' }, do: '印', click: 'next', expect: { screen: 'Done', text: { title: '完了:山田' } } },
      ],
    };
    await runScenario(page, s, { kind: 'app', url: `${server.url}app.html`, map, hooks }, { timeout: 1000 });
    expect(calls).toEqual(['seed:default', 'do:']);
    const missing: Scenario = { ...s, steps: [{ event: '削除', click: 'del', expect: { screen: 'List' } }] };
    const err = await runScenario(page, missing, { kind: 'app', url: `${server.url}app.html`, map }, { timeout: 200 }).catch((e) => e);
    expect(err.message).toContain('対応表（_map.yaml）にイベント 削除 がありません');
  });
});

describe('Web の補助ステップのクリック（DD-DSCN-WCLICK）', () => {
  const map = screenMapFrom({
    screens: { List: { selector: "h1:text-is('一覧')" }, Done: { selector: "h1:text-is('完了')" } },
    events: { 送信: '#go', 消す: '#close-x' },
    fields: { closeDialog: '#close-x', log: '#log' },
  });
  const run = (steps: Scenario['steps'], timeout = 1000) => runScenario(page, { id: 'x', title: '', fixtures: [], start: 'List', steps }, { kind: 'app', url: `${server.url}aux.html`, map }, { timeout });

  it('[DD-DSCN-WCLICK-P001][DD-DSCN-WCLICK-T001][DD-DSCN-WCLICK-T002] モックは補助ステップでも表示中の画面内の data-testid をクリックする', async () => {
    const s: Scenario = { id: 'x', title: '', fixtures: [], start: 'List', steps: [{ click: 'new', expect: { screen: 'Input' } }, { click: 'new', only: 'desktop' }, { input: { customer: '山田' }, click: 'next', expect: { screen: 'Confirm', visible: ['out'] } }] };
    const seen: number[] = [];
    await runScenario(page, s, { kind: 'mock', url: `${server.url}demo/index.html` }, { onStep: (i) => void seen.push(i), timeout: 1000 });
    expect(seen).toEqual([0, 2]);
    expect(await page.textContent('[data-testid="out"]')).toBe('山田///false');
    const err = await runScenario(page, { ...s, steps: [{ click: 'next' }] }, { kind: 'mock', url: `${server.url}demo/index.html` }, { timeout: 200 }).catch((e) => e);
    expect(err.message).toBe('ステップ 1（補助・next）: 操作要素が見つかりません: next（画面 List）');
  });
  it('[DD-DSCN-WCLICK-P002][DD-DSCN-WCLICK-T003][DD-DSCN-WCLICK-T004] 実アプリで event があれば map.events のイベントの要素をクリックする', async () => {
    await run([{ event: '送信', click: 'unused', expect: { screen: 'Done', text: { log: 'G' } } }]);
  });
  it('[DD-DSCN-WCLICK-P003][DD-DSCN-WCLICK-T005][DD-DSCN-WCLICK-T006] 実アプリの補助ステップは map.fields の読み替え先をクリックする（同名のイベントは使わない）', async () => {
    await run([{ click: 'closeDialog', expect: { text: { log: 'X' } } }]);
    const err = await run([{ click: '消す' }], 200).catch((e) => e);
    expect(err.kind).toBe('notFound');
    expect(err.message).toBe('ステップ 1（補助・消す）: 操作要素が見つかりません: 消す（[data-testid="消す"]）');
  });
  it('[DD-DSCN-WCLICK-P004][DD-DSCN-WCLICK-T007] 実アプリで map.fields に無ければ [data-testid=key] をクリックする', async () => {
    await run([{ click: 'dismiss', expect: { screen: 'List', text: { log: 'D' } } }, { click: 'closeDialog' }, { event: '送信', click: 'go', expect: { screen: 'Done', text: { log: 'DXG' } } }]);
  });
});

describe('runScenario のトレース記録（DD-TRREC）', () => {
  const readTrace = async (d: string, id: string) => JSON.parse(await fs.readFile(path.join(d, `${id}.json`), 'utf8')) as TraceFile;
  const meta = (id: string, target: 'mock' | 'app') => ({ runId: 'r1', testId: id, title: 't', mock: 'demo', target });

  it('モック: 失敗したステップまで記録し、window.__ddv.trace の通信・DB・スクリーンショット・期待の観測を書いてから既存の文言で投げる', async () => {
    const out = path.join(dir, 'traces', 'r1');
    const s: Scenario = {
      id: 'BD-X-Y-P002',
      title: 't',
      fixtures: [],
      start: 'List',
      steps: [
        { event: '新規', click: 'new', expect: { screen: 'Input' } },
        { event: '次へ [入力NG]', input: { customer: '' }, click: 'next', expect: { screen: 'Confirm', text: { out: '山田' } } },
        { event: '戻る', click: 'back', expect: { screen: 'List' } },
      ],
    };
    const rec = new TraceRecorder(out, meta(s.id, 'mock'));
    const err = await runScenario(page, s, { kind: 'mock', url: `${server.url}traced/index.html` }, { timeout: 200, trace: rec }).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.message).toMatch(/^ステップ 2（次へ \[入力NG\]）: 期待値と一致しません/);
    expect(await page.evaluate(() => (window as any).__began)).toBe(2);
    const t = await readTrace(out, s.id);
    expect(t).toMatchObject({ status: 'failed', failedStep: 2, error: err.message, target: 'mock' });
    expect(t.steps).toHaveLength(2);
    expect(t.steps[0]).toMatchObject({ index: 1, event: '新規', click: 'new', screenBefore: 'List', screenAfter: 'Input', ok: true, calls: [{ method: 'POST', path: '/api/orders', status: 201 }], db: [{ kind: 'added' }], screenshot: `${s.id}/1.png` });
    expect(t.steps[1]).toMatchObject({ index: 2, input: { customer: '' }, screenBefore: 'Input', screenAfter: 'Input', ok: false, error: err.message });
    expect(t.steps[1].expects).toEqual([
      { kind: 'screen', key: '', expected: 'Confirm', actual: 'Input', ok: false },
      { kind: 'text', key: 'out', expected: '山田', actual: '', ok: false },
    ]);
    expect((await fs.stat(path.join(out, s.id, '2.png'))).size).toBeGreaterThan(0);
  });

  it('実アプリ: fetch・xhr の通信を記録し（同じオリジンはパスとクエリ、失敗は 0、未完了は -1）、db は null', async () => {
    const out = path.join(dir, 'traces', 'r2');
    await page.route('**/slow*', () => {});
    await page.route('**/post-me', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"message":"在庫が不足しています"}' }));
    try {
      const map = screenMapFrom({ screens: { List: { selector: "h1:text-is('一覧')" }, Loaded: { selector: "h1:has-text('読込:')" } }, events: { 読込: '#load' }, fields: { title: '#title' } });
      const s: Scenario = { id: 'BD-X-Y-P003', title: 't', fixtures: [], start: 'List', steps: [{ event: '読込', click: 'load', expect: { screen: 'Loaded', text: { title: '読込:太郎' } } }] };
      const rec = new TraceRecorder(out, meta(s.id, 'app'));
      await runScenario(page, s, { kind: 'app', url: `${server.url}fetching.html`, map }, { timeout: 2000, trace: rec });
      const t = await readTrace(out, s.id);
      expect(t.status).toBe('passed');
      const [st] = t.steps;
      expect(st).toMatchObject({ index: 1, screenBefore: 'List', screenAfter: 'Loaded', ok: true, db: null });
      const byPath = Object.fromEntries(st.calls.map((c) => [c.path, c]));
      expect(byPath['/data.json?q=1']).toMatchObject({ method: 'GET', status: 200, responseBody: '{"name":"太郎"}' });
      expect(byPath['/post-me']).toMatchObject({ method: 'POST', status: 409, requestBody: '{"q":1}', responseBody: '{"message":"在庫が不足しています"}' });
      expect(byPath['/slow?x=1']).toMatchObject({ status: -1 });
      expect(byPath['http://127.0.0.1:1/down']).toMatchObject({ status: 0 });
      expect(byPath['http://127.0.0.1:1/down'].responseBody).toBeTruthy();
    } finally {
      await page.unroute('**/slow*');
      await page.unroute('**/post-me');
    }
  });

  it('ステップの前の失敗は failedStep 0・steps 空を書いてから投げる', async () => {
    const out = path.join(dir, 'traces', 'r3');
    const map = screenMapFrom({});
    const rec = new TraceRecorder(out, meta('BD-X-Y-P004', 'app'));
    const s: Scenario = { id: 'BD-X-Y-P004', title: 't', fixtures: ['default'], start: 'List', steps: [{ event: '新規', click: 'new', expect: { screen: 'Input' } }] };
    const hooks = { seed: () => { throw new Error('seed に失敗'); } };
    await expect(runScenario(page, s, { kind: 'app', url: `${server.url}app.html`, map, hooks }, { trace: rec })).rejects.toThrow('seed に失敗');
    expect(await readTrace(out, s.id)).toMatchObject({ status: 'failed', failedStep: 0, error: 'seed に失敗', steps: [] });
  });
});