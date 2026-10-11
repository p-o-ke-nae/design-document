import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUpstream, fakeGitHub, fakeGitHubState, type FakeGitHubState, type Upstream } from '../apps/server/src/github-fixture.ts';

// Phase 1 (WSPACE) screen flow against a stub GitHub API and a local upstream repository. Never touches github.com.
// Transitions and invalid events of BD-GHREV-SCREEN that involve the review (Phase 2) are linked when that part exists.

const PORT = 5186;
const NO_TOKEN_PORT = 5187;
const REPO = 'acme/order-app';
const TOKEN = 'ghp_test_token';
const DOC = (title: string, body: string) => `---\nid: REVIEW\nkind: basic\nstatus: review\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
// order.md of the PR head: L12 rewritten (added + base 「注文を受け付ける。」 removed), L14–16 added.
const ORDER_V2 = '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文 基本設計\n---\n\n# 注文 基本設計\n\n## 概要\n\n注文を受け付け、内容を確認する。\n\n## 確認\n\n確認画面を表示する。\n';
const ORDER = 'docs/design/basic/order.md';

let tmp = '';
let upstream: Upstream;
let state: FakeGitHubState;
let api: http.Server;
const servers: ChildProcess[] = [];

async function startFakeGitHub(s: FakeGitHubState): Promise<http.Server> {
  const handle = fakeGitHub(s);
  const server = http.createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function startDdv(port: number, env: Record<string, string>): Promise<void> {
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is already in use`);
  // A single process (no tsx wrapper) so that kill() stops the server itself.
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/cli.ts', 'serve', '--repo', 'examples/sample-app', '--port', String(port)], {
    env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', ...env },
    stdio: 'pipe',
  });
  servers.push(child);
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/config`).then((r) => r.ok, () => false);
    if (ok) return;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ddv did not start on ${port}\n${log}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-e2e-gh-'));
  upstream = await createUpstream(path.join(tmp, 'remote'));
  const head = upstream.commit(
    'feature/review',
    { 'docs/design/basic/review.md': DOC('レビュー対象 基本設計', '## 変更点\n\n最初の版。'), 'docs/design/basic/order.md': ORDER_V2, 'src/app.ts': 'export {};\n' },
    'add review doc',
  );
  upstream.setPull(12, head);
  state = fakeGitHubState({
    token: TOKEN,
    pulls: { [REPO]: [{ number: 12, title: '注文の取消を追加', headSha: head, headRef: 'feature/review', baseRef: 'main' }] },
    refs: { [REPO]: { main: upstream.git('rev-parse', 'main') } },
    threads: {
      [`${REPO}#12`]: [
        { id: 'RT_1', path: ORDER, line: 16, comments: [{ id: 101, author: 'bob', body: '画面の名前を書いてください' }, { id: 102, author: 'alice', body: '追記します' }] },
        { id: 'RT_2', path: ORDER, line: null, resolved: true, comments: [{ id: 103, author: 'bob', body: '全体として良いと思います' }] },
      ],
    },
    reviews: { [`${REPO}#12`]: [{ user: { login: 'bob' }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' }] },
  });
  api = await startFakeGitHub(state);
  const common = {
    DDV_GITHUB_API: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    DDV_GITHUB_GIT_URL: `${pathToFileURL(path.join(tmp, 'remote')).href}/{owner}/{repo}`,
    DDV_GITHUB_NO_GH: '1',
    DDV_GITHUB_POLL: '0',
  };
  await startDdv(PORT, { ...common, DDV_HOME: path.join(tmp, 'home'), GITHUB_TOKEN: TOKEN });
  await startDdv(NO_TOKEN_PORT, { ...common, DDV_HOME: path.join(tmp, 'home-none') });
});

test.afterAll(async () => {
  for (const s of servers) s.kill();
  await new Promise((r) => api?.close(r));
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const BASE = `http://127.0.0.1:${PORT}`;

async function openForm(page: Page) {
  await page.getByTestId('open-github').click();
  await expect(page).toHaveURL(/#\/open$/);
  await expect(page.getByTestId('open-page')).toBeVisible();
}

async function submit(page: Page, repo: string, target: string, kind: 'pr' | 'ref' = 'pr') {
  await page.getByTestId('repo').fill(repo);
  await page.getByTestId('kind').selectOption(kind);
  await page.getByTestId('target').fill(target);
  await page.getByTestId('open-submit').click();
}

test('[BD-GHREV-SCREEN-T001] 手元の文書では GitHub に問い合わせない（REQ-209）', async ({ page }) => {
  const before = state.calls.length;
  await page.goto(`${BASE}/#/doc?path=docs/design/basic/order.md`);
  await expect(page.getByTestId('doc-tree')).toContainText('注文画面 基本設計');
  await expect(page.getByTestId('ws-switch')).toHaveValue('');
  await expect(page.getByTestId('auth-status')).toHaveCount(0);
  expect(state.calls.slice(before)).toEqual([]);
});

test('[BD-GHREV-SCREEN-T002][BD-GHREV-SCREEN-T003] 手元 → GitHub を開く → キャンセル → 手元の文書', async ({ page }) => {
  await page.goto(`${BASE}/#/doc?path=docs/design/basic/order.md`);
  await expect(page.getByTestId('doc-tree')).toBeVisible();
  await openForm(page);
  await expect(page.getByTestId('auth-status')).toHaveText('GitHub: GITHUB_TOKEN（alice）');
  await page.getByTestId('open-cancel').click();
  await expect(page).toHaveURL(/#\/doc\?path=docs(%2F|\/)design(%2F|\/)basic(%2F|\/)order\.md$/);
  await expect(page.getByTestId('doc-tree')).toContainText('注文画面 基本設計');
});

test('[BD-GHREV-SCREEN-T004][BD-GHREV-SCREEN-T005][BD-GHREV-SCREEN-T006] 入力NG → 入力OK → 取得中 → PR の文書（ワークスペースの切替を含む）', async ({ page }) => {
  await page.goto(`${BASE}/#/`);
  await openForm(page);
  await expect(page.getByTestId('pulls')).toHaveCount(1);
  await submit(page, 'acme', '12');
  await expect(page.getByTestId('open-error')).toHaveText('owner/repo の形式で入力してください');
  await expect(page).toHaveURL(/#\/open$/);

  await page.getByTestId('repo').fill(REPO);
  await page.getByTestId('pulls').getByText('#12 注文の取消を追加').click();
  await expect(page.getByTestId('target')).toHaveValue('12');
  await page.getByTestId('open-submit').click();
  await expect(page).toHaveURL(/#\/w\/gh~acme~order-app~pr-12\//);
  await expect(page.getByTestId('prbar')).toBeVisible();
  await expect(page.getByTestId('pr-title')).toHaveText('#12 注文の取消を追加');
  await expect(page.getByTestId('prbar')).toContainText('main ← feature/review');
  await expect(page.getByTestId('head-sha')).toHaveText(state.pulls[REPO][0].headSha.slice(0, 7));
  await expect(page.getByTestId('doc-tree')).toContainText('レビュー対象 基本設計');
  await expect(page.locator('.main')).toContainText('注文 基本設計'); // first document auto-selected
  await page.getByTestId('changed-docs').getByText('レビュー対象 基本設計').click();
  await expect(page).toHaveURL(/#\/w\/gh~acme~order-app~pr-12\/doc\?path=/);
  await expect(page.locator('.main')).toContainText('最初の版。');

  await page.getByTestId('ws-switch').selectOption('');
  await expect(page.getByTestId('doc-tree')).toContainText('注文画面 基本設計');
  await expect(page.getByTestId('prbar')).toHaveCount(0);
  await page.getByTestId('ws-switch').selectOption('gh~acme~order-app~pr-12');
  await expect(page.getByTestId('doc-tree')).toContainText('レビュー対象 基本設計');
  expect(await page.content()).not.toContain(TOKEN);
});

test('PR の文書：変更印・レビュー状態・本文 / 差分の切替・スレッド表示', async ({ page }) => {
  await page.goto(`${BASE}/#/w/gh~acme~order-app~pr-12/doc?path=${ORDER}`);
  await expect(page.locator('.main')).toContainText('確認画面を表示する。');
  await expect(page.getByTestId('review-state')).toHaveText('bob: Changes requested');
  const changed = page.getByTestId('changed-docs');
  await expect(changed.locator('li')).toHaveCount(2);
  await expect(changed).toContainText('M注文 基本設計');
  await expect(changed).toContainText('Aレビュー対象 基本設計');

  // 本文：差分の重ね合わせは無く、スレッドは要素の後ろ・ファイルへのコメントは先頭
  const diff = page.getByTestId('diff-view');
  await expect(diff).not.toHaveAttribute('open', '');
  await expect(diff.locator('summary')).toHaveText('差分を表示（main...feature/review：設計書 2 件、文書以外 1 件）');
  await expect(page.getByTestId('removed-block')).toHaveCount(0);
  const thread = page.getByTestId('threads').getByTestId('thread');
  await expect(thread).toHaveCount(1);
  await expect(thread.locator('summary')).toContainText('bob：画面の名前を書いてください');
  await expect(thread.getByTestId('thread-state')).toHaveText('（未解決・返信 1）');
  await expect(thread).toContainText('追記します');
  await expect(page.locator('p:has-text("確認画面を表示する。") + [data-testid=threads]')).toHaveCount(1);
  await expect(page.getByTestId('file-threads').getByTestId('thread-state')).toHaveText('（解決済み）');

  // 差分：追加・変更・削除を本文に重ねる
  await diff.locator('summary').click();
  await expect(page.getByTestId('diff-summary')).toContainText('追加 3');
  await expect(page.getByTestId('removed-block')).toContainText('注文を受け付ける。');
  // 1 行の段落の書き換えは「追加＋削除」（ブロックの一部の行だけが変わったときが「変更」）
  await expect(page.locator('.doc p.block.added')).toHaveText(['注文を受け付け、内容を確認する。', '確認画面を表示する。']);
  await expect(page.locator('.doc h2.block.added')).toHaveText('確認');

  // 変更の無い文書・PR で追加された文書
  await changed.getByText('レビュー対象 基本設計').click();
  await expect(page.locator('.main')).toContainText('最初の版。');
  await expect(page.getByTestId('diff-summary')).toContainText('A docs/design/basic/review.md');
  await expect(page.getByTestId('removed-block')).toHaveCount(0);
  await diff.locator('summary').click();
  await expect(page.locator('.doc .block.added')).toHaveCount(0);
  expect(await page.content()).not.toContain(TOKEN);
});

test('[BD-GHREV-SCREEN-T012] PR の更新を検知（更新あり）→ 最新化 → 取得中 → PR の文書', async ({ page }) => {
  await page.goto(`${BASE}/#/w/gh~acme~order-app~pr-12/doc?path=docs/design/basic/review.md`);
  await expect(page.locator('.main')).toContainText('最初の版。');
  const next = upstream.commit('feature/review', { 'docs/design/basic/review.md': DOC('レビュー対象 基本設計', '## 変更点\n\n二番目の版。') }, 'v2');
  upstream.setPull(12, next);
  state.pulls[REPO][0].headSha = next;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('stale')).toHaveText('更新あり');
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('head-sha')).toHaveText(next.slice(0, 7));
  await expect(page.getByTestId('stale')).toHaveCount(0);
  await expect(page.locator('.main')).toContainText('二番目の版。');
});

test('[BD-GHREV-SCREEN-T007] 取得失敗 → 戻る（入力と理由を保持）→ 入力OK → 取得中 → PR の文書', async ({ page }) => {
  await page.goto(`${BASE}/#/`);
  await openForm(page);
  await submit(page, REPO, '99');
  await expect(page).toHaveURL(/#\/w\/gh~acme~order-app~pr-99\//);
  await expect(page.getByTestId('loading-error')).toBeVisible();
  await expect(page.getByTestId('progress').locator('li.failed')).toHaveCount(1);
  await page.getByTestId('loading-back').click();
  await expect(page).toHaveURL(/#\/open$/);
  await expect(page.getByTestId('repo')).toHaveValue(REPO);
  await expect(page.getByTestId('target')).toHaveValue('99');
  await expect(page.getByTestId('open-error')).not.toBeEmpty();

  await page.getByTestId('target').fill('12');
  await page.getByTestId('open-submit').click();
  await expect(page.getByTestId('prbar')).toBeVisible();
  await expect(page.getByTestId('pr-title')).toHaveText('#12 注文の取消を追加');
});

test('[BD-GHREV-SCREEN-X001][BD-GHREV-SCREEN-X002][BD-GHREV-SCREEN-X003][BD-GHREV-SCREEN-X004][BD-GHREV-SCREEN-X008][BD-GHREV-SCREEN-X010][BD-GHREV-SCREEN-X011][BD-GHREV-SCREEN-X012][BD-GHREV-SCREEN-X016][BD-GHREV-SCREEN-X018][BD-GHREV-SCREEN-X019][BD-GHREV-SCREEN-X020][BD-GHREV-SCREEN-X024][BD-GHREV-SCREEN-X026][BD-GHREV-SCREEN-X027][BD-GHREV-SCREEN-X028][BD-GHREV-SCREEN-X029][BD-GHREV-SCREEN-X030] 各画面は遷移の無い操作を出さない', async ({ page }) => {
  const absent = async (...ids: string[]) => {
    for (const id of ids) await expect(page.getByTestId(id), id).toHaveCount(0);
  };
  await page.goto(`${BASE}/#/doc?path=docs/design/basic/order.md`);
  await expect(page.getByTestId('doc-tree')).toBeVisible();
  await absent('open-cancel', 'open-submit', 'progress', 'loading-page', 'refresh');

  await page.goto(`${BASE}/#/open`);
  await expect(page.getByTestId('open-page')).toBeVisible();
  await absent('open-github', 'progress', 'loading-page', 'refresh', 'prbar');

  await page.goto(`${BASE}/#/w/gh~acme~order-app~pr-99/doc`);
  await expect(page.getByTestId('loading-page')).toBeVisible();
  await absent('open-github', 'open-cancel', 'open-submit', 'refresh');

  await page.goto(`${BASE}/#/w/gh~acme~order-app~pr-12/doc`);
  await expect(page.getByTestId('prbar')).toBeVisible();
  await absent('open-github', 'open-cancel', 'open-submit', 'progress', 'loading-page');
});

test('branch・tag を開く', async ({ page }) => {
  await page.goto(`${BASE}/#/open`);
  await submit(page, REPO, 'main', 'ref');
  await expect(page).toHaveURL(/#\/w\/gh~acme~order-app~ref-main\//);
  await expect(page.getByTestId('pr-title')).toHaveText(`${REPO} @main`);
  await expect(page.getByTestId('doc-tree')).toContainText('注文 基本設計');
  await expect(page.getByTestId('doc-tree')).not.toContainText('レビュー対象 基本設計');
});

test('GitHub のテスト実行は確認ダイアログで許可するまで実行しない', async ({ page }) => {
  await page.goto(`${BASE}/#/w/gh~acme~order-app~pr-12/doc`);
  await expect(page.getByTestId('prbar')).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/w/gh~acme~order-app~pr-12/tests/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  expect(status).toBe(403);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ddv-untrusted')));
  await expect(page.getByTestId('trust-dialog')).toBeVisible();
  await page.getByTestId('trust-cancel').click();
  await expect(page.getByTestId('trust-dialog')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ddv-untrusted')));
  await page.getByTestId('trust-confirm').click();
  await expect(page.getByTestId('trust-dialog')).toHaveCount(0);
  const info = await page.evaluate(async () => (await fetch('/api/workspaces/gh~acme~order-app~pr-12')).json());
  expect(info.trusted).toBe(true);
});

test('閉じる → 手元の文書（ワークスペースの一覧から消える）', async ({ page }) => {
  await page.goto(`${BASE}/#/w/gh~acme~order-app~ref-main/doc`);
  await expect(page.getByTestId('prbar')).toBeVisible();
  await page.getByTestId('ws-close').click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId('ws-switch').locator('option[value="gh~acme~order-app~ref-main"]')).toHaveCount(0);
});

test('未ログインでは GitHub を開かずログイン方法を表示する', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${NO_TOKEN_PORT}/#/`);
  await expect(page.getByTestId('doc-tree')).toBeVisible();
  await page.getByTestId('open-github').click();
  await expect(page.getByTestId('auth-error')).toHaveText('GitHub にログインしてください（`gh auth login` または `GITHUB_TOKEN`）');
  await expect(page.getByTestId('auth-status')).toHaveText('GitHub: 未ログイン');
  await expect(page).toHaveURL(/#\/$/);
});
