import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUpstream, fakeGitHub, fakeGitHubState, type FakeGitHubState, type Upstream } from '../apps/server/src/github-fixture.ts';

// Phase 2B (REVCMT): line comments, pending review, submit, thread reply / resolve against a stub GitHub API. Never touches github.com.

const PORT = 5188;
const REPO = 'acme/order-app';
const TOKEN = 'ghp_test_token';
const WS = 'gh~acme~order-app~pr-12';
const ORDER = 'docs/design/basic/order.md';
const ORDER_V2 = '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文 基本設計\n---\n\n# 注文 基本設計\n\n## 概要\n\n注文を受け付け、内容を確認する。\n\n## 確認\n\n確認画面を表示する。\n';
const TARGET = '確認画面を表示する。';

let tmp = '';
let upstream: Upstream;
let state: FakeGitHubState;
let api: http.Server;
let ddv: ChildProcess | undefined;

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

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-e2e-rev-'));
  upstream = await createUpstream(path.join(tmp, 'remote'));
  const head = upstream.commit('feature/review', { 'docs/design/basic/order.md': ORDER_V2 }, 'edit order');
  upstream.setPull(12, head);
  state = fakeGitHubState({
    token: TOKEN,
    pulls: { [REPO]: [{ number: 12, title: '注文の取消を追加', headSha: head, headRef: 'feature/review', baseRef: 'main' }] },
    refs: { [REPO]: { main: upstream.git('rev-parse', 'main') } },
    threads: { [`${REPO}#12`]: [{ id: 'RT_1', path: ORDER, line: 16, comments: [{ id: 101, author: 'bob', body: '画面の名前を書いてください' }] }] },
    reviews: { [`${REPO}#12`]: [{ user: { login: 'bob' }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' }] },
    upstream,
  });
  api = await startFakeGitHub(state);
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
    },
    stdio: 'pipe',
  });
  let log = '';
  ddv.stdout?.on('data', (d) => (log += d));
  ddv.stderr?.on('data', (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/config`).then((r) => r.ok, () => false)) return;
    if (ddv.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ddv did not start\n${log}`);
});

test.afterAll(async () => {
  ddv?.kill();
  await new Promise((r) => api?.close(r));
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const URL = `http://127.0.0.1:${PORT}/#/w/${WS}/doc?path=${ORDER}`;

async function openDoc(page: Page) {
  await page.goto(URL);
  await expect(page.locator('.doc')).toContainText(TARGET);
}

async function comment(page: Page, text: string) {
  await page.locator('.doc p', { hasText: TARGET }).getByTestId('comment-gutter').click();
  await expect(page.getByTestId('comment-dialog')).toBeVisible();
  await page.getByTestId('comment').fill(text);
  await page.getByTestId('add-comment').click();
  await expect(page.getByTestId('comment-dialog')).toHaveCount(0);
}

const reviewPosts = () => state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/pulls/12/reviews'));

test('[BD-GHREV-CMT-T001][BD-GHREV-SCREEN-T008] 💬 から保留に追加 → 件数 → レビュー画面の一覧・修正・削除（[BD-GHREV-CMT-T002][BD-GHREV-CMT-T003]）', async ({ page }) => {
  await openDoc(page);
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  await page.locator('.doc p', { hasText: TARGET }).getByTestId('comment-gutter').click();
  await expect(page.getByTestId('anchor').locator('option').first()).toHaveText(`ブロック: ${TARGET}`);
  await page.getByTestId('add-comment').click();
  await expect(page.getByTestId('comment-error')).toHaveText('コメントを入力してください');
  await page.getByTestId('comment').fill('画面名を明記してください');
  await page.getByTestId('add-comment').click();
  await expect(page.getByTestId('comment-dialog')).toHaveCount(0);
  await expect(page.getByTestId('pending-count')).toHaveText('1');
  expect(reviewPosts()).toEqual([]); // 送信するまで GitHub に出さない

  await page.getByTestId('to-review').click();
  await expect(page).toHaveURL(/\/review$/);
  const item = page.getByTestId('pending').getByTestId('pending-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(ORDER);
  await expect(item).toHaveAttribute('data-state', 'Pending');
  await expect(item).toHaveAttribute('data-placement', 'line');
  await expect(item.getByTestId('pending-text')).toHaveText('画面名を明記してください');

  await item.getByTestId('pending-edit').click();
  await item.getByTestId('pending-body').fill('画面名と遷移先を明記してください');
  await item.getByTestId('pending-save').click();
  await expect(item.getByTestId('pending-text')).toHaveText('画面名と遷移先を明記してください');

  await item.getByTestId('pending-delete').click();
  await expect(page.getByTestId('pending-item')).toHaveCount(0);
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  await page.getByTestId('review-close').click();
  await expect(page).toHaveURL(/\/doc\?path=/);
});

test('[BD-GHREV-SUBMIT-T009] コメントも本文も無い Comment は送信できない', async ({ page }) => {
  await openDoc(page);
  await page.getByTestId('to-review').click();
  await page.getByTestId('review-submit').click();
  await expect(page.getByTestId('submit-error')).toHaveText('Comment / Request changes には本文が必要です');
  await page.getByTestId('event').selectOption('APPROVE');
  await expect(page.getByTestId('body')).toBeVisible();
});

test('[BD-GHREV-CMT-T009][BD-GHREV-SCREEN-T011][BD-GHREV-CMT-T008][BD-GHREV-SCREEN-T010][BD-GHREV-SCREEN-T013] 送信失敗は保留を残して理由を表示 → 再送信 → 送信済 → PR に戻る', async ({ page }) => {
  await openDoc(page);
  await comment(page, '画面名を明記してください');
  await page.getByTestId('to-review').click();
  const before = reviewPosts().length;
  state.failOn.push({ match: 'POST /repos/acme/order-app/pulls/12/reviews', status: 422, message: 'Unprocessable Entity', times: 1 });
  await page.getByTestId('event').selectOption('COMMENT');
  await page.getByTestId('body').fill('全体として確認をお願いします');
  await page.getByTestId('review-submit').click();
  await expect(page.getByTestId('submit-error')).toContainText('Unprocessable Entity');
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId('pending-item')).toHaveCount(1);
  await expect(page.getByTestId('pending-count')).toHaveText('1');

  await page.getByTestId('review-submit').click();
  await expect(page).toHaveURL(/\/review\/done$/);
  await expect(page.getByTestId('done-message')).toContainText('行コメント 1 件・ファイルコメント 0 件');
  await expect(page.getByTestId('review-url')).toHaveAttribute('href', /^https:\/\/github\.com\/acme\/order-app\/pull\/12#pullrequestreview-\d+$/);
  const posts = reviewPosts().slice(before);
  expect(posts.at(-1)?.body).toMatchObject({ event: 'COMMENT', body: '全体として確認をお願いします' });
  expect(posts.at(-1)?.body.comments).toHaveLength(1);
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  await expect(page.getByTestId('review-state').filter({ hasText: 'alice: Commented' })).toHaveCount(1);

  await page.getByTestId('back-to-pr').click();
  await expect(page).toHaveURL(/\/doc\?path=/);
  await expect(page.getByTestId('review-page')).toHaveCount(0);
  // 送信したコメントはスレッドとして取り直される
  await expect(page.getByTestId('thread').filter({ hasText: '画面名を明記してください' })).toHaveCount(1);
});

test('[BD-GHREV-CMT-T010][BD-GHREV-CMT-T011][BD-GHREV-CMT-T012] スレッドの返信・解決・未解決に戻す', async ({ page }) => {
  await openDoc(page);
  const thread = page.locator('[data-thread-id=RT_1]');
  await expect(thread.getByTestId('thread-state')).toHaveText('（未解決）');
  await thread.getByTestId('thread-reply-send').click();
  await expect(thread.getByTestId('thread-error')).toHaveText('返信を入力してください');
  await thread.getByTestId('thread-reply').fill('追記しました');
  await thread.getByTestId('thread-reply-send').click();
  await expect(thread.getByTestId('thread-state')).toHaveText('（未解決・返信 1）');
  await expect(thread).toContainText('追記しました');
  expect(state.requests.some((r) => r.path.endsWith('/comments/101/replies') && r.body?.body === '追記しました')).toBe(true);

  await thread.getByTestId('thread-resolve').click();
  await expect(thread.getByTestId('thread-state')).toHaveText('（解決済み・返信 1）');
  await thread.locator('summary').click();
  await thread.getByTestId('thread-resolve').click();
  await expect(thread.getByTestId('thread-state')).toHaveText('（未解決・返信 1）');
});

test('[BD-GHREV-SUBMIT-T004] Approve のときだけ status 連動を選べる → コミットして送信', async ({ page }) => {
  await openDoc(page);
  await page.getByTestId('to-review').click();
  const box = page.getByTestId('approve-status').first();
  await expect(box).toBeDisabled();
  await page.getByTestId('event').selectOption('APPROVE');
  await expect(box).toBeEnabled();
  await box.check();
  const before = upstream.git('rev-parse', 'feature/review');
  await page.getByTestId('review-submit').click();
  await expect(page).toHaveURL(/\/review\/done$/);
  await expect(page.getByTestId('done-message')).toContainText('status を approved にしました');
  expect(upstream.git('rev-parse', 'feature/review')).not.toBe(before);
  expect(upstream.git('show', `feature/review:${ORDER}`)).toContain('status: approved');
  await page.getByTestId('back-to-pr').click();
  await expect(page.getByTestId('review-state').filter({ hasText: 'alice: Approved' })).toHaveCount(1);
});

test('[BD-GHREV-CMT-T004][BD-GHREV-SUBMIT-T002] 最新化で行が変わると要確認になり、送信できない（削除すると解消）[BD-GHREV-CMT-T007]', async ({ page }) => {
  await openDoc(page);
  await comment(page, 'この文言を見直してください');
  await expect(page.getByTestId('pending-count')).toHaveText('1');

  const current = upstream.git('show', `feature/review:${ORDER}`);
  const next = upstream.commit('feature/review', { [ORDER]: current.replace(TARGET, '確認画面と取消画面を表示する。') + '\n' }, 'rewrite line');
  upstream.setPull(12, next);
  state.pulls[REPO][0].headSha = next;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('stale')).toHaveText('更新あり');
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('head-sha')).toHaveText(next.slice(0, 7));

  await expect(page.getByTestId('pending-count')).toHaveText('1');
  await page.getByTestId('to-review').click();
  const item = page.getByTestId('pending-item');
  await expect(item).toHaveAttribute('data-state', 'Drifted');
  await expect(page.getByTestId('pending-drifted')).toContainText('位置を確認していません');
  const before = reviewPosts().length;
  await page.getByTestId('body').fill('確認してください');
  await page.getByTestId('review-submit').click();
  await expect(page.getByTestId('submit-error')).toHaveText('位置を確認していないコメントがあります');
  expect(reviewPosts().length).toBe(before);

  await item.getByTestId('pending-delete').click();
  await expect(page.getByTestId('pending-item')).toHaveCount(0);
});
