import { describe, expect, it } from 'vitest';
import { classMatches, elementMatches } from './css/reader.ts';
import { messages, readCss, tok } from './test-helpers.ts';

const ENTRY = 'web/app/globals.css';

describe('CSS の @import（CIMPORT）', () => {
  it('[DD-TOKENGEN-CIMPORT-P001] [DD-TOKENGEN-CIMPORT-T001] [DD-TOKENGEN-CIMPORT-T002] ./ ../ / で始まらないものはパッケージとして無視し数えるだけ', async () => {
    const r = await readCss({ [ENTRY]: '@import "tailwindcss";\n@import url("https://fonts.example.com/x.css");\n:root { --a: 1px; }' });
    expect(r.skipped).toBe(2);
    expect(r.warnings).toEqual([]);
    expect(r.sources.map((s) => s.path)).toEqual([ENTRY]);
    expect(r.rules).toEqual([]);
    expect(tok(r, '--a')).toBe('1px');
  });

  it('[DD-TOKENGEN-CIMPORT-P002] [DD-TOKENGEN-CIMPORT-T003] [DD-TOKENGEN-CIMPORT-T004] layer・supports・メディアの条件付きは warning で辿らない', async () => {
    const r = await readCss({
      [ENTRY]: '@import "./a.css" layer(base);\n@import url(./a.css) screen and (min-width: 1px);\n@import "./a.css" supports(display: grid);',
      'web/app/a.css': ':root { --a: 1px; }',
    });
    expect(messages(r)).toEqual([
      '条件付きの @import は辿りません: "./a.css" layer(base)',
      '条件付きの @import は辿りません: url(./a.css) screen and (min-width: 1px)',
      '条件付きの @import は辿りません: "./a.css" supports(display: grid)',
    ]);
    expect(r.warnings.map((w) => [w.file, w.line])).toEqual([
      [ENTRY, 1],
      [ENTRY, 2],
      [ENTRY, 3],
    ]);
    expect(tok(r, '--a')).toBeUndefined();
  });

  it('[DD-TOKENGEN-CIMPORT-P003] [DD-TOKENGEN-CIMPORT-T005] [DD-TOKENGEN-CIMPORT-T006] 辿っている途中のファイルへ戻る @import は warning', async () => {
    const r = await readCss({
      [ENTRY]: '@import "./a.css";\n:root { --root: 1px; }',
      'web/app/a.css': ':root { --a: 2px; }\n@import "./globals.css";',
    });
    expect(r.warnings).toEqual([{ file: 'web/app/a.css', line: 2, message: '循環して読み込んでいます: ./globals.css' }]);
    expect(tok(r, '--a')).toBe('2px');
    expect(tok(r, '--root')).toBe('1px');
  });

  it('[DD-TOKENGEN-CIMPORT-P004] [DD-TOKENGEN-CIMPORT-T007] [DD-TOKENGEN-CIMPORT-T008] 読めないファイルは warning（入口でなければ生成は続ける）', async () => {
    const r = await readCss({ [ENTRY]: '@import "../missing.css";\n:root { --root: 1px; }' });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([{ file: ENTRY, line: 1, message: 'ファイルが読めません: ../missing.css（web/missing.css）' }]);
    expect(tok(r, '--root')).toBe('1px');
  });

  it('[DD-TOKENGEN-CIMPORT-P005] [DD-TOKENGEN-CIMPORT-T009] その位置に展開して生成元に記録する（/ はパッケージのルートから）', async () => {
    const r = await readCss({
      'web/package.json': '{}',
      [ENTRY]: ':root { --a: 1px; --b: 1px; }\n@import "./a.css";\n@import url("/styles/b.css");\n:root { --b: 3px; }',
      'web/app/a.css': ':root { --a: 2px; }',
      'web/styles/b.css': ':root { --c: 4px; }',
    });
    expect(r.warnings).toEqual([]);
    expect(r.sources.map((s) => s.path)).toEqual([ENTRY, 'web/app/a.css', 'web/styles/b.css']);
    expect([tok(r, '--a'), tok(r, '--b'), tok(r, '--c')]).toEqual(['2px', '3px', '4px']);
    expect(r.dropped).toBe(2);
  });
});

describe('CSS の規則の分類（CRULE）', () => {
  it('[DD-TOKENGEN-CRULE-P001] [DD-TOKENGEN-CRULE-T001] [DD-TOKENGEN-CRULE-T002] @theme はテーマの定義として読む', async () => {
    const r = await readCss({ [ENTRY]: '@theme {\n  --color-accent-25: #a77ca5;\n  @keyframes spin { to { rotate: 1turn; } }\n}' });
    expect(r.tokens).toEqual([{ name: '--color-accent-25', value: '#a77ca5', kind: 'css', origin: 'defined' }]);
    expect(r.rules).toEqual([]);
  });

  it('[DD-TOKENGEN-CRULE-P002] [DD-TOKENGEN-CRULE-T003] @media などは中を同じ規則で読み 取り込んだものがあれば at-rule ごと出す', async () => {
    const r = await readCss(
      {
        [ENTRY]: [
          '@media (prefers-color-scheme: dark) {\n  :root { --background: #0a0a0a; }\n  .card { color: red; }\n  .other { color: blue; }\n}',
          '@supports (display: grid) {\n  .other { display: grid; }\n}',
          '@layer base {\n  @media (min-width: 640px) {\n    .card { padding: 2px; }\n  }\n}',
        ].join('\n'),
      },
      { classes: ['card'] },
    );
    expect(r.tokens).toEqual([]);
    expect(r.rules).toEqual([
      '@media (prefers-color-scheme: dark) {\n  :root { --background: #0a0a0a; }\n  .card { color: red; }\n}',
      '@layer base {\n  @media (min-width: 640px) {\n    .card { padding: 2px; }\n  }\n}',
    ]);
  });

  it('[DD-TOKENGEN-CRULE-P003] [DD-TOKENGEN-CRULE-T004] [DD-TOKENGEN-CRULE-T005] :root・html・:host だけのセレクタは -- の宣言を変数にし ほかの宣言は出さない', async () => {
    const r = await readCss({ [ENTRY]: ':root, html {\n  --a: 1px;\n  color: red;\n}\n:host { --b: 2px !important; }\nhtml { --c: 3px; font-size: 16px; }' });
    expect(r.tokens.map((t) => [t.name, t.value])).toEqual([
      ['--a', '1px'],
      ['--b', '2px !important'],
      ['--c', '3px'],
    ]);
    expect(r.rules).toEqual([]);
    const withHtml = await readCss({ [ENTRY]: ':root, html {\n  --a: 1px;\n  color: red;\n}' }, { elements: ['html'] });
    expect(withHtml.rules).toEqual(['html {\n  color: red;\n}']);
  });

  it('[DD-TOKENGEN-CRULE-P004] [DD-TOKENGEN-CRULE-T006] classes のクラスで始まるセレクタだけを共通クラスとして出す（@apply とビルドが必要な値は除く）', async () => {
    const r = await readCss(
      {
        [ENTRY]: [
          '.admin-card {\n  /* card */\n  padding: 1rem;\n  @apply rounded-lg;\n  width: theme(spacing.4);\n  margin: --spacing(2);\n}',
          'a, .admin-card__title, .admin-cardx, .admin-card:hover > b {\n  color: var(--fg);\n}',
          '.site-frame--wide.x, .site-frame[data-x], .site-frame .y, .site-frame+p, .site-frame~p { gap: 1px; }',
        ].join('\n'),
        'web/app/x.css': '',
      },
      { classes: ['admin-card', 'site-frame'], overrides: { '--fg': '#000' } },
    );
    expect(r.rules).toEqual([
      '.admin-card {\n  padding: 1rem;\n}',
      '.admin-card__title, .admin-card:hover > b {\n  color: var(--fg);\n}',
      '.site-frame--wide.x, .site-frame[data-x], .site-frame .y, .site-frame+p, .site-frame~p { gap: 1px; }',
    ]);
    expect(messages(r)).toEqual(['@apply は展開しません: .admin-card', 'ビルドが必要な値です: .admin-card { width: theme(spacing.4) }', 'ビルドが必要な値です: .admin-card { margin: --spacing(2) }']);
  });

  it('[DD-TOKENGEN-CRULE-P005] [DD-TOKENGEN-CRULE-T007] elements の要素だけのセレクタを要素の規則として出す', async () => {
    const r = await readCss({ [ENTRY]: 'body { margin: 0; }\na:hover, a::after, body > p, abbr { color: red; }' }, { elements: ['body', 'a'] });
    expect(r.rules).toEqual(['body { margin: 0; }', 'a:hover, a::after { color: red; }']);
  });

  it('[DD-TOKENGEN-CRULE-P006] [DD-TOKENGEN-CRULE-T008] それ以外のセレクタは出さない', async () => {
    const r = await readCss({ [ENTRY]: '.other { color: red; }\n#id { color: blue; }\n* { box-sizing: border-box; }' }, { classes: ['card'], elements: ['body'] });
    expect(r.rules).toEqual([]);
    expect(r.tokens).toEqual([]);
  });

  it('[DD-TOKENGEN-CRULE-P007] [DD-TOKENGEN-CRULE-T009] ほかの at-rule（@keyframes・@custom-variant・@font-face）とコメントは出さない', async () => {
    const r = await readCss({ [ENTRY]: '/* c */\n@custom-variant dark (&:where(.dark, .dark *));\n@keyframes spin { to { rotate: 1turn; } }\n@font-face { font-family: X; src: url(x.woff2); }' }, { classes: ['card'] });
    expect(r.rules).toEqual([]);
    expect(r.tokens).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('クラス・要素の判定', () => {
    expect(classMatches('.admin-card', 'admin-card')).toBe(true);
    expect(classMatches('.admin-cardx', 'admin-card')).toBe(false);
    expect(classMatches('.admin-card-x', 'admin-card')).toBe(false);
    expect(classMatches('div .admin-card', 'admin-card')).toBe(false);
    expect(elementMatches('a::before', 'a')).toBe(true);
    expect(elementMatches('a.x', 'a')).toBe(false);
  });
});

describe('テーマの定義（THEME）', () => {
  it('[DD-TOKENGEN-THEME-P001] [DD-TOKENGEN-THEME-T001] [DD-TOKENGEN-THEME-T002] reference を含む @theme は出さない', async () => {
    const r = await readCss({ [ENTRY]: '@theme reference {\n  --color-x: red;\n}\n@theme inline reference { --color-y: blue; }' });
    expect(r.tokens).toEqual([]);
  });

  it('[DD-TOKENGEN-THEME-P002] [DD-TOKENGEN-THEME-T003] [DD-TOKENGEN-THEME-T004] [DD-TOKENGEN-THEME-T005] --*: initial はそれまでの @theme 由来の変数をすべて消す', async () => {
    const r = await readCss({ [ENTRY]: ':root { --background: #fff; }\n@theme { --color-a: red; --font-x: y; }\n@theme { --*: initial; --color-b: blue; }' });
    expect(r.tokens.map((t) => t.name)).toEqual(['--background', '--color-b']);
    expect(r.dropped).toBe(2);
  });

  it('[DD-TOKENGEN-THEME-P003] [DD-TOKENGEN-THEME-T006] --名前空間-*: initial はその名前空間の @theme 由来の変数だけを消す', async () => {
    const r = await readCss({ [ENTRY]: ':root { --color-root: #fff; }\n@theme { --color-a: red; --colorful: 1; --font-x: y; }\n@theme { --color-*: initial; --color-accent-25: #a77ca5; }' });
    expect(r.tokens.map((t) => t.name)).toEqual(['--color-accent-25', '--color-root', '--colorful', '--font-x']);
  });

  it('[DD-TOKENGEN-THEME-P004] [DD-TOKENGEN-THEME-T007] [DD-TOKENGEN-THEME-T008] inline を含む @theme の変数には印 @theme inline を付ける', async () => {
    const r = await readCss({ [ENTRY]: '@theme inline {\n  --font-sans: var(--font-geist-sans);\n}' }, { overrides: { '--font-geist-sans': '"Geist", sans-serif' } });
    expect(r.tokens).toEqual([
      { name: '--font-geist-sans', value: '"Geist", sans-serif', kind: 'css', origin: 'override', note: 'override' },
      { name: '--font-sans', value: 'var(--font-geist-sans)', kind: 'css', origin: 'defined', note: '@theme inline' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('[DD-TOKENGEN-THEME-P005] [DD-TOKENGEN-THEME-T009] inline を含まない @theme の宣言は変数にする（後の定義が勝つ）', async () => {
    const r = await readCss({ [ENTRY]: '@theme { --color-c: #fff; }\n:root { --color-c: #000; }' });
    expect(r.tokens).toEqual([{ name: '--color-c', value: '#000', kind: 'css', origin: 'defined' }]);
    expect(r.dropped).toBe(1);
  });
});

describe('代替値と未定義の変数', () => {
  it('overrides は値を置き換え、表に無い var() は warning（規則は出す）', async () => {
    const r = await readCss(
      { [ENTRY]: ':root { --font-geist-sans: x; }\n.card { color: var(--fg, var(--missing-a)); font: var(--font-geist-sans); --local: 1px; margin: var(--local); }\n:root { --b: var(--missing-b); }' },
      { classes: ['card'], overrides: { '--font-geist-sans': '"Geist"', '--extra': '1px' } },
    );
    expect(r.tokens.map((t) => [t.name, t.value, t.note])).toEqual([
      ['--b', 'var(--missing-b)', undefined],
      ['--extra', '1px', 'override'],
      ['--font-geist-sans', '"Geist"', 'override'],
    ]);
    expect(r.rules).toHaveLength(1);
    expect(messages(r)).toEqual([
      '未定義の変数を参照しています（overrides で値を与えてください）: --fg',
      '未定義の変数を参照しています（overrides で値を与えてください）: --missing-a',
      '未定義の変数を参照しています（overrides で値を与えてください）: --missing-b',
    ]);
  });

  it('入口が読めなければ error', async () => {
    const r = await readCss({}, {});
    expect(r.errors).toEqual([`生成元のファイルを読めません: ${ENTRY}（見つからないか、読み取れません）`]);
  });
});
