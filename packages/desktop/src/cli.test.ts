import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@ddv/core';
import { afterAll, describe, expect, it } from 'vitest';
import { desktopCommand, type DesktopCliIo } from './cli.ts';
import type { DesktopRunOptions } from './run.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'ddv-dcli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(path.join(root, 'app', 'bin'), { recursive: true });
writeFileSync(path.join(root, 'app', 'bin', 'App.exe'), '');
writeFileSync(path.join(root, 'app', 'MainWindow.xaml'), '<Window x:Class="A.MainWindow" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"/>');

const config = parseConfig({
  runners: [
    { name: 'wpf', type: 'flaui', platform: 'wpf', app: { path: 'app/bin/App.exe' }, source: 'app' },
    { name: 'wf', type: 'flaui', platform: 'winforms', app: { path: 'none/App.exe' }, source: 'none' },
    { name: 'u', type: 'vitest' },
  ],
});

function io(over: Partial<DesktopCliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: DesktopCliIo = { out: (l) => out.push(l), err: (l) => err.push(l), cwd: root, help: 'HELP', loadConfig: async () => config, ...over };
  return { value, out, err };
}

describe('ddv desktop', () => {
  it('不明なサブコマンド・--runner なし・リポジトリなしは終了コード 2', async () => {
    const a = io();
    expect(await desktopCommand(['x'], a.value)).toBe(2);
    expect(a.err[0]).toMatch(/^不明なサブコマンド: desktop x/);
    expect(await desktopCommand(['run'], a.value)).toBe(2);
    expect(await desktopCommand(['run', '--runner', 'wpf', '--repo', 'nope'], a.value)).toBe(2);
    expect(await desktopCommand(['doctor', '--runner', 'u'], a.value)).toBe(2);
  });

  it('run は引数を desktopRun に渡し、その終了コードを返す', async () => {
    let got: DesktopRunOptions | undefined;
    const a = io({ run: async (o) => ((got = o), { runner: o.runner, platform: 'wpf', cases: [], exitCode: 1 }) });
    expect(await desktopCommand(['run', '--runner', 'wpf', '--ids', 'A, B', '--junit', 'r.xml', '--trace', 't'], a.value)).toBe(1);
    expect(got).toMatchObject({ repoRoot: root, runner: 'wpf', ids: ['A', 'B'], junit: path.join(root, 'r.xml'), trace: path.join(root, 't') });
    const b = io({ run: async () => { throw new Error('ランナー x が設定にありません'); } });
    expect(await desktopCommand(['run', '--runner', 'x'], b.value)).toBe(2);
    expect(b.err).toEqual(['ランナー x が設定にありません']);
  });

  it('doctor は ランナーごとに OS・.NET SDK・実行ファイル・ドライバ・画面定義を表示し、✗ があれば 1', async () => {
    const a = io({ platform: 'win32', listSdks: async () => '8.0.100 [C:\\dotnet\\sdk]\n', driver: { cached: async () => 'C:/cache/FlaUiDriver.dll', ensure: async () => '' } });
    expect(await desktopCommand(['doctor', '--runner', 'wpf'], a.value)).toBe(0);
    expect(a.out).toEqual(['wpf（wpf）', '  ✓ OS: win32', '  ✓ .NET SDK: 8.0.100', `  ✓ 実行ファイル: ${path.join(root, 'app', 'bin', 'App.exe')}`, '  ✓ ドライバ: キャッシュあり（C:/cache/FlaUiDriver.dll）', '  ✓ 画面定義: 1 件（source: app）']);
    const b = io({ platform: 'linux', listSdks: async () => '' });
    expect(await desktopCommand(['doctor'], b.value)).toBe(1);
    expect(b.out.filter((l) => l.includes('✗')).length).toBe(8);
    expect(b.out[1]).toBe('  ✗ OS: linux（デスクトップアプリの実行は Windows でだけ行えます）');
    const c = io({ platform: 'win32', listSdks: async () => '8.0.100 [x]', driver: { cached: async () => null, ensure: async () => { throw new Error('ドライバのビルドに失敗しました'); } } });
    expect(await desktopCommand(['doctor', '--runner', 'wpf'], c.value)).toBe(1);
    expect(c.out).toContain('  ✗ ドライバ: ドライバのビルドに失敗しました');
  });
});
