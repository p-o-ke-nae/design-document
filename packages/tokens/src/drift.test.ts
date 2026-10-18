import { describe, expect, it } from 'vitest';
import { parseConfig, parseTokenSets } from '@ddv/core';
import { checkTokenSet, checkTokenSets, DRIFT_MESSAGES } from './drift.ts';
import { MemoryTokenFs } from './fs.ts';
import { generateTokens } from './generate.ts';
import { TOKEN_FORMAT } from './schema.ts';
import { app, dict, merged } from './test-helpers.ts';

const OUT = 'docs/mocks/_tokens/order-wpf.css';
const SET = { name: 'order-wpf', kind: 'xaml', sources: ['app/App.xaml'] };

function repo() {
  return new MemoryTokenFs({
    'app/App.xaml': app(`${merged('Themes/Colors.xaml')}\n<Color x:Key="Base">#111111</Color>`),
    'app/Themes/Colors.xaml': dict('<Color x:Key="Accent">#0078D4</Color>'),
  });
}

async function generated(set: Record<string, unknown> = SET) {
  const fs = repo();
  await generateTokens(parseConfig({ tokens: [set] }), fs, {});
  return fs;
}

const check = (fs: MemoryTokenFs, set: Record<string, unknown> = SET, optionalEnv = false) => checkTokenSets(parseConfig({ tokens: [set] }), fs, { optionalEnv });
const warn = (message: string) => [{ severity: 'warning', rule: 'tokens', path: OUT, message }];

describe('乖離の検査（TCHK）', () => {
  it('[DD-TOKENGEN-TCHK-P001] [DD-TOKENGEN-TCHK-T001] [DD-TOKENGEN-TCHK-T002] 出力ファイルが無ければ 未生成', async () => {
    expect(await check(repo())).toEqual({ issues: warn('未生成です（ddv tokens generate を実行してください）'), infos: [] });
  });

  it('[DD-TOKENGEN-TCHK-P002] [DD-TOKENGEN-TCHK-T003] [DD-TOKENGEN-TCHK-T004] ヘッダを読めなければ ヘッダがありません', async () => {
    const fs = await generated();
    fs.files.set(OUT, fs.files.get(OUT)!.replace(/^\/\* ddv tokens: .*\n/, '/* hand written */\n'));
    expect((await check(fs)).issues).toEqual(warn('ヘッダがありません（再生成してください）'));
  });

  it('[DD-TOKENGEN-TCHK-P003] [DD-TOKENGEN-TCHK-T005] [DD-TOKENGEN-TCHK-T006] 記録した format が違えば 生成の規則が変わりました', async () => {
    const fs = await generated();
    fs.files.set(OUT, fs.files.get(OUT)!.replace(`format=${TOKEN_FORMAT}`, `format=${TOKEN_FORMAT + 1}`));
    // Even when the sources also changed, the format is reported first.
    fs.files.set('app/Themes/Colors.xaml', dict('<Color x:Key="Accent">#FF0000</Color>'));
    expect((await check(fs)).issues).toEqual(warn('生成の規則が変わりました（再生成してください）'));
  });

  it('[DD-TOKENGEN-TCHK-P004] [DD-TOKENGEN-TCHK-T007] [DD-TOKENGEN-TCHK-T008] 記録した config が今の設定と違えば 設定が変わりました', async () => {
    const fs = await generated();
    expect((await check(fs, { ...SET, prefix: 'wpf' })).issues).toEqual(warn('設定が変わりました（再生成してください）'));
    expect((await check(fs, { ...SET, overrides: { '--x': '1' } })).issues).toEqual(warn('設定が変わりました（再生成してください）'));
    // name and optional are not part of the config hash.
    expect((await check(fs, { ...SET, optional: true })).issues).toEqual([]);
  });

  it('[DD-TOKENGEN-TCHK-P005] [DD-TOKENGEN-TCHK-T009] [DD-TOKENGEN-TCHK-T010] 設定の sources が記録した生成元に含まれなければ 設定が変わりました', async () => {
    const fs = await generated();
    // Same config hash but a header whose recorded sources lack the entry.
    fs.files.set(OUT, fs.files.get(OUT)!.replace(/ \* source: app\/App\.xaml sha256=\w+\n/, ''));
    expect((await check(fs)).issues).toEqual(warn('設定が変わりました（再生成してください）'));
  });

  it('[DD-TOKENGEN-TCHK-P006] [DD-TOKENGEN-TCHK-T011] [DD-TOKENGEN-TCHK-T012] [DD-TOKENGEN-TCHK-T013] 生成元が読めず optional または DDV_TOKENS_OPTIONAL=1 なら lint に出さず 情報にする', async () => {
    const fs = await generated();
    fs.files.delete('app/Themes/Colors.xaml');
    const info = DRIFT_MESSAGES.skipped('app/Themes/Colors.xaml');
    expect(info).toBe('情報: 生成元が見つからないため検査を省略しました: app/Themes/Colors.xaml');
    expect(await check(fs, { ...SET, optional: true })).toEqual({ issues: [], infos: [info] });
    expect(await check(fs, SET, true)).toEqual({ issues: [], infos: [info] });
  });

  it('[DD-TOKENGEN-TCHK-P007] [DD-TOKENGEN-TCHK-T014] 生成元が読めず optional でなければ 生成元が見つかりません', async () => {
    const fs = await generated();
    fs.files.delete('app/Themes/Colors.xaml');
    expect(await check(fs)).toEqual({ issues: warn('生成元が見つかりません: app/Themes/Colors.xaml'), infos: [] });
  });

  it('[DD-TOKENGEN-TCHK-P008] [DD-TOKENGEN-TCHK-T015] [DD-TOKENGEN-TCHK-T016] 辿ったファイルのハッシュが違えば 生成元が変更されました', async () => {
    const fs = await generated();
    fs.files.set('app/Themes/Colors.xaml', dict('<Color x:Key="Accent">#FF0000</Color>'));
    expect((await check(fs)).issues).toEqual(warn('生成元が変更されました（再生成してください）: app/Themes/Colors.xaml'));
  });

  it('[DD-TOKENGEN-TCHK-P009] [DD-TOKENGEN-TCHK-T017] すべて一致すれば問題なし（改行の違いは無視する）', async () => {
    const fs = await generated();
    fs.files.set('app/App.xaml', fs.files.get('app/App.xaml')!.replace(/\n/g, '\r\n'));
    expect(await check(fs)).toEqual({ issues: [], infos: [] });
  });

  it('設定の誤りは tokens-config として返す', async () => {
    const r = await checkTokenSets(parseConfig({ tokens: [{ name: 'x', kind: 'scss', sources: ['a'] }] }), repo());
    expect(r.issues).toEqual([{ severity: 'error', rule: 'tokens-config', path: 'ddv.config.yaml', message: 'tokens の kind は xaml か css です: scss' }]);
  });
});

describe('基本設計の乖離の検出（DCHK）', () => {
  it('[BD-TOKENS-DCHK-P001] [BD-TOKENS-DCHK-T001] [BD-TOKENS-DCHK-T002] [BD-TOKENS-DCHK-S001] 出力ファイルが無ければ warning: 未生成', async () => {
    expect((await check(repo())).issues).toEqual(warn(DRIFT_MESSAGES.missing));
  });

  it('[BD-TOKENS-DCHK-P002] [BD-TOKENS-DCHK-T003] [BD-TOKENS-DCHK-T004] [BD-TOKENS-DCHK-S002] [BD-TOKENS-DCHK-S003] 生成元のファイルが無ければ warning: 生成元が見つからない', async () => {
    const fs = await generated();
    fs.files.delete('app/App.xaml');
    expect((await check(fs)).issues).toEqual(warn(DRIFT_MESSAGES.sourceMissing('app/App.xaml')));
  });

  it('[BD-TOKENS-DCHK-P003] [BD-TOKENS-DCHK-T005] [BD-TOKENS-DCHK-T006] [BD-TOKENS-DCHK-S004] [BD-TOKENS-DCHK-S005] 記録したハッシュと違えば warning: 生成元が変更された', async () => {
    const fs = await generated();
    fs.files.set('app/App.xaml', app('<Color x:Key="Base">#222222</Color>'));
    expect((await check(fs)).issues).toEqual(warn(DRIFT_MESSAGES.sourceChanged('app/App.xaml')));
  });

  it('[BD-TOKENS-DCHK-P004] [BD-TOKENS-DCHK-T007] [BD-TOKENS-DCHK-T008] [BD-TOKENS-DCHK-S006] [BD-TOKENS-DCHK-S007] 記録した生成元と設定の sources が違えば warning: 設定が変わった', async () => {
    const fs = await generated();
    fs.files.set('app/Second.xaml', dict('<Color x:Key="S">#333333</Color>'));
    expect((await check(fs, { ...SET, sources: ['app/App.xaml', 'app/Second.xaml'] })).issues).toEqual(warn(DRIFT_MESSAGES.config));
  });

  it('[BD-TOKENS-DCHK-P005] [BD-TOKENS-DCHK-T009] [BD-TOKENS-DCHK-S008] すべて一致すれば OK', async () => {
    expect((await check(await generated())).issues).toEqual([]);
  });
});

describe('乖離の状態（DRIFT）', () => {
  const set = () => parseTokenSets(parseConfig({ tokens: [SET] })).sets[0];
  const state = async (fs: MemoryTokenFs) => {
    const { issues } = await checkTokenSet(set(), fs);
    if (!issues.length) return '一致';
    return issues[0].message === DRIFT_MESSAGES.missing ? '未生成' : '乖離';
  };
  const generate = (fs: MemoryTokenFs) => generateTokens(parseConfig({ tokens: [SET] }), fs, {});
  const edit = (fs: MemoryTokenFs, color: string) => fs.files.set('app/Themes/Colors.xaml', dict(`<Color x:Key="Accent">${color}</Color>`));

  it('[BD-TOKENS-DRIFT-T001] 開始時は未生成', async () => {
    expect(await state(repo())).toBe('未生成');
  });

  it('[BD-TOKENS-DRIFT-T002] [BD-TOKENS-DRIFT-T003] [BD-TOKENS-DRIFT-T004] [BD-TOKENS-DRIFT-T005] [BD-TOKENS-DRIFT-T006] 生成で一致・生成元の変更で乖離・再生成で一致に戻る', async () => {
    const fs = repo();
    await generate(fs);
    expect(await state(fs)).toBe('一致'); // T002
    edit(fs, '#FF0000');
    expect(await state(fs)).toBe('乖離'); // T003
    edit(fs, '#00FF00');
    expect(await state(fs)).toBe('乖離'); // T004
    await generate(fs);
    expect(await state(fs)).toBe('一致'); // T005
    const before = fs.files.get(OUT);
    const writes = fs.writes.length;
    await generate(fs);
    expect(await state(fs)).toBe('一致'); // T006
    expect(fs.files.get(OUT)).toBe(before);
    expect(fs.writes.length).toBe(writes);
  });

  it('[BD-TOKENS-DRIFT-X001] 未生成のまま生成元を変更しても未生成のまま（乖離にはならない）', async () => {
    const fs = repo();
    edit(fs, '#FF0000');
    expect(await state(fs)).toBe('未生成');
  });
});
