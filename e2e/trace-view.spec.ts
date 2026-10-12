import { expect, test, type Page } from '@playwright/test';

// e2e-trace-1 (P001 failed at step 2, with its trace) and e2e-trace-0 (P002, a run from before traces) are written by e2e/seed-history.ts.
const TRACE_ID = 'BD-ORDER-SCREEN-P001';
const OLD_ID = 'BD-ORDER-SCREEN-P002';
const TRACE_RUN = 'e2e-trace-1';
const BASIC = '/#/doc?path=docs/design/basic/order.md';

const step = (page: Page, n: number) => page.locator(`[data-testid=timeline-step][data-index="${n}"]`);

async function expectSelected(page: Page, n: number) {
  await expect(step(page, n)).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('trace-detail')).toHaveAttribute('data-index', String(n));
}

/** On the trace screen the result screen's 「トレースを開く」 is gone, and vice versa. */
async function expectNoTraceControls(page: Page) {
  for (const id of ['trace-back', 'notrace-back', 'step-select', 'step-prev', 'step-next']) await expect(page.getByTestId(id)).toHaveCount(0);
}

test('[BD-TRACE-VIEW-P001] [BD-TRACE-VIEW-T001] [BD-TRACE-VIEW-T002] [BD-TRACE-VIEW-T005] [BD-TRACE-VIEW-T007] [BD-TRACE-VIEW-X004] テスト一覧から失敗のトレースを開き、失敗したステップの詳細を見て、ステップを選び、戻る', async ({ page }) => {
  await page.goto('/#/tests');
  const row = page.locator(`[data-testid=test-row][data-test-id=${TRACE_ID}]`);
  await row.getByTestId('test-trace').click();
  await expect(page).toHaveURL(new RegExp(`#/tests/trace/${TRACE_RUN}/${TRACE_ID}$`));

  await expect(page.getByTestId('trace-header')).toContainText(TRACE_ID);
  await expect(page.getByTestId('trace-header')).toContainText('e2e5eed');
  await expect(page.getByTestId('trace-header')).toContainText('モック');
  await expect(page.getByTestId('trace-header')).toContainText('4.1s');
  await expect(page.getByTestId('trace-status')).toHaveText('失敗：ステップ 2');
  await expect(page.getByTestId('timeline-step')).toHaveCount(2);
  await expect(step(page, 2)).toHaveAttribute('data-ok', 'false');
  await expectSelected(page, 2);

  await expect(page.locator('img[data-testid=screenshot]')).toHaveAttribute('src', new RegExp(`/api/traces/${TRACE_RUN}/${TRACE_ID}/steps/2\\.png$`));
  await expect.poll(() => page.locator('img[data-testid=screenshot]').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(page.getByTestId('trace-action')).toContainText('customer：山田 太郎');
  await expect(page.getByTestId('trace-action')).toContainText('クリック next');
  await expect(page.getByTestId('trace-screen')).toContainText('Input → Input');
  await expect(page.getByTestId('trace-screen').locator('.ng')).toHaveText('（期待 Confirm）');
  const expects = page.getByTestId('expect-table').locator('tbody tr');
  await expect(expects).toHaveCount(2);
  await expect(expects.nth(1)).toContainText('text confirm-customer');
  await expect(expects.nth(1)).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('trace-error')).toContainText('画面が Confirm ではなく Input です');
  await expect(page.getByTestId('api-call')).toContainText('409');
  await page.getByTestId('api-call').click();
  await expect(page.getByTestId('api-call-body')).toContainText('在庫が不足しています');
  await expect(page.getByTestId('db-diff')).toContainText('new → held');
  await expect(page.getByTestId('db-diff').locator('.changed')).toHaveCount(1);
  await expect(page.getByTestId('test-trace')).toHaveCount(0);
  await expect(page.getByTestId('trace-open')).toHaveCount(0);

  await step(page, 1).getByTestId('step-select').click();
  await expectSelected(page, 1);
  await expect(page.getByTestId('trace-screen')).toContainText('List → Input');
  await expect(page.getByTestId('trace-screen').locator('.ng')).toHaveCount(0);
  await expect(page.getByTestId('api-calls')).toHaveText('通信はありません');
  await expect(page.getByTestId('db-diff')).toHaveText('変化なし');
  await expect(page.getByTestId('trace-error')).toHaveCount(0);

  await page.getByTestId('trace-back').click();
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('[BD-TRACE-VIEW-P002] [BD-TRACE-VIEW-T006] マトリクスの行から開き、← → と前・次で前後のステップへ（端では動かない）', async ({ page }) => {
  await page.goto(BASIC);
  const row = page.locator(`[data-testid=matrix-row][data-test-id=${TRACE_ID}]`).first();
  await row.getByTestId('trace-open').click();
  await expectSelected(page, 2);
  await expect(page.getByTestId('step-next')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expectSelected(page, 2);
  await page.keyboard.press('ArrowLeft');
  await expectSelected(page, 1);
  await expect(page.getByTestId('step-prev')).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expectSelected(page, 1);
  await page.getByTestId('step-next').click();
  await expectSelected(page, 2);
  await page.getByTestId('step-prev').click();
  await expectSelected(page, 1);

  await page.getByTestId('trace-back').click();
  await expect(page).toHaveURL(/#\/doc\?path=docs/);
  await expect(page.getByTestId('matrix').first()).toBeVisible();
});

test('[BD-TRACE-VIEW-P003] テストIDの履歴からトレースを開いて、そのまま戻る', async ({ page }) => {
  await page.goto(`/#/tests/history/${TRACE_ID}`);
  const seeded = page.locator(`[data-testid=history-row][data-run-id=${TRACE_RUN}]`);
  await seeded.getByTestId('history-trace').click();
  await expect(page.getByTestId('trace-status')).toHaveText('失敗：ステップ 2');
  await page.getByTestId('trace-back').click();
  await expect(page.getByTestId('test-history')).toBeVisible();
});

test('[BD-TRACE-VIEW-P004] [BD-TRACE-VIEW-T003] [BD-TRACE-VIEW-T004] [BD-TRACE-VIEW-X005] [BD-TRACE-VIEW-X006] [BD-TRACE-VIEW-X007] 記録の無い実行のトレースを開くと理由を出し、戻れる', async ({ page }) => {
  await page.goto('/#/tests');
  const row = page.locator(`[data-testid=test-row][data-test-id=${OLD_ID}]`);
  await row.getByTestId('test-trace').click();
  await expect(page.getByTestId('no-trace')).toHaveText('トレースの導入前の実行です');
  for (const id of ['test-trace', 'trace-open', 'step-select', 'step-prev', 'step-next', 'timeline']) await expect(page.getByTestId(id)).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('no-trace')).toBeVisible();
  await page.getByTestId('notrace-back').click();
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('[BD-TRACE-VIEW-P005] [BD-TRACE-VIEW-T008] [BD-TRACE-VIEW-X001] [BD-TRACE-VIEW-X002] [BD-TRACE-VIEW-X003] テスト結果には戻る・ステップの操作が無い', async ({ page }) => {
  await page.goto('/#/tests');
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expect(page.locator(`[data-testid=test-row][data-test-id=${TRACE_ID}]`).getByTestId('test-trace')).toBeVisible();
  await expectNoTraceControls(page);
});

test('直接開いた消えた実行のトレースは unknownRun の理由を出し、戻るとテスト一覧へ', async ({ page }) => {
  await page.goto(`/#/tests/trace/no-such-run/${TRACE_ID}`);
  await expect(page.getByTestId('no-trace')).toHaveText('この実行の記録はありません（保持件数を超えて削除されました）');
  await page.getByTestId('notrace-back').click();
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('プレイヤーのライブ表示：再生したステップの記録（API・DB の変化）を逐次表示し、リセットで消える', async ({ page }) => {
  await page.goto(BASIC);
  const player = page.getByTestId('player');
  await expect(player).toBeVisible();
  await player.getByTestId('player-speed').selectOption({ label: '最速' });
  await expect(page.getByTestId('trace-live')).toHaveCount(0);
  await player.getByTestId('trace-live-toggle').click();
  const live = page.getByTestId('trace-live');
  await expect(live).toBeVisible();
  await expect(page.getByTestId('trace-live-draft')).toHaveCount(0);

  await player.getByTestId('player-scenario').selectOption(TRACE_ID);
  await player.getByTestId('player-play').click();
  await expect(player.getByTestId('player-status')).toHaveAttribute('data-state', 'Done');
  await expect(live.getByTestId('timeline-step')).toHaveCount(5);
  await expect(live).not.toContainText('この runtime は記録に対応していません');
  await expect(live.locator('[data-testid=timeline-step][data-index="5"]')).toHaveAttribute('aria-current', 'step');
  await expect(live.getByTestId('screenshot')).toHaveCount(0);
  await expect(live.getByTestId('trace-screen')).toContainText('Confirm → Done');
  await expect(live.getByTestId('api-call').filter({ hasText: 'POST' }).filter({ hasText: '/orders' })).toHaveCount(1);
  await expect(live.locator('[data-testid=db-diff] caption', { hasText: 'orders' })).toHaveCount(1);
  await expect(live.locator('[data-testid=db-change][data-kind=added]').first()).toBeVisible();

  await player.getByTestId('player-reset').click();
  await expect(live.getByTestId('timeline-step')).toHaveCount(0);
  await player.getByTestId('trace-live-toggle').click();
  await expect(page.getByTestId('trace-live')).toHaveCount(0);
});
