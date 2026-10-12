/** BD-HOSTV-GATE (hosted-viewer.md「操作の可否」): each operation of the Pages edition is enabled / disabled with its reason. */
import type { Page } from '@playwright/test';
import { test, expect, openHash, setPatViaMenu } from './fixtures.ts';
import { OWNER, PAT_NOSCOPE, PAT_WRITE, PR, REPO } from './github-stub.ts';

const PR_HASH = `#/gh/${OWNER}/${REPO}/pr/${PR}`;
const REVIEW_HASH = `${PR_HASH}/review`;

const submit = (page: Page) => page.getByTestId('review-submit');
/** The reason shown next to 送信. */
const reason = (page: Page) => submit(page).locator('xpath=following-sibling::*[@data-testid="disabled-reason"][1]');

async function openReview(page: Page) {
  await openHash(page, REVIEW_HASH);
  await expect(page.getByTestId('review-page')).toBeVisible();
}

test('[BD-HOSTV-GATE-P001][BD-HOSTV-GATE-T001][BD-HOSTV-GATE-T002][BD-HOSTV-GATE-S001] Pages 版で使えない操作（一括実行）は無効で、理由が出る', async ({ page }) => {
  await openHash(page, `${PR_HASH}/tests`);
  await expect(page.getByTestId('tests-page')).toBeVisible();
  await expect(page.getByTestId('run-all')).toBeDisabled();
  await expect(page.getByTestId('run-all')).toHaveAttribute('title', 'Pages 版は Actions で実行します');
  await expect(page.getByTestId('tests-page').getByTestId('disabled-reason').first()).toHaveText('Pages 版は Actions で実行します');
});

test('[BD-HOSTV-GATE-P002][BD-HOSTV-GATE-T003][BD-HOSTV-GATE-T004][BD-HOSTV-GATE-S002][BD-HOSTV-GATE-S003] GitHub へ書き込まない操作（最新化）は PAT が無くても使える', async ({ page }) => {
  await openHash(page, PR_HASH);
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：未設定');
  const refresh = page.getByRole('button', { name: '最新化' });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByTestId('doc-target')).toBeVisible();
});

test('[BD-HOSTV-GATE-P003][BD-HOSTV-GATE-T005][BD-HOSTV-GATE-T006][BD-HOSTV-GATE-S004][BD-HOSTV-GATE-S005] GitHub へ書き込む操作は PAT が無いと無効で、PAT の設定を案内する', async ({ page }) => {
  await openReview(page);
  await expect(submit(page)).toBeDisabled();
  await expect(reason(page)).toHaveText('PAT を設定してください（Pull requests: Write）');
  await expect(submit(page)).toHaveAttribute('title', 'PAT を設定してください（Pull requests: Write）');
});

test('[BD-HOSTV-GATE-P004][BD-HOSTV-GATE-T007][BD-HOSTV-GATE-T008][BD-HOSTV-GATE-S006][BD-HOSTV-GATE-S007] 権限の足りない PAT では無効で、足りない権限が出る', async ({ page }) => {
  await openReview(page);
  await setPatViaMenu(page, PAT_NOSCOPE);
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(reason(page)).toHaveText('PAT に public_repo スコープがありません');
  await expect(submit(page)).toBeDisabled();
});

test('[BD-HOSTV-GATE-P005][BD-HOSTV-GATE-T009][BD-HOSTV-GATE-S008] 必要な権限のある PAT では使える', async ({ page, gh }) => {
  await openReview(page);
  await setPatViaMenu(page, PAT_WRITE);
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(submit(page)).toBeEnabled();
  await expect(reason(page)).toHaveCount(0);
  await expect(page.getByTestId('review-page').getByTestId('disabled-reason')).toHaveCount(0);
  // The PAT went only to api.github.com, as the Authorization header
  const authed = gh.requests.filter((r) => r.auth);
  expect(authed.length).toBeGreaterThan(0);
  expect(authed.every((r) => r.host === 'api.github.com' && r.auth?.replace(/^(token|Bearer)\s+/i, '') === PAT_WRITE)).toBe(true);
});
