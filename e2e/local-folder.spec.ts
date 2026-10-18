import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { E2E_PORT, E2E_TOKEN, login, startUrl } from './ddv-auth.ts';

// `ddv serve` without --repo（手元のフォルダ・起動トークン）on its own port.
const PORT = Number(process.env.DDV_E2E_LOCAL_PORT || E2E_PORT + 12);
const BASE = `http://127.0.0.1:${PORT}`;
const BUSY = 'テストの実行中は選び直せません。完了してから選び直してください';

let ddv: ChildProcess | undefined;
let log = '';
let tmp = '';
let ok = '';
let other = '';

const CONFIG = [
  'docsRoot: docs/design',
  'runners:',
  '  - name: slow',
  '    type: command',
  '    cwd: .',
  '    level: unit',
  `    command: node -e "setTimeout(()=>{},5000)"`,
  '',
].join('\n');

async function makeFolder(dir: string, title: string): Promise<string> {
  await fs.mkdir(path.join(dir, 'docs', 'design', 'basic'), { recursive: true });
  await fs.writeFile(path.join(dir, 'ddv.config.yaml'), CONFIG);
  await fs.writeFile(path.join(dir, 'docs', 'design', 'basic', 'index.md'), `---\ntitle: ${title}\n---\n\n# ${title}\n\n本文。\n`);
  return realpathSync.native(dir);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-e2e-local-')));
  ok = await makeFolder(path.join(tmp, 'ok-folder'), '手元の文書');
  other = await makeFolder(path.join(tmp, 'other-folder'), '別の文書');
  await fs.writeFile(path.join(tmp, 'note.txt'), 'not a folder');
  if (await fetch(`${BASE}/`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`);
  ddv = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/cli.ts', 'serve', '--port', String(PORT)], {
    env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', DDV_HOME: path.join(tmp, 'home'), DDV_GITHUB_NO_GH: '1', DDV_GITHUB_POLL: '0', DDV_GITHUB_API: 'http://127.0.0.1:9', DDV_TOKEN: E2E_TOKEN },
    stdio: 'pipe',
  });
  ddv.stdout?.on('data', (d) => (log += d));
  ddv.stderr?.on('data', (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${BASE}/`).then((r) => r.ok, () => false)) return;
    if (ddv.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ddv did not start\n${log}`);
});

test.afterAll(async () => {
  ddv?.kill();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** A raw request so that Host / Origin / Cookie can be set freely. */
function raw(pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function sessionCookie(): Promise<string> {
  const r = await raw(`/?ddv-token=${E2E_TOKEN}`);
  return String(r.headers['set-cookie']?.[0] ?? '').split(';')[0];
}

async function waitIdle(request: APIRequestContext) {
  await expect
    .poll(async () => ((await (await request.get(`${BASE}/api/local`)).json()) as { busy: string | null }).busy, { timeout: 20_000 })
    .toBeNull();
}

test.describe('手元のフォルダの選択（BD-LOCAL-SCREEN）', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, BASE);
    await waitIdle(page.request);
    expect((await page.request.post(`${BASE}/api/local/close`)).status()).toBe(200);
  });

  async function openFolder(page: Page, p: string) {
    await page.getByTestId('path').fill(p);
    await page.getByTestId('open').click();
  }

  async function expectDoc(page: Page, root: string, title: string) {
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('local-root')).toHaveText(root);
    await expect(page.getByTestId('local-root')).toHaveAttribute('title', root);
    await expect(page.getByTestId('doc-tree')).toContainText(title);
  }

  test('[BD-LOCAL-SCREEN-P002][BD-LOCAL-SCREEN-T001][BD-LOCAL-SCREEN-T002][BD-LOCAL-SCREEN-T003][BD-LOCAL-SCREEN-T006][BD-LOCAL-SCREEN-X001] 開けないフォルダは理由を表示して残り、開けるフォルダで文書へ', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await expect(page).toHaveURL(/#\/folder$/);
    await expect(page.getByRole('heading', { name: '作業フォルダを開く' })).toBeVisible();
    // X001: 「フォルダを選び直す」はフォルダの選択には無い
    await expect(page.getByTestId('reselect')).toHaveCount(0);

    await page.getByTestId('open').click();
    await expect(page.getByTestId('open-error')).toHaveText('パスを入力してください');

    const missing = path.join(tmp, 'missing');
    await openFolder(page, missing);
    await expect(page.getByTestId('open-error')).toHaveText(`フォルダが見つかりません: ${missing}`);
    await openFolder(page, path.join(tmp, 'note.txt'));
    await expect(page.getByTestId('open-error')).toHaveText(`フォルダではありません: ${path.join(tmp, 'note.txt')}`);
    await expect(page).toHaveURL(/#\/folder$/);

    await openFolder(page, ok);
    await expectDoc(page, ok, '手元の文書');
  });

  test('[BD-LOCAL-SCREEN-P001][BD-LOCAL-SCREEN-P003][BD-LOCAL-SCREEN-T004][BD-LOCAL-SCREEN-X002] テストの実行中は選び直さず理由を表示する', async ({ page }) => {
    await page.goto(`${BASE}/#/folder`);
    await openFolder(page, path.join(tmp, 'missing'));
    await expect(page.getByTestId('open-error')).toContainText('フォルダが見つかりません');
    await openFolder(page, ok);
    await expectDoc(page, ok, '手元の文書');
    // X002: 「開く」は文書には無い
    await expect(page.getByTestId('open')).toHaveCount(0);

    expect((await page.request.post(`${BASE}/api/tests/run`, { data: {} })).status()).toBe(202);
    await page.getByTestId('reselect').click();
    await expect(page.getByTestId('reselect-error')).toHaveText(BUSY);
    await expectDoc(page, ok, '手元の文書');
    await expect(page.getByTestId('reselect-error')).toHaveCount(0, { timeout: 8_000 });
    await waitIdle(page.request);
  });

  test('[BD-LOCAL-SCREEN-P004][BD-LOCAL-SCREEN-P005][BD-LOCAL-SCREEN-T005] 実行中でなければ選び直して別のフォルダを開く', async ({ page }) => {
    await page.goto(`${BASE}/#/folder`);
    await openFolder(page, ok);
    await expectDoc(page, ok, '手元の文書');

    await page.getByTestId('reselect').click();
    await expect(page).toHaveURL(/#\/folder$/);
    // 今の場所は直前に開いていたフォルダの親。一覧のクリックで path に入り、ダブルクリックで開く
    await expect(page.getByTestId('dirs-current')).toHaveText(tmp);
    await expect(page.getByTestId('recent')).toContainText(ok);
    const item = page.getByTestId('dirs').locator('li', { hasText: 'other-folder' });
    await expect(item).toContainText('ddv.config.yaml あり');
    await item.dblclick();
    await expectDoc(page, other, '別の文書');
  });

  test('最近開いたフォルダ：クリックでパスに入り、削除で一覧から消える', async ({ page }) => {
    await page.goto(`${BASE}/#/folder`);
    const recent = page.getByTestId('recent');
    await expect(recent).toContainText(other);
    await recent.locator('li', { hasText: ok }).locator('.recent-path').click();
    await expect(page.getByTestId('path')).toHaveValue(ok);
    await recent.locator('li', { hasText: ok }).getByTestId('recent-remove').click();
    await expect(recent).not.toContainText(ok);
    await expect(recent).toContainText(other);
  });

  test('フォルダの一覧：ドライブ・ホームと上の階層へ', async ({ page }) => {
    await page.goto(`${BASE}/#/folder`);
    await page.getByTestId('dirs-roots').click();
    await expect(page.getByTestId('dirs-current')).toHaveText('ドライブ・ホーム');
    await expect(page.getByTestId('dirs-up')).toBeDisabled();
    await page.reload();
    // 今の場所の初期値は最近開いたフォルダの先頭の親
    await expect(page.getByTestId('dirs-current')).toHaveText(tmp);
    await expect(page.getByTestId('dirs')).not.toContainText('note.txt');
    await page.getByTestId('dirs').locator('li', { hasText: 'ok-folder' }).click();
    await expect(page.getByTestId('path')).toHaveValue(ok);
    await expect(page.getByTestId('dirs-current')).toHaveText(ok);
    await page.getByTestId('dirs-up').click();
    await expect(page.getByTestId('dirs-current')).toHaveText(tmp);
  });
});

test.describe('起動トークンとセッション Cookie（BD-LOCAL-TOKEN）', () => {
  test('[BD-LOCAL-TOKEN-P001][BD-LOCAL-TOKEN-S001][BD-LOCAL-TOKEN-T001][BD-LOCAL-TOKEN-T002] Host が待ち受けと違えば 400', async () => {
    const cookie = await sessionCookie();
    for (const host of ['evil.example', `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`]) {
      for (const p of ['/', '/api/local', '/api/events', `/?ddv-token=${E2E_TOKEN}`]) {
        expect((await raw(p, { host, cookie })).status, `${host} ${p}`).toBe(400);
      }
    }
    expect((await raw('/api/local', { host: `localhost:${PORT}`, cookie })).status).toBe(200);
  });

  test('[BD-LOCAL-TOKEN-P002][BD-LOCAL-TOKEN-S002][BD-LOCAL-TOKEN-S003][BD-LOCAL-TOKEN-T003][BD-LOCAL-TOKEN-T004] ビューア以外の Origin は GET・SSE を含めて 403', async () => {
    const cookie = await sessionCookie();
    for (const p of ['/', '/api/local', '/api/events', `/?ddv-token=${E2E_TOKEN}`]) {
      expect((await raw(p, { origin: 'http://evil.example', cookie })).status, p).toBe(403);
    }
    expect((await raw('/api/local/close', { origin: 'http://evil.example', cookie }, 'POST')).status).toBe(403);
    expect((await raw('/api/local', { origin: BASE, cookie })).status).toBe(200);
  });

  test('[BD-LOCAL-TOKEN-P003][BD-LOCAL-TOKEN-S004][BD-LOCAL-TOKEN-S005][BD-LOCAL-TOKEN-S007][BD-LOCAL-TOKEN-T005][BD-LOCAL-TOKEN-T006][BD-LOCAL-TOKEN-T007] 開始 URL はセッション Cookie を発行してトークンを除いた URL へ転送する', async ({ browser }) => {
    expect(log).toContain(`${BASE}/?ddv-token=${E2E_TOKEN}`);
    const r = await raw(`/?ddv-token=${E2E_TOKEN}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    expect(r.headers['set-cookie']?.[0]).toMatch(new RegExp(`^ddv-session-${PORT}=[^;]+; Path=/; HttpOnly; SameSite=Strict`));

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(startUrl(BASE, '#/folder'));
    await expect(page).toHaveURL(`${BASE}/#/folder`);
    await expect(page.getByRole('heading', { name: '作業フォルダを開く' })).toBeVisible();
    await context.close();
  });

  test('[BD-LOCAL-TOKEN-P004][BD-LOCAL-TOKEN-S008][BD-LOCAL-TOKEN-T008] 起動トークンが違えば 401 で案内を表示する', async ({ browser }) => {
    const r = await raw('/?ddv-token=wrong-token-0123456789');
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.body).toContain('name="ddv-auth"');
    expect((await raw('/api/session?ddv-token=wrong-token-0123456789')).status).toBe(401);

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${BASE}/?ddv-token=wrong-token-0123456789`);
    await expect(page.getByTestId('token-required')).toContainText('ddv serve が表示した URL から開いてください');
    await expect(page.getByTestId('token-required')).toContainText('サーバを起動し直したときは、新しく表示された URL を開いてください');
    await context.close();
  });

  test('[BD-LOCAL-TOKEN-P005][BD-LOCAL-TOKEN-S006][BD-LOCAL-TOKEN-S009][BD-LOCAL-TOKEN-T009][BD-LOCAL-TOKEN-T010] 静的ファイルは Cookie なしで応答し、画面は API を呼ばずに案内を出す', async ({ browser }) => {
    const index = await raw('/');
    expect(index.status).toBe(200);
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.body).toContain('<meta name="ddv-auth" content="required">');
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(index.body)?.[1];
    expect(asset).toBeTruthy();
    expect((await raw(asset!)).status).toBe(200);

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const apiCalls: string[] = [];
    page.on('request', (req) => {
      if (/\/(api|raw|w)\//.test(new URL(req.url()).pathname)) apiCalls.push(req.url());
    });
    await page.goto(`${BASE}/#/folder`);
    await expect(page.getByTestId('token-required')).toBeVisible();
    await page.waitForTimeout(500);
    expect(apiCalls).toEqual([]);
    await context.close();
  });

  test('[BD-LOCAL-TOKEN-P006][BD-LOCAL-TOKEN-S010][BD-LOCAL-TOKEN-S011][BD-LOCAL-TOKEN-T011][BD-LOCAL-TOKEN-T012] 有効なセッション Cookie なら API に応答する', async () => {
    const cookie = await sessionCookie();
    expect((await raw('/api/local', { cookie })).status).toBe(200);
    expect((await raw('/api/workspaces', { cookie })).status).toBe(200);
    expect((await raw('/api/fs/dirs', { cookie })).status).toBe(200);
    const index = await raw('/', { cookie });
    expect(index.status).toBe(200);
    expect(index.body).not.toContain('ddv-auth');
  });

  test('[BD-LOCAL-TOKEN-P007][BD-LOCAL-TOKEN-S012][BD-LOCAL-TOKEN-T013] セッション Cookie が無効・なしなら 401、画面は案内に切り替わる', async ({ browser }) => {
    for (const cookie of [undefined, `ddv-session-${PORT}=forged`, `ddv-session-${PORT + 1}=x`]) {
      const r = await raw('/api/local', cookie ? { cookie } : {});
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ error: 'ddv serve が表示した URL から開いてください', code: 'session-required' });
      expect((await raw('/api/local/close', cookie ? { cookie } : {}, 'POST')).status).toBe(401);
      expect((await raw('/raw/docs/x.md', cookie ? { cookie } : {})).status).toBe(401);
    }

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(startUrl(BASE, '#/folder'));
    await expect(page.getByRole('heading', { name: '作業フォルダを開く' })).toBeVisible();
    // The session becomes invalid (e.g. the server was restarted): the next API call shows the guide.
    await context.clearCookies();
    // The next API call shows the guide: this click, or a request the page makes on its own first (then the button is gone).
    await page.getByTestId('dirs-roots').click({ timeout: 5_000 }).catch(() => {});
    await expect(page.getByTestId('token-required')).toBeVisible();
    await context.close();
  });
});
