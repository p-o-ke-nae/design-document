// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { PickedElement } from '@ddv/mock/tune-patch';
import { HostBridge, TUNING_MESSAGE, type BridgeEngine, type OutMessage } from './bridge.ts';
import { DDV_UI_ATTR, TUNE_HOVER_ATTR, ensureHighlightStyle } from './driver.ts';
import { Tuner } from './tuner.ts';

const BODY = `
  <h1 data-testid="title">  Hello  </h1>
  <form data-testid="f">
    <label>名前 <input data-testid="name" type="text" maxlength="10" class="w"></label>
    <select data-testid="kind"><option value="a">A</option><option>B</option></select>
    <button data-testid="save" type="submit">保存</button>
  </form>
  <ul data-testid="list"><template><li>t</li></template><li data-item><span>x</span></li><li data-item>y</li></ul>
  <p data-testid="tail">end</p>
`;

let picked: PickedElement[];
let tuner: Tuner;

beforeEach(() => {
  document.head.innerHTML = '<title>T</title>';
  document.body.innerHTML = BODY;
  picked = [];
  tuner = new Tuner(document, (p) => picked.push(p));
});

const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;

describe('Tuner.pick', () => {
  it('[DD-TUNE-PICK-P003][DD-TUNE-PICK-T001][DD-TUNE-PICK-T003][DD-TUNE-PICK-T005] path・tag・testid・text・attrs を返す', () => {
    expect(tuner.pick($('title'))).toEqual({ path: [1, 0], tag: 'h1', testid: 'title', text: 'Hello', textCount: 1, attrs: {}, generated: false });
    const name = tuner.pick($('name'));
    expect(name).toMatchObject({ path: [1, 1, 0, 0], tag: 'input', testid: 'name', textCount: 0, attrs: { type: 'text', maxlength: '10' }, generated: false });
    expect(name.text).toBeUndefined();
    expect(tuner.pick($('kind')).options).toEqual([
      { value: 'a', label: 'A' },
      { value: 'B', label: 'B' },
    ]);
  });

  it('[DD-TUNE-PICK-T005] data-item・template の中身・ddv の要素はパスに数えない', () => {
    ensureHighlightStyle(document);
    document.head.prepend(Object.assign(document.createElement('div'), {}));
    document.head.firstElementChild!.setAttribute(DDV_UI_ATTR, '');
    expect(tuner.pick($('tail')).path).toEqual([1, 3]);
    expect(tuner.pick(document.querySelector('title')!).path).toEqual([0, 0]);
    expect(tuner.elementAt([1, 3])).toBe($('tail'));
    expect(tuner.elementAt([1, 9])).toBeNull();
  });

  it('[DD-TUNE-PICK-P001][DD-TUNE-PICK-T002] 要素か祖先に data-item があれば generated: true', () => {
    const span = document.querySelector('[data-item] span')!;
    expect(tuner.pick(span)).toMatchObject({ tag: 'span', generated: true, path: [1, 2] });
    expect(tuner.pick(document.querySelectorAll('[data-item]')[1]).generated).toBe(true);
  });

  it('[DD-TUNE-PICK-P002][DD-TUNE-PICK-T004][DD-TUNE-PICK-T006] ddv の枠・runtime が作った要素なら親を選び直す', () => {
    const frame = document.createElement('div');
    frame.setAttribute(DDV_UI_ATTR, '');
    $('save').append(frame);
    expect(tuner.pick(frame)).toMatchObject({ tag: 'button', testid: 'save', text: '保存', path: [1, 1, 2] });
  });
});

describe('Tuner start / apply / stop', () => {
  it('調整中はクリックを止めて選択に使い、ポインタの下を枠で示す', () => {
    let submitted = 0;
    $('f').addEventListener('submit', (e) => {
      e.preventDefault();
      submitted++;
    });
    let clicked = 0;
    $('save').addEventListener('click', () => clicked++);
    tuner.start();
    ($('save') as HTMLElement).click();
    expect(clicked).toBe(0);
    expect(submitted).toBe(0);
    expect(picked.map((p) => p.testid)).toEqual(['save']);
    $('title').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect($('title').hasAttribute(TUNE_HOVER_ATTR)).toBe(true);
    $('name').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect($('title').hasAttribute(TUNE_HOVER_ATTR)).toBe(false);
    expect(document.getElementById('ddv-highlight-style')?.textContent).toContain(TUNE_HOVER_ATTR);
    tuner.stop();
    expect($('name').hasAttribute(TUNE_HOVER_ATTR)).toBe(false);
    ($('save') as HTMLElement).click();
    expect(clicked).toBe(1);
  });

  it('文言・属性・選択肢を DOM に反映し、置き換え・取消・終了で元に戻す', () => {
    tuner.start();
    const path = tuner.pick($('title')).path;
    expect(tuner.apply(path, { text: 'Hi', set: { title: 't' }, remove: [] })).toEqual([]);
    expect($('title').textContent).toBe('  Hi  ');
    expect($('title').getAttribute('title')).toBe('t');
    // Each send replaces the previous patch.
    tuner.apply(path, { set: { 'aria-label': 'a' }, remove: [] });
    expect($('title').textContent).toBe('  Hello  ');
    expect($('title').hasAttribute('title')).toBe(false);
    expect($('title').getAttribute('aria-label')).toBe('a');
    tuner.apply(path, null);
    expect($('title').hasAttribute('aria-label')).toBe(false);

    const name = tuner.pick($('name')).path;
    tuner.apply(name, { set: { maxlength: '20', required: '' }, remove: ['type'] });
    expect($('name').outerHTML).toBe('<input data-testid="name" maxlength="20" class="w" required="">');
    const kind = tuner.pick($('kind')).path;
    tuner.apply(kind, { set: {}, remove: [], options: [{ value: 'c', label: 'C' }] });
    expect($('kind').innerHTML).toBe('<option value="c">C</option>');
    expect(tuner.changed).toEqual([name.join('.'), kind.join('.')]);
    tuner.stop();
    expect($('name').outerHTML).toBe('<input data-testid="name" type="text" maxlength="10" class="w">');
    expect($('kind').innerHTML).toBe('<option value="a">A</option><option>B</option>');
    expect(tuner.changed).toEqual([]);
  });

  it('不正な patch は反映せず検査の結果を返す', () => {
    const path = tuner.pick($('name')).path;
    expect(tuner.apply(path, { set: { class: 'x' }, remove: [] }).map((i) => i.message)).toEqual(['この属性は変更できません: class']);
    expect(tuner.apply(path, { set: { minlength: '11' }, remove: [] }).map((i) => i.message)).toEqual(['範囲を確認してください']);
    expect(tuner.apply([1, 1], { text: 'x', set: {}, remove: [] }).map((i) => i.field)).toEqual(['text']);
    expect(tuner.apply([9], { set: {}, remove: [] }).map((i) => i.field)).toEqual(['path']);
    expect(tuner.changed).toEqual([]);
  });
});

describe('HostBridge と調整モード', () => {
  function setup() {
    const posted: OutMessage[] = [];
    const parent = { postMessage: (m: OutMessage) => posted.push(m) };
    const win = { parent, location: { origin: 'http://localhost' }, addEventListener: () => {} } as unknown as Window;
    const calls: unknown[] = [];
    let tuning = false;
    const engine: BridgeEngine = {
      version: '9.9.9',
      boot: async () => ({ screen: 'S' }),
      exec: async () => ({ ok: true, screen: 'S', failures: [] }),
      cancel: () => {},
      screen: () => 'S',
      get tuning() {
        return tuning;
      },
      tune: (on) => {
        tuning = on;
        calls.push(['tune', on]);
      },
      patch: (path, patch) => {
        calls.push(['patch', path, patch]);
        return patch && 'set' in patch && 'class' in patch.set ? [{ field: 'class', message: 'この属性は変更できません: class' }] : [];
      },
    };
    const bridge = new HostBridge(win, engine);
    const send = (data: unknown) => bridge.onMessage({ origin: 'http://localhost', source: parent, data } as unknown as MessageEvent);
    return { bridge, posted, calls, send };
  }

  it('ddv:tune・ddv:patch を受け、調整中の ddv:step は ok: false（調整中）を返す', async () => {
    const t = setup();
    await t.bridge.start();
    t.send({ type: 'ddv:tune', on: true });
    t.send({ type: 'ddv:step', index: 3, step: { event: 'x', expect: { screen: 'S' } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.posted.at(-1)).toEqual({ type: 'ddv:result', index: 3, ok: false, screen: 'S', failures: [], message: TUNING_MESSAGE });
    t.send({ type: 'ddv:patch', path: [1, 0], patch: { set: { title: 't' }, remove: [] } });
    t.send({ type: 'ddv:patch', path: [1, 0], patch: null });
    t.send({ type: 'ddv:patch', path: [1, -1], patch: null });
    t.send({ type: 'ddv:patch', path: [1, 0], patch: { set: { class: 'x' }, remove: [] } });
    expect(t.posted.at(-1)).toEqual({ type: 'ddv:error', message: 'この属性は変更できません: class' });
    t.send({ type: 'ddv:tune', on: false });
    t.send({ type: 'ddv:tune', on: 'yes' });
    expect(t.calls).toEqual([
      ['tune', true],
      ['patch', [1, 0], { set: { title: 't' }, remove: [] }],
      ['patch', [1, 0], null],
      ['patch', [1, 0], { set: { class: 'x' }, remove: [] }],
      ['tune', false],
    ]);
    await expect(t.bridge.step({ event: 'x', expect: { screen: 'S' } })).resolves.toMatchObject({ ok: true });
  });
});
