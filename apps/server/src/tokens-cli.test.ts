import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@ddv/core/node';
import { checkTokens } from '@ddv/tokens/node';
import { tokensCommand } from './tokens-cli.ts';

let root: string;
let repo: string;
let out: string[];
let err: string[];

const CONFIG = `tokens:
  - name: web
    kind: css
    sources: [../web/app/globals.css]
    classes: [card]
  - name: order-wpf
    kind: xaml
    sources: [desktop/App.xaml]
`;
const APP = `<Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Application.Resources>
    <Color x:Key="Accent">#0078D4</Color>
    <Color x:Key="Bad">sc#1,0,0,0</Color>
  </Application.Resources>
</Application>
`;

async function write(rel: string, text: string) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

const run = (...argv: string[]) => tokensCommand([...argv, '--repo', repo], { out: (l) => out.push(l), err: (l) => err.push(l), cwd: root, help: 'HELP' });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-tokens-'));
  repo = path.join(root, 'repo');
  await write('repo/ddv.config.yaml', CONFIG);
  await write('repo/desktop/App.xaml', APP);
  await write('web/app/globals.css', ':root { --accent: #0078d4; }\n.card { color: var(--accent); }\n');
  out = [];
  err = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('ddv tokens（TCLI）', () => {
  it('[DD-TOKENGEN-TCLI-P001] [DD-TOKENGEN-TCLI-T001] [DD-TOKENGEN-TCLI-T002] [DD-TOKENGEN-TCLI-T005] [DD-TOKENGEN-TCLI-T006] generate で error があれば終了コード 1', async () => {
    expect(await run('generate', '--name', 'missing')).toBe(1);
    expect(out.join('\n')).toBe('error: tokens に missing のセットがありません');
    await fs.rm(path.join(repo, 'desktop/App.xaml'));
    expect(await run('generate')).toBe(1);
    // The other set is still written.
    await expect(fs.readFile(path.join(repo, 'docs/mocks/_tokens/web.css'), 'utf8')).resolves.toContain('.card { color: var(--accent); }');
  });

  it('[DD-TOKENGEN-TCLI-P002] [DD-TOKENGEN-TCLI-T007] generate で error が無ければ終了コード 0（warning は表示する）', async () => {
    expect(await run('generate')).toBe(0);
    expect(out.join('\n').split('\n')).toEqual([
      'web: トークン 1 件・共通クラス 1 件・標準の項目 0 件（WPF 標準 0 件）・負けた定義 0 件 → docs/mocks/_tokens/web.css',
      'order-wpf: トークン 1 件・共通クラス 0 件・標準の項目 16 件（WPF 標準 16 件）・負けた定義 0 件 → docs/mocks/_tokens/order-wpf.css',
      '  warning: desktop/App.xaml:4 色の値を読めません: sc#1,0,0,0',
    ]);
    const css = await fs.readFile(path.join(repo, 'docs/mocks/_tokens/web.css'), 'utf8');
    expect(css).toMatch(/^\/\* ddv tokens: web（ddv tokens generate が生成。編集しない）\n \* source: \.\.\/web\/app\/globals\.css sha256=[0-9a-f]{64}\n/);
    await expect(fs.readFile(path.join(repo, 'docs/mocks/_tokens/wpf-base.css'), 'utf8')).resolves.toContain('var(--wpf-window-bg)');
  });

  it('[DD-TOKENGEN-TCLI-P003] [DD-TOKENGEN-TCLI-T003] [DD-TOKENGEN-TCLI-T008] [DD-TOKENGEN-TCLI-T009] check で warning があれば終了コード 1', async () => {
    expect(await run('check')).toBe(1);
    expect(out).toEqual([
      'warning: docs/mocks/_tokens/web.css [tokens] 未生成です（ddv tokens generate を実行してください）',
      'warning: docs/mocks/_tokens/order-wpf.css [tokens] 未生成です（ddv tokens generate を実行してください）',
    ]);
  });

  it('[DD-TOKENGEN-TCLI-P004] [DD-TOKENGEN-TCLI-T010] check で warning が無ければ終了コード 0（optional で省略したものは情報として表示）', async () => {
    await run('generate');
    out = [];
    expect(await run('check')).toBe(0);
    expect(out).toEqual(['✓ トークンの乖離はありません']);
    await fs.writeFile(path.join(repo, 'ddv.config.yaml'), CONFIG.replace('classes: [card]', 'classes: [card]\n    optional: true'));
    await run('generate');
    await fs.rm(path.join(root, 'web'), { recursive: true });
    out = [];
    expect(await run('check')).toBe(0);
    expect(out).toEqual(['情報: 生成元が見つからないため検査を省略しました: ../web/app/globals.css', '✓ トークンの乖離はありません']);
  });

  it('[DD-TOKENGEN-TCLI-P005] [DD-TOKENGEN-TCLI-T004] その他・なしのサブコマンドは error とヘルプで終了コード 2', async () => {
    expect(await tokensCommand([], { out: (l) => out.push(l), err: (l) => err.push(l), cwd: repo, help: 'HELP' })).toBe(2);
    expect(await run('build')).toBe(2);
    expect(err).toEqual(['不明なサブコマンド: tokens \n\nHELP', '不明なサブコマンド: tokens build\n\nHELP']);
  });
});

describe('lint の乖離の検査（checkTokens）', () => {
  it('生成元の変更を rule tokens の warning にし、DDV_TOKENS_OPTIONAL=1 で見つからない生成元を出さない', async () => {
    const config = await loadConfig(repo);
    await run('generate');
    expect(await checkTokens(repo, config)).toEqual([]);
    await write('repo/desktop/App.xaml', APP.replace('#0078D4', '#FF0000'));
    expect(await checkTokens(repo, config)).toEqual([
      { severity: 'warning', rule: 'tokens', path: 'docs/mocks/_tokens/order-wpf.css', message: '生成元が変更されました（再生成してください）: desktop/App.xaml' },
    ]);
    await fs.rm(path.join(root, 'web'), { recursive: true });
    const prev = process.env.DDV_TOKENS_OPTIONAL;
    try {
      process.env.DDV_TOKENS_OPTIONAL = '1';
      expect((await checkTokens(repo, config)).map((i) => i.path)).toEqual(['docs/mocks/_tokens/order-wpf.css']);
      delete process.env.DDV_TOKENS_OPTIONAL;
      expect((await checkTokens(repo, config)).map((i) => i.message)).toContain('生成元が見つかりません: ../web/app/globals.css');
    } finally {
      if (prev === undefined) delete process.env.DDV_TOKENS_OPTIONAL;
      else process.env.DDV_TOKENS_OPTIONAL = prev;
    }
  });
});
