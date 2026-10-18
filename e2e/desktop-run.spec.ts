import { expect, test, type Locator, type Page } from '@playwright/test';

// e2e-desk-1 (the wpf result of P005 with its trace) is written by e2e/seed-history.ts. The run itself uses the web target
// only: the desktop targets depend on the machine (Windows・.NET SDK・built apps), so their checkboxes are left unchecked.
const DESK_ID = 'BD-ORDER-SCREEN-P005';
const DESK_RUN = 'e2e-desk-1';

const row = (page: Page) => page.locator(`[data-testid=test-row][data-test-id=${DESK_ID}]`);
const absent = async (page: Page, ...ids: string[]) => {
  for (const id of ids) await expect(page.getByTestId(id), id).toHaveCount(0);
};
/** Covered by the modal dialog: the click never reaches it. */
const blocked = async (target: Locator) => {
  await expect(target.click({ trial: true, timeout: 1_000 })).rejects.toThrow();
};

async function openList(page: Page) {
  await page.goto('/#/tests');
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expect(row(page).getByTestId('badge-wpf')).toBeEnabled();
}

async function openTargets(page: Page) {
  await row(page).getByTestId('run-case').click();
  const dialog = page.getByTestId('target-select');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('target-e2e')).toBeVisible();
  await expect(dialog.getByTestId('target-start')).toBeEnabled();
  return dialog;
}

async function uncheckAll(dialog: Locator) {
  for (const box of await dialog.locator('input[type=checkbox]').all()) if ((await box.isEnabled()) && (await box.isChecked())) await box.uncheck();
}

test('[BD-DESKRUN-SCREEN-P005][BD-DESKRUN-SCREEN-P006][BD-DESKRUN-SCREEN-T001][BD-DESKRUN-SCREEN-T007][BD-DESKRUN-SCREEN-T008][BD-DESKRUN-SCREEN-T009][BD-DESKRUN-SCREEN-X001][BD-DESKRUN-SCREEN-X002][BD-DESKRUN-SCREEN-X003][BD-DESKRUN-SCREEN-X004][BD-DESKRUN-SCREEN-X014][BD-DESKRUN-SCREEN-X015][BD-DESKRUN-SCREEN-X016][BD-DESKRUN-SCREEN-X017][BD-DESKRUN-SCREEN-X018] テスト一覧のプラットフォーム別のバッジからデスクトップのトレースを開き、一覧へ戻る', async ({ page }) => {
  await openList(page);
  await expect(row(page).getByTestId('badge-wpf')).toHaveClass(/st-passed/);
  // テスト一覧：開始・キャンセル（接続先の選択）と一覧へ（トレース）は無い。実行完了の通知が無くても一覧のまま
  await absent(page, 'target-select', 'target-start', 'target-cancel', 'trace-back');

  await row(page).getByTestId('badge-wpf').click();
  await expect(page).toHaveURL(new RegExp(`#/tests/trace/${DESK_RUN}/${DESK_ID}\\?platform=wpf$`));
  await expect(page.getByTestId('trace-platform')).toHaveAttribute('data-platform', 'wpf');
  await expect(page.getByTestId('trace-status')).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('timeline-step')).toHaveCount(2);
  // トレース：実行・開始・キャンセル・結果を選ぶ は無い（実行完了で画面は変わらない）
  await absent(page, 'run-case', 'run-all', 'target-start', 'target-cancel', 'badges', 'badge-wpf', 'test-list');

  await page.getByTestId('trace-back').click();
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('[BD-DESKRUN-SCREEN-P002][BD-DESKRUN-SCREEN-P004][BD-DESKRUN-SCREEN-T002][BD-DESKRUN-SCREEN-T003][BD-DESKRUN-SCREEN-T005][BD-DESKRUN-SCREEN-X005][BD-DESKRUN-SCREEN-X006][BD-DESKRUN-SCREEN-X007][BD-DESKRUN-SCREEN-X008] 接続先の選択：1 つも選ばずに開始すると理由を出して留まり、キャンセルで一覧へ戻る', async ({ page }) => {
  await openList(page);
  let dialog = await openTargets(page);
  // 使えない接続先は無効にして理由を出す（どれが使えるかはマシンによる）
  for (const name of ['wpf', 'winforms']) {
    const box = dialog.getByTestId(`target-${name}`);
    if ((await box.count()) && (await box.isDisabled())) await expect(dialog.getByTestId(`target-${name}-reason`)).not.toBeEmpty();
  }
  // 接続先の選択：実行・結果を選ぶ は後ろの画面にあって押せない。一覧へは無い
  await blocked(page.getByTestId('run-all'));
  await blocked(row(page).getByTestId('badge-wpf'));
  await absent(page, 'trace-back');
  await dialog.getByTestId('target-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('test-list')).toBeVisible();

  dialog = await openTargets(page);
  await uncheckAll(dialog);
  await dialog.getByTestId('target-start').click();
  await expect(dialog.getByTestId('target-error')).toHaveText('接続先を選んでください');
  await expect(dialog).toBeVisible();
  // 実行完了は来ない（実行していない）
  await expect(page.locator('[data-testid=run-indicator] [data-testid=status-badge][data-status=running]')).toHaveCount(0);
  await dialog.getByTestId('target-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('test-list')).toBeVisible();
});

test('[BD-DESKRUN-SCREEN-P001][BD-DESKRUN-SCREEN-P003][BD-DESKRUN-SCREEN-T004][BD-DESKRUN-SCREEN-T006][BD-DESKRUN-SCREEN-X009][BD-DESKRUN-SCREEN-X010][BD-DESKRUN-SCREEN-X011][BD-DESKRUN-SCREEN-X012][BD-DESKRUN-SCREEN-X013] 接続先を選んで開始すると実行中になり、実行完了で一覧に結果が出る', async ({ page }) => {
  test.setTimeout(150_000);
  await openList(page);
  const dialog = await openTargets(page);
  await uncheckAll(dialog);
  await dialog.getByTestId('target-start').click();
  await expect(dialog.getByTestId('target-error')).toBeVisible();
  await dialog.getByTestId('target-e2e').check();
  await expect(dialog.getByTestId('target-error')).toHaveCount(0);
  await dialog.getByTestId('target-start').click();

  const indicator = page.getByTestId('run-indicator').getByTestId('status-badge');
  await expect(indicator).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('target-select')).toHaveCount(0);
  await expect(page.getByTestId('run-target').first()).toBeVisible();
  // 実行中：実行・結果を選ぶ は押せない。開始・キャンセル・一覧へ は無い
  await expect(page.getByTestId('run-all')).toBeDisabled();
  await expect(row(page).getByTestId('run-case')).toBeDisabled();
  await expect(row(page).getByTestId('badge-wpf')).toBeDisabled();
  await absent(page, 'target-start', 'target-cancel', 'trace-back');

  await expect(indicator).not.toHaveAttribute('data-status', 'running', { timeout: 120_000 });
  await expect(page.getByTestId('test-list')).toBeVisible();
  await expect(row(page).getByTestId('badge-web')).toHaveClass(/st-passed/);
  await expect(row(page).getByTestId('badge-wpf')).toBeEnabled();
});
