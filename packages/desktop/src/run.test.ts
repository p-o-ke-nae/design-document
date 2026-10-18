import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, type DdvConfig } from '@ddv/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DriverError } from './client.ts';
import { FixturesError, FixturesWriter, readFixtures } from './fixtures.ts';
import { junitXml } from './junit.ts';
import { desktopRun, type DesktopDriverClient } from './run.ts';

let repo: string;

const scenario = (id: string, quantityText = '2') => `id: ${id}
title: 一覧から入力へ
fixtures: [ default, extra ]
start: List
steps:
  - event: 新規
    click: new
    expect: { screen: Input }
  - input: { customer: 山田 }
    click: clear
    only: wpf
  - event: 次へ
    input: { quantity: "${quantityText}" }
    click: next
    expect: { screen: Confirm, text: { confirm-quantity: "2" } }
`;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'ddv-drun-'));
  const mock = path.join(repo, 'docs', 'mocks', 'order');
  mkdirSync(path.join(mock, 'scenarios'), { recursive: true });
  mkdirSync(path.join(mock, 'fixtures'), { recursive: true });
  writeFileSync(path.join(mock, 'fixtures', 'default.yaml'), 'orders:\n  - { id: 1, customer: 佐藤 }\nstock:\n  - { sku: A, qty: 1 }\n');
  writeFileSync(path.join(mock, 'fixtures', 'extra.yaml'), 'orders:\n  - { id: 2, customer: 鈴木 }\n');
  writeFileSync(path.join(mock, 'scenarios', 'A.yaml'), scenario('BD-X-P001'));
  writeFileSync(path.join(mock, 'scenarios', 'B.yaml'), scenario('BD-X-P002', '3'));
  writeFileSync(path.join(mock, 'scenarios', '_map.yaml'), 'winforms:\n  fields: { quantity: QuantityBox }\n');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const config = (platform = 'winforms'): DdvConfig =>
  parseConfig({ runners: [{ name: 'desk', type: 'flaui', platform, app: { path: 'bin/App.exe' }, source: 'src', timeout: 300 }] });

/** A tiny fake app behind the driver protocol: List --new--> Input --next--> Confirm. */
function fakeApp() {
  let screen = 'List';
  const values: Record<string, string> = {};
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const elements: Record<string, string[]> = { List: ['new'], Input: ['customer', 'QuantityBox', 'next', 'clear'], Confirm: ['confirm-quantity'] };
  const client: DesktopDriverClient = {
    start: async () => undefined,
    ensureStarted: async () => undefined,
    stop: async () => undefined,
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ cmd, args });
      const name = String(args.name);
      const here = name === screen || elements[screen].includes(name);
      switch (cmd) {
        case 'launch':
          screen = 'List';
          return {} as T;
        case 'find':
          return { found: here, visible: here, controlType: 'Edit', patterns: name === 'customer' || name === 'QuantityBox' ? ['Value'] : ['Invoke'] } as T;
        case 'setValue':
          values[name] = String(args.value);
          return {} as T;
        case 'invoke':
          if (name === 'new') screen = 'Input';
          if (name === 'next') screen = 'Confirm';
          return {} as T;
        case 'query':
          if (!here) throw new DriverError('notFound', 'x');
          return (name === 'confirm-quantity' ? values.QuantityBox : null) as T;
        default:
          return {} as T;
      }
    },
  };
  return { client, calls };
}

describe('desktopRun', () => {
  it('シナリオを順に実行し、JUnit とトレースを書く（only・対応表・fixtures・環境変数）', async () => {
    const { client, calls } = fakeApp();
    const junit = path.join(repo, 'out', 'desk.xml');
    const trace = path.join(repo, 'traces', 'run1');
    const r = await desktopRun({ repoRoot: repo, config: config(), runner: 'desk', junit, trace, client, driverDll: async () => 'x.dll', gate: { evaluate: async () => ({ available: true }) }, log: () => undefined, pollMs: 5 });
    expect(r.cases.map((c) => [c.id, c.status])).toEqual([
      ['BD-X-P001', 'passed'],
      ['BD-X-P002', 'failed'],
    ]);
    expect(r.cases[1].message).toMatch(/ステップ 3（次へ）/);
    expect(r.exitCode).toBe(1);
    // only: wpf の補助ステップは winforms では実行しない
    expect(calls.some((c) => c.cmd === 'invoke' && c.args.name === 'clear')).toBe(false);
    expect(calls.find((c) => c.cmd === 'setValue')?.args).toEqual({ name: 'QuantityBox', value: '2' });
    const launch = calls.find((c) => c.cmd === 'launch')!.args as { path: string; env: Record<string, string>; automation: string };
    expect(launch.path).toBe(path.join(repo, 'bin', 'App.exe'));
    expect(launch.automation).toBe('uia3');
    expect(launch.env.DDV_SCENARIO).toBe('BD-X-P001');
    expect(launch.env.DDV_PLATFORM).toBe('winforms');
    expect(calls.filter((c) => c.cmd === 'close')).toHaveLength(2);
    const xml = readFileSync(junit, 'utf8');
    expect(xml).toContain('<testcase name="[BD-X-P001] 一覧から入力へ" classname="desk"');
    expect(xml).toMatch(/<failure message="ステップ 3（次へ）/);
    const files = readdirSync(trace).sort();
    expect(files).toEqual(['BD-X-P001@winforms.json', 'BD-X-P002@winforms.json']);
    const t = JSON.parse(readFileSync(path.join(trace, 'BD-X-P001@winforms.json'), 'utf8'));
    expect(t.platform).toBe('winforms');
    expect(t.steps.map((s: { skipped?: boolean }) => !!s.skipped)).toEqual([false, true, false]);
  });

  it('ids で絞る。使えないときはすべて error（理由）', async () => {
    const { client } = fakeApp();
    const r = await desktopRun({ repoRoot: repo, config: config(), runner: 'desk', ids: ['BD-X-P002'], client, gate: { evaluate: async () => ({ available: false, code: 'no-dotnet', reason: '.NET SDK が見つかりません（導入の案内）', url: 'https://dotnet.microsoft.com/download' }) }, log: () => undefined });
    expect(r.cases).toEqual([{ id: 'BD-X-P002', title: '一覧から入力へ', status: 'error', durationMs: 0, message: '.NET SDK が見つかりません（導入の案内）（https://dotnet.microsoft.com/download）' }]);
    expect(r.exitCode).toBe(1);
  });

  it('ドライバのビルドに失敗したらすべて error。fixtures が読めなければ開始前の失敗', async () => {
    const { client } = fakeApp();
    const gate = { evaluate: async () => ({ available: true }) };
    const r = await desktopRun({ repoRoot: repo, config: config(), runner: 'desk', client, gate, driverDll: async () => Promise.reject(new Error('ドライバのビルドに失敗しました')), log: () => undefined });
    expect(r.cases.map((c) => c.status)).toEqual(['error', 'error']);

    rmSync(path.join(repo, 'docs', 'mocks', 'order', 'fixtures', 'extra.yaml'));
    const trace = path.join(repo, 'traces', 'run2');
    const r2 = await desktopRun({ repoRoot: repo, config: config(), runner: 'desk', ids: ['BD-X-P001'], trace, client, gate, driverDll: async () => 'x', log: () => undefined });
    expect(r2.cases[0]).toMatchObject({ status: 'failed', message: 'fixtures extra が読めません' });
    expect(JSON.parse(readFileSync(path.join(trace, 'BD-X-P001@winforms.json'), 'utf8'))).toMatchObject({ failedStep: 0, error: 'fixtures extra が読めません' });
  });

  it('開始の画面にならなければ失敗する', async () => {
    const { client } = fakeApp();
    const base = client.request.bind(client);
    client.request = (async (cmd: string, args?: Record<string, unknown>) => (cmd === 'find' ? { found: false, visible: false, controlType: null, patterns: [] } : base(cmd, args))) as DesktopDriverClient['request'];
    const r = await desktopRun({ repoRoot: repo, config: config(), runner: 'desk', ids: ['BD-X-P001'], client, driverDll: async () => 'x', gate: { evaluate: async () => ({ available: true }) }, log: () => undefined, pollMs: 5 });
    expect(r.cases[0].message).toBe('開始の画面 List になりません（今：不明）');
  });

  it('flaui でないランナーは使えない', async () => {
    const c = parseConfig({ runners: [{ name: 'u', type: 'vitest' }] });
    await expect(desktopRun({ repoRoot: repo, config: c, runner: 'u' })).rejects.toThrow('ランナー u は type: flaui ではありません');
    await expect(desktopRun({ repoRoot: repo, config: c, runner: 'none' })).rejects.toThrow('ランナー none が設定にありません');
  });
});

describe('fixtures・JUnit', () => {
  it('テーブルごとに後の fixtures の行を後ろに足し、{ scenario, fixtures, tables } を書く', async () => {
    const mock = path.join(repo, 'docs', 'mocks', 'order');
    expect(await readFixtures(mock, ['default', 'extra'])).toEqual({ orders: [{ id: 1, customer: '佐藤' }, { id: 2, customer: '鈴木' }], stock: [{ sku: 'A', qty: 1 }] });
    const w = new FixturesWriter(path.join(repo, 'tmp'));
    const file = await w.write(mock, 'BD-X-P001', ['extra']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ scenario: 'BD-X-P001', fixtures: ['extra'], tables: { orders: [{ id: 2, customer: '鈴木' }] } });
    await w.dispose();
    await expect(readFixtures(mock, ['none'])).rejects.toThrow(new FixturesError('fixtures none が読めません'));
    writeFileSync(path.join(mock, 'fixtures', 'bad.yaml'), 'orders: 1\n');
    await expect(readFixtures(mock, ['bad'])).rejects.toThrow(/fixtures bad が読めません/);
  });

  it('JUnit の名前は [ID] title・classname はランナー名。XML の特殊文字を逃がす', () => {
    const xml = junitXml('wpf', [
      { id: 'A-1', title: '<確認> & "保存"', status: 'passed', durationMs: 1500 },
      { id: 'A-2', title: 't', status: 'error', durationMs: 0, message: '一行目\n二行目' },
    ]);
    expect(xml).toContain('<testcase name="[A-1] &lt;確認&gt; &amp; &quot;保存&quot;" classname="wpf" time="1.500"/>');
    expect(xml).toContain('<error message="一行目">一行目\n二行目</error>');
    expect(xml).toContain('tests="2" failures="0" errors="1"');
  });
});
