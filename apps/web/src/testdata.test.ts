import { describe, expect, it } from 'vitest';
import type { TestDataBundle } from './api.ts';
import {
  countValue,
  defaultComment,
  DRAFT_INITIAL,
  DraftStore,
  failedCells,
  fieldType,
  fieldValue,
  inputKind,
  inputValue,
  issueCell,
  nextDraftState,
  NEED_COUNT,
  NEED_NUMBER,
  previewData,
  rowKeyField,
  selectOptions,
  type DraftEvent,
  type DraftState,
} from './testdata.ts';

const BUNDLE: TestDataBundle = {
  scenario: {
    name: 'p002',
    path: 'docs/mocks/order/scenarios/p002.yaml',
    hash: 'aaaa',
    data: {
      id: 'BD-ORDER-SCREEN-P002',
      title: '注文',
      fixtures: ['default'],
      start: 'List',
      steps: [
        { event: '新規', click: 'new', expect: { screen: 'Input' } },
        { event: '次へ', click: 'next', input: { customer: '山田', quantity: 1 }, expect: { screen: 'Confirm', text: { total: '1 円' } } },
      ],
    },
  },
  fixtures: [{ name: 'default', path: 'docs/mocks/order/fixtures/default.yaml', hash: 'bbbb', data: { orders: [{ id: 'A-1', customer: '佐藤', qty: 2, paid: false }] } }],
  availableFixtures: ['default', 'empty'],
  mock: { fields: [{ key: 'quantity', kind: 'number', required: true, options: [] }, { key: 'size', kind: 'select', required: false, options: ['S', 'M'] }], testids: ['customer', 'quantity', 'total'], tables: [{ name: 'stock', key: 'sku' }] },
  editable: true,
  workspace: 'local',
  transitions: [],
  retired: false,
};

describe('編集の状態（DD-TDEDIT-DRAFT）', () => {
  it('[DD-TDEDIT-DRAFT-T001] 開始は表示', () => {
    expect(DRAFT_INITIAL).toBe('View');
  });

  it('[DD-TDEDIT-DRAFT-T002] [DD-TDEDIT-DRAFT-T003] 表示で編集 → 編集中、値を変更しても編集中', () => {
    expect(nextDraftState('View', 'edit')).toBe('Editing');
    expect(nextDraftState('Editing', 'change')).toBe('Editing');
  });

  it('[DD-TDEDIT-DRAFT-T004] [DD-TDEDIT-DRAFT-T005] 形式OK なら再生で再生中、再生終了で編集中へ。形式NG では再生しない', () => {
    expect(nextDraftState('Editing', 'preview', true)).toBe('Previewing');
    expect(nextDraftState('Editing', 'preview', false)).toBeNull();
    expect(nextDraftState('Previewing', 'previewEnd')).toBe('Editing');
  });

  it('[DD-TDEDIT-DRAFT-T006] [DD-TDEDIT-DRAFT-T007] [DD-TDEDIT-DRAFT-T008] 変更あり・エラーなしで保存中、応答の成功で表示・失敗で編集中', () => {
    expect(nextDraftState('Editing', 'save', true)).toBe('Saving');
    expect(nextDraftState('Editing', 'save', false)).toBeNull();
    expect(nextDraftState('Saving', 'response', true)).toBe('View');
    expect(nextDraftState('Saving', 'response', false)).toBe('Editing');
  });

  it('[DD-TDEDIT-DRAFT-T009] 編集中の取消で表示', () => {
    expect(nextDraftState('Editing', 'cancel')).toBe('View');
  });

  it('[DD-TDEDIT-DRAFT-T010] [DD-TDEDIT-DRAFT-T011] [DD-TDEDIT-DRAFT-T012] 変更ありで他へ移ると離脱の確認、破棄で表示・留まるで編集中。変更なしなら確認しない', () => {
    expect(nextDraftState('Editing', 'leave', true)).toBe('Leaving');
    expect(nextDraftState('Editing', 'leave', false)).toBeNull();
    expect(nextDraftState('Leaving', 'discard')).toBe('View');
    expect(nextDraftState('Leaving', 'stay')).toBe('Editing');
  });

  const rejects = (state: DraftState, event: DraftEvent) => {
    expect(nextDraftState(state, event, true)).toBeNull();
    expect(nextDraftState(state, event, false)).toBeNull();
  };
  // 受け付けない操作は何もしない（表示で他へ移るは確認なしで移る）
  it('[DD-TDEDIT-DRAFT-X001] View で change は受け付けない', () => rejects('View', 'change'));
  it('[DD-TDEDIT-DRAFT-X002] View で preview は受け付けない', () => rejects('View', 'preview'));
  it('[DD-TDEDIT-DRAFT-X003] View で previewEnd は受け付けない', () => rejects('View', 'previewEnd'));
  it('[DD-TDEDIT-DRAFT-X004] View で save は受け付けない', () => rejects('View', 'save'));
  it('[DD-TDEDIT-DRAFT-X005] View で response は受け付けない', () => rejects('View', 'response'));
  it('[DD-TDEDIT-DRAFT-X006] View で cancel は受け付けない', () => rejects('View', 'cancel'));
  it('[DD-TDEDIT-DRAFT-X007] View で leave は受け付けない', () => rejects('View', 'leave'));
  it('[DD-TDEDIT-DRAFT-X008] View で discard は受け付けない', () => rejects('View', 'discard'));
  it('[DD-TDEDIT-DRAFT-X009] View で stay は受け付けない', () => rejects('View', 'stay'));
  it('[DD-TDEDIT-DRAFT-X010] Editing で edit は受け付けない', () => rejects('Editing', 'edit'));
  it('[DD-TDEDIT-DRAFT-X011] Editing で previewEnd は受け付けない', () => rejects('Editing', 'previewEnd'));
  it('[DD-TDEDIT-DRAFT-X012] Editing で response は受け付けない', () => rejects('Editing', 'response'));
  it('[DD-TDEDIT-DRAFT-X013] Editing で discard は受け付けない', () => rejects('Editing', 'discard'));
  it('[DD-TDEDIT-DRAFT-X014] Editing で stay は受け付けない', () => rejects('Editing', 'stay'));
  it('[DD-TDEDIT-DRAFT-X015] Previewing で edit は受け付けない', () => rejects('Previewing', 'edit'));
  it('[DD-TDEDIT-DRAFT-X016] Previewing で change は受け付けない', () => rejects('Previewing', 'change'));
  it('[DD-TDEDIT-DRAFT-X017] Previewing で preview は受け付けない', () => rejects('Previewing', 'preview'));
  it('[DD-TDEDIT-DRAFT-X018] Previewing で save は受け付けない', () => rejects('Previewing', 'save'));
  it('[DD-TDEDIT-DRAFT-X019] Previewing で response は受け付けない', () => rejects('Previewing', 'response'));
  it('[DD-TDEDIT-DRAFT-X020] Previewing で cancel は受け付けない', () => rejects('Previewing', 'cancel'));
  it('[DD-TDEDIT-DRAFT-X021] Previewing で leave は受け付けない', () => rejects('Previewing', 'leave'));
  it('[DD-TDEDIT-DRAFT-X022] Previewing で discard は受け付けない', () => rejects('Previewing', 'discard'));
  it('[DD-TDEDIT-DRAFT-X023] Previewing で stay は受け付けない', () => rejects('Previewing', 'stay'));
  it('[DD-TDEDIT-DRAFT-X024] Saving で edit は受け付けない', () => rejects('Saving', 'edit'));
  it('[DD-TDEDIT-DRAFT-X025] Saving で change は受け付けない', () => rejects('Saving', 'change'));
  it('[DD-TDEDIT-DRAFT-X026] Saving で preview は受け付けない', () => rejects('Saving', 'preview'));
  it('[DD-TDEDIT-DRAFT-X027] Saving で previewEnd は受け付けない', () => rejects('Saving', 'previewEnd'));
  it('[DD-TDEDIT-DRAFT-X028] Saving で save は受け付けない', () => rejects('Saving', 'save'));
  it('[DD-TDEDIT-DRAFT-X029] Saving で cancel は受け付けない', () => rejects('Saving', 'cancel'));
  it('[DD-TDEDIT-DRAFT-X030] Saving で leave は受け付けない', () => rejects('Saving', 'leave'));
  it('[DD-TDEDIT-DRAFT-X031] Saving で discard は受け付けない', () => rejects('Saving', 'discard'));
  it('[DD-TDEDIT-DRAFT-X032] Saving で stay は受け付けない', () => rejects('Saving', 'stay'));
  it('[DD-TDEDIT-DRAFT-X033] Leaving で edit は受け付けない', () => rejects('Leaving', 'edit'));
  it('[DD-TDEDIT-DRAFT-X034] Leaving で change は受け付けない', () => rejects('Leaving', 'change'));
  it('[DD-TDEDIT-DRAFT-X035] Leaving で preview は受け付けない', () => rejects('Leaving', 'preview'));
  it('[DD-TDEDIT-DRAFT-X036] Leaving で previewEnd は受け付けない', () => rejects('Leaving', 'previewEnd'));
  it('[DD-TDEDIT-DRAFT-X037] Leaving で save は受け付けない', () => rejects('Leaving', 'save'));
  it('[DD-TDEDIT-DRAFT-X038] Leaving で response は受け付けない', () => rejects('Leaving', 'response'));
  it('[DD-TDEDIT-DRAFT-X039] Leaving で cancel は受け付けない', () => rejects('Leaving', 'cancel'));
  it('[DD-TDEDIT-DRAFT-X040] Leaving で leave は受け付けない', () => rejects('Leaving', 'leave'));
});

describe('値の型', () => {
  it('input はモックの要素の種類に合わせ、数値は空なら空文字列・変換できなければ「数値を入力してください」', () => {
    expect(inputKind(BUNDLE.mock.fields[0])).toBe('number');
    expect(inputKind(undefined)).toBe('text');
    expect(inputValue('number', '5')).toEqual({ ok: true, value: 5 });
    expect(inputValue('number', '')).toEqual({ ok: true, value: '' });
    expect(inputValue('number', 'x')).toEqual({ ok: false, message: NEED_NUMBER });
    expect(inputValue('checkbox', true)).toEqual({ ok: true, value: true });
    expect(inputValue('select', 'M')).toEqual({ ok: true, value: 'M' });
    expect(inputValue('text', '3')).toEqual({ ok: true, value: '3' });
    expect(selectOptions(BUNDLE.mock.fields[1], 'XL')).toEqual(['S', 'M', 'XL']);
    expect(selectOptions(BUNDLE.mock.fields[1], 'S')).toEqual(['S', 'M']);
  });

  it('fixtures の項目は今の値の型（新しい項目は文字列）、count は 0 以上の整数', () => {
    expect(fieldType(2)).toBe('number');
    expect(fieldType(false)).toBe('boolean');
    expect(fieldType(undefined)).toBe('string');
    expect(fieldValue('number', '3.5')).toEqual({ ok: true, value: 3.5 });
    expect(fieldValue('number', 'abc')).toEqual({ ok: false, message: NEED_NUMBER });
    expect(fieldValue('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(countValue('2')).toEqual({ ok: true, value: 2 });
    expect(countValue('-1')).toEqual({ ok: false, message: NEED_COUNT });
    expect(countValue('1.5')).toEqual({ ok: false, message: NEED_COUNT });
  });

  it('行のキーは tables の key（既定 id）、行に無ければ先頭の項目', () => {
    expect(rowKeyField(BUNDLE.mock.tables, 'stock', { sku: 'S', n: 1 })).toBe('sku');
    expect(rowKeyField(BUNDLE.mock.tables, 'orders', { id: 1 })).toBe('id');
    expect(rowKeyField(BUNDLE.mock.tables, 'orders', { code: 'x' })).toBe('code');
  });
});

describe('DraftStore', () => {
  it('begin / set / addRow / removeRow / discard と dirty。キーを消して空になった input は消す', () => {
    const s = new DraftStore();
    s.begin(BUNDLE);
    expect(s.dirty).toBe(false);
    expect(s.draft!.base).toEqual({ 'docs/mocks/order/scenarios/p002.yaml': 'aaaa', 'docs/mocks/order/fixtures/default.yaml': 'bbbb' });
    s.set(['scenario', 'steps', 1, 'input', 'quantity'], 3);
    expect(s.dirty).toBe(true);
    expect(s.draft!.scenario.steps[1].input).toEqual({ customer: '山田', quantity: 3 });
    expect(BUNDLE.scenario.data.steps[1].input).toEqual({ customer: '山田', quantity: 1 });
    s.set(['scenario', 'steps', 1, 'input', 'quantity'], 1);
    expect(s.dirty).toBe(false);
    s.set(['scenario', 'steps', 1, 'input', 'customer'], undefined);
    s.set(['scenario', 'steps', 1, 'input', 'quantity'], undefined);
    expect('input' in s.draft!.scenario.steps[1]).toBe(false);
    s.discard();
    expect(s.dirty).toBe(false);
    s.addRow('default', 'orders');
    expect(s.draft!.fixtures.default.orders[1]).toEqual({ id: '', customer: '', qty: 0, paid: false });
    s.removeRow('default', 'orders', 0);
    expect(s.draft!.fixtures.default.orders).toHaveLength(1);
    expect(s.dirty).toBe(true);
  });

  it('入力のエラーはセルごとに持ち、値は変えない。サーバの指摘と同じセルの形', () => {
    const s = new DraftStore();
    s.begin(BUNDLE);
    s.set(['fixtures', 'default', 'orders', 0, 'qty'], undefined, NEED_NUMBER);
    expect(s.getSnapshot().errors).toEqual({ 'docs/mocks/order/fixtures/default.yaml|orders[0].qty': NEED_NUMBER });
    expect(s.hasInputErrors).toBe(true);
    expect(s.dirty).toBe(false);
    s.set(['fixtures', 'default', 'orders', 0, 'qty'], 4);
    expect(s.hasInputErrors).toBe(false);
    expect(issueCell({ file: 'docs/mocks/order/scenarios/p002.yaml', path: 'steps[1].input.quantity', code: 'schema', message: '' })).toBe('docs/mocks/order/scenarios/p002.yaml|steps[1].input.quantity');
  });

  it('再生用の data は使う fixtures だけ。失敗のキーは強調するセルに、既定のコメントは変えた項目', () => {
    const s = new DraftStore();
    s.begin(BUNDLE);
    s.set(['scenario', 'steps', 1, 'expect', 'text', 'total'], '3 円');
    s.set(['fixtures', 'default', 'orders', 0, 'customer'], '鈴木');
    expect(previewData({ ...s.draft!, fixtures: { ...s.draft!.fixtures, other: {} } })).toEqual({ default: { orders: [{ id: 'A-1', customer: '鈴木', qty: 2, paid: false }] } });
    expect(failedCells([{ key: 'text:total' }, { key: 'count:orders' }, { key: 'visible:x' }, { key: 'screen' }])).toEqual(['ex-total', 'exc-orders', 'exv', 'screen']);
    expect(defaultComment(s.draft!, BUNDLE)).toBe('テストデータ：BD-ORDER-SCREEN-P002 の steps[1]・fixtures/default');
  });
});
