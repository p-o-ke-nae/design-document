// Tune mode inside the mock (DD-TUNE PICK): picks the clicked element and applies ElementPatch to the live DOM,
// keeping the original state so every change can be reverted.
import { editableAttrsFor, validatePatch, type ElementPatch, type OptionPatch, type PatchIssue, type PickedElement } from '@ddv/mock/tune-patch';
import { DDV_UI_ATTR, HIGHLIGHT_ATTR, TUNE_HOVER_ATTR, ensureHighlightStyle } from './driver.ts';

const ITEM_ATTR = 'data-item';
/** Attributes the tune mode itself sets; kept out of snapshots. */
const OWN_ATTRS = new Set([TUNE_HOVER_ATTR, HIGHLIGHT_ATTR]);

interface Snapshot {
  el: Element;
  attrs: Array<[string, string]>;
  text?: { node: Text; data: string };
  children?: Node[];
}

const isCounted = (el: Element) => !el.hasAttribute(ITEM_ATTR) && !el.hasAttribute(DDV_UI_ATTR);
const countedChildren = (el: Element) => Array.from(el.children).filter(isCounted);
const directTexts = (el: Element) => Array.from(el.childNodes).filter((n): n is Text => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');

function optionsOf(el: Element): OptionPatch[] {
  return Array.from(el.children)
    .filter((c) => c.tagName.toLowerCase() === 'option')
    .map((o) => {
      const label = (o.textContent ?? '').trim();
      return { value: o.getAttribute('value') ?? label, label };
    });
}

export class Tuner {
  active = false;
  private readonly patches = new Map<string, Snapshot>();
  private hovered: Element | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly doc: Document,
    private readonly onPick: (picked: PickedElement) => void,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    ensureHighlightStyle(this.doc);
    this.abort = new AbortController();
    const opts = { capture: true, signal: this.abort.signal };
    const block = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    this.doc.addEventListener(
      'click',
      (e) => {
        block(e);
        const t = e.target;
        if (t && (t as Node).nodeType === 1) this.onPick(this.pick(t as Element));
      },
      opts,
    );
    for (const type of ['mousedown', 'mouseup', 'dblclick', 'submit', 'pointerdown', 'pointerup']) this.doc.addEventListener(type, block, opts);
    this.doc.addEventListener('mouseover', (e) => this.hover(e.target as Element | null), opts);
    this.doc.addEventListener('mouseout', (e) => {
      if (!(e as MouseEvent).relatedTarget) this.hover(null);
    }, opts);
  }

  /** Ends the mode and reverts every change. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.abort?.abort();
    this.abort = null;
    this.hover(null);
    for (const key of [...this.patches.keys()]) this.revertKey(key);
  }

  private hover(el: Element | null) {
    const target = el && el.nodeType === 1 ? this.selectable(el) : null;
    if (target === this.hovered) return;
    this.hovered?.removeAttribute(TUNE_HOVER_ATTR);
    this.hovered = target;
    target?.setAttribute(TUNE_HOVER_ATTR, '');
  }

  /** ddv UI / runtime elements are not picked: their parent is (PICK: 親の要素を選び直す). */
  private selectable(el: Element): Element {
    let cur: Element = el;
    while (cur.hasAttribute(DDV_UI_ATTR) && cur.parentElement) cur = cur.parentElement;
    return cur;
  }

  /** Element-child indexes from the root, counting only source elements. */
  pathOf(el: Element): number[] {
    const path: number[] = [];
    let cur: Element = el;
    while (cur !== this.doc.documentElement) {
      const parent = cur.parentElement;
      if (!parent) break;
      path.unshift(countedChildren(parent).indexOf(cur));
      cur = parent;
    }
    return path;
  }

  elementAt(path: number[]): Element | null {
    let cur: Element | undefined = this.doc.documentElement;
    for (const i of path) {
      cur = countedChildren(cur).at(i);
      if (!cur || i < 0) return null;
    }
    return cur;
  }

  pick(target: Element): PickedElement {
    const item = target.closest(`[${ITEM_ATTR}]`);
    const el = item ? target : this.selectable(target);
    const tag = el.tagName.toLowerCase();
    const texts = directTexts(el);
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    const attrs: Record<string, string> = {};
    for (const name of editableAttrsFor(tag)) {
      const v = el.getAttribute(name);
      if (v !== null) attrs[name] = v;
    }
    const testid = el.getAttribute('data-testid');
    return {
      // A generated element has no source; its path points at the bound list it was rendered into.
      path: this.pathOf(item ? (item.parentElement ?? item) : el),
      tag,
      ...(testid !== null ? { testid } : {}),
      ...(texts.length ? { text } : {}),
      textCount: texts.length,
      attrs,
      ...(tag === 'select' ? { options: optionsOf(el) } : {}),
      generated: item !== null,
    };
  }

  /** Replaces the element's changes with `patch` (null = revert). Returns the validation issues (nothing applied when any). */
  apply(path: number[], patch: ElementPatch | null): PatchIssue[] {
    const key = path.join('.');
    if (patch === null) {
      this.revertKey(key);
      return [];
    }
    this.revertKey(key);
    const el = this.elementAt(path);
    if (!el) return [{ field: 'path', message: '要素が見つかりません（モックを再読込してください）' }];
    const tag = el.tagName.toLowerCase();
    const current: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) current[a.name] = a.value;
    const { patch: p, issues } = validatePatch(patch, tag, current);
    if (issues.length) return issues;
    const texts = directTexts(el);
    if (p.text !== undefined && texts.length !== 1) return [{ field: 'text', message: '文言を変えられない要素です（直下のテキストが 1 つではありません）' }];

    const snap: Snapshot = { el, attrs: Array.from(el.attributes).filter((a) => !OWN_ATTRS.has(a.name)).map((a) => [a.name, a.value]) };
    if (p.text !== undefined) {
      const node = texts[0];
      const data = node.data;
      snap.text = { node, data };
      const lead = /^\s*/.exec(data)![0];
      const trail = /\s*$/.exec(data)![0];
      node.data = lead + p.text + trail;
    }
    for (const [name, v] of Object.entries(p.set)) el.setAttribute(name, v);
    for (const name of p.remove) el.removeAttribute(name);
    if (p.options) {
      snap.children = Array.from(el.childNodes);
      el.replaceChildren(
        ...p.options.map((o) => {
          const opt = this.doc.createElement('option');
          opt.setAttribute('value', o.value);
          opt.textContent = o.label;
          return opt;
        }),
      );
    }
    this.patches.set(key, snap);
    return [];
  }

  revert(path: number[]): void {
    this.revertKey(path.join('.'));
  }

  private revertKey(key: string) {
    const snap = this.patches.get(key);
    if (!snap) return;
    this.patches.delete(key);
    const { el } = snap;
    for (const a of Array.from(el.attributes)) if (!OWN_ATTRS.has(a.name)) el.removeAttribute(a.name);
    for (const [name, v] of snap.attrs) el.setAttribute(name, v);
    if (snap.text) snap.text.node.data = snap.text.data;
    if (snap.children) el.replaceChildren(...snap.children);
  }

  /** Paths currently changed (for tests / diagnostics). */
  get changed(): string[] {
    return [...this.patches.keys()];
  }
}
