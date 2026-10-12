import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { lineHunks, PATCH_FAILED, YamlPatcher, YamlPatchError } from './yaml-patch';

const STEP_ORDER = ['event', 'input', 'click', 'do', 'wait', 'expect'];
const patcher = new YamlPatcher({
  arrayKey: (p) => (p.length === 1 && p[0] !== 'steps' ? (p[0] === 'stock' ? 'sku' : 'id') : undefined),
  keyOrder: (p) => (p.length === 2 && p[0] === 'steps' ? STEP_ORDER : undefined),
});

function patch(text: string, edit: (v: any) => void) {
  const before = parse(text);
  const after = structuredClone(before);
  edit(after);
  const out = patcher.apply(text, before, after);
  expect(parse(out.text)).toEqual(after);
  return out;
}

const SCENARIO = [
  '# 注文の確定',
  'id: BD-ORDER-T002',
  'fixtures: [ default ]',
  'start: List',
  'steps:',
  '  - event: 新規',
  '    click: new # ボタン',
  '    expect: { screen: Input }',
  '  - event: 次へ',
  '    input: { customer: 山田 太郎, quantity: 1 }',
  '    click: next',
  '    expect:',
  '      screen: Confirm',
  '      text:',
  '        confirm-quantity: "1"',
  '        # 顧客名',
  '        confirm-customer: 山田 太郎',
  '',
].join('\n');

const FIXTURE = ['orders:', '  - { id: 1, customer: 山田 太郎, sku: A-100 }', '  - { id: 2, customer: 佐藤 花子, sku: B-200 }', 'stock:', '  - sku: A-100', '    qty: 3', '  - sku: B-200', '    qty: 0', ''].join('\n');

describe('YamlPatcher', () => {
  it('[DD-TDEDIT-PATCH-P001] [DD-TDEDIT-PATCH-T001] [DD-TDEDIT-PATCH-T002] [DD-TDEDIT-PATCH-T003] replaces only the scalar outside flow nodes, keeping its quotes and comments', () => {
    const out = patch(SCENARIO, (v) => {
      v.steps[1].expect.text['confirm-quantity'] = '2';
      v.steps[1].expect.text['confirm-customer'] = '鈴木 一郎';
      v.steps[0].click = 'new';
    });
    expect(out.text).toBe(SCENARIO.replace('confirm-quantity: "1"', 'confirm-quantity: "2"').replace('confirm-customer: 山田 太郎', 'confirm-customer: 鈴木 一郎'));
    expect(out.changes.map((c) => c.kind)).toEqual(['value', 'value']);
  });

  it('[DD-TDEDIT-PATCH-P002] [DD-TDEDIT-PATCH-T004] rewrites the whole flow node on one line when a value inside it changes', () => {
    const out = patch(SCENARIO, (v) => {
      v.steps[1].input.quantity = 3;
    });
    expect(out.text).toBe(SCENARIO.replace('input: { customer: 山田 太郎, quantity: 1 }', 'input: { customer: 山田 太郎, quantity: 3 }'));
    expect(out.changes).toEqual([{ kind: 'value', path: ['steps', 1, 'input', 'quantity'] }]);
  });

  it('[DD-TDEDIT-PATCH-P003] [DD-TDEDIT-PATCH-T005] [DD-TDEDIT-PATCH-T006] rewrites the flow node when a key is added to a flow parent', () => {
    const out = patch(SCENARIO, (v) => {
      v.steps[1].input.sku = 'A-100';
    });
    expect(out.text).toBe(SCENARIO.replace('quantity: 1 }', 'quantity: 1, sku: A-100 }'));
    expect(out.changes).toEqual([{ kind: 'addKey', path: ['steps', 1, 'input', 'sku'] }]);
  });

  it('[DD-TDEDIT-PATCH-P004] [DD-TDEDIT-PATCH-T007] inserts a line at the sibling indent after the last key of a block parent', () => {
    const out = patch(SCENARIO, (v) => {
      v.steps[1].expect.text['confirm-sku'] = 'A-100';
    });
    expect(out.text).toBe(SCENARIO.replace('confirm-customer: 山田 太郎\n', 'confirm-customer: 山田 太郎\n        confirm-sku: A-100\n'));
  });

  it('[DD-TDEDIT-PATCH-P004] a new input goes before expect (event・input・click・expect order)', () => {
    const out = patch(SCENARIO, (v) => {
      v.steps[0].input = { customer: '山田' };
    });
    expect(out.text).toBe(SCENARIO.replace('  - event: 新規\n', '  - event: 新規\n    input: { customer: 山田 }\n'));
  });

  it('[DD-TDEDIT-PATCH-P005] [DD-TDEDIT-PATCH-T008] [DD-TDEDIT-PATCH-T009] rewrites the flow node when a key is removed from a flow parent', () => {
    const out = patch(SCENARIO, (v) => {
      delete v.steps[1].input.quantity;
    });
    expect(out.text).toBe(SCENARIO.replace('{ customer: 山田 太郎, quantity: 1 }', '{ customer: 山田 太郎 }'));
    expect(out.changes).toEqual([{ kind: 'removeKey', path: ['steps', 1, 'input', 'quantity'] }]);
  });

  it('[DD-TDEDIT-PATCH-P006] [DD-TDEDIT-PATCH-T010] deletes the lines of a key in a block parent and keeps the comment lines', () => {
    const out = patch(SCENARIO, (v) => {
      delete v.steps[1].expect.text['confirm-customer'];
    });
    expect(out.text).toBe(SCENARIO.replace('        confirm-customer: 山田 太郎\n', ''));
    expect(out.text).toContain('# 顧客名');
  });

  it('[DD-TDEDIT-PATCH-P007] [DD-TDEDIT-PATCH-T011] inserts a row in the format of the last element (flow map / block map)', () => {
    const out = patch(FIXTURE, (v) => {
      v.orders.push({ id: 3, customer: '田中', sku: 'C-300' });
      v.stock.push({ sku: 'C-300', qty: 5 });
    });
    expect(out.text).toBe(
      FIXTURE.replace('sku: B-200 }\n', 'sku: B-200 }\n  - { id: 3, customer: 田中, sku: C-300 }\n').replace('    qty: 0\n', '    qty: 0\n  - sku: C-300\n    qty: 5\n'),
    );
  });

  it('[DD-TDEDIT-PATCH-P008] [DD-TDEDIT-PATCH-T012] deletes the lines of a removed row', () => {
    const out = patch(FIXTURE, (v) => {
      v.orders.splice(0, 1);
      v.stock.splice(0, 1);
    });
    expect(out.text).toBe(FIXTURE.replace('  - { id: 1, customer: 山田 太郎, sku: A-100 }\n', '').replace('  - sku: A-100\n    qty: 3\n', ''));
    expect(out.changes.map((c) => c.kind)).toEqual(['removeItem', 'removeItem']);
  });

  it('matches fixture rows by key, and a changed key at the same position is a value change', () => {
    const out = patch(FIXTURE, (v) => {
      v.orders[0].id = 10;
    });
    expect(out.text).toBe(FIXTURE.replace('{ id: 1,', '{ id: 10,'));
    expect(out.changes).toEqual([{ kind: 'value', path: ['orders', 0, 'id'] }]);
  });

  it('keeps CRLF, the BOM and a missing trailing newline', () => {
    const text = '\uFEFF' + FIXTURE.trimEnd().replace(/\n/g, '\r\n');
    const out = patch(text.slice(1), (v) => v);
    expect(out.text).toBe(text.slice(1));
    const before = parse(text.slice(1));
    const after = structuredClone(before);
    after.stock.push({ sku: 'C', qty: 1 });
    after.orders[1].sku = 'X';
    const res = patcher.apply(text, before, after);
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    expect(res.text.endsWith('    qty: 0\r\n  - sku: C\r\n    qty: 1')).toBe(true);
    expect(res.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(parse(res.text.slice(1))).toEqual(after);
  });

  it('writes plain strings only when they read back the same; numbers and booleans unquoted', () => {
    const out = patch('a: x\nb: y\nc: z\nd: w\n', (v) => {
      v.a = '123';
      v.b = 'true';
      v.c = 'p: q';
      v.d = 5;
    });
    expect(out.text).toBe('a: "123"\nb: "true"\nc: "p: q"\nd: 5\n');
  });

  it('keeps single quotes', () => {
    expect(patch("a: 'x'\n", (v) => (v.a = "it's")).text).toBe("a: 'it''s'\n");
  });

  it('throws "YAML を安全に書き換えられませんでした" when the result does not read back as after', () => {
    const p = new YamlPatcher();
    const text = 'a: &x 1\nb: *x\n';
    // the alias follows the anchored value, so b would change too
    expect(() => p.apply(text, { a: 1, b: 1 }, { a: 2, b: 1 })).toThrow(YamlPatchError);
    expect(() => p.apply(text, { a: 1, b: 1 }, { a: 2, b: 1 })).toThrow(PATCH_FAILED);
  });
});

describe('lineHunks', () => {
  it('separates distant changes and keeps 0 context lines', () => {
    const a = 'a\nb\nc\nd\ne\n';
    const b = 'a\nB\nc\nd\nE\nf\n';
    expect(lineHunks(a, b)).toEqual([
      { startLine: 2, endLine: 2, before: ['b'], after: ['B'] },
      { startLine: 5, endLine: 5, before: ['e'], after: ['E', 'f'] },
    ]);
  });

  it('an insertion has endLine = startLine - 1', () => {
    expect(lineHunks('a\nb\n', 'a\nx\nb\n')).toEqual([{ startLine: 2, endLine: 1, before: [], after: ['x'] }]);
  });
});
