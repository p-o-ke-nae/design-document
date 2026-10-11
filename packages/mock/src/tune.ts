// Server side of the mock tune mode (DD-TUNE): maps an element path of the live mock to the source HTML
// (SourceLocator) and turns an ElementPatch into replacement lines for a GitHub suggestion (SuggestionBuilder).
import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser';
import type { ElementPatch, OptionPatch } from './tune-patch.ts';

export interface OffsetRange {
  start: number;
  end: number;
}

export interface SourceAttr {
  name: string;
  /** Whole attribute (`name="value"`). */
  start: number;
  end: number;
  /** Value without quotes; absent for value-less attributes. */
  value?: OffsetRange;
  quote: '"' | "'" | '';
}

export interface SourceElement {
  path: number[];
  tag: string;
  /** Element (start tag … end tag), 1-based lines. */
  startLine: number;
  endLine: number;
  startTag: OffsetRange & { nameEnd: number; attrs: SourceAttr[]; selfClosing: boolean };
  /** The single non-blank direct text (trimmed range); absent unless textCount = 1. */
  text?: OffsetRange;
  textCount: number;
  /** `option` children of a select. */
  options?: OffsetRange[];
  /** Source lines of the element (start tag only when the element is long). */
  source: string[];
  sourceStartLine: number;
}

export interface Suggestion {
  startLine: number;
  line: number;
  lines: string[];
  changed: boolean;
}

export type LocateReason = 'not-found' | 'generated';

export class TuneError extends Error {
  constructor(
    readonly code: 'no-source' | 'text-not-editable' | 'options-unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'TuneError';
  }
}

export const NO_SOURCE_MESSAGE: Record<LocateReason, string> = {
  'not-found': '対応する行なし：要素が見つかりません（モックを再読込してください）',
  generated: '対応する行なし：mock.js などで作られた要素です',
};

const SOURCE_MAX_LINES = 30;

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** 1-based line of an offset. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const lineText = (text: string, starts: number[], line: number) => {
  const end = line < starts.length ? starts[line] - 1 : text.length;
  return text.slice(starts[line - 1], end).replace(/\r$/, '');
};

/** A node of the tree the browser would build: real elements plus the implied `tbody` around bare table rows. */
interface DomLike {
  el: HTMLElement | null;
  tag: string;
  children: () => DomLike[];
}

const isElement = (n: Node): n is HTMLElement => n.nodeType === NodeType.ELEMENT_NODE;

function domChildren(el: HTMLElement): DomLike[] {
  const tag = el.rawTagName?.toLowerCase() ?? '';
  // Template contents are not children in the DOM (runtime rule: not counted).
  if (tag === 'template') return [];
  const kids = el.childNodes.filter(isElement);
  // The browser always creates <head> (an omitted one is implied before <body>).
  if (tag === 'html' && kids[0]?.rawTagName.toLowerCase() !== 'head') return [{ el: null, tag: 'head', children: () => [] }, ...kids.map(wrap)];
  if (tag !== 'table') return kids.map(wrap);
  // `<table><tr>` → the browser inserts `<tbody>` around consecutive rows.
  const out: DomLike[] = [];
  let rows: HTMLElement[] | null = null;
  for (const k of kids) {
    if (k.rawTagName.toLowerCase() === 'tr') {
      if (!rows) {
        const group: HTMLElement[] = (rows = []);
        out.push({ el: null, tag: 'tbody', children: () => group.map(wrap) });
      }
      rows.push(k);
    } else {
      rows = null;
      out.push(wrap(k));
    }
  }
  return out;
}

const wrap = (el: HTMLElement): DomLike => ({ el, tag: el.rawTagName.toLowerCase(), children: () => domChildren(el) });

/** Lexes the start tag from `<` up to its `>` (quoted values may contain `>` and newlines). */
export function lexStartTag(text: string, start: number): SourceElement['startTag'] {
  let i = start + 1;
  while (i < text.length && !/[\s/>]/.test(text[i])) i++;
  const nameEnd = i;
  const attrs: SourceAttr[] = [];
  let selfClosing = false;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '>') {
      i++;
      break;
    }
    if (text[i] === '/') {
      i++;
      if (text[i] === '>') {
        selfClosing = true;
        i++;
        break;
      }
      continue;
    }
    const aStart = i;
    while (i < text.length && !/[\s"'>/=]/.test(text[i])) i++;
    if (i === aStart) i++; // stray quote etc.
    const name = text.slice(aStart, i).toLowerCase();
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '=') {
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, j + 1);
        const vEnd = close < 0 ? text.length : close;
        attrs.push({ name, start: aStart, end: Math.min(vEnd + 1, text.length), value: { start: j + 1, end: vEnd }, quote: q });
        i = Math.min(vEnd + 1, text.length);
      } else {
        let k = j;
        while (k < text.length && !/[\s>]/.test(text[k])) k++;
        attrs.push({ name, start: aStart, end: k, value: { start: j, end: k }, quote: '' });
        i = k;
      }
    } else {
      attrs.push({ name, start: aStart, end: i, quote: '' });
    }
  }
  return { start, end: i, nameEnd, attrs, selfClosing };
}

/**
 * SourceLocator.locate (DD-TUNE LOCATE): follows `path` (element-child indexes from <html>, template contents not
 * counted) through the parsed source and checks the tag / testid against what the mock showed.
 */
export function locate(html: string, path: number[], expect: { tag: string; testid?: string }): SourceElement | { reason: LocateReason } {
  const root = parse(html, { comment: false, lowerCaseTagName: false });
  const top = root.childNodes.filter(isElement).find((e) => e.rawTagName.toLowerCase() === 'html');
  if (!top) return { reason: 'not-found' };
  let node: DomLike = wrap(top);
  for (const i of path) {
    const kids = node.children();
    if (!Number.isInteger(i) || i < 0 || i >= kids.length) return { reason: 'not-found' };
    node = kids[i];
  }
  if (!node.el || node.tag !== expect.tag.toLowerCase()) return { reason: 'generated' };
  const el = node.el;
  if (expect.testid !== undefined && expect.testid !== '' && el.getAttribute('data-testid') !== expect.testid) return { reason: 'generated' };

  const starts = lineStarts(html);
  const [s, e] = el.range;
  const startTag = lexStartTag(html, s);
  const texts = el.childNodes.filter((n) => n.nodeType === NodeType.TEXT_NODE && n.rawText.trim() !== '');
  let text: OffsetRange | undefined;
  if (texts.length === 1) {
    const [ts, te] = texts[0].range;
    const raw = html.slice(ts, te);
    text = { start: ts + (raw.length - raw.trimStart().length), end: te - (raw.length - raw.trimEnd().length) };
  }
  const options = node.tag === 'select' ? el.childNodes.filter(isElement).filter((c) => c.rawTagName.toLowerCase() === 'option').map((c) => ({ start: c.range[0], end: c.range[1] })) : undefined;
  const startLine = lineAt(starts, s);
  const endLine = lineAt(starts, Math.max(s, e - 1));
  const tagEndLine = lineAt(starts, Math.max(s, startTag.end - 1));
  const last = endLine - startLine + 1 <= SOURCE_MAX_LINES ? endLine : tagEndLine;
  const source: string[] = [];
  for (let l = startLine; l <= last; l++) source.push(lineText(html, starts, l));
  return { path, tag: node.tag, startLine, endLine, startTag, ...(text ? { text } : {}), textCount: texts.length, ...(options ? { options } : {}), source, sourceStartLine: startLine };
}

export const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Edit extends OffsetRange {
  text: string;
}

const indentOf = (html: string, offset: number) => {
  const ls = html.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(html.slice(ls, offset))![0];
};

function attrEdits(html: string, el: SourceElement, patch: ElementPatch): Edit[] {
  const tag = el.startTag;
  const edits: Edit[] = [];
  const byName = new Map(tag.attrs.map((a) => [a.name, a]));
  const added: string[] = [];
  for (const [name, value] of Object.entries(patch.set)) {
    const a = byName.get(name);
    if (!a) {
      added.push(value === '' && name === 'required' ? name : `${name}="${escapeAttr(value)}"`);
      continue;
    }
    if (name === 'required') continue;
    if (a.value) {
      const esc = a.quote === "'" ? escapeAttr(value).replace(/'/g, '&#39;') : escapeAttr(value);
      if (html.slice(a.value.start, a.value.end) === (a.quote ? esc : value)) continue;
      edits.push(a.quote ? { start: a.value.start, end: a.value.end, text: esc } : { start: a.value.start, end: a.value.end, text: `"${escapeAttr(value)}"` });
    } else {
      edits.push({ start: a.end, end: a.end, text: `="${escapeAttr(value)}"` });
    }
  }
  for (const name of patch.remove) {
    const a = byName.get(name);
    if (!a) continue;
    // The attribute and the whitespace before it (the whole line when attributes are one per line).
    let ws = a.start;
    while (ws > tag.nameEnd && /\s/.test(html[ws - 1])) ws--;
    edits.push({ start: ws, end: a.end, text: '' });
  }
  if (added.length) {
    const lastAttr = tag.attrs.at(-1);
    const at = lastAttr ? lastAttr.end : tag.nameEnd;
    const multiline = tag.attrs.some((a, i) => html.slice(i === 0 ? tag.nameEnd : tag.attrs[i - 1].end, a.start).includes('\n'));
    const sep = multiline && lastAttr ? `\n${indentOf(html, lastAttr.start)}` : ' ';
    edits.push({ start: at, end: at, text: added.map((a) => sep + a).join('') });
  }
  return edits;
}

function optionEdits(html: string, el: SourceElement, options: OptionPatch[]): Edit[] {
  if (el.tag !== 'select') throw new TuneError('options-unsupported', '選択肢は select だけで変更できます');
  const current = el.options ?? [];
  const firstTag = current[0] ? lexStartTag(html, current[0].start) : null;
  const keepValue = (o: OptionPatch) => (firstTag && !firstTag.attrs.some((a) => a.name === 'value') && o.value === o.label ? '' : ` value="${escapeAttr(o.value)}"`);
  const render = (o: OptionPatch) => `<option${keepValue(o)}>${escapeText(o.label)}</option>`;
  if (current.length) {
    const s = current[0].start;
    const e = current[current.length - 1].end;
    const multiline = current.length > 1 ? html.slice(current[0].end, current[1].start).includes('\n') : html.slice(el.startTag.end, s).includes('\n');
    const sep = multiline ? `\n${indentOf(html, s)}` : '';
    return [{ start: s, end: e, text: options.map(render).join(sep) }];
  }
  const at = el.startTag.end;
  if (!options.length) return [];
  const base = indentOf(html, el.startTag.start);
  return [{ start: at, end: at, text: options.map((o) => `\n${base}  ${render(o)}`).join('') + `\n${base}` }];
}

/**
 * SuggestionBuilder.build (DD-TUNE BUILD): applies the patch to the element's source and returns the smallest line
 * range containing every change, as replacement lines.
 */
export function build(html: string, el: SourceElement, patch: ElementPatch): Suggestion {
  const edits: Edit[] = [];
  if (patch.text !== undefined) {
    if (el.textCount !== 1 || !el.text) throw new TuneError('text-not-editable', '文言を変えられない要素です（直下のテキストが 1 つではありません）');
    const esc = escapeText(patch.text);
    if (html.slice(el.text.start, el.text.end) !== esc) edits.push({ start: el.text.start, end: el.text.end, text: esc });
  }
  if (Object.keys(patch.set).length || patch.remove.length) edits.push(...attrEdits(html, el, patch));
  if (patch.options) {
    const e = optionEdits(html, el, patch.options);
    const cur = el.options?.length ? html.slice(el.options[0].start, el.options[el.options.length - 1].end) : '';
    if (!(e.length === 1 && e[0].text === cur)) edits.push(...e);
  }

  const starts = lineStarts(html);
  if (!edits.length) {
    const startLine = lineAt(starts, el.startTag.start);
    const line = lineAt(starts, Math.max(el.startTag.start, el.startTag.end - 1));
    const lines: string[] = [];
    for (let l = startLine; l <= line; l++) lines.push(lineText(html, starts, l));
    return { startLine, line, lines, changed: false };
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const lo = Math.min(...edits.map((e) => e.start));
  const hi = Math.max(...edits.map((e) => e.end));
  const startLine = lineAt(starts, lo);
  // An insertion at the very end of a line belongs to that line (not the next one).
  const line = lineAt(starts, hi > lo ? hi - 1 : hi);
  const regionStart = starts[startLine - 1];
  const regionEnd = line < starts.length ? starts[line] - 1 : html.length;
  let region = html.slice(regionStart, regionEnd);
  for (const e of [...edits].reverse()) region = region.slice(0, e.start - regionStart) + e.text + region.slice(e.end - regionStart);
  const lines = region.split('\n').map((l) => l.replace(/\r$/, ''));
  return { startLine, line, lines, changed: true };
}
