import { describe, expect, it } from 'vitest';
import { parseResultKey, PlatformResults, resultKey } from './result-key.ts';
import type { CaseResult } from './history.ts';

const ID = ['BD', 'ORDER', 'SCREEN', 'P001'].join('-');
const r = (status: CaseResult['status'], message?: string): CaseResult => ({ status, durationMs: 1, runner: 'x', test: 't', ...(message ? { message } : {}) });

describe('結果のキー（DD-PLATRES-RKEY）', () => {
  it('resultKey は web・未指定で testId、それ以外は testId@platform', () => {
    expect(resultKey(ID)).toBe(ID);
    expect(resultKey(ID, 'web')).toBe(ID);
    expect(resultKey(ID, 'wpf')).toBe(`${ID}@wpf`);
    expect(resultKey(ID, 'winforms')).toBe(`${ID}@winforms`);
  });

  it('[DD-PLATRES-RKEY-P001] [DD-PLATRES-RKEY-T001] [DD-PLATRES-RKEY-T002] @ を含まないキーは testId=key・platform=web', () => {
    expect(parseResultKey(ID)).toEqual({ testId: ID, platform: 'web' });
    expect(parseResultKey('')).toEqual({ testId: '', platform: 'web' });
  });

  it('[DD-PLATRES-RKEY-P002] [DD-PLATRES-RKEY-T003] [DD-PLATRES-RKEY-T004] 最後の @ の後が wpf・winforms なら分ける', () => {
    expect(parseResultKey(`${ID}@wpf`)).toEqual({ testId: ID, platform: 'wpf' });
    expect(parseResultKey(`${ID}@winforms`)).toEqual({ testId: ID, platform: 'winforms' });
    expect(parseResultKey(`a@b@wpf`)).toEqual({ testId: 'a@b', platform: 'wpf' });
    for (const p of ['wpf', 'winforms'] as const) expect(parseResultKey(resultKey(ID, p))).toEqual({ testId: ID, platform: p });
  });

  it('[DD-PLATRES-RKEY-P003] [DD-PLATRES-RKEY-T005] 不明な形（@web・@WPF・@ の後が空など）は従来のキーとみなす', () => {
    for (const key of [`${ID}@web`, `${ID}@WPF`, `${ID}@`, `${ID}@wpf@x`, 'user@example.com']) expect(parseResultKey(key)).toEqual({ testId: key, platform: 'web' });
  });
});

describe('PlatformResults.byTest', () => {
  it('最新の結果のキーを分け、テストID → プラットフォーム → 結果にする（@ の無い既存のキーは web）', () => {
    const m = PlatformResults.byTest({ [ID]: r('passed'), [`${ID}@wpf`]: r('failed'), X: r('skipped') });
    expect(Object.fromEntries(m)).toEqual({ [ID]: { web: r('passed'), wpf: r('failed') }, X: { web: r('skipped') } });
  });
});

describe('カバレッジのためのまとめ（DD-PLATRES-COVMERGE）', () => {
  it('[DD-PLATRES-COVMERGE-P001] [DD-PLATRES-COVMERGE-T001] [DD-PLATRES-COVMERGE-T002] 結果が無ければ未実行（null）', () => {
    expect(PlatformResults.combine(undefined)).toBeNull();
    expect(PlatformResults.combine({})).toBeNull();
  });

  it('[DD-PLATRES-COVMERGE-P002] [DD-PLATRES-COVMERGE-T003] [DD-PLATRES-COVMERGE-T004] failed か error が 1 つでもあれば失敗（最初の失敗のメッセージ）', () => {
    expect(PlatformResults.combine({ web: r('passed'), wpf: r('failed', 'wpf で失敗'), winforms: r('error', 'winforms で失敗') })).toMatchObject({ status: 'failed', message: 'wpf で失敗' });
    expect(PlatformResults.combine({ winforms: r('error', '起動できません'), web: r('skipped') })).toMatchObject({ status: 'error', message: '起動できません' });
    expect(PlatformResults.combine({ web: r('failed', 'web'), wpf: r('failed', 'wpf') })?.message).toBe('web');
  });

  it('[DD-PLATRES-COVMERGE-P003] [DD-PLATRES-COVMERGE-T005] [DD-PLATRES-COVMERGE-T006] 失敗が無くすべて passed なら成功', () => {
    expect(PlatformResults.combine({ web: r('passed'), wpf: r('passed') })?.status).toBe('passed');
    expect(PlatformResults.combine({ winforms: r('passed') })?.status).toBe('passed');
  });

  it('[DD-PLATRES-COVMERGE-P004] [DD-PLATRES-COVMERGE-T007] 失敗が無く passed でないものがあれば skipped', () => {
    expect(PlatformResults.combine({ web: r('passed'), wpf: r('skipped') })?.status).toBe('skipped');
    expect(PlatformResults.combine({ wpf: r('skipped') })?.status).toBe('skipped');
  });
});
