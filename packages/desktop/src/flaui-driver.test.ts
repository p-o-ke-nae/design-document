import { StepError, createScreenMap, type Scenario } from '@ddv/mock';
import { describe, expect, it } from 'vitest';
import { DriverError } from './client.ts';
import { FlaUiDriver, fillMethod, type DriverRequester, type FindResult } from './flaui-driver.ts';

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** Fake `DriverClient`: elements by name; `appearAfter` makes an element appear after n finds. */
function fake(elements: Record<string, Partial<FindResult> & { appearAfter?: number; text?: string | null; count?: number }>, title?: string) {
  const calls: Call[] = [];
  const seen: Record<string, number> = {};
  const client: DriverRequester = {
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ cmd, args });
      const name = String(args.name);
      const e = elements[name];
      if (cmd === 'find') {
        if (args.by === 'title') return { found: title === name, visible: title === name, controlType: 'Window', patterns: [] } as T;
        seen[name] = (seen[name] ?? 0) + 1;
        if (!e || seen[name] <= (e.appearAfter ?? 0)) return { found: false, visible: false, controlType: null, patterns: [] } as T;
        return { found: true, visible: e.visible ?? true, controlType: e.controlType ?? 'Edit', patterns: e.patterns ?? [] } as T;
      }
      if (!e) throw new DriverError('notFound', `要素が見つかりません: ${name}`);
      if (cmd === 'query') return (args.what === 'text' ? (e.text ?? null) : (e.count ?? 0)) as T;
      return {} as T;
    },
  };
  return { client, calls };
}

const map = createScreenMap({ wpf: { fields: { customer: 'CustomerNameBox' }, events: { 次へ: 'NextButton' }, screens: { Done: { title: '完了' } } } }).wpf;

describe('FlaUiDriver.fill', () => {
  it('[DD-FLAUI-FILL-P001][DD-FLAUI-FILL-T001][DD-FLAUI-FILL-T002] 期限まで見つからなければ notFound（論理名と探した名前）', async () => {
    const { client } = fake({});
    const d = new FlaUiDriver(client, { platform: 'wpf', map, timeout: 30, pollMs: 5 });
    const e = await d.fill('customer', '山田').catch((x) => x);
    expect(e).toBeInstanceOf(StepError);
    expect(e.kind).toBe('notFound');
    expect(e.message).toBe('要素が見つかりません: 論理名 customer（対応表で CustomerNameBox）（探した名前: CustomerNameBox、wpf）');
  });

  it('[DD-FLAUI-FILL-P002][DD-FLAUI-FILL-T003][DD-FLAUI-FILL-T004] Toggle は toggle（true / false）', async () => {
    const { client, calls } = fake({ agree: { patterns: ['Toggle', 'Invoke'], appearAfter: 2 } });
    const d = new FlaUiDriver(client, { platform: 'wpf', timeout: 1000, pollMs: 1 });
    expect(await d.fieldKind('agree')).toBe('checkbox');
    await d.fill('agree', true);
    await d.fill('agree', 'off');
    expect(calls.filter((c) => c.cmd === 'toggle').map((c) => c.args)).toEqual([
      { name: 'agree', on: true },
      { name: 'agree', on: false },
    ]);
  });

  it('[DD-FLAUI-FILL-P003][DD-FLAUI-FILL-T005] 選択・ExpandCollapse は select（表示文字列）', async () => {
    const { client, calls } = fake({ sku: { patterns: ['Selection'] }, combo: { patterns: ['ExpandCollapse', 'Value'] } });
    const d = new FlaUiDriver(client, { platform: 'winforms', timeout: 0 });
    expect(await d.fieldKind('combo')).toBe('select');
    await d.fill('sku', 'A-001 りんご');
    await d.fill('combo', '2');
    expect(calls.filter((c) => c.cmd === 'select').map((c) => c.args)).toEqual([
      { name: 'sku', text: 'A-001 りんご' },
      { name: 'combo', text: '2' },
    ]);
  });

  it('[DD-FLAUI-FILL-P004][DD-FLAUI-FILL-T006] Value は setValue（対応表の名前で）', async () => {
    const { client, calls } = fake({ CustomerNameBox: { patterns: ['Value'] } });
    const d = new FlaUiDriver(client, { platform: 'wpf', map, timeout: 0 });
    expect(await d.fieldKind('customer')).toBe('text');
    await d.fill('customer', '山田 太郎');
    expect(calls.at(-1)).toEqual({ cmd: 'setValue', args: { name: 'CustomerNameBox', value: '山田 太郎' } });
  });

  it('[DD-FLAUI-FILL-P005][DD-FLAUI-FILL-T007] どのパターンも無ければ「入力できない要素です」', async () => {
    const { client } = fake({ label: { patterns: ['Invoke'], controlType: 'Text' } });
    const d = new FlaUiDriver(client, { platform: 'wpf', timeout: 0 });
    expect(await d.fieldKind('label')).toBeNull();
    await expect(d.fill('label', 'x')).rejects.toMatchObject({ kind: 'notFound', message: '入力できない要素です: label（Text）' });
    expect(fillMethod(['Toggle', 'Value'])).toBe('toggle');
  });
});

describe('FlaUiDriver のほかの操作', () => {
  it('click は遷移ならイベント名、補助なら fields で読み替える', async () => {
    const { client, calls } = fake({ NextButton: { patterns: ['Invoke'] }, CustomerNameBox: { patterns: ['Invoke'] } });
    const d = new FlaUiDriver(client, { platform: 'wpf', map, timeout: 0 });
    await d.click('next', '次へ');
    await d.click('customer');
    expect(calls.filter((c) => c.cmd === 'invoke').map((c) => c.args.name)).toEqual(['NextButton', 'CustomerNameBox']);
    await expect(d.click('missing')).rejects.toMatchObject({ kind: 'notFound', message: '要素が見つかりません: 論理名 missing（探した名前: missing、wpf）' });
  });

  it('invoke は desktopSteps を呼び、無ければ unknownOp', async () => {
    const ran: string[] = [];
    const d = new FlaUiDriver(fake({}).client, { platform: 'wpf', timeout: 0, steps: { 在庫を減らす: () => void ran.push('x') } });
    await d.invoke('在庫を減らす');
    expect(ran).toEqual(['x']);
    expect(d.hasOp('在庫を減らす')).toBe(true);
    expect(d.hasOp('toString')).toBe(false);
    await expect(d.invoke('無い')).rejects.toMatchObject({ kind: 'unknownOp' });
  });

  it('screen は直前の画面から、シナリオに現れる順で調べる（title の規則も）', async () => {
    const scenario = { id: 'X', title: 't', start: 'List', steps: [{ event: 'a', click: 'a', expect: { screen: 'Input' } }, { event: 'b', click: 'b', expect: { screen: 'Done' } }] } as unknown as Scenario;
    const els: Record<string, Partial<FindResult>> = { List: {}, Input: {} };
    const { client, calls } = fake(els, '完了');
    const d = new FlaUiDriver(client, { platform: 'wpf', map, timeout: 0 });
    d.useScenario(scenario);
    expect(await d.screen()).toBe('List');
    delete els.List;
    calls.length = 0;
    expect(await d.screen()).toBe('Input');
    expect(calls.map((c) => c.args.name)).toEqual(['List', 'Input']);
    calls.length = 0;
    els.Input = { visible: false };
    expect(await d.screen()).toBe('Done');
    expect(calls[0].args.name).toBe('Input');
    expect(calls.at(-1)?.args).toEqual({ by: 'title', name: '完了' });
  });

  it('isVisible・text・count（見つからなければ false・null・0）', async () => {
    const { client } = fake({ total: { text: '1,200', visible: true }, rows: { count: 3, visible: false } });
    const d = new FlaUiDriver(client, { platform: 'winforms', timeout: 0 });
    expect(await d.isVisible('total')).toBe(true);
    expect(await d.isVisible('rows')).toBe(false);
    expect(await d.isVisible('none')).toBe(false);
    expect(await d.text('total')).toBe('1,200');
    expect(await d.text('none')).toBeNull();
    expect(await d.count('rows')).toBe(3);
    expect(await d.count('none')).toBe(0);
  });
});
