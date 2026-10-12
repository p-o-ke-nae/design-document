/** The mock of a document on the Pages edition (mock-sandbox.md): the srcdoc inherits the page's CSP, so a CSP violation here means the mock does not run. */
import { test, expect, openHash } from './fixtures.ts';
import { OWNER, REPO } from './github-stub.ts';

const DOC = `#/gh/${OWNER}/${REPO}/doc/docs/design/basic/order.md`;

test('[DD-MOCKSB-HOSTMODE-P004][DD-MOCKSB-HANDSHAKE-T001][DD-MOCKSB-HANDSHAKE-T003][DD-MOCKSB-HANDSHAKE-T005][DD-MOCKSB-HANDSHAKE-T008][DD-MOCKSB-HANDSHAKE-T011][DD-MOCKSB-HANDSHAKE-T012] Pages 版で文書のモックを srcdoc で組み立て、CSP に止められずに 1 ステップ再生できる', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|ddv:error/i.test(m.text())) problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener('message', (e) => {
      const d = e.data as { type?: unknown; payload?: { message?: unknown } } | null;
      if (d && d.type === 'ddv:error') console.error(`ddv:error ${String(d.payload?.message)}`);
    });
  });

  await openHash(page, DOC);
  const mock = page.getByTestId('mock').first();
  const iframe = mock.locator('iframe');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(iframe).toHaveAttribute('srcdoc', /window\.__ddvHost/);
  const player = mock.getByTestId('player');
  const status = player.getByTestId('player-status');
  const progress = player.getByTestId('player-progress');

  await player.getByTestId('player-step').click();
  await expect(status).toHaveAttribute('data-state', 'Paused');
  await expect(progress).toHaveText(/^0 \/ \d+$/);
  expect(problems, 'CSP の違反・ddv:error').toEqual([]);
  await expect(player.getByTestId('player-step')).toBeEnabled();
  await player.getByTestId('player-step').click();
  await expect(progress).toHaveText(/^1 \/ \d+$/);
  await expect(page.locator('[data-testid=player-step-item][data-index="0"]')).toHaveAttribute('data-status', 'done');

  // The virtual base (`<base href>`) is in effect: not dropped by the page's `base-uri`.
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc');
  expect(frame, 'srcdoc のモック').toBeTruthy();
  expect(await frame!.evaluate(() => document.baseURI)).toBe('https://mock.ddv.invalid/docs/mocks/order/');
  await expect(mock.locator('.notice.warn')).toHaveCount(0);
  expect(problems, 'CSP の違反・ddv:error').toEqual([]);
});
