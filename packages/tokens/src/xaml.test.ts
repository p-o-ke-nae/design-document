import { describe, expect, it } from 'vitest';
import { app, dict, merged, messages, readXaml, tok } from './test-helpers.ts';

describe('XAML の辞書の直下の要素（XRES）', () => {
  it('[DD-TOKENGEN-XRES-P001] [DD-TOKENGEN-XRES-T001] [DD-TOKENGEN-XRES-T002] [DD-TOKENGEN-XRES-T003] キーの無い Window の Style は Setter を標準の項目の上書きとして読む', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`
      <Style TargetType="{x:Type Window}">
        <Setter Property="Background" Value="#123456" />
        <Setter Property="TextElement.FontFamily" Value="Meiryo UI" />
        <Setter Property="FontSize" Value="14" />
        <Setter Property="Margin" Value="4" />
      </Style>`),
    });
    expect(tok(r, '--wpf-window-bg')).toBe('#123456');
    expect(tok(r, '--wpf-font-family')).toBe('"Meiryo UI"');
    expect(tok(r, '--wpf-font-size')).toBe('14px');
    expect(r.tokens.find((t) => t.name === '--wpf-window-bg')?.origin).toBe('defined');
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('[DD-TOKENGEN-XRES-P002] [DD-TOKENGEN-XRES-T004] キーの無いほかの Style は読み飛ばす（数えない）', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`<Style TargetType="Button"><Setter Property="Background" Value="Red" /></Style>
      <Style TargetType="Window" BasedOn="{StaticResource X}"><Setter Property="Foreground" Value="Red" /></Style>`),
    });
    expect(r.skipped).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(tok(r, '--wpf-button-bg')).toBe('#dddddd');
    // TargetType="Window" without x:Type also counts as the Window style.
    expect(tok(r, '--wpf-window-fg')).toBe('#ff0000');
  });

  it('[DD-TOKENGEN-XRES-P003] [DD-TOKENGEN-XRES-T005] [DD-TOKENGEN-XRES-T006] Color・SolidColorBrush・FontFamily・Thickness・CornerRadius を変換する', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`
      <Color x:Key="AccentColor">#FF0078D4</Color>
      <SolidColorBrush x:Key="AccentBrush" Color="{StaticResource AccentColor}" />
      <SolidColorBrush x:Key="Overlay" Color="#000000" Opacity="0.5" />
      <FontFamily x:Key="UIFont">Yu Gothic UI, sans-serif</FontFamily>
      <Thickness x:Key="CardPadding">12,8</Thickness>
      <CornerRadius x:Key="CardRadius">4</CornerRadius>`),
    });
    expect(r.tokens.filter((t) => t.kind !== 'standard').map((t) => [t.name, t.value, t.kind])).toEqual([
      ['--accent-brush', 'var(--accent-color)', 'color'],
      ['--accent-color', '#0078d4', 'color'],
      ['--overlay', '#00000080', 'color'],
      ['--ui-font', '"Yu Gothic UI", sans-serif', 'font-family'],
      ['--card-padding', '8px 12px 8px 12px', 'thickness'],
      ['--card-radius', '4px', 'corner-radius'],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('[DD-TOKENGEN-XRES-P004] [DD-TOKENGEN-XRES-T007] [DD-TOKENGEN-XRES-T008] Double はキーが FontSize・TextSize を含むか fontSizeKeys にあれば文字サイズにする', async () => {
    const r = await readXaml(
      {
        'app/App.xaml': app(`
      <sys:Double x:Key="BodyFontSize">14</sys:Double>
      <sys:Double x:Key="CaptionTextSize">9pt</sys:Double>
      <sys:Double x:Key="Body">13</sys:Double>`),
      },
      { fontSizeKeys: ['Body'] },
    );
    expect(tok(r, '--body-font-size')).toBe('14px');
    expect(tok(r, '--caption-text-size')).toBe('12px');
    expect(tok(r, '--body')).toBe('13px');
    expect(r.tokens.find((t) => t.name === '--body')?.kind).toBe('font-size');
  });

  it('[DD-TOKENGEN-XRES-P005] [DD-TOKENGEN-XRES-T009] それ以外の Double は対象外として数える', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<sys:Double x:Key="Spacing">8</sys:Double>') });
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it('[DD-TOKENGEN-XRES-P006] [DD-TOKENGEN-XRES-T010] グラデーション・画像のブラシは warning で出さない', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`
      <LinearGradientBrush x:Key="HeaderBrush"><GradientStop Color="Red" Offset="0" /></LinearGradientBrush>
      <ImageBrush x:Key="Logo" ImageSource="logo.png" />`),
    });
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(messages(r)).toEqual(['グラデーション・画像のブラシは変換しません: HeaderBrush（LinearGradientBrush）', 'グラデーション・画像のブラシは変換しません: Logo（ImageBrush）']);
    expect(r.warnings[0]).toMatchObject({ file: 'app/App.xaml', line: 5 });
  });

  it('[DD-TOKENGEN-XRES-P007] [DD-TOKENGEN-XRES-T011] キーのある Style・ControlTemplate・DataTemplate は読まない（数えない）', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`
      <Style x:Key="PrimaryButton" TargetType="Button"><Setter Property="Background" Value="Red" /></Style>
      <ControlTemplate x:Key="T" TargetType="Button"><Border /></ControlTemplate>
      <DataTemplate x:Key="D"><TextBlock /></DataTemplate>`),
    });
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(r.skipped).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('[DD-TOKENGEN-XRES-P008] [DD-TOKENGEN-XRES-T012] その他の型（sys:String・sys:Double 以外の名前空間の Double など）は対象外として数える', async () => {
    const r = await readXaml({
      'app/App.xaml': app(`
      <sys:String x:Key="AppTitle">受注</sys:String>
      <local:Double xmlns:local="clr-namespace:OrderApp" x:Key="HeaderFontSize">20</local:Double>
      <BooleanToVisibilityConverter x:Key="BoolToVis" />`),
    });
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(r.skipped).toBe(3);
  });

  it('改行が CRLF でも warning の行番号はずれない', async () => {
    const body = `
      <Color x:Key="A">#111111</Color>
      <LinearGradientBrush x:Key="HeaderBrush" />`;
    const r = await readXaml({ 'app/App.xaml': app(body).replace(/\n/g, '\r\n') });
    expect(r.warnings).toEqual([{ file: 'app/App.xaml', line: 6, message: 'グラデーション・画像のブラシは変換しません: HeaderBrush（LinearGradientBrush）' }]);
  });
});

describe('トークン名（KEBAB）', () => {
  it('[DD-TOKENGEN-KEBAB-P001] [DD-TOKENGEN-KEBAB-T003] [DD-TOKENGEN-KEBAB-T005] [DD-TOKENGEN-KEBAB-T008] 略語で区切っても英数字が残らないキーは warning で出さない', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<Color x:Key="ÄÖÜü">#000000</Color>') });
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(messages(r)).toEqual(['キーから名前を作れません: ÄÖÜü']);
  });

  it('[DD-TOKENGEN-KEBAB-P002] [DD-TOKENGEN-KEBAB-T010] 略語を区切ると同じ名前になるキーは後のキーを捨てる', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<FontFamily x:Key="UIFont">A</FontFamily>\n<FontFamily x:Key="UI_Font">B</FontFamily>') });
    expect(tok(r, '--ui-font')).toBe('"A"');
    expect(messages(r)).toEqual(['同じ名前になるキーがあります（後のキーを捨てます）: UI_Font（UIFont と同じ --ui-font）']);
  });

  it('[DD-TOKENGEN-KEBAB-P003] [DD-TOKENGEN-KEBAB-T001] [DD-TOKENGEN-KEBAB-T002] [DD-TOKENGEN-KEBAB-T006] [DD-TOKENGEN-KEBAB-T007] [DD-TOKENGEN-KEBAB-T009] [DD-TOKENGEN-KEBAB-T011] 略語の最後の大文字の前で区切って名前を決める', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<sys:Double x:Key="UIFontSize">12</sys:Double>\n<Color x:Key="HTMLLink.Color_2">Blue</Color>') }, { prefix: 'wpf' });
    expect(tok(r, '--wpf-ui-font-size')).toBe('12px');
    expect(tok(r, '--wpf-html-link-color-2')).toBe('#0000ff');
    expect(r.warnings).toEqual([]);
  });

  it('[DD-TOKENGEN-KEBAB-P004] [DD-TOKENGEN-KEBAB-T004] 略語が無く英数字が残らないキーは warning で出さない', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<Color x:Key="強調色">#000000</Color>') });
    expect(r.tokens.filter((t) => t.kind !== 'standard')).toEqual([]);
    expect(messages(r)).toEqual(['キーから名前を作れません: 強調色']);
  });

  it('[DD-TOKENGEN-KEBAB-P005] 区切り文字の違いで同じ名前になるキーは後のキーを捨てる', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<Color x:Key="AccentBrush">#111111</Color>\n<Color x:Key="Accent.Brush">#222222</Color>') });
    expect(tok(r, '--accent-brush')).toBe('#111111');
    expect(messages(r)).toEqual(['同じ名前になるキーがあります（後のキーを捨てます）: Accent.Brush（AccentBrush と同じ --accent-brush）']);
  });

  it('[DD-TOKENGEN-KEBAB-P006] 小文字・数字の後の大文字の前で区切り 区切り文字は - にする', async () => {
    const r = await readXaml({ 'app/App.xaml': app('<Color x:Key="AccentBrush">#111111</Color>\n<Color x:Key="Brush.Accent_2">#222222</Color>\n<Color x:Key="Row2Back Color">#333333</Color>') });
    expect(r.tokens.filter((t) => t.kind !== 'standard').map((t) => t.name)).toEqual(['--accent-brush', '--brush-accent-2', '--row2-back-color']);
  });
});

/** Repository for the URI cases: entry project OrderApp, another project Shared.Styles in the same repository. */
function uriRepo(source: string, extra: Record<string, string> = {}) {
  return {
    'app/OrderApp.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>',
    'app/App.xaml': app(`${merged(source)}\n<Color x:Key="Base">#111111</Color>`),
    'app/Themes/Colors.xaml': dict('<Color x:Key="Accent">#0078D4</Color>'),
    'lib/Lib.csproj': '<Project><PropertyGroup><AssemblyName>Shared.Styles</AssemblyName></PropertyGroup></Project>',
    'lib/Themes/Shared.xaml': dict('<Color x:Key="Accent">#00FF00</Color>'),
    'lib/bin/Debug/Other.csproj': '<Project><PropertyGroup><AssemblyName>Hidden</AssemblyName></PropertyGroup></Project>',
    ...extra,
  };
}

type UriExpect = { follows: string; accent: string } | { warning: string };

async function uriCase(uri: string, want: UriExpect) {
  const r = await readXaml(uriRepo(uri));
  expect(tok(r, '--base')).toBe('#111111');
  if ('warning' in want) {
    expect(r.warnings).toEqual([{ file: 'app/App.xaml', line: 5, message: want.warning }]);
    expect(r.sources.map((s) => s.path)).toEqual(['app/App.xaml']);
    expect(tok(r, '--accent')).toBeUndefined();
  } else {
    expect(r.warnings).toEqual([]);
    expect(r.sources.map((s) => s.path)).toEqual(['app/App.xaml', want.follows]);
    expect(tok(r, '--accent')).toBe(want.accent);
  }
}

describe('XAML の Source の解決（XURI）', () => {
  it('[DD-TOKENGEN-XURI-P001] [DD-TOKENGEN-XURI-T001] [DD-TOKENGEN-XURI-T002] [DD-TOKENGEN-XURI-T004] [DD-TOKENGEN-XURI-T005] [DD-TOKENGEN-XURI-T006] pack の component が外部のアセンブリ', () => uriCase('pack://application:,,,/PresentationFramework.Aero2;component/themes/aero2.normalcolor.xaml', { warning: '外部のアセンブリは辿りません: pack://application:,,,/PresentationFramework.Aero2;component/themes/aero2.normalcolor.xaml' }));
  it('[DD-TOKENGEN-XURI-P002] [DD-TOKENGEN-XURI-T013] [DD-TOKENGEN-XURI-T016] pack の component が辿っている途中のファイル', () => uriCase('pack://application:,,,/OrderApp;component/App.xaml', { warning: '循環して参照しています: pack://application:,,,/OrderApp;component/App.xaml' }));
  it('[DD-TOKENGEN-XURI-P003] [DD-TOKENGEN-XURI-T017] [DD-TOKENGEN-XURI-T018] pack の component の先が無い', () => uriCase('pack://application:,,,/Shared.Styles;component/Themes/Missing.xaml', { warning: 'ファイルが読めません: pack://application:,,,/Shared.Styles;component/Themes/Missing.xaml（lib/Themes/Missing.xaml）' }));
  it('[DD-TOKENGEN-XURI-P004] [DD-TOKENGEN-XURI-T007] [DD-TOKENGEN-XURI-T019] pack の component を同じリポジトリの csproj から辿る（版・公開キー付き）', () => uriCase('pack://application:,,,/Shared.Styles;v1.0.0.0;component/Themes/Shared.xaml', { follows: 'lib/Themes/Shared.xaml', accent: '#00ff00' }));
  it('[DD-TOKENGEN-XURI-P005] [DD-TOKENGEN-XURI-T008] [DD-TOKENGEN-XURI-T009] [DD-TOKENGEN-XURI-T014] pack のルート相対が辿っている途中のファイル', () => uriCase('pack://application:,,,/App.xaml', { warning: '循環して参照しています: pack://application:,,,/App.xaml' }));
  it('[DD-TOKENGEN-XURI-P006] pack のルート相対の先が無い', () => uriCase('pack://application:,,,/Themes/Missing.xaml', { warning: 'ファイルが読めません: pack://application:,,,/Themes/Missing.xaml（app/Themes/Missing.xaml）' }));
  it('[DD-TOKENGEN-XURI-P007] pack のルート相対を入口の csproj の場所から辿る', () => uriCase('pack://application:,,,/Themes/Colors.xaml', { follows: 'app/Themes/Colors.xaml', accent: '#0078d4' }));
  it('[DD-TOKENGEN-XURI-P008] [DD-TOKENGEN-XURI-T010] [DD-TOKENGEN-XURI-T011] pack の後がほかのスキーム', () => uriCase('pack://application:,,,http://example.com/x.xaml', { warning: '対応していない URI です: pack://application:,,,http://example.com/x.xaml' }));
  it('[DD-TOKENGEN-XURI-P009] [DD-TOKENGEN-XURI-T012] [DD-TOKENGEN-XURI-T015] pack の後の相対が辿っている途中のファイル', () => uriCase('pack://application:,,,App.xaml', { warning: '循環して参照しています: pack://application:,,,App.xaml' }));
  it('[DD-TOKENGEN-XURI-P010] pack の後の相対の先が無い', () => uriCase('pack://application:,,,Themes/Missing.xaml', { warning: 'ファイルが読めません: pack://application:,,,Themes/Missing.xaml（app/Themes/Missing.xaml）' }));
  it('[DD-TOKENGEN-XURI-P011] pack の後の相対を XAML のある場所から辿る', () => uriCase('pack://application:,,,Themes/Colors.xaml', { follows: 'app/Themes/Colors.xaml', accent: '#0078d4' }));
  it('[DD-TOKENGEN-XURI-P012] [DD-TOKENGEN-XURI-T003] component が外部のアセンブリ（bin の下の csproj は索引に入れない）', () => uriCase('/Hidden;component/Themes/X.xaml', { warning: '外部のアセンブリは辿りません: /Hidden;component/Themes/X.xaml' }));
  it('[DD-TOKENGEN-XURI-P013] component が辿っている途中のファイル', () => uriCase('/orderapp;component/app.xaml', { warning: '循環して参照しています: /orderapp;component/app.xaml' }));
  it('[DD-TOKENGEN-XURI-P014] component の先が無い', () => uriCase('Shared.Styles;component/Themes/Missing.xaml', { warning: 'ファイルが読めません: Shared.Styles;component/Themes/Missing.xaml（lib/Themes/Missing.xaml）' }));
  it('[DD-TOKENGEN-XURI-P015] component を同じリポジトリの csproj から辿る（大文字小文字を区別しない）', () => uriCase('/shared.styles;component/themes/shared.xaml', { follows: 'lib/Themes/Shared.xaml', accent: '#00ff00' }));
  it('[DD-TOKENGEN-XURI-P016] ルート相対が辿っている途中のファイル', () => uriCase('/App.xaml', { warning: '循環して参照しています: /App.xaml' }));
  it('[DD-TOKENGEN-XURI-P017] ルート相対の先が無い', () => uriCase('/Themes/Missing.xaml', { warning: 'ファイルが読めません: /Themes/Missing.xaml（app/Themes/Missing.xaml）' }));
  it('[DD-TOKENGEN-XURI-P018] ルート相対を入口の csproj の場所から辿る', () => uriCase('/Themes/Colors.xaml', { follows: 'app/Themes/Colors.xaml', accent: '#0078d4' }));
  it('[DD-TOKENGEN-XURI-P019] ほかのスキーム', () => uriCase('https://example.com/theme.xaml', { warning: '対応していない URI です: https://example.com/theme.xaml' }));
  it('[DD-TOKENGEN-XURI-P020] 相対が辿っている途中のファイル', () => uriCase('./App.xaml', { warning: '循環して参照しています: ./App.xaml' }));
  it('[DD-TOKENGEN-XURI-P021] 相対の先が無い', () => uriCase('Themes/Missing.xaml', { warning: 'ファイルが読めません: Themes/Missing.xaml（app/Themes/Missing.xaml）' }));
  it('[DD-TOKENGEN-XURI-P022] 相対を XAML のある場所から辿り 実在の大文字小文字で記録する', () => uriCase('themes/COLORS.xaml', { follows: 'app/Themes/Colors.xaml', accent: '#0078d4' }));

  it('[DD-TOKENGEN-XURI-T016] 入れ子の辞書から入口へ戻る循環も warning にする', async () => {
    const r = await readXaml(uriRepo('Themes/A.xaml', { 'app/Themes/A.xaml': dict(`${merged('../App.xaml')}\n<Color x:Key="A">#AAAAAA</Color>`) }));
    expect(tok(r, '--a')).toBe('#aaaaaa');
    expect(r.warnings).toEqual([{ file: 'app/Themes/A.xaml', line: 3, message: '循環して参照しています: ../App.xaml' }]);
  });
});
