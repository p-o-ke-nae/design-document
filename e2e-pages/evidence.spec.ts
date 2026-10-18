/** Evidence on the Pages edition (evidence-trace.md): opened and saved from the results branch, pruned files say so. */
import { readFile } from 'node:fs/promises';
import { publishFakeResult } from '../apps/server/src/github-fixture.ts';
import { test, expect, openHash } from './fixtures.ts';
import { HEAD_SHA, OWNER, PR, REPO } from './github-stub.ts';

const TEST_ID = 'BD-ORDER-SCREEN-P001';
const RUN = '601-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ORDERS = JSON.stringify({ columns: ['id', 'customer'], rows: [[1, '山田 太郎']] });
const file = (name: string, kind: string, mime: string, size: number) => ({ path: `${TEST_ID}/evidence/${name}`, kind, mime, bytes: size });

const trace = {
  version: 1,
  runId: RUN,
  testId: TEST_ID,
  title: `[${TEST_ID}] 確認画面から戻る`,
  mock: 'order',
  target: 'app',
  startedAt: '2025-01-01T00:00:00.000Z',
  durationMs: 1000,
  status: 'passed',
  steps: [
    {
      index: 1,
      event: '戻る',
      screenBefore: 'Confirm',
      screenAfter: 'Input',
      expects: [{ kind: 'screen', key: '', expected: 'Input', actual: 'Input', ok: true }],
      ok: true,
      durationMs: 300,
      calls: [],
      db: null,
      evidence: [
        { seq: 1, label: '入力画面', use: 'screenshot', at: 'after', provider: 'builtin', status: 'ok', durationMs: 40, files: [file('1-after-1-screen.png', 'image', 'image/png', PNG.length)] },
        { seq: 2, label: '注文表', use: 'db', at: 'after', provider: 'builtin', status: 'ok', durationMs: 20, totalRows: 1, files: [file('1-after-2-orders.table.json', 'table', 'application/json', Buffer.byteLength(ORDERS))] },
        // Recorded in the trace, dropped from the results branch by the size limit.
        { seq: 3, label: '古い画面', use: 'screenshot', at: 'after', provider: 'builtin', status: 'ok', durationMs: 40, files: [file('1-after-3-old.png', 'image', 'image/png', PNG.length)] },
      ],
    },
  ],
};

test('Pages 版：結果ブランチの証跡を開いて保存し、削除された証跡は理由が出る', async ({ page, gh }) => {
  publishFakeResult(
    gh.actions,
    { id: RUN, commit: HEAD_SHA, ref: 'feature/confirm-back', pr: PR, actor: 'alice', status: 'passed' },
    { results: { [TEST_ID]: { status: 'passed', evidence: 3 } }, traces: [TEST_ID] },
    {
      [`traces/${TEST_ID}.json`]: JSON.stringify(trace),
      [`traces/${TEST_ID}/evidence/1-after-1-screen.png`]: new Uint8Array(PNG),
      [`traces/${TEST_ID}/evidence/1-after-2-orders.table.json`]: ORDERS,
    },
  );
  await openHash(page, `#/gh/${OWNER}/${REPO}/pr/${PR}/tests/actions/runs/${RUN}`);
  await page.getByTestId('result-trace').click();
  await expect(page.getByTestId('trace-view')).toBeVisible();
  const list = page.getByTestId('evidence-list');
  await expect(list.locator('tr[data-seq]')).toHaveCount(3);

  // The image opens in the dialog (a blob: URL made from the results branch).
  await list.locator('tr[data-seq="1"]').getByTestId('evidence-open').click();
  const dialog = page.getByTestId('evidence-dialog');
  await expect(dialog.getByTestId('evidence-image')).toHaveAttribute('src', /^blob:/);
  // The table: saved as CSV.
  await dialog.getByTestId('evidence-next').click();
  await expect(dialog.getByTestId('evidence-table')).toContainText('山田 太郎');
  const download = page.waitForEvent('download');
  await dialog.getByTestId('evidence-save').click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('1-after-2-orders.csv');
  const bytes = await readFile((await saved.path())!);
  expect(bytes.subarray(3).toString('utf8')).toBe('id,customer\r\n1,山田 太郎');
  await dialog.getByTestId('evidence-close').click();
  await expect(dialog).toBeHidden();

  // Pruned from the results branch: the reason, not a broken viewer.
  await list.locator('tr[data-seq="3"]').getByTestId('evidence-open').click();
  await expect(page.getByText('古い実行のため証跡は削除されました')).toBeVisible();
  expect(gh.requests.every((r) => r.auth === null)).toBe(true);
});
