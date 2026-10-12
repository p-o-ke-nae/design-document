import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E_PORT, E2E_TOKEN, login } from './ddv-auth.ts';
import {
  createUpstream,
  fakeActionsRepo,
  fakeGitHub,
  fakeGitHubState,
  publishFakeResult,
  type FakeActionsRepo,
  type FakeGitHubState,
  type FakeRun,
  type Upstream,
} from '../apps/server/src/github-fixture.ts';

// Phase 6 (ACTRUN): the Actions screens against a stub GitHub API (dispatch → run → results branch → approve). Never touches github.com.

const PORT = E2E_PORT + 13;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = 'acme/order-app';
const TOKEN = 'ghp_test_token';
const WS = 'gh~acme~order-app~pr-12';
const POLL_MS = 300;
const PR_LIST = `${BASE}/#/w/${WS}/tests/actions`;
const LOCAL_LIST = `${BASE}/#/tests/actions`;
const SCENARIO = 'BD-ORDER-SCREEN-P001';
// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

let tmp = '';
let upstream: Upstream;
let state: FakeGitHubState;
let actions: FakeActionsRepo;
let api: http.Server;
let ddv: ChildProcess | undefined;
let mainSha = '';
let featSha = '';
/** Result id of the completed run of the dispatch test (reused by the approval tests). */
let resultId = '';
const published = new Map<string, { row: Parameters<typeof publishFakeResult>[1]; record: Record<string, unknown>; files: Record<string, string | Uint8Array> }>();

async function startFakeGitHub(s: FakeGitHubState): Promise<http.Server> {
  const handle = fakeGitHub(s);
  const server = http.createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-e2e-act-'));
  upstream = await createUpstream(path.join(tmp, 'remote'));
  mainSha = upstream.git('rev-parse', 'main');
  featSha = upstream.commit('feature/x', { 'docs/design/basic/order.md': '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文\n---\n\n# 注文\n\n変更後\n' }, 'edit order');
  upstream.setPull(12, featSha);
  // The local folder of the server is the upstream itself, with a GitHub origin.
  upstream.git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  // Runs are added by the test (`addRun`) so that 起動中 can be observed; they stay in progress until `finish`.
  actions = fakeActionsRepo({ workflowOn: ['main', 'feature/x'], createRuns: false, script: ['in_progress'] });
  state = fakeGitHubState({
    token: TOKEN,
    pulls: { [REPO]: [{ number: 12, title: '注文画面の修正', headSha: featSha, headRef: 'feature/x', baseRef: 'main' }] },
    refs: { [REPO]: { main: mainSha, 'feature/x': featSha } },
    actions: { [REPO]: actions },
    upstream,
  });
  api = await startFakeGitHub(state);
  if (await fetch(`${BASE}/`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`);
  ddv = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/cli.ts', 'serve', '--repo', upstream.dir, '--port', String(PORT)], {
    env: {
      ...process.env,
      GITHUB_TOKEN: TOKEN,
      GH_TOKEN: '',
      DDV_HOME: path.join(tmp, 'home'),
      DDV_GITHUB_API: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      DDV_GITHUB_GIT_URL: `${pathToFileURL(path.join(tmp, 'remote')).href}/{owner}/{repo}`,
      DDV_GITHUB_NO_GH: '1',
      DDV_GITHUB_POLL: '0',
      DDV_ACTIONS_POLL_MS: String(POLL_MS),
      DDV_TOKEN: E2E_TOKEN,
    },
    stdio: 'pipe',
  });
  let log = '';
  ddv.stdout?.on('data', (d) => (log += d));
  ddv.stderr?.on('data', (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${BASE}/`).then((r) => r.ok, () => false)) return;
    if (ddv.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ddv did not start\n${log}`);
});

test.afterAll(async () => {
  ddv?.kill();
  await new Promise((r) => api?.close(r));
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

test.beforeEach(async ({ page }) => {
  await login(page, BASE);
});

/** The run GitHub creates for the latest dispatch. */
function addRun(conclusion = 'success'): FakeRun {
  const d = actions.dispatches.at(-1)!;
  const run: FakeRun = {
    id: ++state.nextId,
    attempt: 1,
    title: `ddv ${d.inputs.mode ?? 'test'} ${d.inputs.request ?? ''}`.trim(),
    event: 'workflow_dispatch',
    branch: d.ref,
    sha: d.inputs.sha || (d.ref === 'main' ? mainSha : featSha),
    createdAt: new Date().toISOString(),
    actor: state.login,
    script: ['in_progress'],
    conclusion,
    polls: 0,
    inputs: d.inputs,
  };
  actions.runs.unshift(run);
  return run;
}

/** Publishes the run's results to the results branch, then completes it. */
function finish(run: FakeRun, results: Record<string, { status: string; message?: string }> = { 'BD-ORDER-SCREEN-T001': { status: 'passed' } }, snapshots = false): string {
  const id = `${run.id}-${run.attempt}`;
  const failed = Object.values(results).some((r) => r.status !== 'passed');
  const row = { id, commit: run.sha, ref: run.branch, pr: run.branch === 'feature/x' ? 12 : undefined, actor: 'hanako', request: run.inputs?.request, status: (failed ? 'failed' : 'passed') as 'failed' | 'passed', ...(snapshots ? { snapshots: { diff: 1, noBase: 0 } } : {}) };
  const record: Record<string, unknown> = {
    results,
    ...(snapshots ? { snapshots: [{ id: SCENARIO, status: 'failed', steps: [{ step: 1, status: 'Diff', diffRatio: 0.2 }] }] } : {}),
  };
  const files: Record<string, string | Uint8Array> = snapshots
    ? { [`snapshots/baseline/${SCENARIO}/001.png`]: PNG, [`snapshots/current/${SCENARIO}/001.png`]: PNG, [`snapshots/diff/${SCENARIO}/001.png`]: PNG }
    : {};
  publishFakeResult(actions, row, record, files);
  published.set(id, { row, record, files });
  run.script = ['completed'];
  return id;
}

/** Completes an approval run (recording the approval on the approved run's index row when it succeeds). */
function finishApproval(run: FakeRun, commit: string | null): void {
  const target = run.inputs!.run!;
  const p = published.get(target)!;
  if (run.conclusion === 'success') {
    const approvals = [...((p.row.approvals as unknown[]) ?? []), { request: run.inputs!.request, actionsRunId: String(run.id), ids: run.inputs!.ids!.split(','), commit, at: new Date().toISOString(), actor: 'hanako' }];
    p.row = { ...p.row, approvals };
    publishFakeResult(actions, p.row, p.record, p.files);
  }
  run.script = ['completed'];
}

const absent = async (page: Page, ...ids: string[]) => {
  for (const id of ids) await expect(page.getByTestId(id), id).toHaveCount(0);
};
const BACK = ['setup-back', 'running-back', 'detail-back'];
const MOCK_ONLY = ['allowed', 'detected', 'dispatch-fail', 'run-complete', 'approve-done', 'approve-fail'];

async function dispatchAndWait(page: Page): Promise<number> {
  const before = actions.dispatches.length;
  await page.getByTestId('dispatch').click();
  await expect(page.getByTestId('actions-dispatching')).toBeVisible();
  await expect.poll(() => actions.dispatches.length).toBe(before + 1);
  return before;
}

test('[BD-ACTRUN-SCREEN-P001][BD-ACTRUN-SCREEN-P011][BD-ACTRUN-SCREEN-T001][BD-ACTRUN-SCREEN-T002][BD-ACTRUN-SCREEN-T003][BD-ACTRUN-SCREEN-T015][BD-ACTRUN-SCREEN-X001][BD-ACTRUN-SCREEN-X003][BD-ACTRUN-SCREEN-X005][BD-ACTRUN-SCREEN-X006][BD-ACTRUN-SCREEN-X007][BD-ACTRUN-SCREEN-X008][BD-ACTRUN-SCREEN-X009][BD-ACTRUN-SCREEN-X010][BD-ACTRUN-SCREEN-X011][BD-ACTRUN-SCREEN-X012][BD-ACTRUN-SCREEN-X013][BD-ACTRUN-SCREEN-X014][BD-ACTRUN-SCREEN-X015][BD-ACTRUN-SCREEN-X016] 一覧 → 導入の案内（配置する）→ 一覧。遷移の無い操作は出さない', async ({ page }) => {
  // テストタブの切り替え（hidden 以外のときだけ）
  await page.goto(`${BASE}/#/tests`);
  await expect(page.getByTestId('tests-page')).toBeVisible();
  await page.getByTestId('actions-tab').click();
  await expect(page).toHaveURL(LOCAL_LIST);
  await expect(page.getByTestId('actions-list')).toBeVisible();
  await expect(page.getByTestId('target')).toHaveText(`main・${mainSha.slice(0, 7)}`);
  await expect(page.getByTestId('uncommitted-note')).toHaveText(`未コミットの変更は Actions では実行されません（${mainSha.slice(0, 7)} を実行します）`);
  await expect(page.getByTestId('dispatch')).toBeEnabled();
  await expect(page.getByTestId('index-state')).toHaveText('まだ Actions の実行結果はありません');
  await expect(page.getByTestId('runs')).toHaveCount(0);
  await absent(page, ...BACK, 'approve', ...MOCK_ONLY);

  await page.getByTestId('setup-open').click();
  await expect(page).toHaveURL(`${LOCAL_LIST}/setup`);
  await expect(page.getByTestId('setup-steps')).toContainText('既定ブランチ（main）にマージ');
  await absent(page, 'setup-open', 'dispatch', 'run-open', 'approve', ...MOCK_ONLY);
  await page.getByTestId('setup-init').click();
  await expect(page.getByTestId('setup-result')).toHaveText('.github/workflows/ddv-tests.yml を配置しました。コミットして既定ブランチにマージしてください。既存の PR のブランチには既定ブランチを取り込んでください');
  await expect(fs.readFile(path.join(upstream.dir, '.github/workflows/ddv-tests.yml'), 'utf8')).resolves.toContain('workflow_dispatch');
  await page.getByTestId('setup-init').click();
  await expect(page.getByTestId('setup-result')).toHaveText('既に同じワークフローがあります');

  await page.getByTestId('setup-back').click();
  await expect(page).toHaveURL(LOCAL_LIST);
  await expect(page.getByTestId('actions-list')).toBeVisible();
});

test('[BD-ACTRUN-SCREEN-P006][BD-ACTRUN-SCREEN-T007][BD-ACTRUN-SCREEN-X017][BD-ACTRUN-SCREEN-X018][BD-ACTRUN-SCREEN-X019][BD-ACTRUN-SCREEN-X020][BD-ACTRUN-SCREEN-X021][BD-ACTRUN-SCREEN-X022][BD-ACTRUN-SCREEN-X023][BD-ACTRUN-SCREEN-X024] 起動中に実行を検出できなければ一覧に戻り理由を出す', async ({ page }) => {
  await page.goto(PR_LIST);
  await expect(page.getByTestId('target')).toHaveText(`#12（feature/x・${featSha.slice(0, 7)}）`);
  await absent(page, 'uncommitted-note', 'ci-checks');
  await page.getByTestId('ids').fill('BD-ORDER-SCREEN-T001, BD-ORDER-SCREEN-T002');
  await dispatchAndWait(page);
  expect(actions.dispatches.at(-1)).toMatchObject({ ref: 'feature/x', inputs: { mode: 'test', ids: 'BD-ORDER-SCREEN-T001,BD-ORDER-SCREEN-T002', sha: featSha } });
  await expect(page.getByTestId('request')).toHaveText(/^依頼ID ddv-[0-9a-f]{8}（経過 \d+ 秒）$/);
  await absent(page, 'setup-open', ...BACK, 'dispatch', 'run-open', 'approve', 'logs-link', ...MOCK_ONLY);
  // No run appears (createRuns = false): 起動失敗 after the find timeout.
  await expect(page.getByTestId('actions-list')).toBeVisible({ timeout: 20 * POLL_MS + 10_000 });
  await expect(page).toHaveURL(PR_LIST);
  await expect(page.getByTestId('dispatch-error')).toContainText('Actions の画面');
});

test('[BD-ACTRUN-SCREEN-P005][BD-ACTRUN-SCREEN-T009][BD-ACTRUN-SCREEN-X002][BD-ACTRUN-SCREEN-X004][BD-ACTRUN-SCREEN-X025][BD-ACTRUN-SCREEN-X026][BD-ACTRUN-SCREEN-X027][BD-ACTRUN-SCREEN-X028][BD-ACTRUN-SCREEN-X029][BD-ACTRUN-SCREEN-X030][BD-ACTRUN-SCREEN-X031][BD-ACTRUN-SCREEN-X032] 実行中から一覧へ戻っても実行は続き、行に「実行中」と出る', async ({ page }) => {
  await page.goto(PR_LIST);
  await dispatchAndWait(page);
  const run = addRun();
  await expect(page.getByTestId('actions-running')).toBeVisible();
  await expect(page.getByTestId('steps')).toContainText('ddv ci run');
  await expect(page.getByTestId('logs-link')).toHaveAttribute('href', `https://github.com/${REPO}/actions/runs/${run.id}`);
  await absent(page, 'setup-open', 'dispatch', 'run-open', 'approve', ...MOCK_ONLY);

  await page.getByTestId('running-back').click();
  await expect(page).toHaveURL(PR_LIST);
  const row = page.locator(`[data-testid="run-row"][data-state="in_progress"]`);
  await expect(row.getByTestId('run-status')).toHaveText('実行中');
  await expect(row.locator('td').nth(4)).toHaveText('—');

  // The tracker keeps going: the row becomes 成功 when the run completes.
  const id = finish(run);
  await expect(page.locator(`[data-testid="run-row"][data-id="${id}"]`).getByTestId('run-status')).toHaveText('成功');
    // 実行を検出・実行完了 in the list do not move the screen.
    await expect(page).toHaveURL(PR_LIST);
    await expect(page.getByTestId('actions-list')).toBeVisible();
  });

test('[BD-ACTRUN-SCREEN-P002][BD-ACTRUN-SCREEN-T004][BD-ACTRUN-SCREEN-T006][BD-ACTRUN-SCREEN-T008][BD-ACTRUN-SCREEN-T011][BD-ACTRUN-SCREEN-X033][BD-ACTRUN-SCREEN-X034][BD-ACTRUN-SCREEN-X035][BD-ACTRUN-SCREEN-X036][BD-ACTRUN-SCREEN-X037][BD-ACTRUN-SCREEN-X038][BD-ACTRUN-SCREEN-X039][BD-ACTRUN-SCREEN-X040] Actionsで実行 → 起動中 → 実行中 → 実行の結果 → 一覧', async ({ page }) => {
  await page.goto(PR_LIST);
  await expect(page.getByTestId('runner').locator('option').first()).toHaveText('すべて');
  await dispatchAndWait(page);
  await expect(page.getByTestId('request')).toBeVisible();
  const run = addRun();
  await expect(page.getByTestId('actions-running')).toBeVisible();
  resultId = finish(run, { 'BD-ORDER-SCREEN-T001': { status: 'passed' }, [SCENARIO]: { status: 'failed', message: 'expect.screen: Confirm でなく Input' } }, true);

  await expect(page).toHaveURL(`${PR_LIST}/runs/${resultId}`);
  await expect(page.getByTestId('detail-source')).toHaveText('Actions');
  const rows = page.getByTestId('results').getByTestId('result-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-test-id', SCENARIO);
  await expect(page.getByTestId('snapshot-diff')).toBeVisible();
  await expect(page.getByTestId('approve-target')).toBeChecked();
  await expect(page.getByTestId('approve')).toBeEnabled();
  await absent(page, 'setup-open', 'dispatch', 'run-open', ...MOCK_ONLY);

  // 出所: the test's history shows the Actions run.
  await page.goto(`${BASE}/#/w/${WS}/tests/history/${SCENARIO}`);
  await expect(page.locator(`[data-testid="history-row"][data-run-id="${resultId}"]`).getByTestId('history-source')).toHaveText('Actions');

  await page.goto(`${PR_LIST}/runs/${resultId}`);
  await page.getByTestId('detail-back').click();
  await expect(page).toHaveURL(PR_LIST);
  await expect(page.locator(`[data-testid="run-row"][data-id="${resultId}"]`).getByTestId('run-status')).toHaveText('失敗');
});

test('[BD-ACTRUN-SCREEN-P008][BD-ACTRUN-SCREEN-P009][BD-ACTRUN-SCREEN-P003][BD-ACTRUN-SCREEN-T010][BD-ACTRUN-SCREEN-T012][BD-ACTRUN-SCREEN-T013][BD-ACTRUN-SCREEN-X041][BD-ACTRUN-SCREEN-X042][BD-ACTRUN-SCREEN-X043][BD-ACTRUN-SCREEN-X044][BD-ACTRUN-SCREEN-X045][BD-ACTRUN-SCREEN-X046][BD-ACTRUN-SCREEN-X047][BD-ACTRUN-SCREEN-X048] 実行を選ぶ → 実行の結果 → 基準画像を承認 → 更新中 → 更新完了で結果に戻る', async ({ page }) => {
  await page.goto(PR_LIST);
  const row = page.locator(`[data-testid="run-row"][data-id="${resultId}"]`);
  await row.getByTestId('run-open').click();
  await expect(page).toHaveURL(`${PR_LIST}/runs/${resultId}`);
  await page.getByTestId('detail-back').click();
  await expect(page).toHaveURL(PR_LIST);
  await row.getByTestId('run-open').click();
  await expect(page.getByTestId('actions-detail')).toBeVisible();

  const before = actions.dispatches.length;
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('approve-status')).toHaveText('承認のワークフローが PR のブランチ（feature/x）へコミットします');
  await absent(page, 'setup-open', ...BACK, 'dispatch', 'run-open', 'approve', ...MOCK_ONLY);
  await expect.poll(() => actions.dispatches.length).toBe(before + 1);
  expect(actions.dispatches.at(-1)).toMatchObject({ ref: 'feature/x', inputs: { mode: 'approve', ids: SCENARIO, run: resultId } });
  const run = addRun();
  finishApproval(run, 'c'.repeat(40));

  await expect(page).toHaveURL(`${PR_LIST}/runs/${resultId}`);
  await expect(page.getByTestId('approve-commit').locator(`a[href="https://github.com/${REPO}/commit/${'c'.repeat(40)}"]`).first()).toBeVisible();
  await page.getByTestId('detail-back').click();
  await expect(row.getByTestId('run-status')).toContainText('承認済み');
});

test('[BD-ACTRUN-SCREEN-P004][BD-ACTRUN-SCREEN-P010][BD-ACTRUN-SCREEN-T014] 承認のワークフローが失敗したら結果に戻りエラーを出す', async ({ page }) => {
  await page.goto(PR_LIST);
  await page.locator(`[data-testid="run-row"][data-id="${resultId}"]`).getByTestId('run-open').click();
  await expect(page.getByTestId('actions-detail')).toBeVisible();
  const before = actions.dispatches.length;
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('actions-approving')).toBeVisible();
  await expect.poll(() => actions.dispatches.length).toBe(before + 1);
  finishApproval(addRun('failure'), null);
  await expect(page).toHaveURL(`${PR_LIST}/runs/${resultId}`);
  await expect(page.getByTestId('approve-error')).toHaveText('承認のワークフローが失敗しました。Actions のログを確認してください');
  await page.getByTestId('detail-back').click();
  await expect(page).toHaveURL(PR_LIST);
});

test('[BD-ACTRUN-SCREEN-P007][BD-ACTRUN-SCREEN-T005] 実行できないときは押せず、理由を出して一覧のまま', async ({ page }) => {
  actions.push = false;
  try {
    await page.request.get(`${BASE}/api/w/${WS}/actions?refresh=1`);
    await page.goto(PR_LIST);
    await expect(page.getByTestId('dispatch')).toBeDisabled();
    await expect(page.getByTestId('dispatch-error')).toHaveText('書き込み権限が無いため実行できません。実行済みの結果だけを表示します');
    const before = actions.dispatches.length;
    await page.getByTestId('dispatch').click({ force: true });
    await expect(page).toHaveURL(PR_LIST);
    await expect(page.getByTestId('actions-list')).toBeVisible();
    expect(actions.dispatches.length).toBe(before);
    // Results stay readable.
    await expect(page.locator(`[data-testid="run-row"][data-id="${resultId}"]`)).toBeVisible();
  } finally {
    actions.push = true;
    await page.request.get(`${BASE}/api/w/${WS}/actions?refresh=1`);
  }
});
