import { describe, expect, it } from 'vitest';
import { DesktopGate, DOTNET_URL, GATE_MESSAGES, sdkFromList, type DesktopGateOptions, type GateRunner } from './gate.ts';

const SDK8 = '8.0.404 [C:\\Program Files\\dotnet\\sdk]\r\n';
const wpf: GateRunner = { name: 'wpf', type: 'flaui', platform: 'wpf', app: { path: 'apps/Order.exe', args: [] } };
const winforms: GateRunner = { ...wpf, name: 'wf', platform: 'winforms' };
const web: GateRunner = { name: 'e2e', type: 'playwright', platform: undefined, app: undefined };

function gate(o: Partial<DesktopGateOptions> = {}) {
  const calls = { sdk: 0 };
  const g = new DesktopGate({
    repoRoot: 'C:\\repo',
    platform: 'win32',
    listSdks: async () => {
      calls.sdk++;
      return SDK8;
    },
    exists: () => true,
    ...o,
  });
  return { g, calls };
}

describe('実行の可否 DesktopGate（DD-FLAUI-GATE）', () => {
  it('[DD-FLAUI-GATE-P001] [DD-FLAUI-GATE-T001] [DD-FLAUI-GATE-T002] web のランナーは OS・SDK にかかわらず使える', async () => {
    const { g, calls } = gate({ platform: 'linux', listSdks: async () => '' });
    expect(await g.evaluate(web)).toEqual({ available: true });
    expect(await g.evaluate({ ...web, platform: 'web' })).toEqual({ available: true });
    expect(calls.sdk).toBe(0);
  });

  it('[DD-FLAUI-GATE-P002] [DD-FLAUI-GATE-T003] [DD-FLAUI-GATE-T004] wpf・winforms で Windows でなければ not-windows', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const { g, calls } = gate({ platform });
      for (const r of [wpf, winforms]) expect(await g.evaluate(r)).toEqual({ available: false, code: 'not-windows', reason: 'デスクトップアプリの実行は Windows でだけ行えます' });
      expect(calls.sdk).toBe(0);
    }
  });

  it('[DD-FLAUI-GATE-P003] [DD-FLAUI-GATE-T005] [DD-FLAUI-GATE-T006] 8 以上の SDK が無ければ no-dotnet と導入の URL', async () => {
    for (const out of ['', '6.0.428 [C:\\dotnet\\sdk]\n7.0.410 [C:\\dotnet\\sdk]\n', 'dotnet: command not found']) {
      const { g } = gate({ listSdks: async () => out });
      expect(await g.evaluate(wpf)).toEqual({ available: false, code: 'no-dotnet', reason: GATE_MESSAGES['no-dotnet'], url: DOTNET_URL });
    }
    const { g } = gate({ listSdks: () => Promise.reject(new Error('ENOENT')) });
    expect((await g.evaluate(winforms)).code).toBe('no-dotnet');
    expect(DOTNET_URL).toBe('https://dotnet.microsoft.com/download');
    expect(GATE_MESSAGES['no-dotnet']).toBe('.NET SDK が見つかりません（導入の案内）');
  });

  it('[DD-FLAUI-GATE-P004] [DD-FLAUI-GATE-T007] [DD-FLAUI-GATE-T008] app.path のファイルが無ければ app-missing（リポジトリのルートからの相対）', async () => {
    const seen: string[] = [];
    const { g } = gate({
      exists: (f) => {
        seen.push(f);
        return false;
      },
    });
    expect(await g.evaluate(wpf)).toEqual({ available: false, code: 'app-missing', reason: 'アプリの実行ファイルが見つかりません（ビルドしてください）' });
    expect(seen[0].replaceAll('\\', '/')).toMatch(/repo\/apps\/Order\.exe$/);
    expect((await g.evaluate({ ...wpf, app: undefined })).code).toBe('app-missing');
  });

  it('[DD-FLAUI-GATE-P005] [DD-FLAUI-GATE-T009] Windows・SDK 8 以上・実行ファイルがあれば使える', async () => {
    const { g } = gate({ listSdks: async () => `7.0.100 [x]\n${SDK8}9.0.100-preview.1 [x]\n` });
    expect(await g.evaluate(wpf)).toEqual({ available: true });
    expect(await g.evaluate(winforms)).toEqual({ available: true });
  });

  it('dotnet --list-sdks の結果はプロセスの間 30 秒保持する（cacheMs: 0 は毎回）', async () => {
    let t = 0;
    const { g, calls } = gate({ now: () => t });
    await g.evaluate(wpf);
    t = 29_999;
    await g.evaluate(winforms);
    expect(calls.sdk).toBe(1);
    t = 30_000;
    await g.evaluate(wpf);
    expect(calls.sdk).toBe(2);
    const doctor = gate({ cacheMs: 0 });
    await doctor.g.evaluate(wpf);
    await doctor.g.evaluate(wpf);
    expect(doctor.calls.sdk).toBe(2);
  });

  it('sdkFromList は 8 以上の最も新しい版を返す', () => {
    expect(sdkFromList('8.0.100 [a]\n10.0.100 [a]\n9.0.300 [a]\n')).toBe('10.0.100');
    expect(sdkFromList('7.0.100 [a]')).toBeNull();
  });
});
