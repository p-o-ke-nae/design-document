import { describe, expect, it } from 'vitest';
import { parseConfig } from '@ddv/core';
import { MemoryTokenFs } from './fs.ts';
import { formatReport, generateTokens, hasErrors } from './generate.ts';
import { configHash, sha256Hex, TOKEN_FORMAT } from './schema.ts';
import { app, cssSet, xamlSet } from './test-helpers.ts';
import { parseHeader } from './writer.ts';

const WPF_BASE = '/* base */\r\nbody { margin: 0; }\r\n';

const XAML_OK = { 'app/App.xaml': app('<Color x:Key="Accent">#0078D4</Color>') };
const XAML_WARN = { 'app/App.xaml': app('<Color x:Key="Accent">#0078D4</Color>\n<Color x:Key="Bad">sc#1,0,0,0</Color>') };
const CSS_OK = { 'web/app/globals.css': ':root { --accent: #0078d4; }\n.card { color: var(--accent); }' };
const CSS_WARN = { 'web/app/globals.css': ':root { --accent: #0078d4; }\n.card { color: var(--accent); @apply p-4; }' };

const xamlCfg = (over = {}) => {
  const { out: _o, optional: _p, fontSizeKeys: _f, classes: _c, elements: _e, overrides: _v, ...rest } = xamlSet(over);
  return rest;
};
const cssCfg = (over = {}) => {
  const { out: _o, optional: _p, fontSizeKeys: _f, prefix: _x, ...rest } = cssSet(over);
  return rest;
};
const config = (tokens: unknown[]) => parseConfig({ tokens });

async function run(files: Record<string, string>, tokens: unknown[], name?: string) {
  const fs = new MemoryTokenFs(files);
  const report = await generateTokens(config(tokens), fs, { name, wpfBaseCss: WPF_BASE });
  return { fs, report };
}

describe('ddv tokens generate（TGEN）', () => {
  it('[DD-TOKENGEN-TGEN-P001] [DD-TOKENGEN-TGEN-T001] [DD-TOKENGEN-TGEN-T002] 有効なセットが無ければ error: tokens が未設定です', async () => {
    const { fs, report } = await run(XAML_OK, []);
    expect(report.errors).toEqual(['tokens が未設定です']);
    expect(hasErrors(report)).toBe(true);
    expect(fs.writes).toEqual([]);
    const invalid = await run(XAML_OK, [{ name: 'Bad Name', kind: 'xaml', sources: ['app/App.xaml'] }, 'legacy']);
    expect(invalid.report.errors).toEqual(['tokens の name は小文字の英数字とハイフンで書いてください: Bad Name', 'tokens が未設定です']);
    expect(invalid.report.warnings).toEqual(['tokens の文字列の項目は使われなくなりました（無視します）: legacy']);
  });

  it('[DD-TOKENGEN-TGEN-P002] [DD-TOKENGEN-TGEN-T003] [DD-TOKENGEN-TGEN-T004] [DD-TOKENGEN-TGEN-T008] [DD-TOKENGEN-TGEN-T010] すべてのセットのうち入口が読めないセットは error で書かず ほかは書く', async () => {
    const { fs, report } = await run(CSS_OK, [xamlCfg(), cssCfg()]);
    expect(report.sets.map((s) => [s.name, s.errors, s.written])).toEqual([
      ['order-wpf', ['生成元のファイルを読めません: app/App.xaml（見つからないか、読み取れません）'], false],
      ['web', [], true],
    ]);
    expect(hasErrors(report)).toBe(true);
    expect(fs.writes).toEqual(['docs/mocks/_tokens/web.css']);
    expect(formatReport(report)).toContain('error: order-wpf: 生成元のファイルを読めません: app/App.xaml（見つからないか、読み取れません）');
  });

  it('[DD-TOKENGEN-TGEN-P003] [DD-TOKENGEN-TGEN-T011] [DD-TOKENGEN-TGEN-T012] すべてのセットで変換しなかった項目があれば warning を表示して書く', async () => {
    const { fs, report } = await run({ ...XAML_WARN, ...CSS_WARN }, [xamlCfg(), cssCfg({ classes: ['card'] })]);
    expect(hasErrors(report)).toBe(false);
    expect(fs.writes).toEqual(['docs/mocks/_tokens/order-wpf.css', 'docs/mocks/_tokens/web.css', 'docs/mocks/_tokens/wpf-base.css']);
    expect(formatReport(report).split('\n')).toEqual([
      'order-wpf: トークン 1 件・共通クラス 0 件・標準の項目 16 件（WPF 標準 16 件）・負けた定義 0 件 → docs/mocks/_tokens/order-wpf.css',
      '  warning: app/App.xaml:5 色の値を読めません: sc#1,0,0,0',
      'web: トークン 1 件・共通クラス 1 件・標準の項目 0 件（WPF 標準 0 件）・負けた定義 0 件 → docs/mocks/_tokens/web.css',
      '  warning: web/app/globals.css:2 @apply は展開しません: .card',
    ]);
  });

  it('[DD-TOKENGEN-TGEN-P004] [DD-TOKENGEN-TGEN-T013] すべてのセットを書き xaml のセットがあれば wpf-base.css を隣に写す（同じ内容なら書かない）', async () => {
    const { fs, report } = await run({ ...XAML_OK, ...CSS_OK }, [xamlCfg(), cssCfg({ classes: ['card'] })]);
    expect(report.sets.every((s) => s.warnings.length === 0 && s.written)).toBe(true);
    expect(fs.files.get('docs/mocks/_tokens/wpf-base.css')).toBe('/* base */\nbody { margin: 0; }\n');
    const again = await generateTokens(config([xamlCfg(), cssCfg({ classes: ['card'] })]), fs, { wpfBaseCss: WPF_BASE });
    expect(again.written).toEqual([]);
    expect(again.sets.map((s) => s.written)).toEqual([false, false]);
  });

  it('[DD-TOKENGEN-TGEN-P005] [DD-TOKENGEN-TGEN-T005] [DD-TOKENGEN-TGEN-T006] --name のセットが無ければ error', async () => {
    const { fs, report } = await run(XAML_OK, [xamlCfg()], 'nope');
    expect(report.errors).toEqual(['tokens に nope のセットがありません']);
    expect(fs.writes).toEqual([]);
  });

  it('[DD-TOKENGEN-TGEN-P006] [DD-TOKENGEN-TGEN-T007] [DD-TOKENGEN-TGEN-T009] --name のセットだけを対象にし 入口が読めなければ error', async () => {
    const { fs, report } = await run(CSS_OK, [xamlCfg(), cssCfg()], 'order-wpf');
    expect(report.sets.map((s) => s.name)).toEqual(['order-wpf']);
    expect(report.sets[0].errors).toHaveLength(1);
    expect(fs.writes).toEqual([]);
  });

  it('[DD-TOKENGEN-TGEN-P007] --name のセットで変換しなかった項目があれば warning を表示して書く', async () => {
    const { fs, report } = await run({ ...XAML_OK, ...CSS_WARN }, [xamlCfg(), cssCfg({ classes: ['card'] })], 'web');
    expect(report.sets.map((s) => [s.name, s.warnings.length])).toEqual([['web', 1]]);
    expect(fs.writes).toEqual(['docs/mocks/_tokens/web.css']);
  });

  it('[DD-TOKENGEN-TGEN-P008] --name のセットだけを書く', async () => {
    const { fs, report } = await run({ ...XAML_OK, ...CSS_OK }, [xamlCfg(), cssCfg()], 'order-wpf');
    expect(hasErrors(report)).toBe(false);
    expect(fs.writes).toEqual(['docs/mocks/_tokens/order-wpf.css', 'docs/mocks/_tokens/wpf-base.css']);
  });
});

describe('基本設計の生成の流れ（GEN）', () => {
  it('[BD-TOKENS-GEN-P001] [BD-TOKENS-GEN-T001] [BD-TOKENS-GEN-T002] [BD-TOKENS-GEN-S001] 対象のセットが無ければ error（未設定・名前が無い）', async () => {
    expect((await run(XAML_OK, [])).report.errors).toEqual(['tokens が未設定です']);
    expect((await run(XAML_OK, [xamlCfg()], 'x')).report.errors).toEqual(['tokens に x のセットがありません']);
  });

  it('[BD-TOKENS-GEN-P002] [BD-TOKENS-GEN-T003] [BD-TOKENS-GEN-T004] [BD-TOKENS-GEN-S002] [BD-TOKENS-GEN-S003] 生成元を読めないセットは error で出力しない', async () => {
    const { fs, report } = await run({}, [cssCfg()]);
    expect(report.sets[0].errors).toEqual(['生成元のファイルを読めません: web/app/globals.css（見つからないか、読み取れません）']);
    expect(fs.writes).toEqual([]);
  });

  it('[BD-TOKENS-GEN-P003] [BD-TOKENS-GEN-T005] [BD-TOKENS-GEN-T006] [BD-TOKENS-GEN-T008] [BD-TOKENS-GEN-T010] [BD-TOKENS-GEN-T012] [BD-TOKENS-GEN-S004] [BD-TOKENS-GEN-S005] [BD-TOKENS-GEN-S007] [BD-TOKENS-GEN-S009] [BD-TOKENS-GEN-S013] xaml で変換できない値は warning でその項目を出さず 出力を書く', async () => {
    const { fs, report } = await run(XAML_WARN, [xamlCfg()]);
    expect(report.sets[0].warnings.map((w) => w.message)).toEqual(['色の値を読めません: sc#1,0,0,0']);
    const out = fs.files.get('docs/mocks/_tokens/order-wpf.css')!;
    expect(out).toContain('  --accent: #0078d4;\n');
    expect(out).not.toContain('--bad');
    expect(out).toContain('  --wpf-window-bg: #ffffff; /* WPF 標準 */\n');
  });

  it('[BD-TOKENS-GEN-P004] [BD-TOKENS-GEN-T011] [BD-TOKENS-GEN-S010] xaml で変換できない値が無ければ 出力を書き 生成元とハッシュを記録する', async () => {
    const { fs } = await run(XAML_OK, [xamlCfg()]);
    const header = parseHeader(fs.files.get('docs/mocks/_tokens/order-wpf.css')!)!;
    expect(header.sources).toEqual([{ path: 'app/App.xaml', sha256: await sha256Hex(XAML_OK['app/App.xaml']) }]);
  });

  it('[BD-TOKENS-GEN-P005] [BD-TOKENS-GEN-T007] [BD-TOKENS-GEN-T009] [BD-TOKENS-GEN-S006] [BD-TOKENS-GEN-S008] [BD-TOKENS-GEN-S011] css で変換できない値は warning でその項目を出さず 出力を書く', async () => {
    const { fs, report } = await run(CSS_WARN, [cssCfg({ classes: ['card'] })]);
    expect(report.sets[0].warnings.map((w) => w.message)).toEqual(['@apply は展開しません: .card']);
    const out = fs.files.get('docs/mocks/_tokens/web.css')!;
    expect(out).toContain('.card { color: var(--accent); }');
    expect(out).not.toContain('@apply');
  });

  it('[BD-TOKENS-GEN-P006] [BD-TOKENS-GEN-S012] css で変換できない値が無ければ 出力を書き 生成元とハッシュを記録する', async () => {
    const { fs } = await run(CSS_OK, [cssCfg({ classes: ['card'] })]);
    const text = fs.files.get('docs/mocks/_tokens/web.css')!;
    expect(parseHeader(text)?.sources).toEqual([{ path: 'web/app/globals.css', sha256: await sha256Hex(CSS_OK['web/app/globals.css']) }]);
  });
});

describe('出力（TokenWriter）', () => {
  it('ヘッダ・:root・規則を LF で書き、ヘッダを読み戻せる', async () => {
    const files = { 'web/app/globals.css': '@theme inline { --font-sans: var(--x); }\r\n.card { color: red; }\r\n@media (min-width: 1px) { .card { color: blue; } }' };
    const { fs } = await run(files, [cssCfg({ classes: ['card'], overrides: { '--x': 'serif' } })]);
    const text = fs.files.get('docs/mocks/_tokens/web.css')!;
    const set = (await import('@ddv/core')).parseTokenSets(config([cssCfg({ classes: ['card'], overrides: { '--x': 'serif' } })])).sets[0];
    const sha = await sha256Hex(files['web/app/globals.css']);
    expect(sha).toBe(await sha256Hex(files['web/app/globals.css'].replace(/\r\n/g, '\n')));
    expect(text).toBe(
      [
        '/* ddv tokens: web（ddv tokens generate が生成。編集しない）',
        ` * source: web/app/globals.css sha256=${sha}`,
        ` * config: sha256=${await configHash(set)}`,
        ` * generated-by: ddv 0.1.0 format=${TOKEN_FORMAT}`,
        ' */',
        ':root {',
        '  --font-sans: var(--x); /* @theme inline */',
        '  --x: serif; /* override */',
        '}',
        '',
        '.card { color: red; }',
        '',
        '@media (min-width: 1px) { .card { color: blue; } }',
        '',
      ].join('\n'),
    );
    expect(parseHeader(text)).toEqual({ name: 'web', sources: [{ path: 'web/app/globals.css', sha256: sha }], config: await configHash(set), version: '0.1.0', format: TOKEN_FORMAT });
    expect(parseHeader('/* other */\n')).toBeNull();
  });

  it('config のハッシュは name・optional を含まない', async () => {
    const base = cssSet();
    expect(await configHash({ ...base, name: 'other', optional: true })).toBe(await configHash(base));
    expect(await configHash({ ...base, classes: ['x'] })).not.toBe(await configHash(base));
  });
});
