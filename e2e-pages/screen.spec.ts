/** BD-HOSTV-SCREEN (hosted-viewer.md「画面遷移」): 対象の指定 → 取得中 → PAT が必要 / 文書. */
import type { Page } from '@playwright/test';
import { test, expect, openHash, setHash, setPatViaMenu, submitTarget } from './fixtures.ts';
import { HEAD_SHA, OWNER, PAT_WRITE, PR, PR_TITLE, PRIVATE_REPO, REPO } from './github-stub.ts';

const NEED_TOKEN = '非公開のリポジトリ、または見つからないリポジトリです。PAT を設定すると取得し直します。';
const PR_HASH = `#/gh/${OWNER}/${REPO}/pr/${PR}`;
const PRIVATE_HASH = `#/gh/${OWNER}/${PRIVATE_REPO}`;
/** Holds the PR / repository answers so that 取得中 can be seen. */
const SLOW = { delays: [{ path: /^\/repos\/acme\/(order-app|secret-app)$/, ms: 1200 }] };

const openPage = (page: Page) => page.getByTestId('open-submit');
const docTarget = (page: Page) => page.getByTestId('doc-target');

async function expectOpenPage(page: Page) {
  await expect(openPage(page)).toBeVisible();
  await expect(docTarget(page)).toBeHidden();
  await expect(page.getByTestId('loading-target')).toBeHidden();
  await expect(page.getByTestId('token-reason')).toBeHidden();
}

async function expectPrDoc(page: Page) {
  await expect(docTarget(page)).toHaveText(`${OWNER}/${REPO} #${PR} ${PR_TITLE}`);
  await expect(page.getByTestId('doc-head')).toHaveText(`main ← feature/confirm-back（${HEAD_SHA.slice(0, 7)}）`);
}

async function expectTokenPage(page: Page) {
  await expect(page.getByTestId('token-reason')).toHaveText(NEED_TOKEN);
  await expect(page.getByRole('heading', { name: `${OWNER}/${PRIVATE_REPO} を開くには PAT が必要です` })).toBeVisible();
  await expect(page.getByTestId('pat-note')).toHaveText('PAT は api.github.com への要求にだけ使い、URL・ログ・他のサイトには送りません');
  await expect(page.getByTestId('scopes')).toBeVisible();
}

/** 対象の指定 → [開く [入力NG]] 対象の指定 (the form stays with its values). */
async function openNg(page: Page) {
  await submitTarget(page, 'not-a-repo', 'pr', '12');
  await expect(page.getByTestId('open-error')).toHaveText('owner/repo の形式で入力してください');
  await expect(page.getByTestId('repo')).toHaveValue('not-a-repo');
  await expect(page.getByTestId('loading-target')).toBeHidden();
}

/** PAT が必要 → [設定 [入力NG]] PAT が必要. */
async function patNg(page: Page) {
  await page.getByTestId('pat').fill('not-a-token');
  await page.getByTestId('pat-submit').click();
  await expect(page.getByTestId('pat-error')).toBeVisible();
  await expect(page.getByTestId('token-reason')).toHaveText(NEED_TOKEN);
}

/** PAT が必要 → [設定 [入力OK]] 取得中 → [取得完了] 文書 (the private repository). */
async function patOk(page: Page) {
  await page.getByTestId('pat').fill(PAT_WRITE);
  await page.getByTestId('pat-submit').click();
  await expect(page.getByTestId('loading-target')).toHaveText(`${OWNER}/${PRIVATE_REPO}（既定のブランチ） を取得中`);
  await expect(docTarget(page)).toHaveText(`${OWNER}/${PRIVATE_REPO} main（既定）`);
  await expect(page.getByTestId('doc-permission')).toHaveText('書き込み可');
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：タブ限り');
}

test.describe('取得に時間がかかる', () => {
  test.use({ stubOptions: SLOW });

  test('[BD-HOSTV-SCREEN-P001][BD-HOSTV-SCREEN-T001][BD-HOSTV-SCREEN-T002][BD-HOSTV-SCREEN-T003][BD-HOSTV-SCREEN-T004][BD-HOSTV-SCREEN-T011] 入力を直して開くと、取得中を経て PR の文書が出る', async ({ page, gh }) => {
    await openHash(page, '#/');
    await expectOpenPage(page);
    await expect(page.getByTestId('edition')).toHaveText('Pages 版（公式）');
    await expect(page.getByTestId('kind')).toHaveValue('pr');
    await openNg(page);
    await submitTarget(page, `${OWNER}/${REPO}`, 'pr', String(PR));
    await expect(page.getByTestId('loading-target')).toHaveText(`${OWNER}/${REPO} #${PR} を取得中`);
    await expect(page.getByTestId('progress').locator('li')).toHaveCount(4);
    await expectPrDoc(page);
    await expect(page).toHaveURL(new RegExp(`${PR_HASH.replaceAll('/', '\\/')}(\\/|$)`));
    await expect(page.getByTestId('doc-permission')).toHaveText('読み取りのみ（PAT 未設定）');
    await expect(page.getByTestId('rate')).toHaveText('API 残り 52 / 60');
    await expect(page.getByTestId('prbar')).toBeVisible();
    await expect(page.getByTestId('ws-close')).toHaveCount(0);
    // 文書 → 終了: the document stays (no further request needed to read it)
    await expect(page.locator('main h1').first()).toBeVisible();
    expect(gh.requests.some((r) => r.host === 'api.github.com')).toBe(true);
  });

  test('[BD-HOSTV-SCREEN-P002][BD-HOSTV-SCREEN-T005][BD-HOSTV-SCREEN-T007][BD-HOSTV-SCREEN-T008] 入力NGの後に非公開のリポジトリを開き、PAT の入力NGを経て設定すると文書が出る', async ({ page }) => {
    await openHash(page, '#/');
    await openNg(page);
    await submitTarget(page, `${OWNER}/${PRIVATE_REPO}`, 'ref', '');
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await expectTokenPage(page);
    await patNg(page);
    await patOk(page);
  });

  test('[BD-HOSTV-SCREEN-P003] 入力NGの後に非公開のリポジトリを開き、PAT を設定すると文書が出る', async ({ page }) => {
    await openHash(page, '#/');
    await openNg(page);
    await submitTarget(page, `${OWNER}/${PRIVATE_REPO}`, 'ref', '');
    await expectTokenPage(page);
    await patOk(page);
  });

  test('[BD-HOSTV-SCREEN-P006] 非公開のリポジトリを開き、PAT の入力NGを経て設定すると文書が出る', async ({ page }) => {
    await openHash(page, '#/');
    await submitTarget(page, `${OWNER}/${PRIVATE_REPO}`, 'ref', '');
    await expectTokenPage(page);
    await patNg(page);
    await patOk(page);
  });

  test('[BD-HOSTV-SCREEN-P008] 非公開のリポジトリを開き、PAT を設定すると文書が出る', async ({ page }) => {
    await openHash(page, '#/');
    await submitTarget(page, `${OWNER}/${PRIVATE_REPO}`, 'ref', '');
    await expectTokenPage(page);
    await patOk(page);
  });
});

test('[BD-HOSTV-SCREEN-P005] 既定ブランチを開くと文書が出て、最近開いた対象に残る', async ({ page }) => {
  await openHash(page, '#/');
  await submitTarget(page, `${OWNER}/${REPO}`, 'ref', '');
  await expect(docTarget(page)).toHaveText(`${OWNER}/${REPO} main（既定）`);
  await expect(page.getByTestId('doc-head')).toHaveText('bbbbbbb');
  await expect(page).toHaveURL(/#\/gh\/acme\/order-app(\/doc\/|$)/);
  await page.getByTestId('doc-change').click();
  await expectOpenPage(page);
  await expect(page.getByTestId('recent-item')).toHaveText([`${OWNER}/${REPO} main`]);
  await expect(page.getByTestId('recent-item')).toHaveAttribute('href', `#/gh/${OWNER}/${REPO}`);
});

test('[BD-HOSTV-SCREEN-P004][BD-HOSTV-SCREEN-T010] 文書で対象を変更し、別の対象を開き直せる', async ({ page }) => {
  await openHash(page, PR_HASH);
  await expectPrDoc(page);
  await page.getByTestId('doc-change').click();
  await expectOpenPage(page);
  await expect(page).toHaveURL(/#\/$/);
  await submitTarget(page, `${OWNER}/${REPO}`, 'ref', 'v1.0');
  await expect(docTarget(page)).toHaveText(`${OWNER}/${REPO} v1.0`);
  await expect(page).toHaveURL(/#\/gh\/acme\/order-app\/ref\/v1\.0(\/|$)/);
  // 最近開いた対象: newest first; following one reopens it
  await page.getByTestId('doc-change').click();
  await expect(page.getByTestId('recent-item')).toHaveText([`${OWNER}/${REPO} v1.0`, `${OWNER}/${REPO} #${PR} ${PR_TITLE}`]);
  await page.getByTestId('recent-item').nth(1).click();
  await expectPrDoc(page);
});

test('[BD-HOSTV-SCREEN-P007][BD-HOSTV-SCREEN-T009] PAT が必要で入力NGの後に対象を変更し、公開のリポジトリを開ける', async ({ page }) => {
  await openHash(page, '#/');
  await submitTarget(page, `${OWNER}/${PRIVATE_REPO}`, 'ref', '');
  await expectTokenPage(page);
  await patNg(page);
  await page.getByTestId('token-change').click();
  await expectOpenPage(page);
  await submitTarget(page, `${OWNER}/${REPO}`, 'pr', String(PR));
  await expectPrDoc(page);
});

test('[BD-HOSTV-SCREEN-P009] PAT が必要から対象を変更し、公開のリポジトリを開ける', async ({ page }) => {
  await openHash(page, PRIVATE_HASH);
  await expectTokenPage(page);
  await page.getByTestId('token-change').click();
  await expectOpenPage(page);
  await submitTarget(page, `${OWNER}/${REPO}`, 'pr', String(PR));
  await expectPrDoc(page);
});

test.describe('利用上限', () => {
  test.use({ stubOptions: { rateLimited: true } });

  test('[BD-HOSTV-SCREEN-P010][BD-HOSTV-SCREEN-T006] 取得に失敗すると対象の指定に理由が出て、開き直せる', async ({ page, gh }) => {
    await openHash(page, PR_HASH);
    await expect(page.getByTestId('fetch-error')).toContainText('取得できませんでした：GitHub API の利用上限に達しました');
    await expect(openPage(page)).toBeVisible();
    // The failed target stays in the form
    await expect(page.getByTestId('repo')).toHaveValue(`${OWNER}/${REPO}`);
    await expect(page.getByTestId('target')).toHaveValue(String(PR));
    gh.heal();
    await openPage(page).click();
    await expectPrDoc(page);
    await expect(page.getByTestId('fetch-error')).toBeHidden();
  });
});

test.describe('不正な遷移（対象の指定）', () => {
  test.use({
    stubOptions: {
      delays: [{ path: /^\/repos\/acme\/(order-app|secret-app)$/, ms: 1500 }],
      errors: [{ path: /\/commits\/broken$/, status: 500 }],
    },
  });

  test('[BD-HOSTV-SCREEN-X001] 対象の指定に戻った後に前の取得が終わっても、文書に進まない', async ({ page }) => {
    await openHash(page, PR_HASH);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, '#/');
    await expectOpenPage(page);
    await page.waitForTimeout(2500);
    await expectOpenPage(page);
  });

  test('[BD-HOSTV-SCREEN-X002] 対象の指定に戻った後に前の取得が PAT が必要になっても、PAT が必要に進まない', async ({ page }) => {
    await openHash(page, PRIVATE_HASH);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, '#/');
    await expectOpenPage(page);
    await page.waitForTimeout(2500);
    await expectOpenPage(page);
  });

  test('[BD-HOSTV-SCREEN-X003] 対象の指定に戻った後に前の取得が失敗しても、理由を出さない', async ({ page }) => {
    await openHash(page, `#/gh/${OWNER}/${REPO}/ref/broken`);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, '#/');
    await expectOpenPage(page);
    await page.waitForTimeout(2500);
    await expectOpenPage(page);
    await expect(page.getByTestId('fetch-error')).toBeHidden();
  });

  test('[BD-HOSTV-SCREEN-X004][BD-HOSTV-SCREEN-X005] 対象の指定では PAT の設定・対象を変更で画面が変わらない', async ({ page }) => {
    await openHash(page, '#/');
    await expectOpenPage(page);
    await expect(page.getByTestId('pat-submit')).toHaveCount(0);
    await expect(page.getByTestId('doc-change')).toHaveCount(0);
    await expect(page.getByTestId('token-change')).toHaveCount(0);
    // PAT メニューで設定しても、対象が無いので取得しない
    await setPatViaMenu(page, PAT_WRITE);
    await expect(page.getByTestId('pat-menu')).toHaveText('PAT：タブ限り');
    await expectOpenPage(page);
    await setHash(page, '#/');
    await expectOpenPage(page);
  });
});

test.describe('不正な遷移（取得中）', () => {
  test.use({ stubOptions: { delays: [{ path: /^\/repos\/acme\/order-app$/, ms: 2500 }] } });

  test('[BD-HOSTV-SCREEN-X006][BD-HOSTV-SCREEN-X007][BD-HOSTV-SCREEN-X008] 取得中は開く・設定・対象を変更が無く、PAT メニューで設定しても取得を続ける', async ({ page }) => {
    await openHash(page, PR_HASH);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await expect(openPage(page)).toHaveCount(0);
    await expect(page.getByTestId('pat-submit')).toHaveCount(0);
    await expect(page.getByTestId('doc-change')).toHaveCount(0);
    await expect(page.getByTestId('token-change')).toHaveCount(0);
    // The same target again: still loading (no new load)
    await setHash(page, `${PR_HASH}/tests`);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setPatViaMenu(page, PAT_WRITE);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await expectPrDoc(page);
    await expect(page.getByTestId('nav-tests')).toHaveClass(/is-active/);
  });
});

test.describe('不正な遷移（PAT が必要）', () => {
  test.use({
    stubOptions: {
      delays: [
        { path: /^\/repos\/acme\/order-app\/pulls\/12$/, ms: 1500 },
        { path: /\/commits\/broken$/, ms: 1500 },
      ],
      errors: [{ path: /\/commits\/broken$/, status: 500 }],
    },
  });

  test('[BD-HOSTV-SCREEN-X009][BD-HOSTV-SCREEN-X011] PAT が必要では開くが無く、同じ対象をもう一度開いても PAT が必要のまま', async ({ page }) => {
    await openHash(page, PRIVATE_HASH);
    await expectTokenPage(page);
    await expect(openPage(page)).toHaveCount(0);
    await setHash(page, `${PRIVATE_HASH}/tests`);
    await page.waitForTimeout(500);
    await expectTokenPage(page);
    await expect(page.getByTestId('loading-target')).toBeHidden();
  });

  test('[BD-HOSTV-SCREEN-X010] 前の対象の取得が PAT が必要の後に終わっても、文書に進まない', async ({ page }) => {
    await openHash(page, PR_HASH);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, PRIVATE_HASH);
    await expectTokenPage(page);
    await page.waitForTimeout(2000);
    await expectTokenPage(page);
    await expect(docTarget(page)).toBeHidden();
  });

  test('[BD-HOSTV-SCREEN-X012] 前の対象の取得が PAT が必要の後に失敗しても、対象の指定に戻らない', async ({ page }) => {
    await openHash(page, `#/gh/${OWNER}/${REPO}/ref/broken`);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, PRIVATE_HASH);
    await expectTokenPage(page);
    await page.waitForTimeout(2000);
    await expectTokenPage(page);
    await expect(page.getByTestId('fetch-error')).toBeHidden();
  });
});

test.describe('不正な遷移（文書）', () => {
  test.use({
    stubOptions: {
      delays: [
        { path: /^\/repos\/acme\/order-app\/pulls\/12$/, ms: 1500 },
        { path: /^\/repos\/acme\/secret-app$/, ms: 1500 },
        { path: /\/commits\/broken$/, ms: 1500 },
      ],
      errors: [{ path: /\/commits\/broken$/, status: 500 }],
    },
  });

  const REF_HASH = `#/gh/${OWNER}/${REPO}/ref/main`;
  const expectRefDoc = (page: Page) => expect(docTarget(page)).toHaveText(`${OWNER}/${REPO} main`);

  test('[BD-HOSTV-SCREEN-X013][BD-HOSTV-SCREEN-X017] 文書には開く・PAT の設定（PAT が必要の画面）が無い', async ({ page }) => {
    await openHash(page, REF_HASH);
    await expectRefDoc(page);
    await expect(openPage(page)).toHaveCount(0);
    await expect(page.getByTestId('pat-submit')).toHaveCount(0);
    await expect(page.getByTestId('token-reason')).toHaveCount(0);
  });

  test('[BD-HOSTV-SCREEN-X014] 前の対象の取得が文書の表示後に終わっても、文書は変わらない', async ({ page }) => {
    await openHash(page, PR_HASH);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, REF_HASH);
    await expectRefDoc(page);
    await page.waitForTimeout(2000);
    await expectRefDoc(page);
  });

  test('[BD-HOSTV-SCREEN-X015] 前の対象が文書の表示後に PAT が必要になっても、PAT が必要に進まない', async ({ page }) => {
    await openHash(page, PRIVATE_HASH);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, REF_HASH);
    await expectRefDoc(page);
    await page.waitForTimeout(2000);
    await expectRefDoc(page);
    await expect(page.getByTestId('token-reason')).toHaveCount(0);
  });

  test('[BD-HOSTV-SCREEN-X016] 前の対象の取得が文書の表示後に失敗しても、対象の指定に戻らない', async ({ page }) => {
    await openHash(page, `#/gh/${OWNER}/${REPO}/ref/broken`);
    await expect(page.getByTestId('loading-target')).toBeVisible();
    await setHash(page, REF_HASH);
    await expectRefDoc(page);
    await page.waitForTimeout(2000);
    await expectRefDoc(page);
    await expect(page.getByTestId('fetch-error')).toHaveCount(0);
  });
});
