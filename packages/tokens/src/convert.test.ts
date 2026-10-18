import { describe, expect, it } from 'vitest';
import { Aero2Defaults, STANDARD_ITEMS } from './xaml/aero2.ts';
import { kebabKey, XamlConverter } from './xaml/convert.ts';
import { ResourceDict, type XamlResource } from './xaml/reader.ts';
import { app, dict, merged, messages, readXaml, tok } from './test-helpers.ts';

const conv = new XamlConverter((key) => (key === 'Accent' ? '--accent' : null));

describe('値の変換（XamlConverter）', () => {
  it.each([
    ['#FF0078D4', '#0078d4'],
    ['#800078D4', '#0078d480'],
    ['#0078D4', '#0078d4'],
    ['#8F00', '#ff000088'],
    ['#F00', '#ff0000'],
    ['Red', '#ff0000'],
    ['CornflowerBlue', '#6495ed'],
    ['Transparent', '#ffffff00'],
    ['{StaticResource Accent}', 'var(--accent)'],
    ['{DynamicResource ResourceKey=Accent}', 'var(--accent)'],
    ['{x:Static SystemColors.HighlightColor}', 'var(--wpf-highlight-bg)'],
    ['{StaticResource {x:Static SystemColors.WindowBrushKey}}', 'var(--wpf-window-bg)'],
  ])('Color %s → %s', (raw, out) => {
    expect(conv.color(raw)).toMatchObject({ ok: true, value: out });
  });

  it.each([
    ['sc#1,0,0,0', '色の値を読めません: sc#1,0,0,0'],
    ['NoSuchColor', '色の値を読めません: NoSuchColor'],
    ['{StaticResource Missing}', '参照先のリソースがありません: Missing'],
    ['{x:Static SystemColors.MenuBarBrushKey}', '対応していないシステムのリソースです: MenuBarBrushKey'],
    ['{Binding Path=Color}', '実行時にしか決まらない値です: {Binding Path=Color}'],
  ])('Color %s は warning', (raw, warning) => {
    expect(conv.color(raw)).toEqual({ ok: false, warning });
  });

  it('SolidColorBrush は Opacity を A に掛け、参照の色には掛けない', () => {
    expect(conv.brush({ color: '#FF0000', opacity: '0.5' })).toEqual({ ok: true, value: '#ff000080' });
    expect(conv.brush({ color: '#80FF0000', opacity: '0.5' })).toEqual({ ok: true, value: '#ff000040' });
    expect(conv.brush({ color: '#FF0000', opacity: '1' })).toEqual({ ok: true, value: '#ff0000' });
    expect(conv.brush({ color: '{StaticResource Accent}', opacity: '1' })).toEqual({ ok: true, value: 'var(--accent)', ref: '--accent' });
    expect(conv.brush({ color: '{StaticResource Accent}', opacity: '0.4' })).toEqual({ ok: false, warning: '参照の色に Opacity は掛けられません' });
    expect(conv.brush({})).toMatchObject({ ok: false });
  });

  it('FontFamily は名前を "…" で囲み 総称は囲まない', () => {
    expect(conv.fontFamily(' Segoe UI , Yu Gothic UI,sans-serif ')).toEqual({ ok: true, value: '"Segoe UI", "Yu Gothic UI", sans-serif' });
    expect(conv.fontFamily('Consolas, Monospace')).toEqual({ ok: true, value: '"Consolas", monospace' });
    expect(conv.fontFamily(' , ')).toMatchObject({ ok: false, warning: '書体を読めません: （空）' });
  });

  it.each([
    ['14', '14px'],
    ['14px', '14px'],
    ['10.5pt', '14px'],
    ['9pt', '12px'],
    ['1in', '96px'],
    ['1cm', '37.8px'],
    ['13.333', '13.33px'],
  ])('文字サイズ %s → %s', (raw, out) => {
    expect(conv.fontSize(raw)).toEqual({ ok: true, value: out });
  });

  it('文字サイズが数値でなければ warning', () => {
    expect(conv.fontSize('Large')).toEqual({ ok: false, warning: '文字サイズを読めません: Large' });
  });

  it.each([
    ['4', '4px 4px 4px 4px'],
    ['12,8', '8px 12px 8px 12px'],
    ['1,2,3,4', '2px 3px 4px 1px'],
    ['0 4 0 4', '4px 0 4px 0'],
  ])('Thickness %s → %s（上 右 下 左）', (raw, out) => {
    expect(conv.thickness(raw)).toEqual({ ok: true, value: out });
  });

  it('Thickness の値の数が 3 などは warning', () => {
    expect(conv.thickness('1,2,3')).toEqual({ ok: false, warning: '余白の値を読めません: 1,2,3' });
  });

  it('CornerRadius は 1 値・4 値だけ', () => {
    expect(conv.cornerRadius('4')).toEqual({ ok: true, value: '4px' });
    expect(conv.cornerRadius('4,4,0,0')).toEqual({ ok: true, value: '4px 4px 0 0' });
    expect(conv.cornerRadius('4,4')).toEqual({ ok: false, warning: '角丸の値を読めません: 4,4' });
    expect(conv.cornerRadius('1,2,3')).toEqual({ ok: false, warning: '角丸の値を読めません: 1,2,3' });
  });

  it('kebabKey の例', () => {
    expect(kebabKey('AccentBrush')).toBe('accent-brush');
    expect(kebabKey('UIFontSize')).toBe('ui-font-size');
    expect(kebabKey('Brush.Accent_2')).toBe('brush-accent-2');
  });
});

describe('標準の項目（Aero2Defaults）', () => {
  it('上書きの元が無ければ Aero2 の値に WPF 標準の印を付ける', () => {
    const warnings: never[] = [];
    const out = new Aero2Defaults(new XamlConverter()).apply({ windowStyle: new Map(), system: () => null }, warnings);
    expect(out.map((t) => [t.name, t.value])).toEqual(STANDARD_ITEMS.map((i) => [i.token, i.value]));
    expect(out.every((t) => t.origin === 'wpf-default' && t.note === 'WPF 標準' && t.kind === 'standard')).toBe(true);
    expect(out.find((t) => t.name === '--wpf-input-bg')?.value).toBe('var(--wpf-window-bg)');
    expect(warnings).toEqual([]);
  });

  it('Window の Style の Setter がシステムのリソースより優先し、値は変換して参照は var にする', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`
      <SolidColorBrush x:Key="{x:Static SystemColors.WindowBrushKey}" Color="#EEEEEE" />
      <SolidColorBrush x:Key="{x:Static SystemColors.HighlightBrushKey}" Color="{StaticResource Accent}" />
      <Color x:Key="Accent">#0078D4</Color>
      <FontFamily x:Key="{x:Static SystemFonts.MessageFontFamilyKey}">Meiryo UI</FontFamily>
      <Style TargetType="Window">
        <Setter Property="Background" Value="{StaticResource Accent}" />
        <Setter Property="FontSize" Value="Huge" />
      </Style>`),
    });
    expect(tok(r, '--wpf-window-bg')).toBe('var(--accent)');
    expect(tok(r, '--wpf-input-bg')).toBe('#eeeeee');
    expect(tok(r, '--wpf-highlight-bg')).toBe('var(--accent)');
    expect(tok(r, '--wpf-font-family')).toBe('"Meiryo UI"');
    expect(tok(r, '--wpf-font-size')).toBe('12px');
    expect(r.tokens.find((t) => t.name === '--wpf-font-size')?.note).toBe('WPF 標準');
    expect(messages(r)).toEqual(['文字サイズを読めません: Huge（Window の Style の FontSize）']);
    // System keys are not output as ordinary tokens.
    expect(r.tokens.filter((t) => t.kind !== 'standard').map((t) => t.name)).toEqual(['--accent']);
  });

  it('定義したトークンが標準の項目と同じ名前なら定義を出して warning', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<Color x:Key="WindowBg">#ABCDEF</Color>') }, { prefix: 'wpf' });
    expect(r.tokens.filter((t) => t.name === '--wpf-window-bg')).toEqual([{ name: '--wpf-window-bg', value: '#abcdef', kind: 'color', origin: 'defined' }]);
    expect(messages(r)).toEqual(['標準の項目と同じ名前です: WindowBg（--wpf-window-bg）']);
  });

  it('出力は種類（色 → 書体 → 文字サイズ → 余白 → 角丸 → 標準の項目）→ 名前の順', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`<CornerRadius x:Key="R">2</CornerRadius><Thickness x:Key="M">1</Thickness><sys:Double x:Key="BFontSize">10</sys:Double>
      <FontFamily x:Key="F">A</FontFamily><Color x:Key="Z">Red</Color><Color x:Key="A">Blue</Color>`),
    });
    expect(r.tokens.map((t) => t.name).slice(0, 7)).toEqual(['--a', '--z', '--f', '--b-font-size', '--m', '--r', '--wpf-button-bg']);
  });
});

describe('同じキーの優先順（ResourceDict.lookup）', () => {
  const res = (key: string, file: string): XamlResource => ({ key, type: 'Color', raw: '#000000', element: 'Color', file, line: 1 });
  const mk = (file: string, keys: string[], mergedDicts: ResourceDict[] = []) => {
    const d = new ResourceDict(file);
    for (const k of keys) {
      d.own.set(k, res(k, file));
      d.defs.push(res(k, file));
    }
    d.merged.push(...mergedDicts);
    return d;
  };

  it('自身の定義 → merged を後ろから（入れ子も同じ）', () => {
    const inner = mk('inner', ['K', 'N']);
    const a = mk('a', ['K', 'M'], [inner]);
    const b = mk('b', ['K']);
    const root = mk('root', ['O'], [a, b]);
    expect(root.lookup('O')?.file).toBe('root');
    expect(root.lookup('K')?.file).toBe('b');
    expect(root.lookup('M')?.file).toBe('a');
    expect(root.lookup('N')?.file).toBe('inner');
    expect(root.lookup('X')).toBeNull();
  });

  it('後の辞書・後の sources が勝ち 負けた定義を数える', async () => {
    const r = await readXaml(
      {
        'app/App.xaml': app(`${merged('A.xaml', 'B.xaml')}\n<Color x:Key="Own">#000001</Color>`),
        'app/A.xaml': dict('<Color x:Key="K">#00000A</Color><Color x:Key="Own">#00000F</Color>'),
        'app/B.xaml': dict('<Color x:Key="K">#00000B</Color><SolidColorBrush x:Key="Ref" Color="{StaticResource L}" />'),
        'app/Second.xaml': dict('<Color x:Key="L">#00000C</Color><Color x:Key="K">#00000D</Color>'),
      },
      { sources: ['app/App.xaml', 'app/Second.xaml'] },
    );
    expect(tok(r, '--own')).toBe('#000001');
    expect(tok(r, '--k')).toBe('#00000d');
    // References are resolved over the whole set.
    expect(tok(r, '--ref')).toBe('var(--l)');
    expect(r.dropped).toBe(3);
    expect(r.sources.map((s) => s.path)).toEqual(['app/App.xaml', 'app/A.xaml', 'app/B.xaml', 'app/Second.xaml']);
  });

  it('参照先が出ないトークンは辿って落とす', async () => {
    const r = await readXaml({
      'app/App.xaml': app('<SolidColorBrush x:Key="A" Color="{StaticResource B}" /><SolidColorBrush x:Key="B" Color="{StaticResource C}" /><Color x:Key="C">{Binding X}</Color>'),
    });
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(messages(r)).toEqual(['実行時にしか決まらない値です: {Binding X}', '参照先のリソースがありません: C', '参照先のリソースがありません: B']);
  });
});
