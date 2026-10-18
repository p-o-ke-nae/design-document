import type { Token, TokenWarning } from '../schema.ts';
import type { Converted, XamlConverter } from './convert.ts';

export type StandardCategory = 'color' | 'font-family' | 'font-size' | 'fixed';

export interface StandardItem {
  token: string;
  /** Aero2 (Windows 10+ WPF default) value. */
  value: string;
  category: StandardCategory;
  /** Window Style setters that override the value (first wins). */
  styleProps: string[];
  /** `SystemColors.` / `SystemFonts.` keys that override the value (after the style setters). */
  systemKeys: string[];
}

const item = (token: string, value: string, category: StandardCategory, styleProps: string[] = [], systemKeys: string[] = []): StandardItem => ({
  token,
  value,
  category,
  styleProps,
  systemKeys,
});

export const STANDARD_ITEMS: StandardItem[] = [
  item('--wpf-window-bg', '#ffffff', 'color', ['Background'], ['SystemColors.WindowBrushKey', 'SystemColors.WindowColorKey']),
  item('--wpf-window-fg', '#000000', 'color', ['Foreground'], ['SystemColors.WindowTextBrushKey', 'SystemColors.WindowTextColorKey']),
  item('--wpf-font-family', '"Segoe UI", "Yu Gothic UI", sans-serif', 'font-family', ['TextElement.FontFamily', 'FontFamily'], ['SystemFonts.MessageFontFamilyKey']),
  item('--wpf-font-size', '12px', 'font-size', ['TextElement.FontSize', 'FontSize'], ['SystemFonts.MessageFontSizeKey']),
  item('--wpf-button-bg', '#dddddd', 'fixed'),
  item('--wpf-button-border', '#707070', 'fixed'),
  item('--wpf-button-fg', '#000000', 'color', [], ['SystemColors.ControlTextBrushKey', 'SystemColors.ControlTextColorKey']),
  item('--wpf-button-hover-bg', '#bee6fd', 'fixed'),
  item('--wpf-button-pressed-bg', '#c4e5f6', 'fixed'),
  item('--wpf-input-bg', 'var(--wpf-window-bg)', 'color', [], ['SystemColors.WindowBrushKey']),
  item('--wpf-input-border', '#abadb3', 'fixed'),
  item('--wpf-input-focus-border', '#569de5', 'fixed'),
  item('--wpf-highlight-bg', '#0078d7', 'color', [], ['SystemColors.HighlightBrushKey', 'SystemColors.HighlightColorKey']),
  item('--wpf-highlight-fg', '#ffffff', 'color', [], ['SystemColors.HighlightTextBrushKey', 'SystemColors.HighlightTextColorKey']),
  item('--wpf-control-padding', '1px', 'fixed'),
  item('--wpf-control-border-width', '1px', 'fixed'),
];

export const STANDARD_TOKEN_NAMES = new Set(STANDARD_ITEMS.map((i) => i.token));

/** A setter of the keyless Window Style. */
export interface StyleSetter {
  value: string;
  file: string;
  line: number;
}

/** Value source for overriding a standard item. */
export interface StandardOverrides {
  /** Window Style setters by property name. */
  windowStyle: Map<string, StyleSetter>;
  /** Converts the winning resource of a system key (`null` when the key is not defined). */
  system(key: string): { converted: Converted; file: string; line: number } | null;
}

/** Standard items of WPF: the app's overrides when present, otherwise the Aero2 values (marked `WPF 標準`). */
export class Aero2Defaults {
  readonly items = STANDARD_ITEMS;
  constructor(private readonly converter: XamlConverter) {}

  apply(overrides: StandardOverrides, warnings: TokenWarning[]): Token[] {
    const out: Token[] = [];
    for (const it of this.items) {
      let value: string | null = null;
      for (const prop of it.styleProps) {
        const s = overrides.windowStyle.get(prop);
        if (!s) continue;
        const c = this.convert(it.category, s.value);
        if (c.ok && c.ref === it.token) continue;
        if (c.ok) {
          value = c.value;
          break;
        }
        warnings.push({ file: s.file, line: s.line, message: `${c.warning}（Window の Style の ${prop}）` });
      }
      if (value === null) {
        for (const key of it.systemKeys) {
          const r = overrides.system(key);
          if (!r) continue;
          if (r.converted.ok && r.converted.ref === it.token) continue;
          if (r.converted.ok) {
            value = r.converted.value;
            break;
          }
          warnings.push({ file: r.file, line: r.line, message: `${r.converted.warning}（${key}）` });
        }
      }
      out.push(value === null ? { name: it.token, value: it.value, kind: 'standard', origin: 'wpf-default', note: 'WPF 標準' } : { name: it.token, value, kind: 'standard', origin: 'defined' });
    }
    return out;
  }

  private convert(category: StandardCategory, raw: string): Converted {
    if (category === 'font-family') return this.converter.fontFamily(raw);
    if (category === 'font-size') return this.converter.fontSize(raw);
    return this.converter.color(raw);
  }
}
