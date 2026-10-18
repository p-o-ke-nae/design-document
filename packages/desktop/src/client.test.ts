import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DriverClient, DriverError, defaultTimeout } from './client.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'ddv-client-'));
const script = path.join(dir, 'fake-driver.mjs');
writeFileSync(
  script,
  `import { createInterface } from 'node:readline';
const mode = process.argv[2];
if (mode === 'silent') { setInterval(() => {}, 1000); }
else {
  process.stdout.write('starting\\n');
  process.stdout.write(JSON.stringify({ ready: true, version: '0.1.0' }) + '\\n');
  createInterface({ input: process.stdin }).on('line', (l) => {
    const r = JSON.parse(l);
    if (r.cmd === 'echo') process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: r.args }) + '\\n');
    else if (r.cmd === 'fail') process.stdout.write(JSON.stringify({ id: r.id, ok: false, error: { code: 'notFound', message: 'x がありません' } }) + '\\n');
    else if (r.cmd === 'stray') { process.stdout.write(JSON.stringify({ id: 999, ok: true, result: 1 }) + '\\n'); process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: 2 }) + '\\n'); }
    else if (r.cmd === 'die') process.exit(3);
    // 'hang': no answer
  });
}
`,
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function client(mode = 'ok', logs: string[] = []) {
  return new DriverClient({ command: () => ({ file: process.execPath, args: [script, mode] }), readyTimeoutMs: 2000, log: (l) => logs.push(l) });
}

describe('DriverClient', () => {
  it('ready を待ち、要求と応答を id で結ぶ', async () => {
    const logs: string[] = [];
    const c = client('ok', logs);
    await c.start('x.dll');
    expect(c.version).toBe('0.1.0');
    expect(logs).toContain('starting');
    const [a, b] = await Promise.all([c.request('echo', { n: 1 }), c.request('echo', { n: '二' })]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: '二' });
    await expect(c.request('fail')).rejects.toMatchObject({ code: 'notFound', message: 'x がありません' });
    await c.stop();
    expect(c.running).toBe(false);
  });

  it('待っていない id の応答は捨てて記録する', async () => {
    const logs: string[] = [];
    const c = client('ok', logs);
    await c.start('x.dll');
    expect(await c.request('stray')).toBe(2);
    expect(logs.some((l) => l.includes('待っていない応答') && l.includes('999'))).toBe(true);
    await c.stop();
  });

  it('期限を過ぎるとドライバを止めて失敗にし、次は起動し直せる', async () => {
    const c = client();
    await c.start('x.dll');
    const other = c.request('hang', {}, 5000);
    const e = (await c.request('hang', {}, 100).catch((x: unknown) => x)) as DriverError;
    expect(e).toBeInstanceOf(DriverError);
    expect(e.message).toBe('FlaUI のドライバが応答しません（hang）');
    await expect(other).rejects.toBeInstanceOf(DriverError);
    expect(c.running).toBe(false);
    await expect(c.request('echo')).rejects.toThrow(/起動していません/);
    await c.ensureStarted();
    expect(await c.request('echo', { a: 1 })).toEqual({ a: 1 });
    await c.stop();
  });

  it('予期せず終了したら、待っているすべての要求を失敗にする', async () => {
    const c = client();
    await c.start('x.dll');
    const waiting = c.request('hang', {}, 5000);
    await expect(c.request('die', {}, 5000)).rejects.toThrow(/終了しました（終了コード 3）/);
    await expect(waiting).rejects.toThrow(/終了しました/);
  });

  it('ready が来なければ失敗する。期限は launch 30 秒・ほか 10 秒', async () => {
    const c = new DriverClient({ command: () => ({ file: process.execPath, args: [script, 'silent'] }), readyTimeoutMs: 200, log: () => undefined });
    await expect(c.start('x.dll')).rejects.toThrow('FlaUI のドライバが応答しません（ready）');
    expect(defaultTimeout('launch')).toBe(30_000);
    expect(defaultTimeout('find')).toBe(10_000);
  });
});
