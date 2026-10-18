import { expect, test, type Page } from '@playwright/test';

const BASIC = '/#/doc?path=docs/design/basic/order.md';
const REQ = '/#/doc?path=docs/design/requirements/order.md';

/** Passed on web: the single result, or the web badge when the row shows results per platform. */
const PASSED_WEB = '[data-testid=status-badge][data-status=passed], [data-testid=badge-web].st-passed';

/** The sample has desktop runners too: run the web target only (the desktop apps may not be built). The dialog opens only when a scenario is included; returns once the run has started. */
async function startWebOnly(page: Page) {
  const dialog = page.getByTestId('target-select');
  const running = page.locator('[data-testid=run-indicator] [data-testid=status-badge][data-status=running]');
  await expect(dialog.or(running).first()).toBeVisible();
  if (!(await dialog.isVisible())) return;
  await expect(dialog.getByTestId('target-start')).toBeEnabled();
  for (const name of ['wpf', 'winforms']) {
    const box = dialog.getByTestId(`target-${name}`);
    if ((await box.count()) && (await box.isChecked())) await box.uncheck();
  }
  const web = dialog.getByTestId('target-e2e');
  if (!(await web.isChecked())) await web.check();
  await dialog.getByTestId('target-start').click();
  await expect(running).toBeVisible();
}
async function openBasic(page: Page) {
  await page.goto(BASIC);
  await expect(page.getByTestId('matrix').first()).toBeVisible();
  await expect(page.locator('figure[data-diagram=screen-flow] svg')).toBeVisible();
}

test('ツリーとTOC（既定 h2〜h3、範囲変更可）', async ({ page }) => {
  await openBasic(page);
  await expect(page.getByTestId('doc-tree')).toContainText('注文画面 基本設計');
  const toc = page.getByTestId('toc');
  await expect(toc.getByRole('link', { name: '画面遷移' })).toBeVisible();
  await expect(toc.getByRole('link', { name: '入力チェック' })).toBeVisible();
  await page.getByTestId('toc-max').selectOption('2');
  await expect(toc.getByRole('link', { name: '入力チェック' })).toHaveCount(0);
  await page.getByTestId('toc-max').selectOption('3');
});

test('ドキュメントを切り替えても図の初期表示は前の図の状態を引き継がない', async ({ page }) => {
  const zoomOf = async (id: string) => {
    const fig = page.locator(`figure[data-diagram=${id}]`);
    await expect(fig.locator('svg')).toBeVisible();
    await expect(fig.getByTestId('zoom-level')).not.toHaveText('100%');
    return fig.getByTestId('zoom-level').textContent();
  };
  await page.goto('/#/doc?path=docs/design/detailed/order.md');
  const direct = await zoomOf('class');
  await openBasic(page);
  await page.getByTestId('doc-tree').getByText('注文ドメイン 詳細設計').click();
  await expect(page).toHaveURL(/detailed(\/|%2F)order\.md/);
  await page.waitForTimeout(300);
  expect(await zoomOf('class')).toBe(direct);
});

test('ズームとドラッグで文字が選択されない', async ({ page }) => {
  await openBasic(page);
  const fig = page.locator('figure[data-diagram=screen-flow]');
  const zoom = fig.getByTestId('zoom-level');
  const before = await zoom.textContent();
  await fig.getByRole('button', { name: '拡大' }).click();
  await expect(zoom).not.toHaveText(before!);

  const vp = fig.getByTestId('mermaid-viewport');
  await vp.scrollIntoViewIfNeeded();
  const box = (await vp.boundingBox())!;
  // Ctrl + wheel zooms
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const z1 = await zoom.textContent();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect(zoom).not.toHaveText(z1!);

  // Drag across the diagram (over text) -> nothing gets selected, stage moves
  const stage = vp.locator('.mmd-stage');
  const t0 = await stage.getAttribute('style');
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40, { steps: 12 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  expect(await stage.getAttribute('style')).not.toBe(t0);
});

test('マトリクスの行選択で経路を強調し、表示切替できる', async ({ page }) => {
  await openBasic(page);
  const fig = page.locator('figure[data-diagram=screen-flow]');
  const row = page.locator('[data-testid=matrix-row][data-test-id=BD-ORDER-SCREEN-P003]');
  await expect(row).toContainText('BD-ORDER-SCREEN-P003');
  await row.click();
  await expect(fig.locator('svg.ddv-dim')).toHaveCount(1);
  expect(await fig.locator('path.ddv-hl').count()).toBeGreaterThanOrEqual(5);
  await expect(fig.locator('figcaption')).toContainText('BD-ORDER-SCREEN-P003');
  await page.getByRole('tab', { name: '状態×イベント表' }).click();
  await expect(page.getByTestId('state-event-table')).toContainText('×');
  await page.getByTestId('matrix-toggle').uncheck();
  await expect(page.getByTestId('matrix')).toHaveCount(0);
  await page.getByTestId('matrix-toggle').check();
  await expect(page.getByTestId('matrix')).toHaveCount(1);
});

test('[BD-VIEWER-SCREEN-T004] 参照をクリックすると参照先の節がポップアップする', async ({ page }) => {
  await openBasic(page);
  await page.getByTestId('ref-link').first().click();
  const pop = page.getByTestId('ref-popup');
  await expect(pop).toContainText('目的');
  await expect(pop.getByRole('link', { name: '開く ↗' })).toBeVisible();
  await expect(page.getByTestId('embed').first()).toContainText('受入基準');
});

test('[BD-VIEWER-SCREEN-T005] 参照ポップアップは Esc で閉じる', async ({ page }) => {
  await openBasic(page);
  await page.getByTestId('ref-link').first().click();
  await expect(page.getByTestId('ref-popup')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ref-popup')).toHaveCount(0);
});

test('[BD-VIEWER-SCREEN-T002] テストタブへ移動できる', async ({ page }) => {
  await openBasic(page);
  await page.getByTestId('nav-tests').click();
  await expect(page.getByTestId('tests-page')).toBeVisible();
});

test('[BD-VIEWER-SCREEN-T003] テストタブからドキュメントへ戻れる', async ({ page }) => {
  await openBasic(page);
  await page.getByTestId('nav-tests').click();
  await page.getByTestId('nav-docs').click();
  await expect(page.getByTestId('doc')).toContainText('注文画面 基本設計');
});

test('テストタブのレベル絞り込みは未実装のケースも設計の種類で含める', async ({ page }) => {
  await page.goto('/#/tests');
  const rows = page.getByTestId('test-row');
  await expect(rows.first()).toBeVisible();
  const ids = await rows.evaluateAll((es) => es.map((e) => e.getAttribute('data-test-id') ?? ''));
  const level = page.getByLabel('レベル');
  await level.selectOption('unit');
  await expect(rows).toHaveCount(ids.filter((id) => id.startsWith('DD-')).length);
  await level.selectOption('integration');
  await expect(rows).toHaveCount(ids.filter((id) => !id.startsWith('DD-')).length);
});

test('As-Is / To-Be の差分とギャップ表', async ({ page }) => {
  await page.goto(REQ);
  const gap = page.getByTestId('gap-table');
  await expect(gap).toBeVisible();
  expect(await gap.locator('tbody tr').count()).toBeGreaterThan(0);
  await expect(page.locator('.ddv-diff-added').first()).toBeAttached();
});

test('As-Is の図形にホバーすると To-Be の対応図形が強調される', async ({ page }) => {
  await page.goto(REQ);
  const asis = page.locator('.compare > div').first();
  const tobe = page.locator('.compare > div').nth(1);
  await expect(page.getByTestId('pair-hover-toggle')).toBeChecked();
  await asis.locator('g.node:not(.ddv-diff-removed)').first().hover();
  await expect(tobe.locator('.ddv-pair-hl').first()).toBeAttached();
  await page.getByTestId('pair-hover-toggle').uncheck();
  await expect(tobe.locator('.ddv-pair-hl')).toHaveCount(0);
});

test('To-Be 側ホバー・遷移ホバーでも As-Is の対応要素が強調され、右クリックで固定/解除できる', async ({ page }) => {
  await page.goto(REQ);
  const asis = page.locator('.compare > div').first();
  const tobe = page.locator('.compare > div').nth(1);
  const node = tobe.locator('g.node:not(.ddv-diff-added)').first();
  await node.hover();
  await expect(asis.locator('g.node.ddv-pair-hl').first()).toBeAttached();
  await expect(asis.locator('.ddv-hl').first()).toBeAttached();

  // pin with right click, then hovering elsewhere must not change the selection
  await node.click({ button: 'right' });
  await expect(page.getByTestId('pin-caption')).toBeVisible();
  await tobe.locator('g.node').last().hover();
  await expect(asis.locator('g.node.ddv-pair-hl').first()).toBeAttached();
  // right click on empty space unpins
  await tobe.getByTestId('mermaid-viewport').click({ button: 'right', position: { x: 3, y: 3 } });
  await expect(page.getByTestId('pin-caption')).toHaveCount(0);
  await expect(asis.locator('.ddv-pair-hl')).toHaveCount(0);
});

test('[BD-VIEWER-RUN-T003] 紐づいたテストをマトリクスから実行して成功が反映される', async ({ page }) => {
  test.setTimeout(120_000);
  await openBasic(page);
  const linked = page.locator('[data-testid=matrix-row][data-test-id=BD-ORDER-SCREEN-T002]');
  const unlinked = page.locator('[data-testid=matrix-row][data-test-id=BD-ORDER-SCREEN-X001]');
  await expect(unlinked.getByTestId('run-case')).toBeDisabled();
  await linked.getByTestId('run-case').click();
  await startWebOnly(page);
  const indicator = page.getByTestId('run-indicator').getByTestId('status-badge');
  await expect(indicator).toHaveAttribute('data-status', 'passed', { timeout: 90_000 });
  await expect(linked.locator(PASSED_WEB)).toBeVisible();
});

test('[BD-VIEWER-RUN-T002] テストタブで一括実行し監視できる', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/#/tests');
  await expect(page.getByTestId('tests-page')).toBeVisible();
  await page.getByTestId('run-all').click();
  await startWebOnly(page);
  await expect(page.getByTestId('run-log')).toContainText('dotnet', { timeout: 60_000 });
  const indicator = page.getByTestId('run-indicator').getByTestId('status-badge');
  await expect(indicator).not.toHaveAttribute('data-status', 'running', { timeout: 180_000 });
  await expect(page.getByTestId('run-all')).toBeEnabled();
  const row = page.locator('[data-testid=test-row][data-test-id=DD-ORDER-STATUS-T001]');
  await expect(row.locator(PASSED_WEB)).toBeVisible();
  // scenario tests run through the server record their traces (DDV_TRACE_DIR)
  const scenarioId = ['BD', 'ORDER', 'SCREEN', 'P001'].join('-');
  const latest = (await (await page.request.get('/api/results/latest')).json()) as Record<string, { runId?: string; trace?: boolean }>;
  expect(latest[scenarioId]?.trace).toBe(true);
  const trace = (await (await page.request.get(`/api/traces/${latest[scenarioId].runId}/${scenarioId}`)).json()) as { status?: string; steps?: unknown[] };
  expect(trace.status).toBe('passed');
  expect(trace.steps?.length).toBe(5);
});

interface ScenarioInfo {
  id: string;
  steps: Array<{ event: string; click?: string; expect: { screen: string } }>;
  edges: number;
}

/** Playable scenarios of the order mock, with their steps (from the server API). */
async function orderScenarios(page: Page): Promise<ScenarioInfo[]> {
  const list = (await (await page.request.get('/api/mocks/scenarios')).json()) as { scenarios: Array<{ id: string; mock: string; file: string; status: string }> };
  const own = list.scenarios.filter((s) => s.status !== 'Retired' && (s.mock.startsWith('order') || s.file.replace(/\\/g, '/').includes('/order/scenarios/')));
  const out: ScenarioInfo[] = [];
  for (const s of own) {
    const d = (await (await page.request.get(`/api/mocks/scenario?id=${encodeURIComponent(s.id)}`)).json()) as {
      scenario: { steps: ScenarioInfo['steps'] };
      transitions: unknown[];
    };
    out.push({ id: s.id, steps: d.scenario.steps, edges: d.transitions.length });
  }
  return out;
}

async function openPlayer(page: Page) {
  await openBasic(page);
  const player = page.getByTestId('player');
  await expect(player).toBeVisible();
  await player.getByTestId('player-speed').selectOption({ label: '最速' });
  return player;
}

const frameScreen = (page: Page, screen: string) => page.frameLocator('[data-testid=mock] iframe').locator(`[data-screen="${screen}"]`);

test('[BD-MOCK-PLAYER-T002][BD-MOCK-PLAYER-T006] プレイヤーで正常系シナリオを最後まで再生すると完了になる', async ({ page }) => {
  const all = await orderScenarios(page);
  const happy = all.filter((s) => s.steps.at(-1)?.expect.screen === 'Done').sort((a, b) => a.steps.length - b.steps.length)[0];
  expect(happy, '完了画面で終わるシナリオ').toBeTruthy();
  const player = await openPlayer(page);
  await player.getByTestId('player-scenario').selectOption(happy.id);
  const status = player.getByTestId('player-status');
  await expect(status).toHaveAttribute('data-state', 'Idle');
  await expect(page.getByTestId('player-step-item')).toHaveCount(happy.steps.length);
  await player.getByTestId('player-play').click();
  await expect(status).toHaveAttribute('data-state', 'Done');
  await expect(player.getByTestId('player-progress')).toHaveText(`${happy.steps.length} / ${happy.steps.length}`);
  await expect(page.getByTestId('player-failure')).toHaveCount(0);
  await expect(frameScreen(page, 'Done')).toBeVisible();
  // the played transitions are emphasised on the screen diagram
  const fig = page.locator('figure[data-diagram=screen-flow]');
  await expect(fig.getByTestId('play-caption')).toContainText(happy.id);
  expect(await fig.locator('path.ddv-hl').count()).toBeGreaterThanOrEqual(happy.edges);
  // リセット returns to 停止 and clears the emphasis
  await player.getByTestId('player-reset').click();
  await expect(status).toHaveAttribute('data-state', 'Idle');
  await expect(fig.getByTestId('play-caption')).toHaveCount(0);
});

test('[BD-MOCK-PLAYER-T003][BD-MOCK-PLAYER-T009][BD-MOCK-PLAYER-T012] 1ステップずつ進め、ステップを選ぶと巻き戻せる', async ({ page }) => {
  const all = await orderScenarios(page);
  const sc = all.filter((s) => s.steps.length >= 3 && s.steps.at(-1)?.expect.screen === 'Done').sort((a, b) => a.steps.length - b.steps.length)[0] ?? all.sort((a, b) => b.steps.length - a.steps.length)[0];
  expect(sc.steps.length).toBeGreaterThanOrEqual(2);
  const player = await openPlayer(page);
  await player.getByTestId('player-scenario').selectOption(sc.id);
  const status = player.getByTestId('player-status');
  const progress = player.getByTestId('player-progress');
  const n = sc.steps.length;

  await player.getByTestId('player-step').click();
  await expect(status).toHaveAttribute('data-state', 'Paused');
  await expect(progress).toHaveText(`0 / ${n}`);
  await expect(player.getByTestId('player-step')).toBeEnabled();
  await player.getByTestId('player-step').click();
  await expect(progress).toHaveText(`1 / ${n}`);
  await expect(frameScreen(page, sc.steps[0].expect.screen)).toBeVisible();
  await expect(player.getByTestId('player-step')).toBeEnabled();
  await player.getByTestId('player-step').click();
  await expect(progress).toHaveText(`2 / ${n}`);
  await expect(frameScreen(page, sc.steps[1].expect.screen)).toBeVisible();
  await expect(page.locator('[data-testid=player-step-item][data-index="1"]')).toHaveAttribute('data-status', 'done');

  // rewind to step 1 (= replay step 0 only)
  await page.locator('[data-testid=player-step-item][data-index="1"] button').click();
  await expect(status).toHaveAttribute('data-state', 'Paused');
  await expect(progress).toHaveText(`1 / ${n}`);
  await expect(page.locator('[data-testid=player-step-item][data-index="1"]')).toHaveAttribute('data-status', 'next');
  await expect(frameScreen(page, sc.steps[0].expect.screen)).toBeVisible();

  // ⏮ goes one step back
  await player.getByTestId('player-rewind').click();
  await expect(progress).toHaveText(`0 / ${n}`);

  await player.getByTestId('player-play').click();
  await expect(status).toHaveAttribute('data-state', /Done|Failed/);
});

test('[BD-MOCK-PLAYER-T002] マトリクスの ▶ モック で同じ文書のモックがその経路を再生する', async ({ page }) => {
  const player = await openPlayer(page);
  const btn = page.getByTestId('matrix-play-mock').first();
  await expect(btn).toBeVisible();
  const row = page.locator('[data-testid=matrix-row]').filter({ has: page.getByTestId('matrix-play-mock') }).first();
  const id = (await row.getAttribute('data-test-id'))!;
  // rows without a scenario have no button
  const rows = await page.locator('[data-testid=matrix-row]').count();
  const withBtn = await page.locator('[data-testid=matrix-row]').filter({ has: page.getByTestId('matrix-play-mock') }).count();
  expect(withBtn).toBeLessThan(rows);
  await row.getByTestId('matrix-play-mock').click();
  await expect(player.getByTestId('player-scenario')).toHaveValue(id);
  await expect(player.getByTestId('player-status')).toHaveAttribute('data-state', /Playing|Done|Failed/);
  await expect(player.getByTestId('player-status')).toHaveAttribute('data-state', /Done|Failed/);
  await expect(page.locator('figure[data-diagram=screen-flow]').getByTestId('play-caption')).toContainText(id);
  await expect(page.getByTestId('player')).toBeInViewport();
});
test('スナップショットを撮影すると、ステップごとに状態と画像が表示される', async ({ page }) => {
  test.setTimeout(120_000);
  const player = await openPlayer(page);
  const id = await player.getByTestId('player-scenario').inputValue();
  const panel = page.getByTestId('snapshot-panel');
  await panel.locator('summary').click();
  await panel.getByTestId('snapshot-run').click();
  const steps = panel.getByTestId('snapshot-step');
  const statuses = () => steps.evaluateAll((es) => es.map((e) => e.getAttribute('data-status')));
  await expect
    .poll(async () => {
      const s = await statuses();
      return s.length > 0 && s.every((x) => x === 'NoBase' || x === 'Match' || x === 'Diff');
    }, { message: id, timeout: 90_000 })
    .toBe(true);
  await expect(panel.getByTestId('snapshot-run')).toBeEnabled({ timeout: 30_000 });
  await expect(steps.first().locator('img').first()).toBeVisible();
});
test('[BD-MOCK-PLAYER-T003] 速度は 8 段から選べ、操作をハイライトすると操作する要素に枠が出てから操作される', async ({ page }) => {
  const all = await orderScenarios(page);
  const sc = all.find((s) => s.steps[0]?.click)!;
  const player = await openPlayer(page);
  const labels = await player.getByTestId('player-speed').locator('option').allTextContents();
  expect(labels).toEqual(['0.25×', '0.5×', '0.75×', '1×', '1.5×', '2×', '4×', '最速']);
  await player.getByTestId('player-speed').selectOption({ label: '0.25×' });
  await player.getByTestId('player-highlight').check();
  await player.getByTestId('player-scenario').selectOption(sc.id);
  await player.getByTestId('player-step').click();
  await expect(player.getByTestId('player-status')).toHaveAttribute('data-state', 'Paused');
  await expect(player.getByTestId('player-step')).toBeEnabled();
  await player.getByTestId('player-step').click();
  const frame = page.frameLocator('[data-testid=mock] iframe');
  const lit = frame.locator('[data-ddv-highlight]');
  await expect(lit).toHaveAttribute('data-testid', sc.steps[0].click!);
  await expect(lit).toHaveCount(0);
  await expect(player.getByTestId('player-progress')).toHaveText(`1 / ${sc.steps.length}`);
  // the setting is kept across reloads
  await page.reload();
  await expect(page.getByTestId('player-highlight')).toBeChecked();
  await page.getByTestId('player-highlight').uncheck();
});
