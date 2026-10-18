import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@ddv/core';
import { createScreenMap, normalizeScreenMap, parseScenarioFile, type PlatformMap } from '@ddv/mock';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDesktopNames, checkRunnerNames, type NameCheckScenario } from './check.ts';
import { scanDesigner, scanScreenDefs, scanXaml, screenScope, type ScreenDefFs, type ScreenDefIndex } from './screen-defs.ts';

const WPF: Record<string, string> = {
  'app/App.xaml': '<Application x:Class="OrderApp.App" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Application.Resources/></Application>',
  'app/Styles.xaml': '<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Style x:Key="s"/></ResourceDictionary>',
  'app/MainWindow.xaml': `<Window x:Class="OrderApp.MainWindow" x:Name="List"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    xmlns:local="clr-namespace:OrderApp" xmlns:ext="clr-namespace:Other;assembly=Other">
  <Window.Resources><ext:Conv x:Key="c"/></Window.Resources>
  <Grid>
    <Button x:Name="new" Content="新規"/>
    <local:InputView x:Name="Input" Visibility="Collapsed"/>
    <local:Footer/>
  </Grid>
</Window>`,
  'app/InputView.xaml': `<UserControl x:Class="OrderApp.InputView" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <StackPanel><TextBox x:Name="customer"/><Button AutomationProperties.AutomationId="next"/></StackPanel>
</UserControl>`,
  'app/Footer.xaml': `<UserControl x:Class="OrderApp.Footer" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><TextBlock Name="status"/></UserControl>`,
  'app/ConfirmWindow.xaml': `<Window x:Class="OrderApp.ConfirmWindow" AutomationProperties.AutomationId="ConfirmRoot" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <StackPanel><TextBlock AutomationProperties.AutomationId="confirm-customer"/><Button x:Name="submit"/></StackPanel>
</Window>`,
  'app/bin/Debug/Copy.xaml': '<Window x:Class="X.Copy" x:Name="Ghost" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"/>',
};

const memFs = (files: Record<string, string>): ScreenDefFs => ({
  list: async (dir) => {
    const all = Object.keys(files).filter((f) => f.startsWith(`${dir}/`) && !/\/(bin|obj)\//.test(f));
    return all.length ? all.sort() : null;
  },
  read: async (f) => files[f] ?? null,
});

async function wpfIndex(): Promise<ScreenDefIndex> {
  return (await scanScreenDefs(memFs(WPF), 'app', 'wpf'))!;
}

describe('画面定義の走査', () => {
  it('WPF：App.xaml・ResourceDictionary・bin を除き、ルートの名前・子孫の名前・使う UserControl を集める', async () => {
    const idx = await wpfIndex();
    expect(idx.defs.map((d) => [d.file, d.kind, d.className, d.rootName ?? null])).toEqual([
      ['app/ConfirmWindow.xaml', 'Window', 'ConfirmWindow', 'ConfirmRoot'],
      ['app/Footer.xaml', 'UserControl', 'Footer', null],
      ['app/InputView.xaml', 'UserControl', 'InputView', null],
      ['app/MainWindow.xaml', 'Window', 'MainWindow', 'List'],
    ]);
    const main = idx.defs[3];
    expect([...main.names]).toEqual(['new', 'Input']);
    expect(main.uses.sort()).toEqual(['Footer', 'InputView']);
    expect([...main.namedTypes]).toEqual([['Input', 'InputView']]);
    expect(scanXaml('a.xaml', '<Window')).toBeNull();
  });

  it('WinForms：Designer.cs の this.Name・this.x.Name・new T() と基底の型', async () => {
    const designer = `namespace OrderApp {
  partial class OrderForm {
    private void InitializeComponent() {
      this.customer = new System.Windows.Forms.TextBox();
      this.input = new OrderApp.InputPanel();
      this.customer.Name = "customer";
      this.input.Name = "Input";
      this.Name = "List";
    }
  }
}`;
    const d = scanDesigner('f/OrderForm.Designer.cs', designer, 'public partial class OrderForm : Form { }')!;
    expect(d).toMatchObject({ kind: 'Form', className: 'OrderForm', rootName: 'List' });
    expect([...d.names]).toEqual(['customer', 'Input']);
    const panel = scanDesigner('f/InputPanel.Designer.cs', 'partial class InputPanel { void I() { this.next = new Button(); this.next.Name = "next"; } }', 'partial class InputPanel : System.Windows.Forms.UserControl {}')!;
    expect(panel.kind).toBe('UserControl');
    const idx = (await scanScreenDefs(memFs({ 'f/OrderForm.Designer.cs': designer, 'f/OrderForm.cs': 'partial class OrderForm : Form {}', 'f/InputPanel.Designer.cs': 'partial class InputPanel { void I() { this.next = new Button(); this.next.Name = "next"; } }', 'f/InputPanel.cs': 'partial class InputPanel : UserControl {}' }), 'f', 'winforms'))!;
    const form = idx.defs.find((x) => x.className === 'OrderForm')!;
    expect(form.uses).toEqual(['InputPanel']);
    const s = screenScope(idx, undefined, 'Input');
    expect(s.kind === 'file' && [...s.names]).toEqual(['next']);
    expect(await scanScreenDefs(memFs({}), 'none', 'winforms')).toBeNull();
  });
});

describe('画面と定義ファイル（SCRFILE）', () => {
  it('[DD-DSCN-SCRFILE-P001][DD-DSCN-SCRFILE-T001][DD-DSCN-SCRFILE-T002] title の規則はプロジェクト全体の名前', async () => {
    const s = screenScope(await wpfIndex(), { title: '完了' }, 'Done');
    expect(s.kind).toBe('project');
    expect(s.kind === 'project' && s.names.has('confirm-customer') && s.names.has('customer')).toBe(true);
  });

  it('[DD-DSCN-SCRFILE-P002][DD-DSCN-SCRFILE-T003][DD-DSCN-SCRFILE-T005][DD-DSCN-SCRFILE-T007] automationId の規則：ルートの名前のファイル', async () => {
    const s = screenScope(await wpfIndex(), { automationId: 'ConfirmRoot' }, 'Confirm');
    expect(s.kind === 'file' && s.def.file).toBe('app/ConfirmWindow.xaml');
  });

  it('[DD-DSCN-SCRFILE-P003][DD-DSCN-SCRFILE-T008][DD-DSCN-SCRFILE-T009] automationId の規則：ほかのファイルの名前の付いた UserControl の型のファイル', async () => {
    const s = screenScope(await wpfIndex(), { automationId: 'Input' }, 'Entry');
    expect(s.kind === 'file' && s.def.file).toBe('app/InputView.xaml');
    expect(s.kind === 'file' && [...s.names]).toEqual(['customer', 'next']);
  });

  it('[DD-DSCN-SCRFILE-P004][DD-DSCN-SCRFILE-T010] automationId の規則：見つからない', async () => {
    expect(screenScope(await wpfIndex(), { automationId: 'Nothing' }, 'Entry')).toEqual({ kind: 'missing', name: 'Nothing' });
  });

  it('[DD-DSCN-SCRFILE-P005][DD-DSCN-SCRFILE-T004][DD-DSCN-SCRFILE-T006] 規則なし：状態IDの名前のファイル（使う UserControl の名前も範囲）', async () => {
    const idx = await wpfIndex();
    const s = screenScope(idx, undefined, 'List');
    expect(s.kind === 'file' && s.def.file).toBe('app/MainWindow.xaml');
    expect(s.kind === 'file' && [...s.names].sort()).toEqual(['Input', 'customer', 'new', 'next', 'status']);
    const byClass = screenScope(idx, undefined, 'ConfirmWindow');
    expect(byClass.kind === 'file' && byClass.def.file).toBe('app/ConfirmWindow.xaml');
  });

  it('[DD-DSCN-SCRFILE-P006] 規則なし：名前の付いた UserControl の型のファイル', async () => {
    const s = screenScope(await wpfIndex(), undefined, 'Input');
    expect(s.kind === 'file' && s.def.file).toBe('app/InputView.xaml');
  });

  it('[DD-DSCN-SCRFILE-P007] 規則なし：見つからない（bin の下は読まない）', async () => {
    expect(screenScope(await wpfIndex(), undefined, 'Ghost')).toEqual({ kind: 'missing', name: 'Ghost' });
  });
});

const SCENARIO = `id: BD-X-P001
title: t
start: List
steps:
  - event: 新規
    click: new
    expect: { screen: Input, hidden: [ error ] }
  - input: { customer: 山田 }
    click: clear
    only: winforms
  - event: 次へ [入力OK]
    input: { customer: 山田, memo: x }
    click: next
    expect: { screen: Confirm, text: { confirm-customer: 山田 } }
  - event: 確定
    click: submit
    expect: { screen: Done }
`;

function scenarios(text = SCENARIO): NameCheckScenario[] {
  const sf = parseScenarioFile(text, 's.yaml');
  if (!sf.scenario) throw new Error(JSON.stringify(sf.issues));
  return [{ file: 'docs/mocks/order/scenarios/s.yaml', text, scenario: sf.scenario }];
}

async function run(map: Partial<PlatformMap>, text?: string, index?: ScreenDefIndex | null) {
  const pm = createScreenMap({ wpf: map }).wpf;
  return checkRunnerNames({
    runner: { name: 'wpf', source: 'app', platform: 'wpf' },
    index: index === undefined ? await wpfIndex() : index,
    scenarios: scenarios(text),
    mapOf: () => ({ rel: 'docs/mocks/order/scenarios/_map.yaml', text: 'wpf:\n  fields:\n    memo: MemoBox\n  events:\n    確定: SubmitButton\n', map: pm }),
  });
}

const BASE_MAP: Partial<PlatformMap> = { screens: { Confirm: { automationId: 'ConfirmRoot' }, Done: { title: '完了' } }, ignore: ['error'], fields: { memo: 'customer' } };

describe('ステップごとの検査（NAMECHK）', () => {
  it('[DD-DSCN-NAMECHK-P001][DD-DSCN-NAMECHK-T001][DD-DSCN-NAMECHK-T002] 画面定義を読めなければ warning で省略', async () => {
    expect(await run(BASE_MAP, undefined, null)).toEqual([
      { severity: 'warning', rule: 'desktop-names', path: 'app', message: 'ランナー wpf の画面定義（source: app）が見つかりません。名前の検査を省略します' },
    ]);
  });

  it('[DD-DSCN-NAMECHK-P002][DD-DSCN-NAMECHK-P004][DD-DSCN-NAMECHK-P006][DD-DSCN-NAMECHK-T003][DD-DSCN-NAMECHK-T004][DD-DSCN-NAMECHK-T005][DD-DSCN-NAMECHK-T006][DD-DSCN-NAMECHK-T007][DD-DSCN-NAMECHK-T009][DD-DSCN-NAMECHK-T010][DD-DSCN-NAMECHK-T012] ignore は検査しない・読み替え先や名前が範囲にあれば問題なし（only の他プラットフォームは見ない）', async () => {
    const issues = await run(BASE_MAP);
    // Done は title の規則なので warning だけ
    expect(issues.map((i) => [i.severity, i.message])).toEqual([['warning', 'ランナー wpf（wpf）: 画面 Done は title で見分けるため、定義のファイルを特定できません。プロジェクト全体の名前で調べます']]);
  });

  it('[DD-DSCN-NAMECHK-P003][DD-DSCN-NAMECHK-T008] 読み替え先の欠けは _map.yaml の行で error', async () => {
    const issues = await run({ ...BASE_MAP, fields: { memo: 'MemoBox' }, events: { 確定: 'SubmitButton' } });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([
      { severity: 'error', rule: 'desktop-names', path: 'docs/mocks/order/scenarios/_map.yaml', line: 3, message: '_map.yaml の wpf.fields.memo の読み替え先 MemoBox が画面 Input にありません' },
      { severity: 'error', rule: 'desktop-names', path: 'docs/mocks/order/scenarios/_map.yaml', line: 5, message: '_map.yaml の wpf.events.確定 の読み替え先 SubmitButton が画面 Confirm にありません' },
    ]);
  });

  it('[DD-DSCN-NAMECHK-P005][DD-DSCN-NAMECHK-T011] 名前の欠けはシナリオの行で error（同じ名前は 1 回）。画面の定義が無ければ画面の error', async () => {
    const text = SCENARIO.replace('click: next', 'click: go').replace('{ customer: 山田, memo: x }', '{ customer: 山田, memo: x, phone: 1 }');
    const issues = await run({ ...BASE_MAP, screens: { Confirm: { automationId: 'Nope' }, Done: { title: '完了' } }, ignore: [] }, text);
    expect(issues.filter((i) => i.severity === 'error').map((i) => [i.line, i.message])).toEqual([
      [7, 'シナリオ BD-X-P001 ステップ 1（wpf）: 画面 Input に名前 error がありません（x:Name / Name を付けるか、_map.yaml の wpf.events / fields で読み替えてください）'],
      [14, 'ランナー wpf（wpf）: 画面 Confirm の定義（x:Name・AutomationId が Nope の Window・Page・UserControl）が見つかりません'],
      [12, 'シナリオ BD-X-P001 ステップ 3（wpf）: 画面 Input に名前 phone がありません（x:Name / Name を付けるか、_map.yaml の wpf.events / fields で読み替えてください）'],
      [13, 'シナリオ BD-X-P001 ステップ 3（wpf）: 画面 Input に名前 go がありません（x:Name / Name を付けるか、_map.yaml の wpf.events / fields で読み替えてください）'],
    ]);
  });
});

describe('名前の検査（BD-DESKRUN-CHECK）', () => {
  const issuesOf = (text: string) => parseScenarioFile(text, 's.yaml').issues.map((i) => i.message);

  it('[BD-DESKRUN-CHECK-P001][BD-DESKRUN-CHECK-T001][BD-DESKRUN-CHECK-T002] 対応表の形式の error', () => {
    const r = normalizeScreenMap({ wpf: { screens: { List: { url: '/x' } } } });
    expect(r.ok).toBe(false);
  });

  it('[BD-DESKRUN-CHECK-P002][BD-DESKRUN-CHECK-T003][BD-DESKRUN-CHECK-T004] 遷移のステップに only は error', () => {
    expect(issuesOf(SCENARIO.replace('    click: new\n', '    click: new\n    only: wpf\n')).join()).toMatch(/遷移のステップに only は付けられません/);
  });

  it('[BD-DESKRUN-CHECK-P003][BD-DESKRUN-CHECK-T005][BD-DESKRUN-CHECK-T006] 不明なプラットフォームは error', () => {
    expect(issuesOf(SCENARIO.replace('only: winforms', 'only: mac')).join()).toMatch(/不明なプラットフォームです: mac/);
  });

  const root = mkdtempSync(path.join(os.tmpdir(), 'ddv-names-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const repo = (map: string, withDefs = true) => {
    const dir = mkdtempSync(path.join(root, 'r-'));
    mkdirSync(path.join(dir, 'docs', 'mocks', 'order', 'scenarios'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'mocks', 'order', 'scenarios', 'BD-X-P001.yaml'), SCENARIO);
    writeFileSync(path.join(dir, 'docs', 'mocks', 'order', 'scenarios', '_map.yaml'), map);
    if (withDefs) for (const [f, t] of Object.entries(WPF)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), t);
    }
    return dir;
  };
  const config = parseConfig({ runners: [{ name: 'wpf', type: 'flaui', platform: 'wpf', app: { path: 'app/bin/App.exe' }, source: 'app' }, { name: 'u', type: 'vitest' }] });
  const okMap = 'wpf:\n  screens:\n    Confirm: { automationId: ConfirmRoot }\n    Done: { title: 完了 }\n  fields: { memo: customer }\n  ignore: [ error ]\n';
  const errorsOf = async (dir: string) => (await checkDesktopNames(dir, config)).filter((i) => i.severity === 'error').map((i) => i.message);

  it('[BD-DESKRUN-CHECK-P004][BD-DESKRUN-CHECK-T007][BD-DESKRUN-CHECK-T008] flaui のランナーの画面定義を読めなければ warning', async () => {
    const issues = await checkDesktopNames(repo(okMap, false), config);
    expect(issues.map((i) => i.severity)).toEqual(['warning']);
  });

  it('[BD-DESKRUN-CHECK-P005][BD-DESKRUN-CHECK-T009][BD-DESKRUN-CHECK-T010] 名前の欠け', async () => {
    expect(await errorsOf(repo(okMap.replace('  ignore: [ error ]\n', '')))).toEqual([expect.stringMatching(/画面 Input に名前 error がありません/)]);
  });

  it('[BD-DESKRUN-CHECK-P006][BD-DESKRUN-CHECK-T011][BD-DESKRUN-CHECK-T012] 読み替え先の欠け', async () => {
    expect(await errorsOf(repo(okMap.replace('memo: customer', 'memo: MemoBox')))).toEqual(['_map.yaml の wpf.fields.memo の読み替え先 MemoBox が画面 Input にありません']);
  });

  it('[BD-DESKRUN-CHECK-P007][BD-DESKRUN-CHECK-T013] 名前も読み替え先もあれば OK（不正な対応表のシナリオは checkMocks に任せる）', async () => {
    expect(await errorsOf(repo(okMap))).toEqual([]);
    expect(await checkDesktopNames(repo('wpf: [ 1 ]\n'), config)).toEqual([]);
    expect(await checkDesktopNames(repo(okMap), parseConfig({}))).toEqual([]);
  });
});
