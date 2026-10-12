import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E_TOKEN, login } from './ddv-auth.ts';
import { createUpstream, fakeGitHub, fakeGitHubState, type FakeGitHubState } from '../apps/server/src/github-fixture.ts';

// Phase 4 段階C テストデータ編集（BD-TDATA-EDITOR / DD-TDEDIT）. Saving tests restore the sample files byte-for-byte afterwards.

const BASIC = '/#/doc?path=docs/design/basic/order.md';
const ID = 'BD-ORDER-SCREEN-P002';
const MOCK_DIR = 'examples/sample-app/docs/mocks/order';
const SCENARIO_FILE = `${MOCK_DIR}/scenarios/${ID}.yaml`;
const FIXTURE_FILE = `${MOCK_DIR}/fixtures/default.yaml`;

const originals = new Map<string, Buffer>();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  for (const f of [SCENARIO_FILE, FIXTURE_FILE]) originals.set(f, await fs.readFile(f));
});

async function restore() {
  for (const [f, b] of originals) if (!(await fs.readFile(f)).equals(b)) await fs.writeFile(f, b);
}

test.afterEach(restore);
test.afterAll(restore);

async function openFromMatrix(page: Page): Promise<Locator> {
  await page.goto(BASIC);
  const row = page.locator(`[data-testid=matrix-row][data-test-id=${ID}]`).first();
  await row.getByTestId('td-open').click();
  const panel = page.getByTestId('td-panel');
  await expect(panel.locator('.td')).toHaveAttribute('data-state', 'View');
  await expect(panel.getByTestId('td-title')).toContainText(ID);
  return panel;
}

const stateOf = (panel: Locator) => panel.locator('.td');
const stepRow = (panel: Locator, i: number) => panel.locator(`[data-testid=step-row][data-index="${i}"]`);

async function startEdit(panel: Locator) {
  await panel.getByTestId('edit').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'Editing');
}

/** Changes the customer of step 2 (input and the expected confirm text). */
async function renameCustomer(panel: Locator, name: string) {
  await stepRow(panel, 1).getByTestId('in-customer').fill(name);
  await stepRow(panel, 1).getByTestId('ex-confirm-customer').fill(name);
  await expect(panel.getByTestId('diff')).toContainText(`input: { customer: ${name}, sku: A-100, quantity: 1 }`);
}

const text = (f: string) => fs.readFile(f, 'utf8').then((t) => t.replace(/\r\n/g, '\n'));

test('[BD-TDATA-EDITOR-P009] [BD-TDATA-EDITOR-T001] [BD-TDATA-EDITOR-T009] [BD-TDATA-EDITOR-X001] [BD-TDATA-EDITOR-X002] [BD-TDATA-EDITOR-X003] [BD-TDATA-EDITOR-X004] [BD-TDATA-EDITOR-X005] マトリクスの行から開くと保存済みの内容を表示し、表示中は変更・編集中の再生・保存・取消ができない', async ({ page }) => {
  const panel = await openFromMatrix(page);
  await expect(panel.getByTestId('steps-view').locator('tbody tr')).toHaveCount(7);
  await expect(panel.getByTestId('steps-view').locator('tbody tr').nth(1)).toContainText('customer：山田 太郎');
  await expect(panel.locator('[data-testid=fixtures-view][data-table=orders] tbody tr')).toHaveCount(2);
  await expect(panel.locator('[data-testid=fixtures-view][data-table=stock]')).toContainText('A-100');
  // X001 値を変更 / X002 再生（編集中のデータ）/ X003 再生終了 / X004 保存 / X005 取消: no controls in View
  await expect(panel.locator('input, textarea')).toHaveCount(0);
  for (const id of ['preview', 'preview-badge', 'save', 'cancel']) await expect(panel.getByTestId(id)).toHaveCount(0);
  await expect(panel.getByTestId('td-play')).toBeEnabled();
  await expect(panel.getByTestId('edit')).toBeEnabled();

  await panel.getByTestId('td-close').click();
  await expect(page.getByTestId('td-panel')).toHaveCount(0);
});

test('[BD-TDATA-EDITOR-P001] [BD-TDATA-EDITOR-P007] [BD-TDATA-EDITOR-T002] [BD-TDATA-EDITOR-T003] [BD-TDATA-EDITOR-T007] [BD-TDATA-EDITOR-X006] [BD-TDATA-EDITOR-X007] 編集 → 入力値と期待値を変える → 変わる行を確認して保存すると YAML の書式を保って書き換わる', async ({ page }) => {
  const panel = await openFromMatrix(page);
  await startEdit(panel);
  // X006 編集 / X007 再生終了: not available while editing
  await expect(panel.getByTestId('edit')).toHaveCount(0);
  await expect(panel.getByTestId('preview-badge')).toHaveCount(0);
  await expect(panel.getByTestId('save')).toBeDisabled();
  await expect(panel.getByTestId('diff')).toHaveText('変更はありません');
  await expect(stepRow(panel, 0).locator('.td-gen').first()).toHaveText('新規');

  await renameCustomer(panel, '山田 花子');
  await expect(panel.getByTestId('diff').locator('.del').first()).toContainText('input: { customer: 山田 太郎, sku: A-100, quantity: 1 }');
  await expect(panel.getByTestId('save-error')).toHaveCount(0);
  await expect(panel.getByTestId('save')).toBeEnabled();
  await panel.getByTestId('save').click();

  await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
  await expect(panel.getByTestId('saved')).toHaveText('保存しました');
  await expect(panel.getByTestId('steps-view').locator('tbody tr').nth(1)).toContainText('customer：山田 花子');
  const saved = await text(SCENARIO_FILE);
  const before = originals.get(SCENARIO_FILE)!.toString('utf8').replace(/\r\n/g, '\n');
  expect(saved).toBe(before.replace('input: { customer: 山田 太郎, sku: A-100, quantity: 1 }', 'input: { customer: 山田 花子, sku: A-100, quantity: 1 }').replace('text: { confirm-customer: 山田 太郎 }', 'text: { confirm-customer: 山田 花子 }'));
  expect(saved.startsWith('# ddv mock scaffold が生成')).toBe(true);
});

test('[BD-TDATA-EDITOR-P002] [BD-TDATA-EDITOR-P008] [BD-TDATA-EDITOR-T008] 取消：変更がなければそのまま戻り、変更があれば確認してから破棄する', async ({ page }) => {
  const panel = await openFromMatrix(page);
  await startEdit(panel);
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    expect(d.message()).toBe('変更を破棄しますか');
    void (dialogs === 1 ? d.dismiss() : d.accept());
  });
  await panel.getByTestId('cancel').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
  expect(dialogs).toBe(0);

  await startEdit(panel);
  await renameCustomer(panel, '取消 太郎');
  await panel.getByTestId('cancel').click();
  await expect.poll(() => dialogs).toBe(1);
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'Editing');
  await expect(stepRow(panel, 1).getByTestId('in-customer')).toHaveValue('取消 太郎');
  await panel.getByTestId('cancel').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
  expect(dialogs).toBe(2);
  await expect(panel.getByTestId('steps-view').locator('tbody tr').nth(1)).toContainText('customer：山田 太郎');
  expect((await fs.readFile(SCENARIO_FILE)).equals(originals.get(SCENARIO_FILE)!)).toBe(true);
});

test('[BD-TDATA-EDITOR-P005] [BD-TDATA-EDITOR-T006] 検証の誤りはその場に出て保存できない → 他で変更されたら保存は 409 → 元に戻せば保存できる', async ({ page }) => {
  const panel = await openFromMatrix(page);
  await startEdit(panel);
  const orders = panel.locator('[data-testid=fx-row][data-table=orders]');
  await orders.nth(1).getByTestId('fxkey').fill('1');
  await expect(panel.getByTestId('save-error')).toContainText('キー 1 が重複しています');
  await expect(panel.getByTestId('save')).toBeDisabled();
  await orders.nth(1).getByTestId('fxkey').fill('2');
  await orders.nth(1).getByTestId('fxquantity').fill('5');
  await expect(panel.getByTestId('diff')).toContainText('quantity: 5');
  await expect(panel.getByTestId('save-error')).toHaveCount(0);
  await expect(panel.getByTestId('warnings').locator('li[data-code=sharedFixture]')).toHaveText('警告：default は他の 4 本のシナリオでも使われています');

  // 保存 [検証NG]: the file changed elsewhere after the last check
  await fs.writeFile(FIXTURE_FILE, Buffer.concat([originals.get(FIXTURE_FILE)!, Buffer.from('# changed\n')]));
  await panel.getByTestId('save').click();
  await expect(panel.getByTestId('save-error')).toContainText('他で変更されました。開き直してください');
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'Editing');
  await expect(panel.getByTestId('save')).toBeDisabled();

  await fs.writeFile(FIXTURE_FILE, originals.get(FIXTURE_FILE)!);
  await orders.nth(1).getByTestId('fxquantity').fill('6');
  await expect(panel.getByTestId('diff')).toContainText('quantity: 6');
  await expect(panel.getByTestId('save-error')).toHaveCount(0);
  await panel.getByTestId('save').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
  await expect(panel.getByTestId('saved')).toContainText('保存しました');
  expect(await text(FIXTURE_FILE)).toContain('  - { id: 2, customer: 鈴木 一郎, sku: B-200, quantity: 6, status: Submitted }');
});

test('[BD-TDATA-EDITOR-P006] 保存が 409 になったあと取消すると、ファイルは変えずに表示に戻る', async ({ page }) => {
  const panel = await openFromMatrix(page);
  await startEdit(panel);
  await renameCustomer(panel, '衝突 太郎');
  const changed = Buffer.concat([originals.get(SCENARIO_FILE)!, Buffer.from('# changed\n')]);
  await fs.writeFile(SCENARIO_FILE, changed);
  await panel.getByTestId('save').click();
  await expect(panel.getByTestId('save-error')).toContainText('他で変更されました');
  page.once('dialog', (d) => void d.accept());
  await panel.getByTestId('cancel').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
  expect((await fs.readFile(SCENARIO_FILE)).equals(changed)).toBe(true);
});

test('[BD-TDATA-EDITOR-P004] [BD-TDATA-EDITOR-T004] [BD-TDATA-EDITOR-T005] [BD-TDATA-EDITOR-X008] [BD-TDATA-EDITOR-X009] [BD-TDATA-EDITOR-X010] [BD-TDATA-EDITOR-X011] [BD-TDATA-EDITOR-X012] 編集中のデータで再生（記録しない）→ 失敗したステップを示す → 取消', async ({ page }) => {
  const played: string[] = [];
  page.on('request', (r) => r.url().includes('/api/mocks/played') && played.push(r.url()));
  const panel = await openFromMatrix(page);
  await startEdit(panel);
  await stepRow(panel, 1).getByTestId('ex-confirm-customer').fill('別の人');
  await expect(panel.getByTestId('diff')).toContainText('text: { confirm-customer: 別の人 }');
  await panel.getByTestId('preview').click();

  await expect(stateOf(panel)).toHaveAttribute('data-state', 'Previewing');
  await expect(panel.getByTestId('preview-badge')).toHaveText('編集中のデータで再生中');
  await expect(page.getByTestId('player').getByTestId('player-draft')).toBeVisible();
  // X008 編集 / X009 値を変更 / X010 再生 / X011 保存 / X012 取消
  await expect(panel.getByTestId('edit')).toHaveCount(0);
  await expect(stepRow(panel, 1).getByTestId('in-customer')).toBeDisabled();
  for (const id of ['preview', 'save', 'cancel']) await expect(panel.getByTestId(id)).toBeDisabled();

  await expect(stateOf(panel)).toHaveAttribute('data-state', 'Editing', { timeout: 30_000 });
  await expect(panel.getByTestId('preview-badge')).toHaveCount(0);
  await expect(panel.getByTestId('preview-failed')).toContainText('ステップ 2「次へ [入力OK]」で失敗');
  await expect(stepRow(panel, 1)).toHaveAttribute('data-failed', 'true');
  await expect(stepRow(panel, 1).locator('.td-cell-failed')).toHaveCount(1);
  await expect(stepRow(panel, 1).getByTestId('in-customer')).toBeEnabled();
  expect(played).toEqual([]);

  page.once('dialog', (d) => void d.accept());
  await panel.getByTestId('cancel').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
  expect((await fs.readFile(SCENARIO_FILE)).equals(originals.get(SCENARIO_FILE)!)).toBe(true);
});

test('[BD-TDATA-EDITOR-P003] 再生ツールバーから開き、編集中のデータ（fixtures の行も）で再生して通ったら保存する', async ({ page }) => {
  const played: string[] = [];
  page.on('request', (r) => r.url().includes('/api/mocks/played') && played.push(r.url()));
  await page.goto(BASIC);
  const player = page.getByTestId('player');
  await player.getByTestId('player-scenario').selectOption(ID);
  await player.getByTestId('td-open').click();
  const panel = page.getByTestId('td-panel');
  await expect(panel.getByTestId('td-title')).toContainText(ID);
  await startEdit(panel);
  await renameCustomer(panel, '山田 花子');
  // The 4th step expects 3 orders: one more row in the draft fixture makes the preview fail unless the count follows.
  await panel.locator('[data-testid=fixtures-edit][data-table=orders]').locator('..').getByTestId('fx-add-row').click();
  const added = panel.locator('[data-testid=fx-row][data-table=orders]').nth(2);
  await expect(added.getByTestId('fxkey')).toHaveValue('0');
  await added.getByTestId('fxkey').fill('3');
  await added.getByTestId('fxcustomer').fill('新規 花子');
  await added.getByTestId('fxstatus').fill('Submitted');
  await stepRow(panel, 3).getByTestId('exc-orders').fill('4');
  await expect(panel.getByTestId('diff')).toContainText('count: { orders: 4 }');
  await expect(panel.getByTestId('save-error')).toHaveCount(0);

  await panel.getByTestId('preview').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'Previewing');
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'Editing', { timeout: 30_000 });
  await expect(panel.getByTestId('preview-failed')).toHaveCount(0);
  await expect(player.getByTestId('player-status')).toHaveAttribute('data-state', 'Done');
  expect(played).toEqual([]);

  await panel.getByTestId('save').click();
  await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
  await expect(panel.getByTestId('saved')).toContainText('保存しました');
  const scenario = await text(SCENARIO_FILE);
  expect(scenario).toContain('expect: { screen: List, count: { orders: 4 } }');
  expect(scenario).toContain('input: { customer: 山田 花子, sku: A-100, quantity: 1 }');
  expect((await text(FIXTURE_FILE)).split('\n').filter((l) => l.startsWith('  - { id: 3, customer: 新規 花子,')).length).toBe(1);
});

test.describe('PR のワークスペース', () => {
  const PORT = 5190;
  const REPO = 'acme/order-app';
  const TOKEN = 'ghp_test_token';
  const WS = 'gh~acme~order-app~pr-12';
  const DOC = 'docs/design/basic/screen.md';
  let tmp = '';
  let state: FakeGitHubState;
  let api: http.Server;
  let ddv: ChildProcess | undefined;

  test.beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-e2e-td-'));
    const upstream = await createUpstream(path.join(tmp, 'remote'));
    const files: Record<string, string> = {
      [DOC]: '---\nid: SCREEN\nkind: basic\nstatus: review\ntitle: 画面\n---\n\n# 画面\n\n::mock[order/index.html]\n',
      'docs/mocks/_ddv/mock-runtime.js': await fs.readFile('examples/sample-app/docs/mocks/_ddv/mock-runtime.js', 'utf8'),
    };
    for (const f of ['index.html', 'api.yaml', 'fixtures/default.yaml', `scenarios/${ID}.yaml`]) files[`docs/mocks/order/${f}`] = (await fs.readFile(`${MOCK_DIR}/${f}`, 'utf8')).replace(/\r\n/g, '\n');
    const head = upstream.commit('feature/data', files, 'add mock');
    upstream.setPull(12, head);
    state = fakeGitHubState({
      token: TOKEN,
      pulls: { [REPO]: [{ number: 12, title: 'テストデータ', headSha: head, headRef: 'feature/data', baseRef: 'main' }] },
      refs: { [REPO]: { main: upstream.git('rev-parse', 'main') } },
      upstream,
    });
    const handle = fakeGitHub(state);
    api = http.createServer(async (req, res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    if (await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`);
    ddv = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/cli.ts', 'serve', '--repo', 'examples/sample-app', '--port', String(PORT)], {
      env: {
        ...process.env,
        GITHUB_TOKEN: TOKEN,
        GH_TOKEN: '',
        DDV_HOME: path.join(tmp, 'home'),
        DDV_GITHUB_API: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
        DDV_GITHUB_GIT_URL: `${pathToFileURL(path.join(tmp, 'remote')).href}/{owner}/{repo}`,
        DDV_GITHUB_NO_GH: '1',
        DDV_GITHUB_POLL: '0',
        DDV_TOKEN: E2E_TOKEN,
      },
      stdio: 'pipe',
    });
    let log = '';
    ddv.stdout?.on('data', (d) => (log += d));
    ddv.stderr?.on('data', (d) => (log += d));
    for (let i = 0; i < 150; i++) {
      if (await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.ok, () => false)) return;
      if (ddv.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`ddv did not start\n${log}`);
  });

  test.beforeEach(async ({ page }) => {
    await login(page, `http://127.0.0.1:${PORT}`);
  });

  test.afterAll(async () => {
    ddv?.kill();
    await new Promise((r) => api?.close(r));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  test('[BD-TDATA-EDITOR-T007] PR では保存の代わりに変わる行ごとの suggestion を保留に追加する', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/#/w/${WS}/doc?path=${DOC}`);
    const player = page.getByTestId('player');
    await expect(page.getByTestId('pending-count')).toHaveText('0');
    await player.getByTestId('player-scenario').selectOption(ID);
    await player.getByTestId('td-open').click();
    const panel = page.getByTestId('td-panel');
    await expect(panel.getByTestId('td-title')).toContainText(ID);
    await startEdit(panel);
    await renameCustomer(panel, '山田 花子');
    await expect(panel.getByTestId('td-comment')).not.toHaveValue('');
    await expect(panel.getByTestId('save')).toHaveText('suggestion に追加');
    await panel.getByTestId('save').click();
    await expect(stateOf(panel)).toHaveAttribute('data-state', 'View');
    await expect(panel.getByTestId('saved')).toContainText('suggestion を 2 件追加しました');
    await expect(page.getByTestId('pending-count')).toHaveText('2');
    expect(state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/pulls/12/reviews'))).toEqual([]);

    await page.getByTestId('to-review').click();
    const items = page.getByTestId('pending').getByTestId('pending-item');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toHaveAttribute('data-placement', 'line');
  });
});
