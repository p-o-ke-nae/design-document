import { XMLParser } from 'fast-xml-parser';
import type { TokenSetConfig } from '@ddv/core';
import { dirname, normalizePath, type TokenFs } from '../fs.ts';
import { emptyResult, sha256Hex, type ReadResult, type Token, type TokenKind, type TokenWarning } from '../schema.ts';
import { Aero2Defaults, STANDARD_TOKEN_NAMES, type StyleSetter } from './aero2.ts';
import { systemKeyOf, tokenName, XamlConverter, type Converted } from './convert.ts';
import { XamlUriResolver } from './uri.ts';

export const XAML_NS = 'http://schemas.microsoft.com/winfx/2006/xaml';
const SYSTEM_NS = /^clr-namespace:System;assembly=(mscorlib|System\.Runtime)$/;

export type XamlType = 'Color' | 'SolidColorBrush' | 'FontFamily' | 'FontSize' | 'Thickness' | 'CornerRadius' | 'ImageBrush' | 'WindowStyle';

export interface XamlResource {
  key: string;
  type: XamlType;
  /** Content (Color, FontFamily, …) or the `Color` of a SolidColorBrush. */
  raw: string;
  /** Referenced key when the value is `{StaticResource K}` / `{DynamicResource K}`. */
  ref?: string;
  opacity?: string;
  setters?: Map<string, StyleSetter>;
  /** Local element name (for messages). */
  element: string;
  file: string;
  line: number;
}

/** Resources of one ResourceDictionary with its merged dictionaries (WPF lookup order). */
export class ResourceDict {
  readonly own = new Map<string, XamlResource>();
  readonly merged: ResourceDict[] = [];
  /** Definitions of this dictionary in document order (duplicates included). */
  readonly defs: XamlResource[] = [];
  constructor(readonly file: string) {}

  /** Own definition first, then the merged dictionaries from the last one. */
  lookup(key: string): XamlResource | null {
    const own = this.own.get(key);
    if (own) return own;
    for (let i = this.merged.length - 1; i >= 0; i--) {
      const r = this.merged[i].lookup(key);
      if (r) return r;
    }
    return null;
  }

  /** All definitions: own first, then the merged dictionaries in order (depth first). */
  allDefs(): XamlResource[] {
    return [...this.defs, ...this.merged.flatMap((m) => m.allDefs())];
  }
}

export interface XNode {
  qname: string;
  local: string;
  ns: string;
  attrs: Record<string, string>;
  scope: Map<string, string>;
  children: XNode[];
  text: string;
  line: number;
}

const META = XMLParser.getMetaDataSymbol() as unknown as symbol;

export function parseXml(text: string): XNode[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    captureMetaData: true,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const tree = parser.parse(text) as Array<Record<string | symbol, unknown>>;
  const breaks: number[] = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) breaks.push(i);
  const lineOf = (idx: number | undefined) => {
    if (idx === undefined) return 0;
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < idx) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const build = (entries: Array<Record<string | symbol, unknown>>, parentScope: Map<string, string>): { nodes: XNode[]; text: string } => {
    const nodes: XNode[] = [];
    let txt = '';
    for (const e of entries) {
      const tag = Object.keys(e).find((k) => k !== ':@');
      if (!tag) continue;
      if (tag === '#text') {
        txt += String(e[tag]);
        continue;
      }
      if (tag.startsWith('?') || tag.startsWith('!')) continue;
      const attrs = (e[':@'] ?? {}) as Record<string, string>;
      const scope = new Map(parentScope);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'xmlns') scope.set('', v);
        else if (k.startsWith('xmlns:')) scope.set(k.slice(6), v);
      }
      const colon = tag.indexOf(':');
      const prefix = colon >= 0 ? tag.slice(0, colon) : '';
      const inner = build((e[tag] ?? []) as Array<Record<string | symbol, unknown>>, scope);
      const meta = e[META] as { startIndex?: number } | undefined;
      nodes.push({
        qname: tag,
        local: colon >= 0 ? tag.slice(colon + 1) : tag,
        ns: scope.get(prefix) ?? '',
        attrs,
        scope,
        children: inner.nodes,
        text: inner.text,
        line: lineOf(meta?.startIndex),
      });
    }
    return { nodes, text: txt };
  };
  return build(tree, new Map()).nodes;
}

/** Attribute `<p>:<name>` whose prefix is the XAML namespace. */
function xamlAttr(node: XNode, name: string): string | undefined {
  for (const [k, v] of Object.entries(node.attrs)) {
    const i = k.indexOf(':');
    if (i > 0 && k.slice(i + 1) === name && node.scope.get(k.slice(0, i)) === XAML_NS) return v;
  }
  return undefined;
}

/** Value given as attribute or as property element (`<Type.Prop>value</Type.Prop>`). */
function propValue(node: XNode, prop: string): string | undefined {
  if (node.attrs[prop] !== undefined) return node.attrs[prop];
  const pe = node.children.find((c) => c.local === `${node.local}.${prop}`);
  if (!pe) return undefined;
  if (pe.text) return pe.text;
  const child = pe.children[0];
  return child ? child.text : undefined;
}

const CONVERTED_TYPES = new Set(['Color', 'SolidColorBrush', 'FontFamily', 'Thickness', 'CornerRadius']);
const IMAGE_BRUSHES = new Set(['LinearGradientBrush', 'RadialGradientBrush', 'ImageBrush', 'VisualBrush', 'DrawingBrush']);
const NOT_READ = new Set(['Style', 'ControlTemplate', 'DataTemplate']);
const WINDOW_STYLE_PROPS = new Set(['Background', 'Foreground', 'FontFamily', 'FontSize', 'TextElement.FontFamily', 'TextElement.FontSize']);
const KIND_OF: Record<string, TokenKind> = {
  Color: 'color',
  SolidColorBrush: 'color',
  FontFamily: 'font-family',
  FontSize: 'font-size',
  Thickness: 'thickness',
  CornerRadius: 'corner-radius',
};
export const KIND_ORDER: TokenKind[] = ['color', 'font-family', 'font-size', 'thickness', 'corner-radius', 'standard', 'css'];

const STATIC_REF = /^\{\s*(?:StaticResource|DynamicResource)\s+(?:ResourceKey\s*=\s*)?([^{}]+?)\s*\}$/;

export const WINDOW_STYLE_KEY = 'style:Window';
const sysKey = (name: string) => `sys:${name}`;

function isWindowTarget(target: string | undefined): boolean {
  if (!target) return false;
  return /^(?:\{\s*[\w.]+:Type\s+(?:TypeName\s*=\s*)?)?(?:[\w.]+:)?Window\s*\}?$/.test(target.trim());
}

/** Classification of one element directly under a dictionary (`XRES`). */
export type ResourceClass =
  | { action: 'window-style'; resource: XamlResource }
  | { action: 'skip' }
  | { action: 'convert'; resource: XamlResource }
  | { action: 'count' }
  | { action: 'image-brush'; resource: XamlResource }
  | { action: 'not-read' };

export function classifyResource(node: XNode, file: string, fontSizeKeys: string[]): ResourceClass {
  const base = { element: node.local, file, line: node.line };
  const rawKey = xamlAttr(node, 'Key');
  if (rawKey === undefined) {
    if (node.local === 'Style' && isWindowTarget(node.attrs.TargetType)) {
      const setters = new Map<string, StyleSetter>();
      for (const s of node.children) {
        if (s.local !== 'Setter') continue;
        const prop = s.attrs.Property;
        const value = propValue(s, 'Value');
        if (prop && WINDOW_STYLE_PROPS.has(prop) && value !== undefined && !setters.has(prop)) setters.set(prop, { value, file, line: s.line });
      }
      return { action: 'window-style', resource: { ...base, key: WINDOW_STYLE_KEY, type: 'WindowStyle', raw: '', setters } };
    }
    return { action: 'skip' };
  }
  const sys = systemKeyOf(rawKey);
  const key = sys ? sysKey(sys) : rawKey;
  const local = node.local;
  if (CONVERTED_TYPES.has(local)) {
    const raw = local === 'SolidColorBrush' ? (propValue(node, 'Color') ?? '') : node.text;
    const ref = STATIC_REF.exec(raw.trim())?.[1];
    const resource: XamlResource = { ...base, key, type: local as XamlType, raw, ...(ref && !ref.startsWith('{') ? { ref } : {}) };
    if (local === 'SolidColorBrush') {
      const op = propValue(node, 'Opacity');
      if (op !== undefined) resource.opacity = op;
    }
    return { action: 'convert', resource };
  }
  if (local === 'Double' && SYSTEM_NS.test(node.ns)) {
    if (sys || /FontSize|TextSize/.test(rawKey) || fontSizeKeys.includes(rawKey)) return { action: 'convert', resource: { ...base, key, type: 'FontSize', raw: node.text } };
    return { action: 'count' };
  }
  if (IMAGE_BRUSHES.has(local)) return { action: 'image-brush', resource: { ...base, key, type: 'ImageBrush', raw: '' } };
  if (NOT_READ.has(local)) return { action: 'not-read' };
  return { action: 'count' };
}

/** Reads a `kind: xaml` token set: entries, merged dictionaries, conversion and the standard items. */
export class XamlReader {
  async read(set: TokenSetConfig, fs: TokenFs): Promise<ReadResult> {
    return new XamlReadRun(set, fs).run();
  }
}

class XamlReadRun {
  private readonly result = emptyResult();
  private readonly resolver: XamlUriResolver;
  private readonly recorded = new Set<string>();
  private caseIndex: Map<string, string> | null = null;

  constructor(
    private readonly set: TokenSetConfig,
    private readonly fs: TokenFs,
  ) {
    this.resolver = new XamlUriResolver(fs);
  }

  private warn(w: TokenWarning) {
    this.result.warnings.push(w);
  }

  private async record(path: string, text: string) {
    if (this.recorded.has(path.toLowerCase())) return;
    this.recorded.add(path.toLowerCase());
    this.result.sources.push({ path, sha256: await sha256Hex(text) });
  }

  /** Actual case of a repository XAML file (URIs are matched case-insensitively). */
  private async realCase(path: string): Promise<string> {
    if (!this.caseIndex) {
      this.caseIndex = new Map();
      for (const p of await this.fs.glob('**/*.xaml')) this.caseIndex.set(p.toLowerCase(), p);
    }
    return this.caseIndex.get(path.toLowerCase()) ?? path;
  }

  async run(): Promise<ReadResult> {
    const entries: Array<{ path: string; text: string }> = [];
    for (const src of this.set.sources) {
      const path = normalizePath(src);
      const text = await this.fs.read(path);
      if (text === null) this.result.errors.push(`生成元のファイルを読めません: ${src}（見つからないか、読み取れません）`);
      else entries.push({ path: await this.realCase(path), text });
    }
    if (this.result.errors.length) return this.result;
    const dicts: ResourceDict[] = [];
    for (const e of entries) {
      await this.record(e.path, e.text);
      const project = (await this.resolver.projectDirOf(e.path)) ?? dirname(e.path);
      dicts.push(await this.parseFile(e.path, e.text, [e.path.toLowerCase()], project));
    }
    this.resolve(dicts);
    return this.result;
  }

  private async parseFile(file: string, text: string, chain: string[], project: string): Promise<ResourceDict> {
    let roots: XNode[];
    try {
      roots = parseXml(text);
    } catch (e) {
      this.warn({ file, message: `XAML を読めません: ${e instanceof Error ? e.message : String(e)}` });
      return new ResourceDict(file);
    }
    const root = roots[0];
    const dict = new ResourceDict(file);
    if (!root) return dict;
    let container: XNode | undefined;
    if (root.local === 'ResourceDictionary') container = root;
    else if (root.local === 'Application') {
      const res = root.children.find((c) => c.local === 'Application.Resources');
      if (res) container = res.children.length === 1 && res.children[0].local === 'ResourceDictionary' ? res.children[0] : res;
    }
    if (container) await this.readDict(container, dict, chain, project);
    return dict;
  }

  private async readDict(node: XNode, dict: ResourceDict, chain: string[], project: string): Promise<void> {
    const file = dict.file;
    for (const child of node.children) {
      if (child.local === 'ResourceDictionary.MergedDictionaries') {
        for (const rd of child.children) {
          if (rd.local !== 'ResourceDictionary') continue;
          const source = rd.attrs.Source;
          if (source === undefined) {
            const inline = new ResourceDict(file);
            await this.readDict(rd, inline, chain, project);
            dict.merged.push(inline);
            continue;
          }
          const sub = await this.follow(source, file, rd.line, chain, project);
          if (sub) dict.merged.push(sub);
        }
        continue;
      }
      const c = classifyResource(child, file, this.set.fontSizeKeys);
      if (c.action === 'skip' || c.action === 'not-read') continue;
      if (c.action === 'count') {
        this.result.skipped++;
        continue;
      }
      dict.defs.push(c.resource);
      dict.own.set(c.resource.key, c.resource);
    }
  }

  /** Follows a `Source` URI (`XURI`); `null` (with a warning) when it is not followed. */
  private async follow(uri: string, from: string, line: number, chain: string[], project: string): Promise<ResourceDict | null> {
    const r = await this.resolver.resolve(uri, from, project);
    if (!r.ok) {
      this.warn({ file: from, line, message: r.warning });
      return null;
    }
    const path = await this.realCase(r.path);
    if (chain.includes(path.toLowerCase())) {
      this.warn({ file: from, line, message: `循環して参照しています: ${uri}` });
      return null;
    }
    const text = await this.fs.read(path);
    if (text === null) {
      this.warn({ file: from, line, message: `ファイルが読めません: ${uri}（${path}）` });
      return null;
    }
    await this.record(path, text);
    return this.parseFile(path, text, [...chain, path.toLowerCase()], project);
  }

  private resolve(dicts: ResourceDict[]) {
    const lookup = (key: string): XamlResource | null => {
      for (let i = dicts.length - 1; i >= 0; i--) {
        const r = dicts[i].lookup(key);
        if (r) return r;
      }
      return null;
    };
    const defs = dicts.flatMap((d) => d.allDefs());
    const keys: string[] = [];
    const seenKeys = new Set<string>();
    for (const d of defs) {
      if (!seenKeys.has(d.key)) {
        seenKeys.add(d.key);
        keys.push(d.key);
      }
    }
    this.result.dropped = defs.length - keys.length;
    const winners = keys.map((k) => lookup(k)!);
    const names = new Map<string, string>();
    const used = new Map<string, XamlResource>();
    for (const w of winners) {
      if (w.key.startsWith('sys:') || w.type === 'WindowStyle') continue;
      if (w.type === 'ImageBrush') {
        this.warn({ file: w.file, line: w.line, message: `グラデーション・画像のブラシは変換しません: ${w.key}（${w.element}）` });
        continue;
      }
      const name = tokenName(w.key, this.set.prefix);
      if (!name) {
        this.warn({ file: w.file, line: w.line, message: `キーから名前を作れません: ${w.key}` });
        continue;
      }
      const prev = used.get(name);
      if (prev) {
        this.warn({ file: w.file, line: w.line, message: `同じ名前になるキーがあります（後のキーを捨てます）: ${w.key}（${prev.key} と同じ ${name}）` });
        continue;
      }
      used.set(name, w);
      names.set(w.key, name);
    }
    const converter = new XamlConverter((key) => names.get(key) ?? null);
    const convert = (r: XamlResource): Converted => {
      switch (r.type) {
        case 'Color':
          return converter.color(r.raw);
        case 'SolidColorBrush':
          return converter.brush({ color: r.raw === '' ? undefined : r.raw, opacity: r.opacity });
        case 'FontFamily':
          return converter.fontFamily(r.raw);
        case 'FontSize':
          return converter.fontSize(r.raw);
        case 'Thickness':
          return converter.thickness(r.raw);
        case 'CornerRadius':
          return converter.cornerRadius(r.raw);
        default:
          return { ok: false, warning: `変換できない型です: ${r.element}` };
      }
    };
    let tokens: Array<Token & { ref?: string; res: XamlResource }> = [];
    for (const [key, name] of names) {
      const r = lookup(key)!;
      const c = convert(r);
      if (!c.ok) {
        this.warn({ file: r.file, line: r.line, message: c.warning });
        continue;
      }
      tokens.push({ name, value: c.value, kind: KIND_OF[r.type], origin: 'defined', ref: c.ref, res: r });
    }
    const aero = new Aero2Defaults(converter);
    const standard = aero.apply(
      {
        windowStyle: lookup(WINDOW_STYLE_KEY)?.setters ?? new Map(),
        system: (key) => {
          const r = lookup(sysKey(key));
          return r ? { converted: convert(r), file: r.file, line: r.line } : null;
        },
      },
      this.result.warnings,
    );
    // Drop tokens whose reference target was not emitted (until nothing changes).
    for (;;) {
      const emitted = new Set([...tokens.map((t) => t.name), ...STANDARD_TOKEN_NAMES]);
      const broken = tokens.filter((t) => t.ref && !emitted.has(t.ref));
      if (!broken.length) break;
      for (const t of broken) this.warn({ file: t.res.file, line: t.res.line, message: `参照先のリソースがありません: ${t.res.ref ?? t.ref}` });
      tokens = tokens.filter((t) => !broken.includes(t));
    }
    const defined = new Map(tokens.map((t) => [t.name, t]));
    const out: Token[] = tokens.map(({ name, value, kind, origin }) => ({ name, value, kind, origin }));
    for (const s of standard) {
      const clash = defined.get(s.name);
      if (clash) {
        this.warn({ file: clash.res.file, line: clash.res.line, message: `標準の項目と同じ名前です: ${clash.res.key}（${s.name}）` });
        continue;
      }
      out.push(s);
    }
    out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.result.tokens = out;
  }
}
