import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext, type ServerContext } from './app.ts';
import { BUSY_MESSAGES, LocalError, LocalWorkspace, NO_FOLDER_MESSAGE, SWAPPING_MESSAGE, type LocalEvent } from './local.ts';
import { RecentFolders } from './recent.ts';
import type { RunRecord } from './runs.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Gate {
  release: () => void;
  fail: (e: Error) => void;
}

async function setup(opts: { initial?: boolean; gated?: boolean } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-local-')));
  cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
  const repo = async (name: string, config = 'docs: docs\n') => {
    const d = path.join(tmp, name);
    await fs.mkdir(path.join(d, 'docs'), { recursive: true });
    if (config !== '') await fs.writeFile(path.join(d, 'ddv.config.yaml'), config);
    return d;
  };
  const a = await repo('a');
  const b = await repo('b');
  const broken = await repo('broken', 'docs: [1, 2\n');
  const created: string[] = [];
  const gates: Gate[] = [];
  const create = async (root: string): Promise<ServerContext> => {
    created.push(root);
    if (opts.gated) {
      await new Promise<void>((resolve, reject) => gates.push({ release: resolve, fail: reject }));
    }
    return createContext(root, { watch: false });
  };
  const recent = new RecentFolders(path.join(tmp, 'home', 'recent.json'), { warn: () => undefined });
  const initial = opts.initial ? await createContext(a, { watch: false }) : undefined;
  const logs: string[] = [];
  const local = new LocalWorkspace({ recent, createContext: create, initial, log: (m) => logs.push(m) });
  cleanups.push(() => local.dispose());
  const events: LocalEvent[] = [];
  local.events.on('local', (e: LocalEvent) => events.push(e));
  const err = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(LocalError);
    return e as LocalError;
  };
  const fetchJson = async (u: string) => {
    const r = await local.fetch(new Request(`http://127.0.0.1:5178${u}`));
    return { status: r.status, body: await r.json() };
  };
  return { tmp, a, b, broken, local, recent, created, gates, events, logs, err, fetchJson };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('作業フォルダの状態（DD-LOCALF-LOCALWS）', () => {
  it('[DD-LOCALF-LOCALWS-T001] [DD-LOCALF-LOCALWS-T004] 開始は未選択。close は何もしない、既存 API は 409 no-folder', async () => {
    const s = await setup();
    expect(s.local.state).toBe('Empty');
    expect(await s.local.info()).toEqual({ state: 'Empty', root: null, repoName: null, hasConfig: false, busy: null, recent: [] });
    await s.local.close();
    expect(s.local.state).toBe('Empty');
    expect(s.events).toEqual([]);
    expect(await s.fetchJson('/api/config')).toEqual({ status: 409, body: { error: NO_FOLDER_MESSAGE, code: 'no-folder', message: NO_FOLDER_MESSAGE } });
  });

  it('[DD-LOCALF-LOCALWS-T002] 未選択で開けないフォルダは 422 のまま未選択（無いパスは最近から消す）', async () => {
    const s = await setup();
    const gone = path.join(s.tmp, 'gone');
    await s.recent.add(gone, true);
    const e = await s.err(s.local.open(gone));
    expect(e).toMatchObject({ status: 422, code: 'not-found', removed: true });
    expect(s.local.state).toBe('Empty');
    expect(await s.recent.load()).toEqual([]);
    expect(await s.err(s.local.open(path.join(s.tmp, 'gone2')))).toMatchObject({ code: 'not-found', removed: false });
    expect(await s.err(s.local.open(42))).toMatchObject({ status: 400, code: 'bad-request' });
    expect(s.created).toEqual([]);
  });

  it('[DD-LOCALF-LOCALWS-T003] [DD-LOCALF-LOCALWS-T005] 未選択から開くと入れ替え中を経て開いている。最近に入り、local を送る', async () => {
    const s = await setup({ gated: true });
    const p = s.local.open(s.a);
    await tick();
    expect(s.local.state).toBe('Swapping');
    expect((await s.local.info()).state).toBe('Swapping');
    s.gates[0]!.release();
    expect(await p).toEqual({ root: s.a, repoName: 'a', hasConfig: true });
    expect(s.local.state).toBe('Open');
    expect(s.local.generation).toBe(1);
    expect(s.events).toEqual([{ root: s.a, repoName: 'a', generation: 1 }]);
    expect((await s.recent.load()).map((f) => f.path)).toEqual([s.a]);
    expect((await s.fetchJson('/api/config')).status).toBe(200);
    expect(await s.local.info()).toMatchObject({ state: 'Open', root: s.a, repoName: 'a', hasConfig: true, busy: null });
  });

  it('[DD-LOCALF-LOCALWS-T006] 作成失敗（前が未選択）は 422 config-invalid で未選択に戻る。最近は更新しない', async () => {
    const s = await setup();
    const e = await s.err(s.local.open(s.broken));
    expect(e.status).toBe(422);
    expect(e.code).toBe('config-invalid');
    expect(e.message).toMatch(/^ddv\.config\.yaml を読み込めません: /);
    expect(s.local.state).toBe('Empty');
    expect(s.local.generation).toBe(0);
    expect(await s.recent.load()).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it('[DD-LOCALF-LOCALWS-T007] 作成失敗（前が開いている）は今のフォルダのまま', async () => {
    const s = await setup({ initial: true });
    const before = s.local.ctx;
    expect(await s.err(s.local.open(s.broken))).toMatchObject({ code: 'config-invalid' });
    expect(s.local.state).toBe('Open');
    expect(s.local.ctx).toBe(before);
    expect((await s.fetchJson('/api/config')).status).toBe(200);
  });

  it('[DD-LOCALF-LOCALWS-T008] 開いているときに開けないフォルダは 422、今のフォルダのまま', async () => {
    const s = await setup({ initial: true });
    await fs.writeFile(path.join(s.tmp, 'f.txt'), 'x');
    expect(await s.err(s.local.open(path.join(s.tmp, 'f.txt')))).toMatchObject({ code: 'not-directory', removed: false });
    expect(await s.err(s.local.open('relative'))).toMatchObject({ code: 'path-relative' });
    expect(s.local.state).toBe('Open');
    expect(s.local.ctx?.repoRoot).toBe(s.a);
  });

  it('[DD-LOCALF-LOCALWS-T009] [DD-LOCALF-LOCALWS-T012] 実行中は open・close とも 409 busy（test → snapshot → deps）', async () => {
    const s = await setup({ initial: true });
    const runs = s.local.ctx!.runs;
    runs.active = { id: 'r1' } as RunRecord;
    expect(await s.err(s.local.open(s.b))).toMatchObject({ status: 409, code: 'busy', kind: 'test', message: BUSY_MESSAGES.test });
    expect(await s.err(s.local.close())).toMatchObject({ status: 409, code: 'busy', kind: 'test' });
    runs.active = null;
    const orig = runs.activeTask.bind(runs);
    runs.activeTask = (k) => (k === 'snapshot' ? ({ id: 's' } as RunRecord) : orig(k));
    expect(await s.err(s.local.close())).toMatchObject({ kind: 'snapshot', message: BUSY_MESSAGES.snapshot });
    runs.activeTask = (k) => (k === 'deps' ? ({ id: 'd' } as RunRecord) : orig(k));
    expect(await s.err(s.local.open(s.b))).toMatchObject({ kind: 'deps', message: BUSY_MESSAGES.deps });
    expect((await s.local.info()).busy).toBe('deps');
    expect(s.local.state).toBe('Open');
    expect(s.local.ctx?.repoRoot).toBe(s.a);
    expect(s.created).toEqual([]);
  });

  it('[DD-LOCALF-LOCALWS-T010] 同じフォルダは作り直さず、最近の先頭へ移す（SSE は送らない）。実行中でも 200', async () => {
    const s = await setup({ initial: true });
    await s.recent.add(s.a, true);
    await s.recent.add(s.b, true);
    const ctx = s.local.ctx;
    s.local.ctx!.runs.active = { id: 'r1' } as RunRecord;
    const variant = process.platform === 'win32' ? s.a.toUpperCase() : `${s.a}${path.sep}`;
    expect(await s.local.open(variant)).toEqual({ root: s.a, repoName: 'a', hasConfig: true });
    expect(s.local.ctx).toBe(ctx);
    expect(s.created).toEqual([]);
    expect(s.events).toEqual([]);
    expect((await s.recent.load()).map((f) => f.path)).toEqual([s.a, s.b]);
  });

  it('[DD-LOCALF-LOCALWS-T011] 開いているときに別のフォルダを開くと入れ替える（古い ctx を閉じる）', async () => {
    const s = await setup({ initial: true, gated: true });
    const old = s.local.ctx!;
    let closed = false;
    const close = old.close.bind(old);
    old.close = () => {
      closed = true;
      close();
    };
    const p = s.local.open(s.b);
    await tick();
    expect(s.local.state).toBe('Swapping');
    expect(await s.fetchJson('/api/config')).toMatchObject({ status: 409, body: { code: 'swapping', error: SWAPPING_MESSAGE } });
    expect(closed).toBe(false);
    s.gates[0]!.release();
    expect(await p).toMatchObject({ root: s.b, repoName: 'b' });
    expect(closed).toBe(true);
    expect(s.local.ctx?.repoRoot).toBe(s.b);
    expect(s.events).toEqual([{ root: s.b, repoName: 'b', generation: 1 }]);
  });

  it('[DD-LOCALF-LOCALWS-T013] 実行中が無ければ close で未選択になり local を送る', async () => {
    const s = await setup({ initial: true });
    await s.local.close();
    expect(s.local.state).toBe('Empty');
    expect(s.local.ctx).toBeNull();
    expect(s.events).toEqual([{ root: null, repoName: null, generation: 1 }]);
    expect((await s.fetchJson('/api/config')).body).toMatchObject({ code: 'no-folder' });
  });

  it('[DD-LOCALF-LOCALWS-X001] [DD-LOCALF-LOCALWS-X002] 未選択では作成完了・作成失敗は起きない（close・info・既存 API は createContext を呼ばない）', async () => {
    const s = await setup({ gated: true });
    await s.local.close();
    await s.local.info();
    await s.fetchJson('/api/config');
    expect(s.created).toEqual([]);
    expect(s.gates).toEqual([]);
    expect(s.local.state).toBe('Empty');
  });

  it('[DD-LOCALF-LOCALWS-X003] [DD-LOCALF-LOCALWS-X004] 開いているときに作成完了・作成失敗は届かない（作成は 1 回ずつで、結果は 1 度だけ反映）', async () => {
    const s = await setup({ initial: true, gated: true });
    const p = s.local.open(s.b);
    await tick();
    expect(await s.err(s.local.open(s.broken))).toMatchObject({ status: 409, code: 'swapping' });
    s.gates[0]!.release();
    await p;
    expect(s.created).toEqual([s.b]);
    expect(s.local.generation).toBe(1);
    const q = s.local.open(s.a);
    await tick();
    s.gates[1]!.fail(new Error('boom'));
    expect(await s.err(q)).toMatchObject({ code: 'config-invalid', message: 'ddv.config.yaml を読み込めません: boom' });
    expect(s.local.state).toBe('Open');
    expect(s.local.ctx?.repoRoot).toBe(s.b);
    expect(s.local.generation).toBe(1);
  });

  it('[DD-LOCALF-LOCALWS-X005] [DD-LOCALF-LOCALWS-X006] 入れ替え中の open・close は 409 swapping', async () => {
    const s = await setup({ gated: true });
    const p = s.local.open(s.a);
    await tick();
    expect(await s.err(s.local.open(s.b))).toMatchObject({ status: 409, code: 'swapping', message: SWAPPING_MESSAGE });
    expect(await s.err(s.local.close())).toMatchObject({ status: 409, code: 'swapping' });
    s.gates[0]!.release();
    await p;
    expect(s.local.ctx?.repoRoot).toBe(s.a);
    expect(s.created).toEqual([s.a]);
  });

  it('最近開いたフォルダに保存できなくても開くことは成功させる', async () => {
    const s = await setup();
    const bad = new LocalWorkspace({
      recent: Object.assign(Object.create(RecentFolders.prototype), { load: async () => [], add: async () => Promise.reject(new Error('EACCES')) }) as RecentFolders,
      createContext: (d) => createContext(d, { watch: false }),
      log: (m) => s.logs.push(m),
    });
    cleanups.push(() => bad.dispose());
    expect(await bad.open(s.a)).toMatchObject({ root: s.a });
    expect(s.logs).toEqual(['[ddv] 最近開いたフォルダを保存できません: EACCES']);
  });
});
