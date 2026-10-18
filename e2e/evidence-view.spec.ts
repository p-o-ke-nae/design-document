import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

// e2e-evidence-1 (a passed P004 whose step 1 has a screenshot and a table, step 2 a failed hook) is written by e2e/seed-history.ts.
const EV_ID = 'BD-ORDER-SCREEN-P004';
const EV_RUN = 'e2e-evidence-1';
const BASIC = '/#/doc?path=docs/design/basic/order.md';

const matrixRow = (page: Page) => page.locator(`[data-testid=matrix-row][data-test-id=${EV_ID}]`).first();
const step = (page: Page, n: number) => page.locator(`[data-testid=timeline-step][data-index="${n}"]`);
const evidenceRow = (page: Page, seq: number) => page.getByTestId('evidence-list').locator(`tbody tr[data-seq="${seq}"]`).first();
const absent = async (page: Page, ...ids: string[]) => {
  for (const id of ids) await expect(page.getByTestId(id), id).toHaveCount(0);
};
/** Covered by the modal dialog: the click never reaches it. */
const blocked = async (target: Locator) => {
  await expect(target.click({ trial: true, timeout: 1_000 })).rejects.toThrow();
};

async function openResult(page: Page) {
  await page.goto(BASIC);
  await expect(matrixRow(page)).toBeVisible();
}

async function openTrace(page: Page) {
  await openResult(page);
  await matrixRow(page).getByTestId('trace-open').click();
  await expect(page).toHaveURL(new RegExp(`#/tests/trace/${EV_RUN}/${EV_ID}$`));
  await expect(page.getByTestId('timeline-step')).toHaveCount(2);
}

async function selectStep(page: Page, n: number) {
  await step(page, n).getByTestId('step-select').click();
  await expect(page.getByTestId('trace-detail')).toHaveAttribute('data-index', String(n));
}

test('[BD-EVIVIEW-SCREEN-P007][BD-EVIVIEW-SCREEN-T001][BD-EVIVIEW-SCREEN-T010][BD-EVIVIEW-SCREEN-X001][BD-EVIVIEW-SCREEN-X002][BD-EVIVIEW-SCREEN-X003][BD-EVIVIEW-SCREEN-X004][BD-EVIVIEW-SCREEN-X005][BD-EVIVIEW-SCREEN-X006] テスト結果に証跡の件数と警告が出て、ステップ・証跡の操作は無い', async ({ page }) => {
  await openResult(page);
  const count = matrixRow(page).getByTestId('evidence-count');
  await expect(count).toHaveText('証跡 3・警告 1');
  await expect(count).toHaveClass(/st-warn/);
  await absent(page, 'step-select', 'evidence-open', 'evidence-save', 'evidence-next', 'evidence-close', 'trace-back');
});

test('[BD-EVIVIEW-SCREEN-P001][BD-EVIVIEW-SCREEN-P006][BD-EVIVIEW-SCREEN-T002][BD-EVIVIEW-SCREEN-T003][BD-EVIVIEW-SCREEN-T009][BD-EVIVIEW-SCREEN-X007][BD-EVIVIEW-SCREEN-X008][BD-EVIVIEW-SCREEN-X009][BD-EVIVIEW-SCREEN-X010] トレースのタイムラインに証跡の件数と警告の印が出て、ステップを選ぶと一覧が出る。行の保存では画面は変わらない', async ({ page }) => {
  await openTrace(page);
  await expect(step(page, 1).getByTestId('timeline-evidence')).toHaveText('証跡 2');
  await expect(step(page, 2).getByTestId('timeline-evidence')).toContainText('証跡 1');
  await expect(step(page, 2).locator('[title="証跡の警告・失敗があります"]')).toBeVisible();
  // トレース：トレースを開く・次の証跡・閉じる は無い
  await absent(page, 'trace-open', 'evidence-dialog', 'evidence-next', 'evidence-close');

  await selectStep(page, 1);
  const list = page.getByTestId('evidence-list');
  await expect(list.locator('tbody tr')).toHaveCount(2);
  await expect(evidenceRow(page, 1)).toContainText('入力画面');
  await expect(evidenceRow(page, 1)).toContainText('画像');
  await expect(evidenceRow(page, 2)).toContainText('注文表');
  await expect(evidenceRow(page, 2)).toContainText('表');

  // 行の保存：その場でダウンロードし、トレースのまま
  const download = page.waitForEvent('download');
  await evidenceRow(page, 1).getByTestId('evidence-save').click();
  expect((await download).suggestedFilename()).toBe('1-after-1-screen.png');
  await absent(page, 'evidence-dialog');
  await expect(page.getByTestId('trace-view')).toBeVisible();

  await page.getByTestId('trace-back').click();
  await expect(page).toHaveURL(/#\/doc\?path=docs/);
  await expect(matrixRow(page)).toBeVisible();

  // トレースを開いてそのまま戻る
  await matrixRow(page).getByTestId('trace-open').click();
  await expect(page.getByTestId('trace-view')).toBeVisible();
  await page.getByTestId('trace-back').click();
  await expect(matrixRow(page)).toBeVisible();
});

test('[BD-EVIVIEW-SCREEN-P002][BD-EVIVIEW-SCREEN-P004][BD-EVIVIEW-SCREEN-T004][BD-EVIVIEW-SCREEN-T006][BD-EVIVIEW-SCREEN-T008][BD-EVIVIEW-SCREEN-X011][BD-EVIVIEW-SCREEN-X012][BD-EVIVIEW-SCREEN-X013][BD-EVIVIEW-SCREEN-X014] 表の証跡を開き、注記を見て CSV で保存し、閉じてトレースに戻る', async ({ page }) => {
  await openTrace(page);
  await selectStep(page, 1);
  await evidenceRow(page, 2).getByTestId('evidence-open').click();
  const dialog = page.getByTestId('evidence-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('evidence-title')).toHaveText('注文表');
  await expect(page.getByTestId('evidence-table')).toBeVisible();
  await expect(page.getByTestId('evidence-table')).toContainText('山田 太郎');
  await expect(page.getByTestId('evidence-note')).toHaveText('card_no は伏せています。1 行中 1 行を表示。');
  await expect(page.getByTestId('evidence-close')).toBeFocused();

  // 証跡の表示：トレースを開く は無い。ステップを選ぶ・証跡を開く・戻る は後ろにあって押せない。← → はステップを動かさない
  await absent(page, 'trace-open');
  await blocked(step(page, 2).getByTestId('step-select'));
  await blocked(evidenceRow(page, 1).getByTestId('evidence-open'));
  await blocked(page.getByTestId('trace-back'));
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('trace-detail')).toHaveAttribute('data-index', '1');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('evidence-title')).toHaveText('注文表');

  const download = page.waitForEvent('download');
  await dialog.getByTestId('evidence-save').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('1-after-2-orders.csv');
  const bytes = await readFile((await file.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.subarray(3).toString('utf8')).toBe('id,customer,card_no,note\r\n1,山田 太郎,****,"a,""b"""');
  await expect(dialog).toBeVisible();

  await page.getByTestId('evidence-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(evidenceRow(page, 2).getByTestId('evidence-open')).toBeFocused();
  await expect(page.getByTestId('trace-detail')).toHaveAttribute('data-index', '1');

  // 開いて閉じるだけ（Esc でも閉じる）
  await evidenceRow(page, 2).getByTestId('evidence-open').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByTestId('trace-back').click();
  await expect(matrixRow(page)).toBeVisible();
});

test('[BD-EVIVIEW-SCREEN-P003][BD-EVIVIEW-SCREEN-T007] 画像の証跡を開き、次の証跡で表へ移って閉じる', async ({ page }) => {
  await openTrace(page);
  await selectStep(page, 1);
  await evidenceRow(page, 1).getByTestId('evidence-open').click();
  await expect(page.getByTestId('evidence-title')).toHaveText('入力画面');
  await expect.poll(() => page.getByTestId('evidence-image').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await page.getByTestId('evidence-next').click();
  await expect(page.getByTestId('evidence-title')).toHaveText('注文表');
  await expect(page.getByTestId('evidence-table')).toBeVisible();
  await page.getByTestId('evidence-close').click();
  await expect(page.getByTestId('evidence-dialog')).toHaveCount(0);
  await page.getByTestId('trace-back').click();
  await expect(matrixRow(page)).toBeVisible();
});

test('[BD-EVIVIEW-SCREEN-P005][BD-EVIVIEW-SCREEN-T005] 取得に失敗した証跡は開くと理由が行の下に広がり、トレースのまま', async ({ page }) => {
  await openTrace(page);
  await selectStep(page, 2);
  const r = evidenceRow(page, 1);
  await expect(r).toHaveAttribute('data-status', 'failed');
  await expect(r.getByTestId('evidence-save')).toHaveCount(0);
  await r.getByTestId('evidence-open').click();
  await expect(page.getByTestId('evidence-error')).toHaveText('取得に失敗しました：connect ECONNREFUSED');
  await absent(page, 'evidence-dialog');
  await r.getByTestId('evidence-open').click();
  await expect(page.getByTestId('evidence-error')).toHaveCount(0);
  await page.getByTestId('trace-back').click();
  await expect(matrixRow(page)).toBeVisible();
});

test('証跡の API：Content-Type・nosniff・download=1・削除済みは pruned', async ({ page }) => {
  await openResult(page);
  const base = `/api/traces/${EV_RUN}/${EV_ID}/evidence`;
  const img = await page.request.get(`${base}/1-after-1-screen.png`);
  expect(img.status()).toBe(200);
  expect(img.headers()['content-type']).toBe('image/png');
  expect(img.headers()['x-content-type-options']).toBe('nosniff');
  const dl = await page.request.get(`${base}/1-after-2-orders.table.json?download=1`);
  expect(dl.headers()['content-disposition']).toContain('attachment');
  const missing = await page.request.get(`${base}/9-after-1-none.png`);
  expect(missing.status()).toBe(404);
});
