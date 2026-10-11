// 実アプリで E2E を実行するときのフック（任意。実装工程で AI が書く）。DDV_BASE_URL 指定時だけ読み込まれる
import type { ScenarioHooks } from '@ddv/mock/playwright';

// シナリオの fixtures（例 ['default']）を実アプリの API / DB に投入する
export const seed: ScenarioHooks['seed'] = async (fixtures, { page, baseURL }) => {
  for (const name of fixtures) {
    await page.request.post(new URL(`/test/seed/${name}`, baseURL).href);
  }
};

// シナリオの do: <名前> で呼ばれる独自の操作
export const steps: ScenarioHooks['steps'] = {
  // ログイン: async (page) => { await page.fill('#user', 'test'); await page.click('text=ログイン'); },
};