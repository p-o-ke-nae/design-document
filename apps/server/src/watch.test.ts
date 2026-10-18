import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => [] as Array<EventEmitter & { close(): void; closed: boolean }>);

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...real,
    watch: () => {
      const w = Object.assign(new Emitter(), {
        closed: false,
        close() {
          w.closed = true;
        },
      });
      fakes.push(w);
      return w;
    },
  };
});

const { createContext } = await import('./app.ts');

const tmps: string[] = [];
afterEach(async () => {
  fakes.splice(0);
  for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('ファイル監視', () => {
  it('監視のエラー（Linux で監視中のフォルダが消えたときの ENOENT）でサーバを止めず、監視をやり直す', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-watch-'));
    tmps.push(root);
    const ctx = await createContext(root);
    expect(fakes).toHaveLength(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => fakes[0].emit('error', Object.assign(new Error('ENOENT: no such file or directory, scandir'), { code: 'ENOENT' }))).not.toThrow();
    expect(fakes[0].closed).toBe(true);
    await vi.waitFor(() => expect(fakes).toHaveLength(2), { timeout: 2000 });

    ctx.close();
    expect(fakes[1].closed).toBe(true);
    fakes[1].emit('error', new Error('after close'));
    await new Promise((r) => setTimeout(r, 700));
    expect(fakes).toHaveLength(2);
  });
});
