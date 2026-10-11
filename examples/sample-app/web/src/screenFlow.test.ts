import { describe, expect, it } from 'vitest';
import { ScreenFlow } from './screenFlow';

const valid = { customer: '山田', sku: 'A-100', quantity: 2 };

describe('画面遷移', () => {
  it('[BD-ORDER-SCREEN-T002] 一覧で新規を押すと入力へ', () => {
    const f = new ScreenFlow();
    expect(f.send('新規')).toBe('Input');
  });

  it('[BD-ORDER-SCREEN-T003] 入力OKで次へを押すと確認へ', () => {
    const f = new ScreenFlow();
    f.send('新規');
    f.input = valid;
    expect(f.send('次へ')).toBe('Confirm');
  });

  it('[BD-ORDER-SCREEN-T004] 入力NGで次へを押すと入力のまま', () => {
    const f = new ScreenFlow();
    f.send('新規');
    expect(f.send('次へ')).toBe('Input');
    expect(f.errors.length).toBeGreaterThan(0);
  });

  it('[BD-ORDER-SCREEN-T005] 入力でキャンセルすると一覧へ', () => {
    const f = new ScreenFlow();
    f.send('新規');
    expect(f.send('キャンセル')).toBe('List');
  });

  it('[BD-ORDER-SCREEN-P003] 一覧→入力→確認→確定→完了', () => {
    const f = new ScreenFlow();
    f.send('新規');
    f.input = valid;
    f.send('次へ');
    expect(f.send('確定')).toBe('Done');
    expect(f.send('終了')).toBe('End');
  });

  it('[BD-ORDER-SCREEN-X004] 一覧で確定はできない', () => {
    const f = new ScreenFlow();
    expect(() => f.send('確定')).toThrow();
  });
});
