import { expect, test, type Page } from '@playwright/test';

// REQ-206 モック調整モード（BD-GHREV-TUNE / DD-TUNE）: the local workspace has no pending review, so 保留に追加 copies the HTML.

const BASIC = '/#/doc?path=docs/design/basic/order.md';

async function openMock(page: Page) {
  await page.goto(BASIC);
  const mock = page.getByTestId('mock');
  await expect(mock).toBeVisible();
  const frame = mock.frameLocator('iframe');
  await expect(frame.locator('[data-screen=List]')).toBeVisible();
  return { mock, frame };
}

test('[BD-GHREV-TUNE-T001][BD-GHREV-TUNE-T009][BD-GHREV-TUNE-P007][BD-GHREV-TUNE-X001][BD-GHREV-TUNE-X002][BD-GHREV-TUNE-X003][BD-GHREV-TUNE-X004][BD-GHREV-TUNE-X005] 通常のときはクリックで画面が進み、調整の入力欄は出ない', async ({ page }) => {
  const { mock, frame } = await openMock(page);
  await expect(mock.getByTestId('tune-mode')).toHaveCount(0);
  await expect(mock.getByTestId('tune-end')).toHaveCount(0);
  await expect(mock.getByTestId('t-add')).toHaveCount(0);
  await expect(mock.getByTestId('t-cancel')).toHaveCount(0);
  await frame.getByTestId('new').click();
  await expect(frame.locator('[data-screen=Input]')).toBeVisible();
});

test('[BD-GHREV-TUNE-T002][BD-GHREV-TUNE-T004][BD-GHREV-TUNE-T008][BD-GHREV-TUNE-P005][BD-GHREV-TUNE-P006][BD-GHREV-TUNE-X006][BD-GHREV-TUNE-X007][BD-GHREV-TUNE-X008][BD-GHREV-TUNE-X009] 調整 → data-bind の要素は対応する行なし → 調整終了', async ({ page }) => {
  const { mock, frame } = await openMock(page);
  await mock.getByTestId('tune-start').click();
  await expect(mock.getByTestId('tune-mode')).toHaveAttribute('data-state', 'Picking');
  await expect(mock.getByTestId('tune-start')).toBeDisabled();
  await expect(mock.getByTestId('t-add')).toHaveCount(0);
  await expect(mock.getByTestId('t-cancel')).toHaveCount(0);
  await expect(mock.getByTestId('t-text')).toHaveCount(0);
  if (await mock.getByTestId('player-play').count()) await expect(mock.getByTestId('player-play')).toBeDisabled();

  await frame.getByTestId('orders').locator('td').first().click();
  await expect(mock.getByTestId('pick-error')).toHaveText('対応する行なし：data-bind で作られた要素です');
  await expect(mock.getByTestId('tune-mode')).toHaveAttribute('data-state', 'Picking');
  await expect(frame.locator('[data-screen=List]')).toBeVisible(); // the click is a pick, not an operation

  await mock.getByTestId('tune-end').click();
  await expect(mock.getByTestId('tune-mode')).toHaveCount(0);
  await expect(mock.getByTestId('tune-start')).toBeEnabled();
  await frame.getByTestId('new').click();
  await expect(frame.locator('[data-screen=Input]')).toBeVisible();
});

test('[BD-GHREV-TUNE-T003][BD-GHREV-TUNE-T005][BD-GHREV-TUNE-T007][BD-GHREV-TUNE-P002][BD-GHREV-TUNE-P004][BD-GHREV-TUNE-X010][BD-GHREV-TUNE-X011][BD-GHREV-TUNE-X012] 要素を選んで文言を変える → その場に反映 → 取消で元に戻る', async ({ page }) => {
  const { mock, frame } = await openMock(page);
  await mock.getByTestId('tune-start').click();
  await frame.getByTestId('new').click();
  await expect(mock.getByTestId('tune-mode')).toHaveAttribute('data-state', 'Editing');
  await expect(mock.getByTestId('tune-end')).toHaveCount(0);
  await expect(mock.getByTestId('tune-start')).toBeDisabled();
  await expect(mock.getByTestId('t-text')).toHaveValue('新規');
  await expect(mock.getByTestId('t-add')).toBeDisabled();

  await mock.getByTestId('t-text').fill('新規注文');
  await expect(frame.getByTestId('new')).toHaveText('新規注文');
  const suggestion = mock.getByTestId('suggestion');
  await expect(suggestion).toContainText('- ');
  await expect(suggestion).toContainText('data-goto="Input">新規注文</button>');
  await expect(mock.getByTestId('t-add')).toBeEnabled();

  // 編集中のクリックは選択にならない
  await frame.locator('h2').first().click();
  await expect(mock.getByTestId('t-text')).toHaveValue('新規注文');

  await mock.getByTestId('t-cancel').click();
  await expect(mock.getByTestId('tune-mode')).toHaveAttribute('data-state', 'Picking');
  await expect(frame.getByTestId('new')).toHaveText('新規');
  await mock.getByTestId('tune-end').click();
});

test('[BD-GHREV-TUNE-T006][BD-GHREV-TUNE-P001] 手元のワークスペースでは「HTML をコピー」で変更後の行をコピーする', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { mock, frame } = await openMock(page);
  await mock.getByTestId('tune-start').click();
  await frame.getByTestId('new').click();
  await mock.getByTestId('t-title').fill('注文を追加');
  await expect(frame.getByTestId('new')).toHaveAttribute('title', '注文を追加');
  await expect(mock.getByTestId('suggestion')).toContainText('title="注文を追加"');
  await expect(mock.getByTestId('t-add')).toHaveText('HTML をコピー');
  await mock.getByTestId('t-add').click();
  await expect(mock.getByTestId('tune-mode')).toHaveAttribute('data-state', 'Picking');
  await expect(mock.getByTestId('tune-notice')).toContainText('docs/mocks/order/index.html L');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('<button class="btn btn-primary" data-testid="new"');
  expect(copied).toContain('title="注文を追加"');
  await expect(mock.getByTestId('tune-pending')).toHaveCount(0);
  // 変更はその場の DOM に残り、調整終了で戻る
  await expect(frame.getByTestId('new')).toHaveAttribute('title', '注文を追加');
  await mock.getByTestId('tune-end').click();
  await expect(frame.getByTestId('new')).not.toHaveAttribute('title', /.*/);
});
