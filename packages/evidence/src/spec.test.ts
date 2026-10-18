import { describe, expect, it } from 'vitest';
import { parseScenarioFile } from '@ddv/mock';
import { normalizeSpec, validateEvidence } from './spec.ts';

const scenario = (...evidence: unknown[]) => ({ id: 'BD-X-P001', steps: [{ event: 'a' }, { event: 'b', evidence }] });
const check = (...evidence: unknown[]) => validateEvidence(scenario(...evidence));
const at = (j: number, label: string, message: string) => `シナリオ BD-X-P001 のステップ 2 の証跡 ${j}（${label}）: ${message}`;

describe('指定の形式の検査（SPECVAL）', () => {
  it('[DD-EVSPEC-SPECVAL-P001] [DD-EVSPEC-SPECVAL-T001] [DD-EVSPEC-SPECVAL-T002] use が空か無ければ use が必要です', () => {
    expect(check({ use: '' })).toEqual([{ path: 'steps.1.evidence.0.use', message: at(1, '', 'use（取得手段の名前）が必要です') }]);
    expect(check({ label: 'x' })[0].message).toBe(at(1, 'x', 'use（取得手段の名前）が必要です'));
    expect(check({ use: '  ' })).toHaveLength(1);
  });

  it('[DD-EVSPEC-SPECVAL-P002] [DD-EVSPEC-SPECVAL-T003] [DD-EVSPEC-SPECVAL-T004] at・onError が既知の値でなければエラー', () => {
    expect(check({ use: 'db', at: 'during' })).toEqual([{ path: 'steps.1.evidence.0.at', message: at(1, 'db', 'at は before か after です') }]);
    expect(check({ use: 'db', onError: 'ignore' })).toEqual([{ path: 'steps.1.evidence.0.onError', message: at(1, 'db', 'onError は fail か warn です') }]);
    expect(check({ use: 'db', at: 'before', onError: 'warn' })).toEqual([]);
  });

  it('[DD-EVSPEC-SPECVAL-P003] [DD-EVSPEC-SPECVAL-T005] [DD-EVSPEC-SPECVAL-T006] timeout は 100〜600000 の整数', () => {
    for (const timeout of [99, 600_001, 1.5]) {
      expect(check({ use: 'db', timeout })).toEqual([{ path: 'steps.1.evidence.0.timeout', message: at(1, 'db', 'timeout は 100〜600000 ミリ秒の整数です') }]);
    }
    expect(check({ use: 'db', timeout: 100 }, { use: 'x', timeout: 600_000 })).toEqual([]);
  });

  it('[DD-EVSPEC-SPECVAL-P004] [DD-EVSPEC-SPECVAL-T007] [DD-EVSPEC-SPECVAL-T008] with の値は Scalar・Scalar の配列・input の参照', () => {
    expect(check({ use: 'x', with: { a: { b: 1 } } })).toEqual([{ path: 'steps.1.evidence.0.with.a', message: at(1, 'x', 'with の値に使えない形があります（a）') }]);
    expect(check({ use: 'x', with: { a: [1, [2]] } })[0].path).toBe('steps.1.evidence.0.with.a');
    expect(check({ use: 'x', with: { a: [{ input: 'k' }] } })).toHaveLength(1);
    expect(check({ use: 'x', with: { a: { input: 'k', x: 1 } } })).toHaveLength(1);
    expect(check({ use: 'x', with: { a: null } })).toHaveLength(1);
    // db の params は 1 段の map（値は WithValue）
    expect(check({ use: 'db', with: { params: { id: { nested: 1 } } } })[0].path).toBe('steps.1.evidence.0.with.params.id');
    expect(check({ use: 'db', with: { sql: 'select 1', params: { id: { input: 'id' }, n: 1 } } })).toEqual([]);
    expect(check({ use: 'x', with: { s: 'a', n: 1, b: true, l: ['a', 2, false], r: { input: 'k' } } })).toEqual([]);
  });

  it('[DD-EVSPEC-SPECVAL-P005] [DD-EVSPEC-SPECVAL-T009] [DD-EVSPEC-SPECVAL-T010] 同じステップに同じ表示名があればエラー', () => {
    expect(check({ use: 'db' }, { use: 'db' })).toEqual([{ path: 'steps.1.evidence.1.use', message: at(2, 'db', '同じステップに同じ表示名があります: db') }]);
    expect(check({ use: 'db', label: 'A' }, { use: 'x', label: 'A' })[0].path).toBe('steps.1.evidence.1.label');
    // 既定の label は use
    expect(check({ use: 'db', label: 'x' }, { use: 'x' })).toHaveLength(1);
  });

  it('[DD-EVSPEC-SPECVAL-P006] [DD-EVSPEC-SPECVAL-T011] 正しい指定は問題なし・既定値を補う', () => {
    expect(check({ use: 'db', label: '注文' }, { use: 'db', label: '明細' }, { use: 'screenshot' })).toEqual([]);
    expect(validateEvidence({ id: 'S', steps: [{ evidence: [{ use: 'db' }] }, { evidence: [{ use: 'db' }] }] })).toEqual([]);
    expect(normalizeSpec({ use: 'db' })).toEqual({ use: 'db', at: 'after', label: 'db', with: {}, onError: 'fail' });
    expect(normalizeSpec({ use: 'db', at: 'before', label: 'L', with: { a: 1 }, onError: 'warn', timeout: 500 })).toEqual({ use: 'db', at: 'before', label: 'L', with: { a: 1 }, onError: 'warn', timeout: 500 });
  });
});

describe('シナリオの evidence', () => {
  const file = (evidence: string, extra = '') => `id: BD-X-P001
title: t
start: A
steps:
  - event: e
    click: b
    expect: { screen: B }
    evidence:
${evidence}
${extra}`;

  it('[BD-EVICAP-CHECK-P001] [BD-EVICAP-CHECK-T001] [BD-EVICAP-CHECK-T002] 形式に合わない指定はシナリオの形式のエラー', () => {
    const r = parseScenarioFile(file('      - { use: db, at: later }'), 'x.yaml');
    expect(r.scenario).toBeUndefined();
    expect(r.issues.map((i) => i.message)).toEqual([expect.stringContaining('シナリオ BD-X-P001 のステップ 1 の証跡 1（db）: at は before か after です')]);
    // 未知のキーは zod の strictObject で弾く
    expect(parseScenarioFile(file('      - { use: db, when: after }'), 'x.yaml').scenario).toBeUndefined();
    // 正しい指定は通り、evidence が残る
    const ok = parseScenarioFile(file('      - { use: db, label: 注文, with: { sql: "select 1" } }'), 'x.yaml');
    expect(ok.issues).toEqual([]);
    expect(ok.scenario?.steps[0].evidence).toEqual([{ use: 'db', label: '注文', with: { sql: 'select 1' } }]);
  });

  it('補助ステップにも evidence を書けるが、evidence だけの補助ステップはエラー', () => {
    const aux = (body: string) => `id: BD-X-P001
title: t
start: A
steps:
${body}
  - event: e
    click: b
    expect: { screen: B }
`;
    const ok = parseScenarioFile(aux('  - click: x\n    evidence: [ { use: db, at: before, with: { sql: "select 1" } } ]'), 'x.yaml');
    expect(ok.issues).toEqual([]);
    const bad = parseScenarioFile(aux('  - click: x\n    evidence: [ { use: "" } ]'), 'x.yaml');
    expect(bad.issues.map((i) => i.message)).toEqual([expect.stringContaining('ステップ 1 の証跡 1（）: use（取得手段の名前）が必要です')]);
    expect(parseScenarioFile(aux('  - evidence: [ { use: db } ]'), 'x.yaml').scenario).toBeUndefined();
  });
});
