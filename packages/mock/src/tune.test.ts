import { describe, expect, it } from 'vitest';
import { build, locate, TuneError, type SourceElement } from './tune.ts';
import { validatePatch, defaultTuneBody, isNoopPatch } from './tune-patch.ts';

const HTML = [
  '<!doctype html>',
  '<html lang="ja">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <template id="t"><p>x</p></template>',
  '  <title>T</title>',
  '</head>',
  '<body>',
  '  <h1 data-testid="title">  Hello  </h1>',
  "  <input data-testid=\"name\" type=\"text\" maxlength=10 placeholder='名前'>",
  '  <input',
  '    data-testid="mail"',
  '    type="email"',
  '    required',
  '  >',
  '  <select data-testid="kind">',
  '    <option value="a">A</option>',
  '    <option value="b">B</option>',
  '  </select>',
  '  <p data-testid="mixed">a<b>b</b>c</p>',
  '  <table><tr><td data-testid="cell">1</td></tr></table>',
  '  <ul data-bind="items"><template><li data-item>x</li></template></ul>',
  '</body>',
  '</html>',
  '',
].join('\n');

function at(path: number[], tag: string, testid?: string, html = HTML): SourceElement {
  const r = locate(html, path, { tag, testid });
  if ('reason' in r) throw new Error(`not located: ${r.reason}`);
  return r;
}

describe('SourceLocator.locate', () => {
  it('[DD-TUNE-LOCATE-P001][DD-TUNE-LOCATE-T001][DD-TUNE-LOCATE-T002][DD-TUNE-LOCATE-T003] path をたどれなければ対応なし: 要素が見つからない', () => {
    expect(locate(HTML, [1, 99], { tag: 'p' })).toEqual({ reason: 'not-found' });
    expect(locate(HTML, [5], { tag: 'p' })).toEqual({ reason: 'not-found' });
    expect(locate('<p>no html</p>', [1], { tag: 'p' })).toEqual({ reason: 'not-found' });
  });

  it('[DD-TUNE-LOCATE-P002][DD-TUNE-LOCATE-T004][DD-TUNE-LOCATE-T005] tag が違えば mock.js 等で作られた要素', () => {
    expect(locate(HTML, [1, 0], { tag: 'p' })).toEqual({ reason: 'generated' });
  });

  it('[DD-TUNE-LOCATE-P003][DD-TUNE-LOCATE-T006][DD-TUNE-LOCATE-T007] expect.testid が違えば mock.js 等で作られた要素', () => {
    expect(locate(HTML, [1, 0], { tag: 'h1', testid: 'other' })).toEqual({ reason: 'generated' });
  });

  it('[DD-TUNE-LOCATE-P004][DD-TUNE-LOCATE-T008] 開始タグ・直下テキストの位置と行範囲を求める', () => {
    const el = at([1, 0], 'H1', 'title');
    expect(el).toMatchObject({ tag: 'h1', startLine: 9, endLine: 9, textCount: 1, source: ['  <h1 data-testid="title">  Hello  </h1>'] });
    expect(HTML.slice(el.text!.start, el.text!.end)).toBe('Hello');
    expect(el.startTag.attrs.map((a) => a.name)).toEqual(['data-testid']);
  });

  it('[DD-TUNE-LOCATE-T008] 複数行の開始タグ・値なし属性・引用符なしの値', () => {
    const mail = at([1, 2], 'input', 'mail');
    expect(mail).toMatchObject({ startLine: 11, endLine: 15, textCount: 0 });
    expect(mail.text).toBeUndefined();
    expect(mail.startTag.attrs.map((a) => [a.name, a.value ? HTML.slice(a.value.start, a.value.end) : null])).toEqual([
      ['data-testid', 'mail'],
      ['type', 'email'],
      ['required', null],
    ]);
    const name = at([1, 1], 'input', 'name');
    expect(name.startTag.attrs.map((a) => [a.name, a.quote])).toEqual([
      ['data-testid', '"'],
      ['type', '"'],
      ['maxlength', ''],
      ['placeholder', "'"],
    ]);
  });

  it('[DD-TUNE-LOCATE-T002] template の中身を数えず、table の tr には tbody を補う', () => {
    expect(at([0, 2], 'title').startLine).toBe(6);
    expect(at([1, 5, 0, 0, 0], 'td', 'cell').startLine).toBe(21);
    expect(locate(HTML, [1, 5, 0], { tag: 'tbody' })).toEqual({ reason: 'generated' });
    expect(at([1, 6, 0], 'template').startLine).toBe(22);
    expect(locate(HTML, [1, 6, 1], { tag: 'li' })).toEqual({ reason: 'not-found' });
  });

  it('[DD-TUNE-LOCATE-T008] 直下のテキストが複数なら text を返さない', () => {
    const el = at([1, 4], 'p', 'mixed');
    expect(el.textCount).toBe(2);
    expect(el.text).toBeUndefined();
  });

  it('[DD-TUNE-LOCATE-T008] select は option の範囲を返す', () => {
    const el = at([1, 3], 'select', 'kind');
    expect(el.options!.map((o) => HTML.slice(o.start, o.end))).toEqual(['<option value="a">A</option>', '<option value="b">B</option>']);
    expect(el).toMatchObject({ startLine: 16, endLine: 19 });
  });

  it('CRLF の改行でも行を求める', () => {
    const crlf = HTML.replace(/\n/g, '\r\n');
    const el = at([1, 0], 'h1', 'title', crlf);
    expect(el.startLine).toBe(9);
    expect(el.source).toEqual(['  <h1 data-testid="title">  Hello  </h1>']);
  });
});

const ODD = ['<html><body>', '  <select data-testid="odd">Pick', '    <option>A</option>', '  </select>', '</body></html>'].join('\n');

describe('SuggestionBuilder.build', () => {
  const none = { set: {}, remove: [] };

  it('[DD-TUNE-BUILD-P001][DD-TUNE-BUILD-T001][DD-TUNE-BUILD-T002][DD-TUNE-BUILD-T003] 直下のテキストが 1 つでなければエラー', () => {
    const el = at([1, 4], 'p', 'mixed');
    expect(() => build(HTML, el, { ...none, text: 'x' })).toThrow(TuneError);
    expect(() => build(HTML, at([1, 2], 'input', 'mail'), { ...none, text: 'x' })).toThrow('文言を変えられない要素');
  });

  it('[DD-TUNE-BUILD-P003][DD-TUNE-BUILD-T004][DD-TUNE-BUILD-T006][DD-TUNE-BUILD-T007][DD-TUNE-BUILD-T011] 文言だけを置換し、前後の空白を保ちエスケープする', () => {
    const s = build(HTML, at([1, 0], 'h1', 'title'), { ...none, text: 'A & <B>' });
    expect(s).toEqual({ startLine: 9, line: 9, lines: ['  <h1 data-testid="title">  A &amp; &lt;B&gt;  </h1>'], changed: true });
  });

  it('[DD-TUNE-BUILD-P005][DD-TUNE-BUILD-T008][DD-TUNE-BUILD-T009] 文言と属性をまとめて変更する', () => {
    const s = build(HTML, at([1, 0], 'h1', 'title'), { text: 'Hi', set: { title: 'say "hi"' }, remove: [] });
    expect(s.lines).toEqual(['  <h1 data-testid="title" title="say &quot;hi&quot;">  Hi  </h1>']);
  });

  it('[DD-TUNE-BUILD-P009][DD-TUNE-BUILD-T005][DD-TUNE-BUILD-T008] 属性の置換（引用符を保つ・引用符なしは補う）・追加・削除', () => {
    const s = build(HTML, at([1, 1], 'input', 'name'), { set: { maxlength: '20', placeholder: '氏名', title: 'お名前' }, remove: ['type'] });
    expect(s).toEqual({ startLine: 10, line: 10, lines: ["  <input data-testid=\"name\" maxlength=\"20\" placeholder='氏名' title=\"お名前\">"], changed: true });
  });

  it('[DD-TUNE-BUILD-T008] 1 行に 1 属性のタグには同じ字下げで追加し、削除は行ごと消える', () => {
    const el = at([1, 2], 'input', 'mail');
    expect(build(HTML, el, { set: { maxlength: '50' }, remove: [] })).toEqual({
      startLine: 14,
      line: 14,
      lines: ['    required', '    maxlength="50"'],
      changed: true,
    });
    expect(build(HTML, el, { set: {}, remove: ['required'] })).toEqual({ startLine: 13, line: 14, lines: ['    type="email"'], changed: true });
    expect(build(HTML, el, { set: { required: '' }, remove: [] }).changed).toBe(false);
  });

  it('[DD-TUNE-BUILD-T008] 値なしの required を追加する', () => {
    const s = build(HTML, at([1, 1], 'input', 'name'), { set: { required: '' }, remove: [] });
    expect(s.lines).toEqual(["  <input data-testid=\"name\" type=\"text\" maxlength=10 placeholder='名前' required>"]);
  });

  it('[DD-TUNE-BUILD-P006][DD-TUNE-BUILD-T010][DD-TUNE-BUILD-T012] option の行を作り直す', () => {
    const s = build(HTML, at([1, 3], 'select', 'kind'), { ...none, options: [{ value: 'a', label: 'A' }, { value: 'c', label: 'C & D' }, { value: 'b', label: 'B' }] });
    expect(s).toEqual({
      startLine: 17,
      line: 18,
      lines: ['    <option value="a">A</option>', '    <option value="c">C &amp; D</option>', '    <option value="b">B</option>'],
      changed: true,
    });
  });

  it('[DD-TUNE-BUILD-P008] 属性と option をまとめて変更する', () => {
    const s = build(HTML, at([1, 3], 'select', 'kind'), { set: { title: '種類' }, remove: [], options: [{ value: 'a', label: 'A' }] });
    expect(s).toEqual({ startLine: 16, line: 18, lines: ['  <select data-testid="kind" title="種類">', '    <option value="a">A</option>'], changed: true });
  });

  it('[DD-TUNE-BUILD-P002][DD-TUNE-BUILD-P004] 文言・(属性)・option をまとめて変更し、元に value がなければ省く', () => {
    const el = at([1, 0], 'select', 'odd', ODD);
    expect(at([1], 'body', undefined, ODD).startLine).toBe(1);
    const opts = [{ value: 'A', label: 'A' }, { value: 'x', label: 'B' }];
    expect(build(ODD, el, { ...none, text: 'Choose', options: opts })).toEqual({
      startLine: 2,
      line: 3,
      lines: ['  <select data-testid="odd">Choose', '    <option>A</option>', '    <option value="x">B</option>'],
      changed: true,
    });
    expect(build(ODD, el, { text: 'Choose', set: { title: 't' }, remove: [], options: opts }).lines[0]).toBe('  <select data-testid="odd" title="t">Choose');
  });

  it('[DD-TUNE-BUILD-P007] 変更がなければ changed: false と開始タグの行', () => {
    const s = build(HTML, at([1, 2], 'input', 'mail'), { text: undefined, set: { type: 'email' }, remove: ['maxlength'], options: undefined });
    expect(s).toEqual({ startLine: 11, line: 15, lines: ['  <input', '    data-testid="mail"', '    type="email"', '    required', '  >'], changed: false });
  });

  it('CRLF のファイルでも行に \\r を含めない', () => {
    const crlf = HTML.replace(/\n/g, '\r\n');
    const s = build(crlf, at([1, 0], 'h1', 'title', crlf), { ...none, text: 'Hi' });
    expect(s).toMatchObject({ startLine: 9, line: 9, lines: ['  <h1 data-testid="title">  Hi  </h1>'] });
  });
});

describe('validatePatch', () => {
  it('編集できる属性だけを受け付ける', () => {
    const { issues } = validatePatch({ set: { class: 'x', onclick: 'a()', 'data-x': '1', id: 'i', style: 'c' }, remove: ['data-testid'] }, 'input');
    expect(issues.map((i) => i.message)).toEqual(expect.arrayContaining(['この属性は変更できません: class', 'この属性は変更できません: data-testid']));
    expect(issues).toHaveLength(6);
  });

  it('範囲・正規表現・選択肢の重複・型を検査する', () => {
    const msgs = (p: unknown, tag = 'input', cur: Record<string, string> = {}) => validatePatch(p, tag, cur).issues.map((i) => `${i.field}:${i.message}`);
    expect(msgs({ set: { minlength: '5' }, remove: [] }, 'input', { maxlength: '3' })).toEqual(['minlength:範囲を確認してください']);
    expect(msgs({ set: { pattern: '[a-' }, remove: [] })).toEqual(['pattern:正規表現を確認してください']);
    expect(msgs({ set: {}, remove: [], options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }, 'select')).toEqual(['options:選択肢の値が重複しています']);
    expect(msgs({ set: { maxlength: '-1', type: 'file', required: 'yes' }, remove: [] })).toHaveLength(3);
    expect(msgs({ set: { min: '2024-01-02', max: '2024-01-01' }, remove: [] })).toEqual([]);
    expect(msgs({ text: 'x', set: {}, remove: [] })).toEqual(['text:この要素の文言は変えられません']);
    expect(msgs('nope')).toHaveLength(1);
  });

  it('正しい patch はそのまま返し、既定の本文を作る', () => {
    const r = validatePatch({ text: '保存する', set: { title: 't' }, remove: ['aria-label'] }, 'button', { 'aria-label': 'a' });
    expect(r.issues).toEqual([]);
    const el = { tag: 'button', testid: 'save', text: '保存', attrs: { 'aria-label': 'a' } };
    expect(defaultTuneBody(el, r.patch)).toBe('モック調整：save（button） の 文言・title・aria-label');
    expect(isNoopPatch({ text: '保存', set: {}, remove: [] }, el)).toBe(true);
  });
});
