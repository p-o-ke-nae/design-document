import { expect, test as setup } from '@playwright/test';
import { E2E_TOKEN } from './ddv-auth.ts';

export const STORAGE_STATE = 'test-results/.auth/ddv.json';

setup('起動トークンでセッション Cookie を得る', async ({ request }) => {
  const res = await request.get(`/?ddv-token=${E2E_TOKEN}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  await request.storageState({ path: STORAGE_STATE });
});