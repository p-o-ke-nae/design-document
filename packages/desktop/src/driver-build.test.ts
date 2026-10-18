import { promises as fs, existsSync, mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DriverBuilder, DriverBuildError, hashDriverSources, tailLines, type BuildOutcome } from './driver-build.ts';

let root: string;
let driverDir: string;
let cacheRoot: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ddv-dbuild-'));
  driverDir = path.join(root, 'driver');
  cacheRoot = path.join(root, 'cache');
  mkdirSync(driverDir);
  writeFileSync(path.join(driverDir, 'Program.cs'), 'class P {}');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function builder(build: (d: string, o: string) => Promise<BuildOutcome>, extra: Partial<ConstructorParameters<typeof DriverBuilder>[0]> = {}) {
  return new DriverBuilder({ version: '1.2.3', driverDir, cacheRoot, build, sleep: async () => undefined, ...extra });
}

const okBuild = (calls: string[]) => async (_d: string, out: string) => {
  calls.push(out);
  writeFileSync(path.join(out, 'FlaUiDriver.dll'), 'dll');
  return { code: 0, output: 'ok' };
};

describe('DriverBuilder', () => {
  it('[DD-FLAUI-DBUILD-P001][DD-FLAUI-DBUILD-T001][DD-FLAUI-DBUILD-T002] 作ってあるならビルドしない', async () => {
    const calls: string[] = [];
    const b = builder(okBuild(calls));
    const dir = await b.cacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'FlaUiDriver.dll'), 'x');
    writeFileSync(path.join(dir, '.ok'), 'x');
    expect(await b.ensure()).toBe(path.join(dir, 'FlaUiDriver.dll'));
    expect(calls).toEqual([]);
  });

  it('[DD-FLAUI-DBUILD-P006][DD-FLAUI-DBUILD-T003][DD-FLAUI-DBUILD-T006][DD-FLAUI-DBUILD-T007][DD-FLAUI-DBUILD-T009][DD-FLAUI-DBUILD-T010] ビルドして .ok を書きロックを消す', async () => {
    const calls: string[] = [];
    const b = builder(okBuild(calls));
    const dir = await b.cacheDir();
    expect(path.basename(dir)).toMatch(/^1\.2\.3-[0-9a-f]{12}$/);
    expect(await b.ensure()).toBe(path.join(dir, 'FlaUiDriver.dll'));
    expect(calls).toEqual([dir]);
    expect(existsSync(path.join(dir, '.ok'))).toBe(true);
    expect(existsSync(path.join(dir, '.lock'))).toBe(false);
  });

  it('[DD-FLAUI-DBUILD-P005][DD-FLAUI-DBUILD-T008] 失敗すると build.log を残し末尾 20 行を出す', async () => {
    const out = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
    const b = builder(async () => ({ code: 1, output: out }));
    const dir = await b.cacheDir();
    const e = await b.ensure().catch((x) => x);
    expect(e).toBeInstanceOf(DriverBuildError);
    expect(e.message).toContain('ドライバのビルドに失敗しました');
    expect(e.message).toContain('line30');
    expect(e.message).toContain('line11');
    expect(e.message).not.toContain('line10\n');
    expect(await fs.readFile(path.join(dir, 'build.log'), 'utf8')).toBe(out);
    expect(existsSync(path.join(dir, '.ok'))).toBe(false);
    expect(existsSync(path.join(dir, '.lock'))).toBe(false);
  });

  it('[DD-FLAUI-DBUILD-P002][DD-FLAUI-DBUILD-T004][DD-FLAUI-DBUILD-T005] ほかがビルド中なら、できあがるのを待つ', async () => {
    const calls: string[] = [];
    let dir = '';
    const b = builder(okBuild(calls), {
      sleep: async () => {
        // the other build finishes
        writeFileSync(path.join(dir, 'FlaUiDriver.dll'), 'x');
        writeFileSync(path.join(dir, '.ok'), 'x');
        await fs.rm(path.join(dir, '.lock'));
      },
    });
    dir = await b.cacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.lock'), '999');
    expect(await b.ensure()).toBe(path.join(dir, 'FlaUiDriver.dll'));
    expect(calls).toEqual([]);
  });

  it('[DD-FLAUI-DBUILD-P004] ほかのビルドが失敗して消えたら、自分でビルドする', async () => {
    const calls: string[] = [];
    let dir = '';
    const b = builder(okBuild(calls), { sleep: async () => fs.rm(path.join(dir, '.lock')) });
    dir = await b.cacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.lock'), '999');
    expect(await b.ensure()).toBe(path.join(dir, 'FlaUiDriver.dll'));
    expect(calls).toEqual([dir]);
  });

  it('[DD-FLAUI-DBUILD-P003] 待ったあとの自分のビルドも失敗する', async () => {
    let dir = '';
    const b = builder(async () => ({ code: 1, output: 'error CS0001' }), { sleep: async () => fs.rm(path.join(dir, '.lock')) });
    dir = await b.cacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.lock'), '999');
    await expect(b.ensure()).rejects.toThrow(/ドライバのビルドに失敗しました[\s\S]*error CS0001/);
  });

  it('5 分待ってもロックが消えなければ失敗する。10 分より古いロックは消す', async () => {
    let t = 0;
    const b = builder(okBuild([]), { now: () => t, sleep: async (ms) => void (t += ms * 60) });
    const dir = await b.cacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.lock'), '999');
    const st = await fs.stat(path.join(dir, '.lock'));
    t = st.mtimeMs;
    await expect(b.ensure()).rejects.toThrow(/待ちきれませんでした/);

    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(path.join(dir, '.lock'), old, old);
    const b2 = builder(okBuild([]));
    expect(await b2.ensure()).toBe(path.join(dir, 'FlaUiDriver.dll'));
  });

  it('ソースが変わるとキャッシュの場所が変わる（bin・obj は含めない）', async () => {
    const h1 = await hashDriverSources(driverDir);
    mkdirSync(path.join(driverDir, 'obj'));
    writeFileSync(path.join(driverDir, 'obj', 'x'), 'y');
    expect(await hashDriverSources(driverDir)).toBe(h1);
    writeFileSync(path.join(driverDir, 'Program.cs'), 'class Q {}');
    expect(await hashDriverSources(driverDir)).not.toBe(h1);
    expect(tailLines('a\nb\nc\n\n', 2)).toBe('b\nc');
  });
});
