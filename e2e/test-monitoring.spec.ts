import { expect, test, type APIRequestContext } from '@playwright/test';

// Run records e2e-seed-1/2 (BD-ORDER-SCREEN-T002 failed then passed on the same clean commit) are written by e2e/seed-history.ts.
const FLAKY_ID = 'BD-ORDER-SCREEN-T002';
const UNLINKED_ID = 'BD-ORDER-SCREEN-X001';

async function waitIdle(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const runs = (await (await request.get('/api/runs')).json()) as Array<{ status: string }>;
      return runs.some((r) => r.status === 'running');
    }, { timeout: 60_000 })
    .toBe(false);
}

test('[BD-TMON-SCREEN-P001] テスト一覧の直近の結果とフレーキーの印から、テストIDの履歴を開いて戻る', async ({ page }) => {
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
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('[BD-TMON-SCREEN-P002] [BD-TMON-SCREEN-P003] フレーキー一覧からテストIDの履歴へ、一覧へ戻る', async ({ page }) => {
  await page.goto('/#/tests');
  await page.getByTestId('flaky-open').click();
  const list = page.getByTestId('flaky-list');
  const row = list.locator(`tr[data-test-id=${FLAKY_ID}]`);
  await expect(row).toContainText('e2e5eed');
  await expect(row).toContainText('1 / 1');

  await page.getByTestId('flaky-back').click();
  await expect(page.getByTestId('test-list')).toBeVisible();

  await page.getByTestId('flaky-open').click();
  await row.getByTestId('flaky-test-open').click();
  await expect(page.getByTestId('detail-title')).toContainText(FLAKY_ID);
  await page.getByTestId('detail-back').click();
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('ロックにないテストIDの履歴は、その旨を表示する', async ({ page }) => {
  await page.goto('/#/tests/history/BD-NOPE-NOPE-T999');
  await expect(page.getByTestId('detail-title')).toContainText('このテストIDはロックにありません');
  await expect(page.getByTestId('history')).toContainText('まだ実行していません');
});

test('[BD-TMON-SCREEN-P004] 失敗を再実行すると指定の回数だけ続けて実行し、履歴に再実行として残る', async ({ page, request }) => {
  await waitIdle(request);
  const res = await request.post('/api/tests/run', { data: { ids: [UNLINKED_ID] } });
  expect(res.status()).toBe(202);
  await waitIdle(request);

  await page.goto('/#/tests');
  await page.getByTestId('rerun-times').selectOption('2');
  const rerun = page.getByTestId('rerun');
  await expect(rerun).toBeEnabled();
  await rerun.click();
  await expect(page.getByTestId('rerun-error')).toHaveCount(0);

  await expect
    .poll(async () => {
      const h = (await (await request.get(`/api/history/tests/${UNLINKED_ID}`)).json()) as { entries: Array<{ attempt?: number; times?: number }> };
      return h.entries[0]?.attempt === 2 && h.entries[0]?.times === 2;
    }, { timeout: 60_000 })
    .toBe(true);
  await waitIdle(request);

  await page.goto(`/#/tests/history/${UNLINKED_ID}`);
  const rows = page.getByTestId('history-row');
  await expect(rows.nth(0)).toContainText('再実行 2/2');
  await expect(rows.nth(1)).toContainText('再実行 1/2');
  await expect(page.getByTestId('first-failure')).toBeVisible();
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
