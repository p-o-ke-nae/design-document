import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RECENT, RECENT_BROKEN_MESSAGE, RecentFolders } from './recent.ts';

const tmps: string[] = [];
afterEach(async () => {
  for (const t of tmps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

async function setup(opts: { platform?: NodeJS.Platform; content?: string } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-recent-'));
  tmps.push(tmp);
  const file = path.join(tmp, 'home', 'recent.json');
  if (opts.content !== undefined) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, opts.content);
  }
  const warnings: string[] = [];
  let t = Date.UTC(2025, 0, 1);
  const recent = new RecentFolders(file, { platform: opts.platform ?? 'linux', now: () => new Date((t += 60_000)), warn: (m) => warnings.push(m) });
  const saved = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const leftovers = async () => (await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'));
  return { file, recent, warnings, saved, leftovers };
}

const folders = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ path: `/p/${from + i}`, openedAt: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(), hasConfig: false }));
const fileOf = (list: unknown[]) => JSON.stringify({ version: 1, folders: list });

describe('最近開いたフォルダ（DD-LOCALF-RECENT）', () => {
  it('[DD-LOCALF-RECENT-P004] [DD-LOCALF-RECENT-T001] [DD-LOCALF-RECENT-T002] [DD-LOCALF-RECENT-T003] [DD-LOCALF-RECENT-T007] [DD-LOCALF-RECENT-T011] [DD-LOCALF-RECENT-T013] [DD-LOCALF-RECENT-T015] ファイルが無ければ空の一覧から 1 件にして書く', async () => {
    const { recent, saved, warnings, leftovers } = await setup();
    expect(await recent.load()).toEqual([]);
    const list = await recent.add('/repo/a', true);
    expect(list).toEqual([{ path: '/repo/a', openedAt: expect.any(String), hasConfig: true }]);
    expect(await saved()).toEqual({ version: 1, folders: list });
    expect(await leftovers()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('[DD-LOCALF-RECENT-P012] [DD-LOCALF-RECENT-T004] [DD-LOCALF-RECENT-T006] [DD-LOCALF-RECENT-T009] 読めたファイルは合う項目だけ残し、新しいものを先頭に入れる', async () => {
    const [a, b] = folders(2);
    const { recent, saved } = await setup({ content: fileOf([a, { path: '', openedAt: 'x', hasConfig: 1 }, 'junk', b]) });
    expect(await recent.load()).toEqual([a, b]);
    const list = await recent.add('/repo/new', false);
    expect(list.map((f) => f.path)).toEqual(['/repo/new', a.path, b.path]);
    expect((await saved()).folders).toEqual(list);
  });

  it('[DD-LOCALF-RECENT-P010] [DD-LOCALF-RECENT-T010] [DD-LOCALF-RECENT-T012] 同じフォルダは除いてから先頭に入れ直す（openedAt・hasConfig を更新）', async () => {
    const [a, b, c] = folders(3);
    const { recent } = await setup({ content: fileOf([a, b, c]) });
    const list = await recent.add(b.path, true);
    expect(list.map((f) => f.path)).toEqual([b.path, a.path, c.path]);
    expect(list[0]).toMatchObject({ hasConfig: true });
    expect(list[0]!.openedAt).not.toBe(b.openedAt);
  });

  it('[DD-LOCALF-RECENT-P010] Windows では大文字小文字の違いを同じフォルダとみなす（他は区別する）', async () => {
    const content = fileOf([{ path: 'C:\\Repo\\A', openedAt: new Date().toISOString(), hasConfig: false }]);
    const win = await setup({ platform: 'win32', content });
    expect((await win.recent.add('c:\\repo\\a', true)).map((f) => f.path)).toEqual(['c:\\repo\\a']);
    const linux = await setup({ platform: 'linux', content });
    expect(await linux.recent.add('c:\\repo\\a', true)).toHaveLength(2);
  });

  it('[DD-LOCALF-RECENT-P011] [DD-LOCALF-RECENT-T014] [DD-LOCALF-RECENT-T016] MAX_RECENT 件を超えたら末尾から切り捨てる', async () => {
    const list10 = folders(MAX_RECENT);
    const { recent, saved } = await setup({ content: fileOf(list10) });
    const list = await recent.add('/repo/new', false);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]!.path).toBe('/repo/new');
    expect(list.map((f) => f.path)).not.toContain(list10[MAX_RECENT - 1]!.path);
    expect((await saved()).folders).toHaveLength(MAX_RECENT);
  });

  it('[DD-LOCALF-RECENT-P009] 同じフォルダを除いても MAX_RECENT 件を超えれば末尾から切り捨てる（ファイルが手で 11 件にされた場合）', async () => {
    const list11 = folders(MAX_RECENT + 1);
    const { recent } = await setup({ content: fileOf(list11) });
    const list = await recent.add(list11[3]!.path, true);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list.map((f) => f.path)).toEqual([list11[3]!.path, ...list11.filter((_, i) => i !== 3).slice(0, MAX_RECENT - 1).map((f) => f.path)]);
  });

  it('[DD-LOCALF-RECENT-P008] [DD-LOCALF-RECENT-T005] [DD-LOCALF-RECENT-T008] 壊れたファイルは空として扱い、警告は 1 回だけ。次の add で上書きする', async () => {
    const { recent, warnings, saved } = await setup({ content: '{ broken' });
    expect(await recent.load()).toEqual([]);
    expect(await recent.load()).toEqual([]);
    const list = await recent.add('/repo/a', false);
    expect(list.map((f) => f.path)).toEqual(['/repo/a']);
    expect(warnings).toEqual([RECENT_BROKEN_MESSAGE]);
    expect(await saved()).toEqual({ version: 1, folders: list });
  });

  it('[DD-LOCALF-RECENT-P008] 形の合わないファイル（version 違い・folders が配列でない）も壊れたファイルとして扱う', async () => {
    for (const content of [JSON.stringify({ version: 2, folders: [] }), JSON.stringify({ version: 1, folders: {} }), '[]']) {
      const { recent, warnings } = await setup({ content });
      expect(await recent.load()).toEqual([]);
      expect(warnings).toEqual([RECENT_BROKEN_MESSAGE]);
    }
  });

  // Paths that need a duplicate or more than MAX_RECENT entries right after an empty list cannot happen in one call;
  // they are covered as a sequence that starts from a missing / broken file.
  it('[DD-LOCALF-RECENT-P001] [DD-LOCALF-RECENT-P002] [DD-LOCALF-RECENT-P003] ファイルが無い状態から続けて追加すると、重複の除去と切り捨てが効く', async () => {
    const { recent, saved } = await setup();
    for (let i = 0; i <= MAX_RECENT; i++) await recent.add(`/p/${i}`, false);
    let list = await recent.load();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]!.path).toBe(`/p/${MAX_RECENT}`);
    list = await recent.add('/p/5', true);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list.filter((f) => f.path === '/p/5')).toHaveLength(1);
    expect(list[0]!.path).toBe('/p/5');
    expect((await saved()).folders).toEqual(list);
  });

  it('[DD-LOCALF-RECENT-P005] [DD-LOCALF-RECENT-P006] [DD-LOCALF-RECENT-P007] 壊れたファイルから作り直したあとも重複の除去と切り捨てが効き、警告は 1 回だけ', async () => {
    const { recent, warnings } = await setup({ content: 'not json' });
    for (let i = 0; i <= MAX_RECENT; i++) await recent.add(`/p/${i}`, false);
    expect(await recent.load()).toHaveLength(MAX_RECENT);
    const list = await recent.add('/p/7', false);
    expect(list.map((f) => f.path).filter((p) => p === '/p/7')).toHaveLength(1);
    expect(warnings).toEqual([RECENT_BROKEN_MESSAGE]);
  });

  it('[DD-LOCALF-RECENT-T010] remove は同じフォルダを除いて書き、無いパスでは書かない。壊れたファイルは remove でも作り直す', async () => {
    const [a, b] = folders(2);
    const { recent, file, saved } = await setup({ content: fileOf([a, b]) });
    expect((await recent.remove(a.path)).map((f) => f.path)).toEqual([b.path]);
    expect((await saved()).folders).toEqual([b]);
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    expect(await recent.remove('/nope')).toEqual([b]);
    expect((await fs.stat(file)).mtimeMs).toBe(before);

    const broken = await setup({ content: '{' });
    expect(await broken.recent.remove('/x')).toEqual([]);
    expect(await broken.saved()).toEqual({ version: 1, folders: [] });
  });
});
