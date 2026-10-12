/** Actions on the Pages edition (actions-run.md・pages-viewer.md): dispatch with a PAT, read the results without one. */
import type { Page } from '@playwright/test';
import { publishFakeResult, type FakeActionsRepo, type FakeRun } from '../apps/server/src/github-fixture.ts';
import { test, expect, openHash, setPatViaMenu } from './fixtures.ts';
import { HEAD_SHA, OWNER, PAT_NOSCOPE, PAT_WRITE, PR, REPO } from './github-stub.ts';

const LIST = `#/gh/${OWNER}/${REPO}/pr/${PR}/tests/actions`;
const LIST_URL = new RegExp(`/design-document/${LIST.replace(/[/.]/g, '\\$&')}$`);
const TEST_ID = 'BD-ORDER-SCREEN-T001';
/** The tracker finds the run every 2–3 s and polls it every 10 s. */
const TRACK = { timeout: 40_000 };

/** The workflow on main and the PR branch; dispatched runs stay in progress until `finish`. */
function withWorkflow(a: FakeActionsRepo): void {
  Object.assign(a, { workflowOn: ['main', 'feature/confirm-back'], push: true, createRuns: true, script: ['in_progress'] });
}

/** Publishes the run's results to `ddv-results`, then completes it. */
function finish(a: FakeActionsRepo, run: FakeRun): string {
  const id = `${run.id}-${run.attempt}`;
  publishFakeResult(a, { id, commit: run.sha, ref: run.branch, pr: PR, actor: 'alice', request: run.inputs?.request, status: 'passed' }, { results: { [TEST_ID]: { status: 'passed' } } });
  run.script = ['completed'];
  return id;
}

async function openList(page: Page): Promise<void> {
  await openHash(page, LIST);
  await expect(page.getByTestId('actions-list')).toBeVisible();
  await expect(page.getByTestId('target')).toHaveText(`#${PR}（feature/confirm-back・${HEAD_SHA.slice(0, 7)}）`);
}

test.describe.configure({ timeout: 90_000 });

test('PAT があれば Actionsで実行 → 起動中 → 実行中 → 実行の結果（display_title で実行を見つける）', async ({ page, gh }) => {
  withWorkflow(gh.actions);
  await openList(page);
  await setPatViaMenu(page, PAT_WRITE);
  await openList(page);
  await expect(page.getByTestId('index-state')).toHaveText('まだ Actions の実行結果はありません');
  await expect(page.getByTestId('dispatch')).toBeEnabled();
  await expect(page.getByTestId('actions-list').getByTestId('disabled-reason')).toHaveCount(0);

  await page.getByTestId('ids').fill(TEST_ID);
  await page.getByTestId('dispatch').click();
  await expect.poll(() => gh.actions.dispatches.length).toBe(1);
  const { ref, inputs } = gh.actions.dispatches[0];
  expect(ref).toBe('feature/confirm-back');
  expect(inputs).toMatchObject({ mode: 'test', ids: TEST_ID, sha: HEAD_SHA, run: '' });
  expect(inputs.request).toMatch(/^ddv-[0-9a-f]{8}$/);
  await expect(page).toHaveURL(new RegExp(`/tests/actions/requests/${inputs.request}$`));
  await expect(page.getByTestId('request')).toContainText(`依頼ID ${inputs.request}`);

  // The run GitHub created is found through its display_title (`ddv test <request>`).
  await expect(page.getByTestId('actions-running')).toBeVisible(TRACK);
  const run = gh.actions.runs[0];
  expect(run.title).toBe(`ddv test ${inputs.request}`);
  await expect(page.getByTestId('logs-link')).toHaveAttribute('href', `https://github.com/${OWNER}/${REPO}/actions/runs/${run.id}`);

  const id = finish(gh.actions, run);
  await expect(page).toHaveURL(new RegExp(`/tests/actions/runs/${id}$`), TRACK);
  await expect(page.getByTestId('detail-source')).toHaveText('Actions');
  await expect(page.getByTestId('results').getByTestId('result-row')).toHaveAttribute('data-test-id', TEST_ID);

  await page.getByTestId('detail-back').click();
  await expect(page).toHaveURL(LIST_URL);
  await expect(page.locator(`[data-testid="run-row"][data-id="${id}"]`).getByTestId('run-status')).toHaveText('成功');
  // Writes went to api.github.com with the PAT; nothing else carried it.
  const post = gh.requests.find((r) => r.method === 'POST');
  expect(post?.url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/ddv-tests.yml/dispatches`);
  expect(post?.auth).toMatch(new RegExp(`${PAT_WRITE}$`));
});

test('PAT が無ければ実行できず理由が出るが、実行済みの結果は認証なしで読める', async ({ page, gh }) => {
  withWorkflow(gh.actions);
  publishFakeResult(gh.actions, { id: '501-1', commit: HEAD_SHA, ref: 'feature/confirm-back', pr: PR, actor: 'alice', status: 'failed' }, { results: { [TEST_ID]: { status: 'failed', message: '画面が違う' } } });
  await openList(page);
  await expect(page.getByTestId('pat-menu')).toHaveText('PAT：未設定');
  await expect(page.getByTestId('dispatch')).toBeDisabled();
  await expect(page.getByTestId('dispatch')).toHaveAttribute('title', 'PAT が無いため実行できません。実行済みの結果だけを表示します');
  await expect(page.getByTestId('dispatch-error')).toHaveText('PAT が無いため実行できません。実行済みの結果だけを表示します');

  const row = page.locator('[data-testid="run-row"][data-id="501-1"]');
  await expect(row.getByTestId('run-status')).toHaveText('失敗');
  await row.getByTestId('run-open').click();
  await expect(page).toHaveURL(/\/tests\/actions\/runs\/501-1$/);
  await expect(page.getByTestId('results').getByTestId('result-row')).toHaveAttribute('data-test-id', TEST_ID);

  expect(gh.actions.dispatches).toEqual([]);
  expect(gh.requests.every((r) => r.auth === null)).toBe(true);
  expect(gh.requests.some((r) => r.host === 'raw.githubusercontent.com' && r.url.endsWith('/runs/501-1/run.json'))).toBe(true);
});

test('権限の足りない PAT では Actionsで実行 が無効で、足りない権限が出る', async ({ page, gh }) => {
  withWorkflow(gh.actions);
  await openList(page);
  await setPatViaMenu(page, PAT_NOSCOPE);
  await openList(page);
  // The repository answers `push: false` for this PAT: the service is readonly before the gate is asked.
  await expect(page.getByTestId('dispatch-error')).toHaveText('書き込み権限が無いため実行できません。実行済みの結果だけを表示します');
  await expect(page.getByTestId('dispatch')).toBeDisabled();
  await expect(page.getByTestId('dispatch')).toHaveAttribute('title', '書き込み権限が無いため実行できません。実行済みの結果だけを表示します');
  expect(gh.actions.dispatches).toEqual([]);
});
