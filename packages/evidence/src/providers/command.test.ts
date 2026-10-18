import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandConfig } from '../config.ts';
import type { EvidenceContext } from '../index.ts';
import { CommandProvider, kindOfExt, missingValueMessage, NO_FILES, substituteArg, unknownNameMessage } from './command.ts';

const context = { out: '/o', testId: 'SCN-1', step: '2', platform: 'wpf', at: 'before' };
const params = { id: {}, tags: {}, none: {} };
const values = { id: 'A 1;&', tags: ['x', 'y', 3] };

describe('引数の置き換え（ARGSUB）', () => {
  it('[DD-EVRUN-ARGSUB-P001][DD-EVRUN-ARGSUB-T001][DD-EVRUN-ARGSUB-T002] {名前} を含まなければそのまま（{{ }} は波かっこ）', () => {
    expect(substituteArg('--flag', context, params, values)).toBe('--flag');
    expect(substituteArg('{{id}}', context, params, values)).toBe('{id}');
  });

  it('[DD-EVRUN-ARGSUB-P002][DD-EVRUN-ARGSUB-T003][DD-EVRUN-ARGSUB-T004] 文脈の名前は文脈の値に', () => {
    expect(substituteArg('{out}/{testId}-{step}-{platform}-{at}', context, params, values)).toBe('/o/SCN-1-2-wpf-before');
  });

  it('[DD-EVRUN-ARGSUB-P003][DD-EVRUN-ARGSUB-T005][DD-EVRUN-ARGSUB-T006] params の値を文字列に（配列はカンマ区切り・要素は分けない）', () => {
    expect(substituteArg('--id={id}', context, params, values)).toBe('--id=A 1;&');
    expect(substituteArg('{tags}', context, params, values)).toBe('x,y,3');
  });

  it('[DD-EVRUN-ARGSUB-P004][DD-EVRUN-ARGSUB-T007] 値が無ければ失敗', () => {
    expect(() => substituteArg('{none}', context, params, values)).toThrow(missingValueMessage('none'));
  });

  it('[DD-EVRUN-ARGSUB-P005][DD-EVRUN-ARGSUB-T008] params に無い名前は失敗', () => {
    expect(() => substituteArg('{other}', context, params, values)).toThrow(unknownNameMessage('other'));
  });
});

describe('外部コマンドの出力（CMDOUT）', () => {
  let dir: string;
  let out: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ddv-cmd-'));
    writeFileSync(
      path.join(dir, 'tool.mjs'),
      `import fs from 'node:fs';
const [mode, arg] = process.argv.slice(2);
const out = process.env.DDV_EVIDENCE_OUT;
if (mode === 'fail') { process.stderr.write('ここで失敗'); process.exit(3); }
if (mode === 'json') console.log(JSON.stringify({ arg, step: process.env.DDV_STEP }));
if (mode === 'text') console.log('hello ' + arg);
if (mode === 'files') {
  fs.writeFileSync(out + '/b.csv', 'id,name\\n1,"a,b"\\n');
  fs.writeFileSync(out + '/a.log', 'log');
  fs.writeFileSync(out + '/c.json', '{"x":1}');
  fs.writeFileSync(out + '/d.png', 'png');
  fs.writeFileSync(out + '/e.zip', 'zip');
  fs.mkdirSync(out + '/sub'); fs.writeFileSync(out + '/sub/z.txt', 'z');
}
if (mode === 'sleep') { const { spawn } = await import('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' }); setTimeout(() => {}, 60000); }
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const provider = (output: 'dir' | 'stdout', args: string[]) =>
    new CommandProvider('tool', { run: process.execPath, args: ['tool.mjs', ...args], cwd: '.', params: { id: { required: false } }, output } as CommandConfig, dir, 1024);
  const ctx = (signal = new AbortController().signal): EvidenceContext => {
    out = mkdtempSync(path.join(dir, 'out-'));
    return { platform: 'web', testId: 'SCN-1', step: 4, at: 'after', outDir: out, input: {}, signal };
  };

  it('[DD-EVRUN-CMDOUT-P001][DD-EVRUN-CMDOUT-T001][DD-EVRUN-CMDOUT-T002] 終了コードが 0 でなければ標準エラーの末尾とともに失敗', async () => {
    await expect(provider('stdout', ['fail']).capture({}, ctx())).rejects.toThrow('終了コード 3：ここで失敗');
  });

  it('[DD-EVRUN-CMDOUT-P002][DD-EVRUN-CMDOUT-T003][DD-EVRUN-CMDOUT-T004][DD-EVRUN-CMDOUT-T005] 標準出力が JSON なら json（; や & も 1 つの引数のまま渡る）', async () => {
    const r = await provider('stdout', ['json', '{id}']).capture({ id: 'a;b & c' }, ctx());
    expect(r.outputs).toEqual({ kind: 'json', data: { arg: 'a;b & c', step: '4' } });
  });

  it('[DD-EVRUN-CMDOUT-P003][DD-EVRUN-CMDOUT-T006] 読めなければ text', async () => {
    const r = await provider('stdout', ['text', 'x']).capture({}, ctx());
    expect(r.outputs).toEqual({ kind: 'text', text: expect.stringMatching(/^hello x\r?\n$/) });
  });

  it('[DD-EVRUN-CMDOUT-P004][DD-EVRUN-CMDOUT-T007][DD-EVRUN-CMDOUT-T008] 出力フォルダが空なら失敗', async () => {
    await expect(provider('dir', ['text', 'x']).capture({}, ctx())).rejects.toThrow(NO_FILES);
  });

  it('[DD-EVRUN-CMDOUT-P005][DD-EVRUN-CMDOUT-T009] ファイルごとに拡張子で kind を決め、名前の昇順（サブフォルダは見ない）', async () => {
    const r = await provider('dir', ['files']).capture({}, ctx());
    expect(r.outputs).toEqual([
      { kind: 'text', text: 'log', ext: 'log' },
      { kind: 'table', columns: ['id', 'name'], rows: [['1', 'a,b']] },
      { kind: 'json', data: { x: 1 } },
      { kind: 'image', path: path.join(out, 'd.png') },
      { kind: 'file', path: path.join(out, 'e.zip') },
    ]);
    expect(kindOfExt('JPEG')).toBe('image');
  });

  it('中止されたら子のプロセスも含めて終わらせる', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = provider('stdout', ['sleep']).capture({}, ctx(ac.signal));
    setTimeout(() => ac.abort(), 500);
    await expect(p).rejects.toThrow(/終了コード/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});
