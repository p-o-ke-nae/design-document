import { describe, expect, it } from 'vitest';
import { planSteps } from '@ddv/mock';
import { InputScope, resolveWith } from './with.ts';

// Step 1 (web only), step 2 (all), step 3 (wpf only), step 4 (all): inputs overlap on `k`.
const scenario: { start: string; steps: Array<{ event: string; only?: 'web' | 'wpf'; input: Record<string, string>; expect: { screen: string } }> } = {
  start: 'A',
  steps: [
    { event: 'a', only: 'web', input: { k: 'web1', w: 'only-web' }, expect: { screen: 'B' } },
    { event: 'b', input: { k: 'all2', c: 'common' }, expect: { screen: 'C' } },
    { event: 'c', only: 'wpf', input: { k: 'wpf3' }, expect: { screen: 'D' } },
    { event: 'd', input: { k: 'all4' }, expect: { screen: 'E' } },
  ],
};
const scope = (platform: 'web' | 'wpf') => InputScope.of(scenario, planSteps(scenario, platform));
const obj = (m: Map<string, unknown>) => Object.fromEntries(m);

describe('入力値の範囲（SCOPE）', () => {
  it('[DD-EVSPEC-SCOPE-P001] [DD-EVSPEC-SCOPE-T001] [DD-EVSPEC-SCOPE-T002] [DD-EVSPEC-SCOPE-T004] [DD-EVSPEC-SCOPE-T006] before: 飛ばしたステップの入力は使わない', () => {
    // wpf: step 1 is skipped → `w` is absent before step 2
    expect(obj(scope('wpf').before(1))).toEqual({});
    expect(obj(scope('wpf').at('before', 3))).toEqual({ k: 'wpf3', c: 'common' });
    // web: step 3 (wpf only) is skipped
    expect(obj(scope('web').before(3))).toEqual({ k: 'all2', w: 'only-web', c: 'common' });
  });

  it('[DD-EVSPEC-SCOPE-P002] [DD-EVSPEC-SCOPE-T007] before: ステップ 1〜n-1 の入力を後の値で上書き', () => {
    expect(obj(scope('web').before(0))).toEqual({});
    expect(obj(scope('web').before(2))).toEqual({ k: 'all2', w: 'only-web', c: 'common' });
  });

  it('[DD-EVSPEC-SCOPE-P003] [DD-EVSPEC-SCOPE-T003] [DD-EVSPEC-SCOPE-T005] after: 飛ばしたステップの入力は使わない', () => {
    expect(obj(scope('wpf').after(0))).toEqual({});
    expect(obj(scope('web').after(2))).toEqual({ k: 'all2', w: 'only-web', c: 'common' });
  });

  it('[DD-EVSPEC-SCOPE-P004] after: ステップ 1〜n の入力を後の値で上書き', () => {
    expect(obj(scope('web').after(0))).toEqual({ k: 'web1', w: 'only-web' });
    expect(obj(scope('wpf').at('after', 2))).toEqual({ k: 'wpf3', c: 'common' });
    expect(obj(scope('web').after(3))).toEqual({ k: 'all4', w: 'only-web', c: 'common' });
  });
});

describe('引数の解決（WITH）', () => {
  const s = new Map<string, string | number | boolean>([['orderId', 'A-1'], ['qty', 2]]);

  it('[DD-EVSPEC-WITH-P001] [DD-EVSPEC-WITH-T001] [DD-EVSPEC-WITH-T002] Scalar はそのまま', () => {
    expect(resolveWith({ s: 'x', n: 1, b: false }, s)).toEqual({ ok: true, args: { s: 'x', n: 1, b: false } });
  });

  it('[DD-EVSPEC-WITH-P002] [DD-EVSPEC-WITH-T003] Scalar の配列はそのまま', () => {
    expect(resolveWith({ l: ['a', 1, true] }, s)).toEqual({ ok: true, args: { l: ['a', 1, true] } });
  });

  it('[DD-EVSPEC-WITH-P003] [DD-EVSPEC-WITH-T004] [DD-EVSPEC-WITH-T005] input の参照は scope の値', () => {
    expect(resolveWith({ id: { input: 'orderId' }, params: { q: { input: 'qty' }, fixed: 'z' } }, s)).toEqual({
      ok: true,
      args: { id: 'A-1', params: { q: 2, fixed: 'z' } },
    });
  });

  it('[DD-EVSPEC-WITH-P004] [DD-EVSPEC-WITH-T006] scope に無いキーは 失敗: 入力 キー はこの時点ではありません', () => {
    expect(resolveWith({ id: { input: 'customer' }, again: { input: 'customer' } }, s)).toEqual({
      ok: false,
      missing: ['customer'],
      message: '入力 customer はこの時点ではありません',
    });
    const r = resolveWith({ params: { a: { input: 'x' } }, b: { input: 'y' } }, s);
    expect(r.ok ? [] : r.missing).toEqual(['x', 'y']);
  });
});
