import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Run records e2e-seed-1/2 (BD-ORDER-SCREEN-T002 failed then passed on the same clean commit) are written by e2e/seed-history.ts.
const FLAKY_ID = 'BD-ORDER-SCREEN-T002';
const UNLINKED_ID = 'BD-ORDER-SCREEN-X001';
// Linked to a vitest test of the sample app that passes.
const PASSING_ID = 'BD-ORDER-SCREEN-T003';

async function waitIdle(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const runs = (await (await request.get('/api/runs')).json()) as Array<{ status: string }>;
      return runs.some((r) => r.status === 'running');
    }, { timeout: 60_000 })
    .toBe(false);
}

/** Makes the latest test run fail (an unlinked id ends as error) so that 「失敗を再実行」 has something to re-run. */
async function latestFails(request: APIRequestContext) {
  await waitIdle(request);
  expect((await request.post('/api/tests/run', { data: { ids: [UNLINKED_ID] } })).status()).toBe(202);
  await waitIdle(request);
}

/** No control of another screen's event (一覧へ・テストIDを選ぶ・フレーキー・失敗を再実行) other than `allowed`. */
async function expectOnlyControls(page: Page, allowed: string[]) {
  for (const id of ['detail-back', 'flaky-back', 'test-open', 'flaky-test-open', 'flaky-open', 'rerun', 'rerun-attempt']) {
    if (!allowed.includes(id)) await expect(page.getByTestId(id)).toHaveCount(0);
  }
}

test('[BD-TMON-SCREEN-P001] [BD-TMON-SCREEN-T002] [BD-TMON-SCREEN-T003] テスト一覧の直近の結果とフレーキーの印から、テストIDの履歴を開いて戻る', async ({ page }) => {
  await page.goto('/#/tests');
  const row = page.locator(`[data-testid=test-row][data-test-id=${FLAKY_ID}]`);
  await expect(row.getByTestId('test-dots').locator('.dot')).toHaveCount(10);
  await expect(row.getByTestId('flaky-mark')).toBeVisible();

  await row.getByTestId('test-open').click();
  await expect(page).toHaveURL(new RegExp(`#/tests/history/${FLAKY_ID}`));
  await expect(page.getByTestId('detail-title')).toContainText(FLAKY_ID);
  await expect(page.getByTestId('detail-flaky')).toContainText('e2e5eed');
  const seeded = page.locator('[data-testid=history-row][data-run-id=e2e-seed-1]');
  await expect(seeded).toContainText('e2e5eed');
  await expect(seeded).toContainText('失敗');
  await expect(seeded).toContainText('1.2s');
  await expect(seeded).toContainText('expected Confirm but got Input');
  await expect(page.getByTestId('history-trace')).toHaveCount(0);

  await page.getByTestId('detail-back').click();
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('[BD-TMON-SCREEN-P002] [BD-TMON-SCREEN-P003] [BD-TMON-SCREEN-T004] [BD-TMON-SCREEN-T005] [BD-TMON-SCREEN-T006] フレーキー一覧からテストIDの履歴へ、一覧へ戻る', async ({ page }) => {
  await page.goto('/#/tests');
  await page.getByTestId('flaky-open').click();
  await expect(page).toHaveURL(/#\/tests\/flaky$/);
  const list = page.getByTestId('flaky-list');
  const row = list.locator(`tr[data-test-id=${FLAKY_ID}]`);
  await expect(row).toContainText('e2e5eed');
  await expect(row).toContainText('1 / 1');

  await page.getByTestId('flaky-back').click();
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByTestId('test-list')).toBeVisible();

  await page.getByTestId('flaky-open').click();
  await row.getByTestId('flaky-test-open').click();
  await expect(page).toHaveURL(new RegExp(`#/tests/history/${FLAKY_ID}`));
  await expect(page.getByTestId('detail-title')).toContainText(FLAKY_ID);
  await page.getByTestId('detail-back').click();
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('ロックにないテストIDの履歴は、その旨を表示する', async ({ page }) => {
  await page.goto('/#/tests/history/BD-NOPE-NOPE-T999');
  await expect(page.getByTestId('detail-title')).toContainText('このテストIDはロックにありません');
  await expect(page.getByTestId('history')).toContainText('まだ実行していません');
});

test('[BD-TMON-SCREEN-P006] [BD-TMON-SCREEN-T001] [BD-TMON-SCREEN-T010] テストタブを開くとテスト一覧で、他のタブへ移って終える', async ({ page }) => {
  await page.goto('/#/tests');
  await expect(page.getByTestId('tests-page')).toBeVisible();
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expect(page.getByTestId('test-row').first()).toBeVisible();
  await page.goto('/#/doc?path=docs/design/basic/order.md');
  await expect(page.getByTestId('tests-page')).toHaveCount(0);
});

test('[BD-TMON-SCREEN-X001] [BD-TMON-SCREEN-X002] テスト一覧には「一覧へ」が無く、（再実行でない）実行の完了でもテスト一覧のまま', async ({ page, request }) => {
  await page.goto('/#/tests');
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expectOnlyControls(page, ['test-open', 'flaky-open', 'rerun']);
  await latestFails(request);
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expect(page.getByTestId('rerun-attempt')).toHaveCount(0);
});

test('[BD-TMON-SCREEN-X003] [BD-TMON-SCREEN-X004] [BD-TMON-SCREEN-X005] [BD-TMON-SCREEN-X006] テストIDの履歴にはテストIDを選ぶ・フレーキー・失敗を再実行が無く、再実行が完了しても履歴のまま', async ({ page, request }) => {
  await latestFails(request);
  await page.goto(`/#/tests/history/${FLAKY_ID}`);
  await expect(page.getByTestId('test-history')).toBeVisible();
  await expectOnlyControls(page, ['detail-back']);
  await expect(page.getByTestId('detail-back')).toBeVisible();

  expect((await request.post('/api/tests/rerun', { data: { times: 2 } })).status()).toBe(202);
  await waitIdle(request);
  await expect(page).toHaveURL(new RegExp(`#/tests/history/${FLAKY_ID}$`));
  await expect(page.getByTestId('detail-title')).toContainText(FLAKY_ID);
  await expectOnlyControls(page, ['detail-back']);
});

test('[BD-TMON-SCREEN-X007] [BD-TMON-SCREEN-X008] [BD-TMON-SCREEN-X009] フレーキー一覧にはフレーキー・失敗を再実行が無く、再実行が完了してもフレーキー一覧のまま', async ({ page, request }) => {
  await latestFails(request);
  await page.goto('/#/tests/flaky');
  await expect(page.getByTestId('flaky-page')).toBeVisible();
  await expectOnlyControls(page, ['flaky-back', 'flaky-test-open']);
  await expect(page.getByTestId('flaky-test-open').first()).toBeVisible();

  expect((await request.post('/api/tests/rerun', { data: { times: 2 } })).status()).toBe(202);
  await waitIdle(request);
  await expect(page).toHaveURL(/#\/tests\/flaky$/);
  await expect(page.getByTestId('flaky-page')).toBeVisible();
  await expectOnlyControls(page, ['flaky-back', 'flaky-test-open']);
});

test('[BD-TMON-SCREEN-P004] [BD-TMON-SCREEN-T007] [BD-TMON-SCREEN-T009] [BD-TMON-SCREEN-X010] [BD-TMON-SCREEN-X011] [BD-TMON-SCREEN-X012] [BD-TMON-SCREEN-X013] 失敗を再実行すると再実行中になり（他の画面へは移れない）、指定の回数だけ続けて実行して一覧に戻り、履歴に再実行として残る', async ({ page, request }) => {
  await latestFails(request);

  // The unlinked id fails at once: hold the result of each attempt so that the page stays in 再実行中 until released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/runs\/[^/?]+$/, async (route) => {
    await gate;
    await route.continue();
  });

  // Both attempts end within milliseconds: the page must be subscribed to /api/events before the 2nd attempt's `run` event.
  const subscribed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/events');
  await page.goto('/#/tests');
  await subscribed;
  await page.getByTestId('rerun-times').selectOption('2');
  const rerun = page.getByTestId('rerun');
  await expect(rerun).toBeEnabled();
  await rerun.click();
  await expect(page.getByTestId('rerun-error')).toHaveCount(0);

  const attempt = page.getByTestId('rerun-attempt');
  await expect(attempt).toHaveText(/[12] \/ 2 回目/);
  await expect(page.getByTestId('rerun-log')).toBeVisible();
  await expect(page).toHaveURL(/#\/tests$/);
  // X010 テストIDを選ぶ: the ids are not links.
  await expect(page.getByTestId('test-open')).toHaveCount(0);
  await page.locator(`[data-testid=test-row][data-test-id=${FLAKY_ID}] code.test-id`).click();
  await expect(page).toHaveURL(/#\/tests$/);
  // X011 一覧へ・X012 フレーキー・X013 失敗を再実行.
  await expect(page.getByTestId('detail-back')).toHaveCount(0);
  await expect(page.getByTestId('flaky-back')).toHaveCount(0);
  await expect(page.getByTestId('flaky-open')).toBeDisabled();
  await expect(rerun).toBeDisabled();
  await expect(rerun).toHaveAttribute('title', 'テストの実行中は再実行できません');
  await expect(attempt).toBeVisible();

  await waitIdle(request);
  await expect(attempt).toHaveText('2 / 2 回目');
  release();
  await expect(attempt).toHaveCount(0);
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expect(page.getByTestId('test-open').first()).toBeVisible();
  await expect(page.getByTestId('flaky-open')).toBeEnabled();
  await page.unroute(/\/api\/runs\/[^/?]+$/);

  const h = (await (await request.get(`/api/history/tests/${UNLINKED_ID}`)).json()) as { entries: Array<{ attempt?: number; times?: number }> };
  expect(h.entries[0]).toMatchObject({ attempt: 2, times: 2 });
  await page.goto(`/#/tests/history/${UNLINKED_ID}`);
  const rows = page.getByTestId('history-row');
  await expect(rows.nth(0)).toContainText('再実行 2/2');
  await expect(rows.nth(1)).toContainText('再実行 1/2');
  await expect(page.getByTestId('first-failure')).toBeVisible();
});

test('[BD-TMON-SCREEN-P005] [BD-TMON-SCREEN-T008] 直近の実行に失敗が無ければ「失敗を再実行」は押せず、理由を出してテスト一覧のまま', async ({ page, request }) => {
  await waitIdle(request);
  expect((await request.post('/api/tests/run', { data: { ids: [PASSING_ID] } })).status()).toBe(202);
  await waitIdle(request);
  const latest = ((await (await request.get('/api/runs')).json()) as Array<{ status: string; results: Record<string, { status: string }> }>)[0];
  expect(latest.status).toBe('passed');
  expect(latest.results[PASSING_ID].status).toBe('passed');

  await page.goto('/#/tests');
  const rerun = page.getByTestId('rerun');
  await expect(rerun).toHaveText('失敗を再実行 (0)');
  await expect(rerun).toBeDisabled();
  await expect(rerun).toHaveAttribute('title', '直近の実行に失敗したテストはありません');
  await rerun.click({ force: true });
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expect(page.getByTestId('rerun-attempt')).toHaveCount(0);

  const res = await request.post('/api/tests/rerun', { data: { times: 2 } });
  expect(res.status()).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'no-failures', error: '直近の実行に失敗したテストはありません' });
});

test('設計カバレッジ：文書と図の集計、図の色分け、行を選ぶと強調に戻る', async ({ page }) => {
  await page.goto('/#/doc?path=docs/design/basic/order.md');
  await expect(page.getByTestId('coverage-doc')).toContainText(/テストID \d+・紐づけ \d+（\d+%）・実行 \d+（\d+%）・成功 \d+（\d+%）/);
  const fig = page.locator('figure[data-diagram=screen-flow]');
  await expect(fig.locator('svg')).toBeVisible();
  await expect(fig.getByTestId('coverage-diagram')).toBeVisible();

  const matrix = page.locator('[data-testid=matrix][data-diagram-key*=SCREEN]').first();
  await expect(matrix.locator('[data-testid=matrix-row][data-test-id=BD-ORDER-SCREEN-X002] [data-testid=matrix-coverage]')).toHaveAttribute('data-class', 'unlinked');
  await expect(matrix.locator(`[data-testid=matrix-row][data-test-id=${FLAKY_ID}] [data-testid=matrix-flaky]`)).toBeVisible();

  const toggle = fig.getByTestId('coverage-toggle');
  await toggle.check();
  await expect(fig.locator('svg [class*=ddv-cov-]').first()).toBeAttached();
  await expect(fig.locator('svg .ddv-hl')).toHaveCount(0);

  await matrix.locator(`[data-testid=matrix-row][data-test-id=${FLAKY_ID}]`).click();
  await expect(toggle).not.toBeChecked();
  await expect(fig.locator('svg [class*=ddv-cov-]')).toHaveCount(0);
  await expect(fig.locator('svg .ddv-hl').first()).toBeAttached();

  await matrix.locator(`[data-testid=matrix-row][data-test-id=${FLAKY_ID}]`).getByTestId('matrix-history').click();
  await expect(page.getByTestId('detail-title')).toContainText(FLAKY_ID);
});
