import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import { BrowserLauncher } from './browser.ts';
import { ScreenMapSchema } from './map.ts';
import { runScenario } from './run-scenario.ts';
import { startStaticServer, type StaticServer } from './static-server.ts';
import { StepError } from './step.ts';
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

let dir = '';
let server: StaticServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-pw-'));
  await fs.mkdir(path.join(dir, 'demo'), { recursive: true });
  await fs.writeFile(path.join(dir, 'demo/index.html'), MOCK);
  await fs.writeFile(path.join(dir, 'app.html'), APP);
  server = await startStaticServer(dir);
  browser = await new BrowserLauncher(undefined, { env: {} }).launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

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
    const map = ScreenMapSchema.parse({
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
