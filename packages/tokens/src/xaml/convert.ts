/** `x:Key` → kebab-case name part (may be empty when nothing usable remains). */
export function kebabKey(key: string): string {
  return key
    .replace(/[._\s]+/g, '-')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1-$2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `--` + (`<prefix>-`) + kebabKey(key); `null` when the key gives no name. */
export function tokenName(key: string, prefix?: string): string | null {
  const k = kebabKey(key);
  if (!k) return null;
  return `--${prefix ? `${prefix}-` : ''}${k}`;
}

/** WPF / CSS named colors (WPF's `Colors` names that CSS also knows, lower-cased) → #rrggbb. */
const NAMED_COLORS: Record<string, string> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
  blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
  chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b',
  darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkkhaki: 'bdb76b', darkmagenta: '8b008b',
  darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
  darkslateblue: '483d8b', darkslategray: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff',
  dimgray: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f', honeydew: 'f0fff0',
  hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5',
  lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3', lightgreen: '90ee90', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa',
  lightslategray: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff',
  maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970',
  mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
  olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6',
  purple: '800080', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460',
  seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090',
  snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347',
  turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
  transparent: 'ffffff00',
};

/** `SystemColors` / `SystemFonts` names (without the `Key` suffix) → standard item token. */
export const SYSTEM_RESOURCE_TOKENS: Record<string, string> = {
  'SystemColors.WindowBrush': '--wpf-window-bg',
  'SystemColors.WindowColor': '--wpf-window-bg',
  'SystemColors.WindowTextBrush': '--wpf-window-fg',
  'SystemColors.WindowTextColor': '--wpf-window-fg',
  'SystemFonts.MessageFontFamily': '--wpf-font-family',
  'SystemFonts.MessageFontSize': '--wpf-font-size',
  'SystemColors.ControlTextBrush': '--wpf-button-fg',
  'SystemColors.ControlTextColor': '--wpf-button-fg',
  'SystemColors.HighlightBrush': '--wpf-highlight-bg',
  'SystemColors.HighlightColor': '--wpf-highlight-bg',
  'SystemColors.HighlightTextBrush': '--wpf-highlight-fg',
  'SystemColors.HighlightTextColor': '--wpf-highlight-fg',
};

export type Converted = { ok: true; value: string; ref?: string } | { ok: false; warning: string };

const ok = (value: string, ref?: string): Converted => (ref ? { ok: true, value, ref } : { ok: true, value });
const fail = (warning: string): Converted => ({ ok: false, warning });

export type Markup =
  | { kind: 'resource'; key: string }
  | { kind: 'system'; name: string }
  | { kind: 'other'; text: string };

/** `{x:Static SystemColors.WindowBrushKey}` → `SystemColors.WindowBrushKey`. */
export function systemKeyOf(text: string): string | null {
  const m = /^\{\s*[\w.]+:Static\s+(?:Member\s*=\s*)?((?:SystemColors|SystemFonts)\.\w+)\s*\}$/.exec(text.trim());
  return m ? m[1] : null;
}

/** Parses a markup extension value; `null` for a literal. */
export function parseMarkup(raw: string): Markup | null {
  const t = raw.trim();
  if (!t.startsWith('{') || t.startsWith('{}')) return null;
  const res = /^\{\s*(?:StaticResource|DynamicResource)\s+(?:ResourceKey\s*=\s*)?(.+?)\s*\}$/.exec(t);
  if (res) {
    const inner = res[1];
    const sys = systemKeyOf(inner);
    if (sys) return { kind: 'system', name: sys };
    return { kind: 'resource', key: inner };
  }
  const sys = systemKeyOf(t);
  if (sys) return { kind: 'system', name: sys };
  return { kind: 'other', text: t };
}

function hexColor(raw: string): string | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(raw);
  if (!m) return null;
  const h = m[1].toLowerCase();
  let a: string;
  let rgb: string;
  if (h.length === 8) [a, rgb] = [h.slice(0, 2), h.slice(2)];
  else if (h.length === 6) [a, rgb] = ['ff', h];
  else if (h.length === 4) [a, rgb] = [h[0] + h[0], [...h.slice(1)].map((c) => c + c).join('')];
  else if (h.length === 3) [a, rgb] = ['ff', [...h].map((c) => c + c).join('')];
  else return null;
  return a === 'ff' ? `#${rgb}` : `#${rgb}${a}`;
}

function withAlpha(color: string, opacity: number): string {
  const rgb = color.slice(1, 7);
  const a = color.length === 9 ? parseInt(color.slice(7), 16) : 255;
  const na = Math.round(a * opacity);
  return na === 255 ? `#${rgb}` : `#${rgb}${na.toString(16).padStart(2, '0')}`;
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** WPF length (`14`, `14px`, `10.5pt`, `1in`, `1cm`) → px number. */
function lengthPx(raw: string): number | null {
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(px|pt|in|cm)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  const factor = unit === 'pt' ? 4 / 3 : unit === 'in' ? 96 : unit === 'cm' ? 96 / 2.54 : 1;
  return n * factor;
}

const px = (n: number) => (n === 0 ? '0' : `${trimNumber(n)}px`);

/** Resolves references while converting (`var(--…)` of a resource or a standard item). */
export type RefResolver = (key: string) => string | null;

export interface BrushInput {
  color?: string;
  opacity?: string;
}

/** Converts XAML values to CSS values (one method per XAML type). */
export class XamlConverter {
  constructor(private readonly resolveRef: RefResolver = () => null) {}

  /** Handles `{…}` values: references become `var(--…)`, other markup extensions are rejected. `null` for literals. */
  markup(raw: string): Converted | null {
    const m = parseMarkup(raw);
    if (!m) return null;
    if (m.kind === 'other') return fail(`実行時にしか決まらない値です: ${m.text}`);
    if (m.kind === 'system') {
      const token = SYSTEM_RESOURCE_TOKENS[m.name.replace(/Key$/, '')];
      return token ? ok(`var(${token})`, token) : fail(`対応していないシステムのリソースです: ${m.name.replace(/^\w+\./, '')}`);
    }
    const name = this.resolveRef(m.key);
    return name ? ok(`var(${name})`, name) : fail(`参照先のリソースがありません: ${m.key}`);
  }

  color(raw: string): Converted {
    const mk = this.markup(raw);
    if (mk) return mk;
    const t = raw.trim();
    const hex = hexColor(t);
    if (hex) return ok(hex);
    const named = NAMED_COLORS[t.toLowerCase()];
    if (named) return ok(hexColor(`#${named.length === 8 ? named.slice(6) + named.slice(0, 6) : named}`)!);
    return fail(`色の値を読めません: ${t}`);
  }

  brush(res: BrushInput): Converted {
    if (res.color === undefined) return fail('色の値を読めません: （Color がありません）');
    const c = this.color(res.color);
    if (!c.ok || res.opacity === undefined) return c;
    const op = Number(res.opacity);
    if (!Number.isFinite(op) || op < 0 || op > 1) return fail(`Opacity を読めません: ${res.opacity}`);
    if (op >= 1) return c;
    if (c.ref) return fail('参照の色に Opacity は掛けられません');
    return ok(withAlpha(c.value, op));
  }

  fontFamily(raw: string): Converted {
    const mk = this.markup(raw);
    if (mk) return mk;
    const names = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return fail('書体を読めません: （空）');
    return ok(names.map((n) => (GENERIC_FAMILIES.has(n.toLowerCase()) ? n.toLowerCase() : `"${n.replace(/"/g, '\\"')}"`)).join(', '));
  }

  fontSize(raw: string): Converted {
    const mk = this.markup(raw);
    if (mk) return mk;
    const n = lengthPx(raw);
    if (n === null) return fail(`文字サイズを読めません: ${raw.trim()}`);
    return ok(`${trimNumber(n)}px`);
  }

  thickness(raw: string): Converted {
    const mk = this.markup(raw);
    if (mk) return mk;
    const parts = raw.trim().split(/\s*,\s*|\s+/).filter(Boolean).map(lengthPx);
    if (parts.some((p) => p === null) || ![1, 2, 4].includes(parts.length)) return fail(`余白の値を読めません: ${raw.trim()}`);
    const v = parts as number[];
    const [l, t, r, b] = v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v;
    return ok([t, r, b, l].map(px).join(' '));
  }

  cornerRadius(raw: string): Converted {
    const mk = this.markup(raw);
    if (mk) return mk;
    const parts = raw.trim().split(/\s*,\s*|\s+/).filter(Boolean).map(lengthPx);
    if (parts.some((p) => p === null) || ![1, 4].includes(parts.length)) return fail(`角丸の値を読めません: ${raw.trim()}`);
    return ok((parts as number[]).map(px).join(' '));
  }
}
