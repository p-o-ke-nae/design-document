import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@ddv/core';
import { lintDocs, loadDocs, type LintIssue } from '@ddv/core/node';
import { generateAll, readLock } from '@ddv/testid';
import { checkMocks, mockRefs, mockRuntimeHeader, mockTargets, parseScenarioFile, pathSpecs, scaffoldMock, screenDiagram, targetDiagram, MOCK_VERSION } from './index.ts';

const DOC = `---
id: ORDER
kind: basic
status: approved
title: 注文
---

# 注文

::mock[order/index.html]

\`\`\`mermaid id=screen matrix nswitch=0
stateDiagram-v2
  state "一覧" as List
  state "入力" as Input
  state "完了" as Done
  [*] --> List
  List --> Input : 新規
  Input --> Done : 確定
  List --> Done : 直接
\`\`\`
`;

const html = (o: { done: boolean; confirm: boolean }) => `<!doctype html><body>
<section data-screen="List"><button data-event="新規" data-testid="new">新規</button><button data-event="直接" data-testid="direct">直接</button></section>
<section data-screen="Input"><input data-testid="customer" required data-sample="山田">${o.confirm ? '<button data-event="確定" data-testid="ok" data-submit="POST /orders">確定</button>' : ''}</section>
${o.done ? '<section data-screen="Done"></section>' : ''}
</body>`;

const config = parseConfig({ docsRoot: 'docs', mocksRoot: 'mocks' });
let base = '';
let n = 0;
let P1 = ''; // List → Input → Done
let P2 = ''; // List → Done

async function writeFile(repo: string, rel: string, text: string) {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), text, 'utf8');
}

async function makeRepo(): Promise<string> {
  const repo = path.join(base, `r${++n}`);
  await writeFile(repo, 'docs/basic/order.md', DOC);
  await generateAll(repo, config, { write: true });
  return repo;
}

const scenarioText = (variant: 'format' | 'unknownId' | 'mismatch' | 'todo' | 'clean') => `id: ${variant === 'unknownId' ? 'BD-ORDER-SCREEN-P999' : P1}
title: t
start: List
steps:
  - event: 新規
    click: new
    expect: { screen: Input }
  - event: 確定
    input: { customer: 山田 }
    click: ${variant === 'todo' ? '"" # 要確認' : 'ok'}
    expect: { ${variant === 'format' ? '' : `screen: ${variant === 'mismatch' ? 'List' : 'Done'}`} }
`;

interface CaseOpts {
  done: boolean;
  confirm: boolean;
  scenario: 'format' | 'unknownId' | 'mismatch' | 'todo' | 'clean';
  all?: boolean;
}

async function runCase(o: CaseOpts): Promise<LintIssue[]> {
  const repo = await makeRepo();
  await writeFile(repo, 'mocks/order/index.html', html(o));
  await writeFile(repo, `mocks/order/scenarios/${P1}.yaml`, scenarioText(o.scenario));
  if (o.all) await writeFile(repo, `mocks/order/scenarios/${P2}.yaml`, `id: ${P2}\ntitle: t\nstart: List\nsteps:\n  - event: 直接\n    click: direct\n    expect: { screen: Done }\n`);
  return checkMocks(repo, config, await loadDocs(repo, config));
}

function verify(issues: LintIssue[], o: CaseOpts) {
  const has = (re: RegExp, sev?: 'error' | 'warning') => issues.some((i) => re.test(i.message) && (!sev || i.severity === sev));
  expect(has(/data-screen="Done"/, 'warning')).toBe(!o.done);
  expect(has(/イベント「確定」/, 'warning')).toBe(!o.confirm);
  expect(has(/シナリオの形式/, 'error')).toBe(o.scenario === 'format');
  expect(has(/不明なテストID/, 'error')).toBe(o.scenario === 'unknownId');
  expect(has(/経路と一致しません/, 'error')).toBe(o.scenario === 'mismatch');
  if (o.scenario === 'todo' || o.scenario === 'clean') {
    expect(has(/要確認の値/, 'warning')).toBe(o.scenario === 'todo');
    expect(has(/シナリオのない経路.*ddv mock scaffold/, 'warning')).toBe(!o.all);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  }
  if (o.scenario === 'mismatch') expect(issues.find((i) => /経路と一致/.test(i.message))?.line).toBe(11);
  if (o.scenario === 'todo') expect(issues.find((i) => /要確認の値/.test(i.message))?.line).toBe(10);
}

const check = async (o: CaseOpts) => verify(await runCase(o), o);

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-mock-'));
  const repo = await makeRepo();
  const docs = await loadDocs(repo, config);
  const sd = screenDiagram(docs[0])!;
  const specs = pathSpecs(docs[0], sd.diagram, await readLock(repo), config);
  P1 = specs.find((s) => s.transitions.length === 2)!.id;
  P2 = specs.find((s) => s.transitions.length === 1)!.id;
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('pathSpecs', () => {
  it('active な P ケースを開始状態・遷移（ガード分離・辺番号付き）に変換する', async () => {
    const repo = await makeRepo();
    const docs = await loadDocs(repo, config);
    const sd = screenDiagram(docs[0])!;
    const specs = pathSpecs(docs[0], sd.diagram, await readLock(repo), config);
    expect(specs).toHaveLength(2);
    const p1 = specs.find((s) => s.id === P1)!;
    expect(p1.start).toBe('List');
    expect(p1.transitions).toEqual([
      { from: 'List', to: 'Input', event: '新規', guard: '', edge: 1 },
      { from: 'Input', to: 'Done', event: '確定', guard: '', edge: 2 },
    ]);
    expect(p1.edges).toEqual([0, 1, 2]);
  });
});

describe('checkMocks', () => {
  it('[BD-MOCK-CHECK-P011][BD-MOCK-CHECK-T001][BD-MOCK-CHECK-T002][BD-MOCK-CHECK-T014][BD-MOCK-CHECK-T015][BD-MOCK-CHECK-T017][BD-MOCK-CHECK-T005] 画面・操作要素の欠け + シナリオの形式エラー', () => check({ done: false, confirm: false, scenario: 'format' }));
  it('[BD-MOCK-CHECK-P012][BD-MOCK-CHECK-T006][BD-MOCK-CHECK-T007] 画面・操作要素の欠け + 不明なテストID', () => check({ done: false, confirm: false, scenario: 'unknownId' }));
  it('[BD-MOCK-CHECK-P013][BD-MOCK-CHECK-T008][BD-MOCK-CHECK-T009] 画面・操作要素の欠け + 経路不一致', () => check({ done: false, confirm: false, scenario: 'mismatch' }));
  it('[BD-MOCK-CHECK-P014][BD-MOCK-CHECK-T018][BD-MOCK-CHECK-T019][BD-MOCK-CHECK-T021][BD-MOCK-CHECK-T011] 画面・操作要素の欠け + 要確認 + 経路不足', () => check({ done: false, confirm: false, scenario: 'todo' }));
  it('[BD-MOCK-CHECK-P015][BD-MOCK-CHECK-T012] 画面・操作要素の欠け + 要確認 + 経路充足', () => check({ done: false, confirm: false, scenario: 'todo', all: true }));
  it('[BD-MOCK-CHECK-P016][BD-MOCK-CHECK-T020] 画面・操作要素の欠け + 要確認なし + 経路不足', () => check({ done: false, confirm: false, scenario: 'clean' }));
  it('[BD-MOCK-CHECK-P017] 画面・操作要素の欠け + 要確認なし + 経路充足', () => check({ done: false, confirm: false, scenario: 'clean', all: true }));
  it('[BD-MOCK-CHECK-P018][BD-MOCK-CHECK-T016] 画面の欠け + シナリオの形式エラー', () => check({ done: false, confirm: true, scenario: 'format' }));
  it('[BD-MOCK-CHECK-P019] 画面の欠け + 不明なテストID', () => check({ done: false, confirm: true, scenario: 'unknownId' }));
  it('[BD-MOCK-CHECK-P020] 画面の欠け + 経路不一致', () => check({ done: false, confirm: true, scenario: 'mismatch' }));
  it('[BD-MOCK-CHECK-P021] 画面の欠け + 要確認 + 経路不足', () => check({ done: false, confirm: true, scenario: 'todo' }));
  it('[BD-MOCK-CHECK-P022] 画面の欠け + 要確認 + 経路充足', () => check({ done: false, confirm: true, scenario: 'todo', all: true }));
  it('[BD-MOCK-CHECK-P023] 画面の欠け + 要確認なし + 経路不足', () => check({ done: false, confirm: true, scenario: 'clean' }));
  it('[BD-MOCK-CHECK-P024] 画面の欠け + 要確認なし + 経路充足', () => check({ done: false, confirm: true, scenario: 'clean', all: true }));
  it('[BD-MOCK-CHECK-P025][BD-MOCK-CHECK-T013] 操作要素の欠け + シナリオの形式エラー', () => check({ done: true, confirm: false, scenario: 'format' }));
  it('[BD-MOCK-CHECK-P026] 操作要素の欠け + 不明なテストID', () => check({ done: true, confirm: false, scenario: 'unknownId' }));
  it('[BD-MOCK-CHECK-P027] 操作要素の欠け + 経路不一致', () => check({ done: true, confirm: false, scenario: 'mismatch' }));
  it('[BD-MOCK-CHECK-P028] 操作要素の欠け + 要確認 + 経路不足', () => check({ done: true, confirm: false, scenario: 'todo' }));
  it('[BD-MOCK-CHECK-P029] 操作要素の欠け + 要確認 + 経路充足', () => check({ done: true, confirm: false, scenario: 'todo', all: true }));
  it('[BD-MOCK-CHECK-P030] 操作要素の欠け + 要確認なし + 経路不足', () => check({ done: true, confirm: false, scenario: 'clean' }));
  it('[BD-MOCK-CHECK-P031] 操作要素の欠け + 要確認なし + 経路充足', () => check({ done: true, confirm: false, scenario: 'clean', all: true }));
  it('[BD-MOCK-CHECK-P032] 欠けなし + シナリオの形式エラー', () => check({ done: true, confirm: true, scenario: 'format' }));
  it('[BD-MOCK-CHECK-P033] 欠けなし + 不明なテストID', () => check({ done: true, confirm: true, scenario: 'unknownId' }));
  it('[BD-MOCK-CHECK-P034] 欠けなし + 経路不一致', () => check({ done: true, confirm: true, scenario: 'mismatch' }));
  it('[BD-MOCK-CHECK-P035] 欠けなし + 要確認 + 経路不足', () => check({ done: true, confirm: true, scenario: 'todo' }));
  it('[BD-MOCK-CHECK-P036] 欠けなし + 要確認 + 経路充足', () => check({ done: true, confirm: true, scenario: 'todo', all: true }));
  it('[BD-MOCK-CHECK-P037] 欠けなし + 要確認なし + 経路不足', () => check({ done: true, confirm: true, scenario: 'clean' }));
  it('[BD-MOCK-CHECK-P038] 欠けなし + 要確認なし + 経路充足で問題なし', async () => {
    const o: CaseOpts = { done: true, confirm: true, scenario: 'clean', all: true };
    const issues = await runCase(o);
    verify(issues, o);
    expect(issues).toEqual([]);
  });

  it('mocksRoot がなければ何もしない。_map.yaml と runtime の版を検査する', async () => {
    const repo = await makeRepo();
    expect(await checkMocks(repo, config, await loadDocs(repo, config))).toEqual([]);
    await writeFile(repo, 'mocks/order/index.html', html({ done: true, confirm: true }));
    await writeFile(repo, 'mocks/order/scenarios/_map.yaml', 'screens:\n  List: { url: "/orders$" }\n  Nope: { selector: h1 }\nevents:\n  新規: a\n  謎: b\n');
    await writeFile(repo, 'mocks/_ddv/mock-runtime.js', `${mockRuntimeHeader('0.0.0')}\n`);
    const issues = await checkMocks(repo, config, await loadDocs(repo, config));
    expect(issues.filter((i) => i.path.endsWith('_map.yaml')).map((i) => [i.line, i.message])).toEqual([
      [3, '対応表の画面 Nope は画面遷移図にありません'],
      [6, '対応表のイベント 謎 は画面遷移図にありません'],
    ]);
    expect(issues.some((i) => i.path === 'mocks/_ddv/mock-runtime.js' && i.message.includes(MOCK_VERSION))).toBe(true);
    await writeFile(repo, 'mocks/_ddv/mock-runtime.js', `${mockRuntimeHeader()}\n`);
    expect((await checkMocks(repo, config, await loadDocs(repo, config))).some((i) => i.path.includes('mock-runtime'))).toBe(false);
  });
});

describe('scaffoldMock', () => {
  it('骨組みを生成し、再生成でマージ・欠番移動・未変更スキップを行う', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'mocks/order/index.html', html({ done: true, confirm: true }));
    await writeFile(repo, 'mocks/order/fixtures/default.yaml', 'orders: []\n');
    await writeFile(repo, 'mocks/order/scenarios/BD-ORDER-SCREEN-P777.yaml', 'id: BD-ORDER-SCREEN-P777\ntitle: old\nstart: List\nsteps: []\n');

    const c1 = await scaffoldMock(repo, config, 'order');
    expect(c1).toMatchObject({ added: 2, updated: 0, retired: 1, todo: 0, unchanged: 0, skipped: [], mocks: ['order'] });
    expect(existsSync(path.join(repo, 'mocks/order/scenarios/_retired/BD-ORDER-SCREEN-P777.yaml'))).toBe(true);
    const f1 = path.join(repo, `mocks/order/scenarios/${P1}.yaml`);
    const text = await fs.readFile(f1, 'utf8');
    expect(text).toContain('# ddv mock scaffold が生成');
    expect(text.indexOf('id:')).toBeLessThan(text.indexOf('title:'));
    expect(text).toContain('fixtures: [ default ]');
    expect(parseScenarioFile(text, f1).scenario).toEqual({
      id: P1,
      title: expect.any(String),
      fixtures: ['default'],
      start: 'List',
      steps: [
        { event: '新規', click: 'new', expect: { screen: 'Input' } },
        { event: '確定', input: { customer: '山田' }, click: 'ok', expect: { screen: 'Done' } },
      ],
    });
    expect(await checkMocks(repo, config, await loadDocs(repo, config))).toEqual([]);

    const stat = await fs.stat(f1);
    expect(await scaffoldMock(repo, config)).toMatchObject({ added: 0, updated: 0, retired: 0, unchanged: 2 });
    expect((await fs.stat(f1)).mtimeMs).toBe(stat.mtimeMs);

    // Human edits are kept; generated items are updated.
    const edited = text.replace('customer: 山田', 'customer: 佐藤').replace('click: ok', 'click: wrong # 人間のコメント').replace('fixtures: [ default ]', 'fixtures: [ many ]');
    await fs.writeFile(f1, edited, 'utf8');
    expect(await scaffoldMock(repo, config)).toMatchObject({ updated: 1, unchanged: 1 });
    const merged = await fs.readFile(f1, 'utf8');
    expect(merged).toContain('customer: 佐藤');
    expect(merged).toContain('click: ok # 人間のコメント');
    expect(merged).toContain('fixtures: [ many ]');

    // Missing data-event element → empty click with # 要確認.
    await writeFile(repo, 'mocks/order/index.html', html({ done: true, confirm: false }));
    const c3 = await scaffoldMock(repo, config);
    expect(c3).toMatchObject({ updated: 1, todo: 1 });
    expect(await fs.readFile(f1, 'utf8')).toMatch(/click: "" # 要確認/);

    await expect(scaffoldMock(repo, config, 'nope')).rejects.toThrow(/nope/);
  });

  it('[DD-DSCN-AUXMRG-P001][DD-DSCN-AUXMRG-P002][DD-DSCN-AUXMRG-P003] 再生成は補助ステップと only・コメントを残し、消した補助ステップの件数を表示する', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'mocks/order/index.html', html({ done: true, confirm: true }));
    await scaffoldMock(repo, config, 'order');
    const f1 = path.join(repo, `mocks/order/scenarios/${P1}.yaml`);
    await fs.writeFile(
      f1,
      `id: ${P1}\ntitle: t\nstart: List\nsteps:\n  - click: splash\n    only: desktop\n  - event: 新規\n    click: new\n    expect: { screen: Input }\n  - click: tab # 人間のコメント\n    only: [ wpf ]\n  - event: 旧\n    click: old\n    expect: { screen: Input }\n  - input: { a: 1 }\n  - event: 確定\n    input: { customer: 佐藤 }\n    click: ok\n    expect: { screen: Done }\n`,
      'utf8',
    );
    const c = await scaffoldMock(repo, config);
    expect(c).toMatchObject({ updated: 1, notes: [`${P1}: 更新（補助ステップを 1 件削除）`] });
    const text = await fs.readFile(f1, 'utf8');
    expect(text).toContain('click: tab # 人間のコメント');
    expect(parseScenarioFile(text, f1).scenario?.steps).toEqual([
      { click: 'splash', only: 'desktop' },
      { event: '新規', click: 'new', expect: { screen: 'Input' } },
      { click: 'tab', only: ['wpf'] },
      { event: '確定', input: { customer: '佐藤' }, click: 'ok', expect: { screen: 'Done' } },
    ]);
    expect(await scaffoldMock(repo, config)).toMatchObject({ updated: 0, unchanged: 2, notes: [] });
  });
});

const MULTI = `---
id: MULTI
kind: basic
status: draft
title: 複数モック
---

# 複数モック

::mock[main/index.html]

\`\`\`mermaid id=screen matrix nswitch=0
stateDiagram-v2
  [*] --> A
  A --> B : 次へ
\`\`\`

::mock[sub/index.html]{diagram=sub}

\`\`\`mermaid id=sub matrix nswitch=0
stateDiagram-v2
  [*] --> X
  X --> Y : 進む
\`\`\`
`;

const VIEW = `---
id: VIEWD
kind: detailed
status: draft
title: 参照側
traces: [BD-MULTI]
---

# 参照側

::mock[sub/index.html]

\`\`\`mermaid id=other matrix nswitch=0
stateDiagram-v2
  [*] --> Q
  Q --> R : 他
\`\`\`
`;

describe('::mock の diagram 属性', () => {
  async function multiRepo(extra: Record<string, string> = {}) {
    const repo = path.join(base, `m${++n}`);
    await writeFile(repo, 'docs/detailed/a-view.md', VIEW);
    await writeFile(repo, 'docs/basic/multi.md', MULTI);
    for (const [k, v] of Object.entries(extra)) await writeFile(repo, k, v);
    await writeFile(repo, 'mocks/main/index.html', '<body><section data-screen="A"><button data-event="次へ" data-testid="next"></button></section><section data-screen="B"></section></body>');
    await writeFile(repo, 'mocks/sub/index.html', '<body><section data-screen="X"><button data-event="進む" data-testid="go"></button></section><section data-screen="Y"></section></body>');
    await generateAll(repo, config, { write: true });
    return repo;
  }

  it('mockRefs は diagram 属性を返し、screenDiagram は指定した図を選ぶ', async () => {
    const repo = await multiRepo();
    const doc = (await loadDocs(repo, config)).find((d) => d.path.endsWith('multi.md'))!;
    expect(mockRefs(doc).map((r) => [r.name, r.diagram])).toEqual([['main', undefined], ['sub', 'sub']]);
    expect(screenDiagram(doc)!.diagram.id).toBe('screen');
    expect(screenDiagram(doc, 'sub')!.diagram.id).toBe('sub');
    expect(screenDiagram(doc, 'nope')).toBeNull();
  });

  it('mockTargets は基本設計の参照を優先し、図の指定を保持する', async () => {
    const repo = await multiRepo();
    const ts = mockTargets(await loadDocs(repo, config));
    const sub = ts.find((t) => t.name === 'sub')!;
    expect(sub.doc.path).toMatch(/multi\.md$/);
    expect(sub.diagram).toBe('sub');
    expect(targetDiagram(sub)!.diagram.id).toBe('sub');
  });

  it('scaffold・check は指定した図の経路でシナリオを扱う', async () => {
    const repo = await multiRepo();
    const c = await scaffoldMock(repo, config);
    expect(c.mocks.sort()).toEqual(['main', 'sub']);
    const subFiles = (await fs.readdir(path.join(repo, 'mocks/sub/scenarios'))).filter((f) => f.endsWith('.yaml'));
    expect(subFiles).toEqual(['BD-MULTI-SUB-P001.yaml']);
    expect(await fs.readFile(path.join(repo, 'mocks/sub/scenarios', subFiles[0]), 'utf8')).toContain('start: X');
    const issues = await checkMocks(repo, config, await loadDocs(repo, config));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => /data-screen/.test(i.message))).toBe(false);
  });

  it('lint：diagram で指定した図が無い・matrix 付きの状態図でないときは error', async () => {
    const bad = MULTI.replace('{diagram=sub}', '{diagram=none}') + '\n::mock[main/index.html]{diagram=flow}\n\n```mermaid id=flow matrix\nflowchart TD\n  A --> B\n```\n';
    const repo = await multiRepo({ 'docs/basic/multi.md': bad });
    const issues = lintDocs(repo, config, await loadDocs(repo, config)).filter((i) => i.rule === 'ref');
    expect(issues.map((i) => i.message)).toEqual([
      'モック sub/index.html の diagram=none が見つかりません',
      'モック main/index.html の diagram=flow は matrix 付きの状態図ではありません',
    ]);
  });
});