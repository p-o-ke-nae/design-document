import type { Page } from '@playwright/test';

/** Start token of every `ddv serve` started by the E2E (`DDV_TOKEN`). */
export const E2E_TOKEN = 'ddv-e2e-0123456789abcdef';

/** E2E port of the main server (`DDV_E2E_PORT`, default 5179). */
export const E2E_PORT = Number(process.env.DDV_E2E_PORT || 5179);

export function startUrl(base: string, hash = ''): string {
  return `${base.replace(/\/+$/, '')}/?ddv-token=${E2E_TOKEN}${hash}`;
}

/** Gets the session cookie of `base` into the page's browser context (`page.request` shares its cookies). */
export async function login(page: Page, base: string): Promise<void> {
  const res = await page.request.get(startUrl(base), { maxRedirects: 0 });
  if (res.status() !== 302) throw new Error(`login to ${base} failed: ${res.status()}`);
}