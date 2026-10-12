import { isMap, isScalar, isSeq, parse, parseDocument, type Node, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml';

/** DD-TDEDIT「YAML の書き換え」: edits the original text range by range (never `Document.toString()`). */

export type PathSeg = string | number;

export interface TextEdit {
  /** Offsets in the text without the BOM. */
  start: number;
  end: number;
  text: string;
}

export type ChangeKind = 'value' | 'addKey' | 'removeKey' | 'addItem' | 'removeItem';

export interface PatchChange {
  kind: ChangeKind;
  path: PathSeg[];
}

export interface PatchOutput {
  text: string;
  edits: TextEdit[];
  /** The differences between `before` and `after` that were written. */
  changes: PatchChange[];
}

export interface PatchOptions {
  /** Field identifying the elements of the array at `path` (fixture rows); undefined = matched by position. */
  arrayKey?: (path: PathSeg[]) => string | undefined;
  /** Canonical key order of the map at `path`: a new key is inserted at its place (e.g. `input` before `expect`). */
  keyOrder?: (path: PathSeg[]) => readonly string[] | undefined;
}

export const PATCH_FAILED = 'YAML を安全に書き換えられませんでした';

export class YamlPatchError extends Error {
  constructor(readonly detail?: string) {
    super(PATCH_FAILED);
    this.name = 'YamlPatchError';
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const isScalarValue = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isFlow = (n: unknown): boolean => (isMap(n) || isSeq(n)) && !!(n as YAMLMap).flow;

/** Deep equality of JSON-like values (key order ignored, `undefined` keys = absent). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => has(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

/** A string written without quotes reads back as the same string. */
export function plainOk(v: string, flow: boolean): boolean {
  if (!v || v.trim() !== v || /[\r\n\t]/.test(v)) return false;
  try {
    if (flow) {
      const r = parse(`[${v}]`) as unknown;
      return Array.isArray(r) && r.length === 1 && r[0] === v;
    }
    const r = parse(`k: ${v}`) as unknown;
    return isObj(r) && Object.keys(r).length === 1 && r.k === v;
  } catch {
    return false;
  }
}

const keyText = (k: string) => (plainOk(k, true) ? k : JSON.stringify(k));

/** Value written the way the original was (same quotes; plain when it reads back the same; else `"…"`). */
export function scalarText(v: unknown, original: Node | null | undefined, flow: boolean): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : JSON.stringify(String(v));
  if (typeof v === 'boolean') return String(v);
  const s = String(v);
  const type = isScalar(original) ? original.type : undefined;
  if (type === 'QUOTE_DOUBLE') return JSON.stringify(s);
  if (type === 'QUOTE_SINGLE' && !/[\r\n]/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  return plainOk(s, flow) ? s : JSON.stringify(s);
}

interface Ctx {
  src: string;
  eol: string;
  edits: Array<TextEdit & { seq: number }>;
  changes: PatchChange[];
}

export class YamlPatcher {
  constructor(private readonly opts: PatchOptions = {}) {}

  /** Writes the differences between `before` (the values of `text`) and `after` into `text`. Throws YamlPatchError when the result does not read back as `after`. */
  apply(text: string, before: unknown, after: unknown): PatchOutput {
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const src = bom ? text.slice(1) : text;
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const target = JSON.parse(JSON.stringify(after ?? null)) as unknown;
    const doc = parseDocument(src, { keepSourceTokens: true });
    if (doc.errors.length) throw new YamlPatchError(doc.errors[0].message);
    const ctx: Ctx = { src, eol, edits: [], changes: [] };
    if (!sameValue(before, target)) this.node(ctx, doc.contents as Node | null, before, target, []);
    const sorted = [...ctx.edits].sort((a, b) => b.start - a.start || b.end - a.end || b.seq - a.seq);
    let out = src;
    let limit = Infinity;
    for (const e of sorted) {
      if (e.end > limit) throw new YamlPatchError('overlapping edits');
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
      limit = e.start;
    }
    const check = parseDocument(out);
    if (check.errors.length || !sameValue(check.toJS(), target)) throw new YamlPatchError('the result does not read back as the new values');
    return { text: bom + out, edits: ctx.edits.map(({ seq: _seq, ...e }) => e), changes: ctx.changes };
  }

  private edit(ctx: Ctx, start: number, end: number, text: string) {
    ctx.edits.push({ start, end, text, seq: ctx.edits.length });
  }

  private node(ctx: Ctx, node: Node | null, before: unknown, after: unknown, path: PathSeg[]): void {
    if (sameValue(before, after)) return;
    if (!node || !node.range) throw new YamlPatchError(`no node at ${path.join('.')}`);
    if (isFlow(node)) {
      this.collectChanges(ctx, before, after, path);
      this.edit(ctx, node.range[0], node.range[1], this.flowOf(ctx, node, before, after));
      return;
    }
    if (isMap(node) && isObj(before) && isObj(after)) return this.blockMap(ctx, node, before, after, path);
    if (isSeq(node) && Array.isArray(before) && Array.isArray(after)) return this.blockSeq(ctx, node, before, after, path);
    ctx.changes.push({ kind: 'value', path });
    const start = node.range[0];
    const lead = ctx.src[start - 1] === ':' ? ' ' : '';
    const text = isScalarValue(after) ? scalarText(after, node, false) : this.flowOf(ctx, null, undefined, after);
    this.edit(ctx, start, this.contentEnd(node), lead + text);
  }

  /** Records the differences inside a flow node (rewritten as a whole). */
  private collectChanges(ctx: Ctx, before: unknown, after: unknown, path: PathSeg[]) {
    if (sameValue(before, after)) return;
    if (isObj(before) && isObj(after)) {
      for (const k of Object.keys(before)) if (has(before, k) && !has(after, k)) ctx.changes.push({ kind: 'removeKey', path: [...path, k] });
      for (const k of Object.keys(after)) {
        if (!has(after, k)) continue;
        if (!has(before, k)) ctx.changes.push({ kind: 'addKey', path: [...path, k] });
        else this.collectChanges(ctx, before[k], after[k], [...path, k]);
      }
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      for (const [bi, ai] of this.match(before, after, path).pairs) this.collectChanges(ctx, before[bi], after[ai], [...path, ai]);
      const m = this.match(before, after, path);
      for (const bi of m.removed) ctx.changes.push({ kind: 'removeItem', path: [...path, bi] });
      for (const ai of m.added) ctx.changes.push({ kind: 'addItem', path: [...path, ai] });
      return;
    }
    ctx.changes.push({ kind: 'value', path });
  }

  /** Pairs of (before index, after index): by the key field when the array has one (a changed key at the same position is the same row), else by position. */
  private match(before: unknown[], after: unknown[], path: PathSeg[]): { pairs: Array<[number, number]>; removed: number[]; added: number[] } {
    const key = this.opts.arrayKey?.(path);
    const pairs: Array<[number, number]> = [];
    const usedB = new Set<number>();
    const usedA = new Set<number>();
    if (key) {
      const keyOf = (v: unknown) => (isObj(v) && has(v, key) ? JSON.stringify(v[key]) : undefined);
      const byKey = new Map<string, number>();
      after.forEach((v, i) => {
        const k = keyOf(v);
        if (k !== undefined && !byKey.has(k)) byKey.set(k, i);
      });
      before.forEach((v, i) => {
        const k = keyOf(v);
        const ai = k === undefined ? undefined : byKey.get(k);
        if (ai !== undefined && !usedA.has(ai)) {
          pairs.push([i, ai]);
          usedB.add(i);
          usedA.add(ai);
        }
      });
    }
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      if (usedB.has(i) || usedA.has(i)) continue;
      pairs.push([i, i]);
      usedB.add(i);
      usedA.add(i);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    return { pairs, removed: before.map((_, i) => i).filter((i) => !usedB.has(i)), added: after.map((_, i) => i).filter((i) => !usedA.has(i)) };
  }

  // ---- flow (one line) ----

  private flowOf(ctx: Ctx, node: Node | null, before: unknown, after: unknown): string {
    if (Array.isArray(after)) {
      const items = after.map((v, i) => {
        const n = isSeq(node) ? ((node.items[i] as Node | undefined) ?? null) : null;
        return this.flowItem(ctx, n, Array.isArray(before) ? before[i] : undefined, v);
      });
      return items.length ? `[ ${items.join(', ')} ]` : '[]';
    }
    if (isObj(after)) {
      const parts: string[] = [];
      for (const k of Object.keys(after)) {
        if (!has(after, k)) continue;
        const pair = isMap(node) ? (node.items as Pair[]).find((p) => keyOf(p) === k) : undefined;
        const ks = pair && isScalar(pair.key) && pair.key.range ? ctx.src.slice(pair.key.range[0], pair.key.range[1]) : keyText(k);
        const vn = (pair?.value as Node | null | undefined) ?? null;
        parts.push(`${ks.includes('\n') ? keyText(k) : ks}: ${this.flowItem(ctx, vn, isObj(before) ? before[k] : undefined, after[k])}`);
      }
      return parts.length ? `{ ${parts.join(', ')} }` : '{}';
    }
    return scalarText(after, node, true);
  }

  private flowItem(ctx: Ctx, n: Node | null, before: unknown, after: unknown): string {
    if (n?.range && before !== undefined && sameValue(before, after) && (isScalar(n) || isFlow(n))) {
      const s = ctx.src.slice(n.range[0], n.range[1]);
      if (!s.includes('\n')) return s;
    }
    return this.flowOf(ctx, n, before, after);
  }

  // ---- block map ----

  private blockMap(ctx: Ctx, map: YAMLMap, before: Obj, after: Obj, path: PathSeg[]) {
    const pairs = map.items as Pair[];
    if (!Object.keys(after).some((k) => has(after, k))) {
      for (const k of Object.keys(before)) if (has(before, k)) ctx.changes.push({ kind: 'removeKey', path: [...path, k] });
      this.edit(ctx, map.range![0], this.contentEnd(map), '{}');
      return;
    }
    pairs.forEach((p, i) => {
      const k = keyOf(p);
      if (has(before, k) && !has(after, k)) {
        ctx.changes.push({ kind: 'removeKey', path: [...path, k] });
        this.removePair(ctx, pairs, i);
      }
    });
    for (const p of pairs) {
      const k = keyOf(p);
      if (has(before, k) && has(after, k)) this.node(ctx, (p.value as Node | null) ?? null, before[k], after[k], [...path, k]);
    }
    const order = this.opts.keyOrder?.(path) ?? [];
    const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
    const added = Object.keys(after)
      .filter((k) => has(after, k) && !has(before, k))
      .map((k, i) => ({ k, i }))
      .sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i)
      .map((x) => x.k);
    if (!added.length) return;
    const first = pairs[0];
    const ind = ' '.repeat(this.column(ctx, (first.key as Node).range![0]));
    const flowStyle = pairs.some((p) => isFlow(p.value)) || !pairs.some((p) => isMap(p.value) || isSeq(p.value));
    for (const k of added) {
      ctx.changes.push({ kind: 'addKey', path: [...path, k] });
      const lines = this.pairLines(k, after[k], ind, flowStyle);
      const nextIdx = pairs.findIndex((p) => rank(keyOf(p)) > rank(k) && order.includes(k));
      if (nextIdx > 0 || nextIdx === -1) {
        const prev = pairs[(nextIdx === -1 ? pairs.length : nextIdx) - 1];
        const at = this.lineEnd(ctx, this.contentEnd((prev.value as Node | null) ?? (prev.key as Node)));
        this.edit(ctx, at, at, ctx.eol + lines.join(ctx.eol));
      } else {
        const ks = (first.key as Node).range![0];
        const ls = this.lineStart(ctx, ks);
        if (ctx.src.slice(ls, ks).trim() === '') this.edit(ctx, ls, ls, lines.join(ctx.eol) + ctx.eol);
        else {
          const last = pairs[pairs.length - 1];
          const at = this.lineEnd(ctx, this.contentEnd((last.value as Node | null) ?? (last.key as Node)));
          this.edit(ctx, at, at, ctx.eol + lines.join(ctx.eol));
        }
      }
    }
  }

  private removePair(ctx: Ctx, pairs: Pair[], i: number) {
    const p = pairs[i];
    const start = (p.key as Node).range![0];
    const end = this.contentEnd((p.value as Node | null) ?? (p.key as Node));
    const ls = this.lineStart(ctx, start);
    if (ctx.src.slice(ls, start).trim() === '') {
      this.deleteLines(ctx, ls, end);
      return;
    }
    // first key on a `- ` line: the next key moves up onto that line
    const next = pairs[i + 1];
    if (next) this.edit(ctx, start, (next.key as Node).range![0], '');
    else this.edit(ctx, start, end, '{}');
  }

  private pairLines(k: string, v: unknown, ind: string, flowStyle: boolean): string[] {
    if (isScalarValue(v)) return [`${ind}${keyText(k)}: ${scalarText(v, null, false)}`];
    const empty = Array.isArray(v) ? v.length === 0 : !Object.keys(v as Obj).some((x) => has(v as Obj, x));
    if (flowStyle || empty) return [`${ind}${keyText(k)}: ${this.flowOf({ src: '', eol: '\n', edits: [], changes: [] }, null, undefined, v)}`];
    return [`${ind}${keyText(k)}:`, ...this.blockLines(v, `${ind}  `)];
  }

  /** Block style lines of a new collection value. */
  private blockLines(v: unknown, ind: string): string[] {
    const out: string[] = [];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (isScalarValue(item) || (Array.isArray(item) && !item.length) || (isObj(item) && !Object.keys(item).length)) {
          out.push(`${ind}- ${isScalarValue(item) ? scalarText(item, null, false) : Array.isArray(item) ? '[]' : '{}'}`);
          continue;
        }
        const inner = this.blockLines(item, `${ind}  `);
        out.push(`${ind}- ${inner[0].slice(ind.length + 2)}`, ...inner.slice(1));
      }
      return out;
    }
    for (const k of Object.keys(v as Obj)) {
      const x = (v as Obj)[k];
      if (x === undefined) continue;
      out.push(...this.pairLines(k, x, ind, false));
    }
    return out;
  }

  // ---- block sequence ----

  private blockSeq(ctx: Ctx, seq: YAMLSeq, before: unknown[], after: unknown[], path: PathSeg[]) {
    const items = seq.items as Node[];
    const m = this.match(before, after, path);
    if (!after.length) {
      for (const bi of m.removed) ctx.changes.push({ kind: 'removeItem', path: [...path, bi] });
      this.edit(ctx, seq.range![0], this.contentEnd(seq), '[]');
      return;
    }
    for (const [bi, ai] of m.pairs) this.node(ctx, items[bi] ?? null, before[bi], after[ai], [...path, ai]);
    for (const bi of m.removed) {
      ctx.changes.push({ kind: 'removeItem', path: [...path, bi] });
      const item = items[bi];
      const ls = this.lineStart(ctx, item.range![0]);
      if (!/^\s*-\s*$/.test(ctx.src.slice(ls, item.range![0]))) throw new YamlPatchError('array item shares its line');
      this.deleteLines(ctx, ls, this.contentEnd(item));
    }
    if (!m.added.length) return;
    const template = items[items.length - 1];
    const tls = this.lineStart(ctx, template.range![0]);
    const dash = ctx.src.slice(tls, template.range![0]).indexOf('-');
    const dashInd = ' '.repeat(Math.max(0, dash));
    const kept = m.pairs.map(([bi]) => bi);
    const lines: string[] = [];
    for (const ai of m.added) {
      ctx.changes.push({ kind: 'addItem', path: [...path, ai] });
      const v = after[ai];
      if (isMap(template) && !template.flow && isObj(v) && Object.keys(v).length) {
        const keyCol = this.column(ctx, ((template.items[0] as Pair).key as Node).range![0]);
        const inner = this.blockLines(v, ' '.repeat(keyCol));
        lines.push(`${dashInd}-${' '.repeat(Math.max(1, keyCol - dash - 1))}${inner[0].trimStart()}`, ...inner.slice(1));
      } else if (isScalarValue(v)) lines.push(`${dashInd}- ${scalarText(v, isScalar(template) ? template : null, false)}`);
      else lines.push(`${dashInd}- ${this.flowOf(ctx, null, undefined, v)}`);
    }
    if (!kept.length) {
      // every old element is removed: write the new elements in place of the first one
      const first = items[0];
      const ls = this.lineStart(ctx, first.range![0]);
      this.edit(ctx, ls, ls, lines.join(ctx.eol) + ctx.eol);
      return;
    }
    const last = items[Math.max(...kept)];
    const at = this.lineEnd(ctx, this.contentEnd(last));
    this.edit(ctx, at, at, ctx.eol + lines.join(ctx.eol));
  }

  // ---- positions ----

  /** End offset of the last content of a node (block collections end at their last value, not at the next line). */
  private contentEnd(n: Node): number {
    if (isMap(n) && !n.flow) {
      const last = n.items[n.items.length - 1] as Pair | undefined;
      if (!last) return n.range![0];
      const v = last.value as Node | null;
      return v && v.range && v.range[1] > (last.key as Node).range![1] ? this.contentEnd(v) : (last.key as Node).range![1];
    }
    if (isSeq(n) && !n.flow) {
      const last = n.items[n.items.length - 1] as Node | undefined;
      return last ? this.contentEnd(last) : n.range![0];
    }
    return (n as Scalar).range![1];
  }

  private lineStart(ctx: Ctx, pos: number): number {
    return ctx.src.lastIndexOf('\n', pos - 1) + 1;
  }

  /** Offset of the end of the line (before its line break). */
  private lineEnd(ctx: Ctx, pos: number): number {
    const i = ctx.src.indexOf('\n', pos);
    if (i < 0) return ctx.src.length;
    return ctx.src[i - 1] === '\r' ? i - 1 : i;
  }

  private column(ctx: Ctx, pos: number): number {
    return pos - this.lineStart(ctx, pos);
  }

  /** Deletes whole lines from `from` (a line start) through the line containing `lastPos`. */
  private deleteLines(ctx: Ctx, from: number, lastPos: number) {
    const nl = ctx.src.indexOf('\n', Math.max(from, lastPos - 1));
    if (nl >= 0) this.edit(ctx, from, nl + 1, '');
    else {
      const prev = from >= ctx.eol.length && ctx.src.slice(from - ctx.eol.length, from) === ctx.eol ? from - ctx.eol.length : from;
      this.edit(ctx, prev, ctx.src.length, '');
    }
  }
}

function keyOf(p: Pair): string {
  return isScalar(p.key) ? String(p.key.value) : String(p.key);
}

export interface LineHunk {
  /** First line of `before` (1-based). For an insertion: the line before which `after` goes (endLine = startLine - 1). */
  startLine: number;
  endLine: number;
  before: string[];
  after: string[];
}

function splitLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line differences with no context lines (separate changes stay separate hunks). */
export function lineHunks(beforeText: string, afterText: string): LineHunk[] {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  // LCS of the middle part
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks: LineHunk[] = [];
  let cur: LineHunk | null = null;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  const open = () => (cur ??= { startLine: pre + i + 1, endLine: pre + i, before: [], after: [] });
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      open().after.push(B[j++]);
    } else {
      const h = open();
      h.before.push(A[i++]);
      h.endLine = pre + i;
    }
  }
  flush();
  return hunks;
}
