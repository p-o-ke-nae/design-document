import { test as base, expect, type Page } from '@playwright/test';
import { ALL_PATS, stubGitHub, type GitHubStub, type StubOptions } from './github-stub.ts';
import { PAGES_PORT } from './env.ts';

declare global {
  interface Window {
    __ddvMessages?: string[];
  }
}

interface SeenRequest {
  url: string;
  host: string;
  auth: string | null;
  body: string | null;
}

/**
 * `gh`: the stubbed GitHub. After each test: no request to the local server API (`/api`, other localhost ports), the
 * `Authorization` header only to api.github.com, and no PAT in URLs, request bodies or `postMessage` (REQ-608).
 */
export const test = base.extend<{ stubOptions: StubOptions; gh: GitHubStub; seen: SeenRequest[] }>({
  stubOptions: [{}, { option: true }],
  seen: async ({ page }, use) => {
    const seen: SeenRequest[] = [];
    await page.addInitScript(() => {
      window.__ddvMessages = [];
      window.addEventListener('message', (e) => {
        try {
          window.__ddvMessages!.push(typeof e.data === 'string' ? e.data : JSON.stringify(e.data));
        } catch {
          window.__ddvMessages!.push(String(e.data));
        }
      });
    });
    // Anything outside the Pages server and the stubbed GitHub hosts never leaves the test (the stub routes win).
    const external: string[] = [];
    await page.route(
      (u) => !(u.protocol === 'http:' && u.host === `127.0.0.1:${PAGES_PORT}`) && u.protocol !== 'data:' && u.protocol !== 'blob:',
      (route) => {
        external.push(route.request().url());
        return route.abort().catch(() => undefined);
      },
    );
    const pending: Promise<void>[] = [];
    page.on('request', (req) => {
      pending.push(
        req
          .allHeaders()
          .then((h) => {
            seen.push({ url: req.url(), host: new URL(req.url()).host, auth: h['authorization'] ?? null, body: req.postData() });
          })
          .catch(() => undefined),
      );
    });
    await use(seen);
    expect(external, 'スタブされていない外部への要求').toEqual([]);
    await Promise.all(pending);
    const messages = (await Promise.all(page.frames().map((f) => f.evaluate(() => window.__ddvMessages ?? []).catch(() => [] as string[])))).flat();
    for (const r of seen) {
      const u = new URL(r.url);
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') continue;
      expect(u.pathname.startsWith('/api'), `ローカルサーバの API への要求：${r.url}`).toBe(false);
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') expect(u.port, `ローカルサーバへの要求：${r.url}`).toBe(String(PAGES_PORT));
      if (r.auth) expect(r.host, `Authorization を送った先：${r.url}`).toBe('api.github.com');
      for (const pat of ALL_PATS) {
        expect(r.url.includes(pat), `URL に PAT：${r.url}`).toBe(false);
        if (r.host !== 'api.github.com') expect(r.body?.includes(pat) ?? false, `api.github.com 以外への本文に PAT：${r.url}`).toBe(false);
      }
    }
    for (const m of messages) for (const pat of ALL_PATS) expect(m.includes(pat), 'postMessage に PAT').toBe(false);
  },
  gh: [
    async ({ page, stubOptions, seen }, use) => {
      void seen;
      const gh = await stubGitHub(page, stubOptions);
      await use(gh);
      expect(gh.unhandled, 'スタブに無い GitHub への要求').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Opens the viewer at a hash (relative to the Pages base). */
export async function openHash(page: Page, hash = '#/'): Promise<void> {
  await page.goto(`./${hash}`);
}

/** 対象の指定 → 開く. */
export async function submitTarget(page: Page, repo: string, kind: 'pr' | 'ref', target: string): Promise<void> {
  await page.getByTestId('repo').fill(repo);
  await page.getByTestId('kind').selectOption(kind);
  await page.getByTestId('target').fill(target);
  await page.getByTestId('open-submit').click();
}

/** PAT メニュー → PAT を設定（ダイアログ）. */
export async function setPatViaMenu(page: Page, pat: string, persist = false): Promise<void> {
  await page.getByTestId('pat-menu').click();
  await page.getByTestId('pat-menu-set').click();
  const dialog = page.getByTestId('pat-dialog');
  await dialog.getByTestId('pat').fill(pat);
  if (persist) await dialog.getByTestId('pat-store').check();
  await dialog.getByTestId('pat-submit').click();
  await expect(dialog).toBeHidden();
}

/** `location.hash = …` from the page (as the user editing the URL). */
export async function setHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => (location.hash = h), hash);
}
