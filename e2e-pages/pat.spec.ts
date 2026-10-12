/** BD-HOSTV-PAT (hosted-viewer.md「PAT の扱い」): setting the PAT again while one is set replaces it and keeps where it is kept. */
import { test, expect, openHash, setPatViaMenu } from './fixtures.ts';
import { OWNER, PAT_NOSCOPE, PAT_WRITE, PRIVATE_REPO } from './github-stub.ts';

const PRIVATE_HASH = `#/gh/${OWNER}/${PRIVATE_REPO}`;
const bare = (auth: string | null) => auth?.replace(/^(token|Bearer)\s+/i, '') ?? null;

test('[BD-HOSTV-PAT-X006] タブ限りで設定すると PAT を置き換え、タブ限りのまま取得し直す', async ({ page, gh }) => {
  await openHash(page, PRIVATE_HASH);
  await expect(page.getByTestId('token-reason')).toBeVisible();
  await setPatViaMenu(page, PAT_NOSCOPE);
  await expect(page.getByTestId('doc-target')).toHaveText(`${OWNER}/${PRIVATE_REPO} main（既定）`);
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：タブ限り');

  await page.getByTestId('pat-menu').click();
  await expect(page.getByTestId('pat-menu-set')).toHaveText('PAT を置き換え');
  await page.getByTestId('pat-menu').click();
  const before = gh.requests.length;
  await setPatViaMenu(page, PAT_WRITE);
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：タブ限り');
  await expect(page.getByTestId('doc-permission')).toHaveText('書き込み可');
  const after = gh.requests.slice(before).filter((r) => r.auth);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((r) => bare(r.auth) === PAT_WRITE)).toBe(true);
  // タブ限り: not in localStorage
  expect(await page.evaluate(() => Object.values(localStorage).join('\n'))).not.toContain('github_pat_');
});

test('[BD-HOSTV-PAT-X008] 端末に保存で設定すると PAT を置き換え、端末に保存のまま再読み込み後も使う', async ({ page, gh }) => {
  await openHash(page, PRIVATE_HASH);
  await expect(page.getByTestId('token-reason')).toBeVisible();
  await setPatViaMenu(page, PAT_NOSCOPE, true);
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：端末に保存');
  await expect(page.getByTestId('doc-target')).toBeVisible();

  // The dialog starts with 「この端末に保存」 on; setting replaces the stored PAT
  await page.getByTestId('pat-menu').click();
  await expect(page.getByTestId('pat-menu-set')).toHaveText('PAT を置き換え');
  await page.getByTestId('pat-menu-set').click();
  const dialog = page.getByTestId('pat-dialog');
  await expect(dialog.getByTestId('pat-store')).toBeChecked();
  await dialog.getByTestId('pat').fill(PAT_WRITE);
  await dialog.getByTestId('pat-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：端末に保存');
  await expect(page.getByTestId('doc-permission')).toHaveText('書き込み可');

  const before = gh.requests.length;
  await page.reload();
  await expect(page.getByTestId('doc-target')).toHaveText(`${OWNER}/${PRIVATE_REPO} main（既定）`);
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：端末に保存');
  await expect(page.getByTestId('token-reason')).toHaveCount(0);
  const authed = gh.requests.slice(before).filter((r) => r.auth);
  expect(authed.length).toBeGreaterThan(0);
  expect(authed.every((r) => bare(r.auth) === PAT_WRITE)).toBe(true);
});
