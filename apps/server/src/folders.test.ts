import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listDirs, LocalError, MAX_DIR_ENTRIES, PATH_RELATIVE_MESSAGE, resolveFolder, samePath, type FolderEnv } from './folders.ts';

const tmps: string[] = [];
afterEach(async () => {
  for (const t of tmps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

async function tmpdir(): Promise<string> {
  const t = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-folders-')));
  tmps.push(t);
  return t;
}

const errno = (code: string) => Object.assign(new Error(code), { code });

async function rejects(p: Promise<unknown>): Promise<LocalError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(LocalError);
  return e as LocalError;
}

function dirent(name: string, kind: 'dir' | 'file' | 'link'): Dirent {
  return { name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' } as unknown as Dirent;
}

describe('パスの検査（DD-LOCALF-FOLDER）', () => {
  it('[DD-LOCALF-FOLDER-P001] [DD-LOCALF-FOLDER-T001] [DD-LOCALF-FOLDER-T002] 空白だけは 422 path-empty', async () => {
    for (const input of ['', '   ', '\t\n']) {
      const e = await rejects(resolveFolder(input));
      expect(e).toMatchObject({ status: 422, code: 'path-empty', message: 'パスを入力してください' });
    }
  });

  it('[DD-LOCALF-FOLDER-P002] [DD-LOCALF-FOLDER-T003] [DD-LOCALF-FOLDER-T004] [DD-LOCALF-FOLDER-T006] [DD-LOCALF-FOLDER-T007] ~ を置き換えても絶対パスでなければ 422 path-relative', async () => {
    const e = await rejects(resolveFolder('~/src', { home: 'relative-home', platform: process.platform }));
    expect(e).toMatchObject({ status: 422, code: 'path-relative', message: PATH_RELATIVE_MESSAGE });
    expect(e.toJSON()).toEqual({ error: PATH_RELATIVE_MESSAGE, code: 'path-relative', message: PATH_RELATIVE_MESSAGE });
  });

  it('[DD-LOCALF-FOLDER-P003] [DD-LOCALF-FOLDER-T008] [DD-LOCALF-FOLDER-T009] [DD-LOCALF-FOLDER-T010] ~ 配下の無いフォルダは 422 not-found（消す対象は展開後のパス）', async () => {
    const home = await tmpdir();
    const e = await rejects(resolveFolder('~/nope', { home, platform: process.platform }));
    const target = path.join(home, 'nope');
    expect(e).toMatchObject({ status: 422, code: 'not-found', message: `フォルダが見つかりません: ${target}`, target });
    const notDirParent = path.join(home, 'file.txt');
    await fs.writeFile(notDirParent, 'x');
    expect(await rejects(resolveFolder('~/file.txt/sub', { home, platform: process.platform }))).toMatchObject({ code: 'not-found' });
  });

  it('[DD-LOCALF-FOLDER-P004] [DD-LOCALF-FOLDER-T011] ~ 配下で realpath が EACCES / EPERM なら 422 unreadable', async () => {
    const home = await tmpdir();
    for (const code of ['EACCES', 'EPERM']) {
      const env: FolderEnv = { home, platform: process.platform, fs: { realpath: async () => Promise.reject(errno(code)) } };
      const e = await rejects(resolveFolder('~', env));
      expect(e).toMatchObject({ status: 422, code: 'unreadable', message: `フォルダを読めません（権限を確認してください）: ${home}` });
    }
  });

  it('[DD-LOCALF-FOLDER-P005] [DD-LOCALF-FOLDER-T012] [DD-LOCALF-FOLDER-T013] ~ 配下のファイルは 422 not-directory', async () => {
    const home = await tmpdir();
    await fs.writeFile(path.join(home, 'a.txt'), 'x');
    const e = await rejects(resolveFolder('~/a.txt', { home, platform: process.platform }));
    expect(e).toMatchObject({ status: 422, code: 'not-directory', message: `フォルダではありません: ${path.join(home, 'a.txt')}` });
  });

  it('[DD-LOCALF-FOLDER-P006] [DD-LOCALF-FOLDER-T014] [DD-LOCALF-FOLDER-T015] ~ 配下で readdir できなければ 422 unreadable', async () => {
    const home = await tmpdir();
    const env: FolderEnv = { home, platform: process.platform, fs: { readdir: async () => Promise.reject(errno('EACCES')) } };
    expect(await rejects(resolveFolder('~', env))).toMatchObject({ status: 422, code: 'unreadable' });
  });

  it('[DD-LOCALF-FOLDER-P007] [DD-LOCALF-FOLDER-T016] ~ だけ・~/ 配下は展開して実体のパスと hasConfig を返す', async () => {
    const home = await tmpdir();
    await fs.mkdir(path.join(home, 'repo'));
    await fs.writeFile(path.join(home, 'repo', 'ddv.config.yaml'), 'docs: docs\n');
    expect(await resolveFolder('~', { home, platform: process.platform })).toEqual({ root: home, hasConfig: false });
    expect(await resolveFolder('  ~/repo/  ', { home, platform: process.platform })).toEqual({ root: path.join(home, 'repo'), hasConfig: true });
    expect(await resolveFolder(`~${path.sep}repo${path.sep}..${path.sep}repo`, { home, platform: process.platform })).toMatchObject({ root: path.join(home, 'repo') });
  });

  it('[DD-LOCALF-FOLDER-P008] [DD-LOCALF-FOLDER-T005] 相対パス・~user は 422 path-relative', async () => {
    const home = await tmpdir();
    for (const input of ['src/app', './x', '..', '~user/src', '~user']) {
      expect(await rejects(resolveFolder(input, { home, platform: process.platform }))).toMatchObject({ code: 'path-relative' });
    }
  });

  it('[DD-LOCALF-FOLDER-P009] 絶対パスの無いフォルダは 422 not-found', async () => {
    const t = await tmpdir();
    const e = await rejects(resolveFolder(path.join(t, 'none')));
    expect(e).toMatchObject({ code: 'not-found', target: path.join(t, 'none') });
  });

  it('[DD-LOCALF-FOLDER-P010] 絶対パスで realpath が EACCES なら 422 unreadable（最近からは消さない対象）', async () => {
    const t = await tmpdir();
    const e = await rejects(resolveFolder(t, { home: t, platform: process.platform, fs: { realpath: async () => Promise.reject(errno('EPERM')) } }));
    expect(e).toMatchObject({ code: 'unreadable' });
  });

  it('[DD-LOCALF-FOLDER-P011] 絶対パスのファイルは 422 not-directory', async () => {
    const t = await tmpdir();
    await fs.writeFile(path.join(t, 'f'), 'x');
    expect(await rejects(resolveFolder(path.join(t, 'f')))).toMatchObject({ code: 'not-directory' });
  });

  it('[DD-LOCALF-FOLDER-P012] 絶対パスで readdir できなければ 422 unreadable', async () => {
    const t = await tmpdir();
    expect(await rejects(resolveFolder(t, { home: t, platform: process.platform, fs: { readdir: async () => Promise.reject(errno('EPERM')) } }))).toMatchObject({ code: 'unreadable' });
  });

  it('[DD-LOCALF-FOLDER-P013] 絶対パスは正規化して実体のパスと hasConfig を返す（.yml / .json も設定ファイル）', async () => {
    const t = await tmpdir();
    for (const name of ['ddv.config.yml', 'ddv.config.json']) {
      const d = path.join(t, name);
      await fs.mkdir(d);
      await fs.writeFile(path.join(d, name), '{}');
      expect(await resolveFolder(path.join(t, '.', name, '..', name) + path.sep)).toEqual({ root: d, hasConfig: true });
    }
    if (process.platform === 'win32') {
      expect(await resolveFolder(t.toUpperCase())).toMatchObject({ root: t });
      expect((await resolveFolder(t.slice(0, 2))).root.toLowerCase()).toBe(`${t.slice(0, 2)}\\`.toLowerCase());
    }
  });

  it('samePath は Windows だけ大文字小文字を区別しない', () => {
    expect(samePath('C:\\A', 'c:\\a', 'win32')).toBe(true);
    expect(samePath('/A', '/a', 'linux')).toBe(false);
    expect(samePath('/a', '/a', 'darwin')).toBe(true);
  });
});

describe('フォルダの一覧（DD-LOCALF-DIRS）', () => {
  it('[DD-LOCALF-DIRS-P001] [DD-LOCALF-DIRS-T001] [DD-LOCALF-DIRS-T002] [DD-LOCALF-DIRS-T003] path が無ければ Windows はホームと存在するドライブ（応答の無いドライブは待たない）', async () => {
    const home = await tmpdir();
    const env: FolderEnv = {
      home,
      platform: 'win32',
      fs: {
        access: (p) => (p === 'C:\\' || p === 'D:\\' ? Promise.resolve() : p === 'E:\\' ? new Promise<void>(() => undefined) : Promise.reject(errno('ENOENT'))),
      },
    };
    const started = Date.now();
    const list = await listDirs(undefined, env);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(list).toMatchObject({ path: null, parent: null, truncated: false });
    expect(list.entries.map((e) => [e.name, e.path, e.kind])).toEqual([
      ['ホーム', home, 'home'],
      ['C:', 'C:\\', 'drive'],
      ['D:', 'D:\\', 'drive'],
    ]);
    expect(await listDirs('  ', env)).toMatchObject({ path: null });
  });

  it('[DD-LOCALF-DIRS-P002] [DD-LOCALF-DIRS-T004] path が無ければ Windows 以外はホームとルート', async () => {
    const home = await tmpdir();
    const list = await listDirs(undefined, { home, platform: 'linux' });
    expect(list.entries.map((e) => [e.name, e.path, e.kind])).toEqual([
      ['ホーム', home, 'home'],
      ['/', '/', 'drive'],
    ]);
  });

  it('[DD-LOCALF-DIRS-P003] [DD-LOCALF-DIRS-T005] [DD-LOCALF-DIRS-T006] [DD-LOCALF-DIRS-T007] 検査のエラーは 422 の同じ code（removed は付けない）', async () => {
    const t = await tmpdir();
    await fs.writeFile(path.join(t, 'f'), 'x');
    const cases: [string, string][] = [
      ['rel/path', 'path-relative'],
      [path.join(t, 'none'), 'not-found'],
      [path.join(t, 'f'), 'not-directory'],
    ];
    for (const [input, code] of cases) {
      const e = await rejects(listDirs(input));
      expect(e).toMatchObject({ status: 422, code });
      expect(e.toJSON()).not.toHaveProperty('removed');
    }
  });

  it('[DD-LOCALF-DIRS-P004] [DD-LOCALF-DIRS-P009] [DD-LOCALF-DIRS-T008] [DD-LOCALF-DIRS-T009] [DD-LOCALF-DIRS-T010] [DD-LOCALF-DIRS-T014] [DD-LOCALF-DIRS-T016] ファイルは除き、フォルダは名前順（数字は数値順）で hasConfig を付ける', async () => {
    const t = await tmpdir();
    for (const d of ['b', 'a10', 'a2', 'リポジトリ']) await fs.mkdir(path.join(t, d));
    await fs.writeFile(path.join(t, 'a2', 'ddv.config.yaml'), 'docs: docs\n');
    await fs.writeFile(path.join(t, 'file.md'), 'x');
    const list = await listDirs(t);
    expect(list).toMatchObject({ path: t, parent: path.dirname(t), truncated: false });
    expect(list.entries).toEqual([
      { name: 'a2', path: path.join(t, 'a2'), kind: 'dir', hasConfig: true },
      { name: 'a10', path: path.join(t, 'a10'), kind: 'dir', hasConfig: false },
      { name: 'b', path: path.join(t, 'b'), kind: 'dir', hasConfig: false },
      { name: 'リポジトリ', path: path.join(t, 'リポジトリ'), kind: 'dir', hasConfig: false },
    ]);
  });

  it('[DD-LOCALF-DIRS-P005] [DD-LOCALF-DIRS-P006] [DD-LOCALF-DIRS-P007] [DD-LOCALF-DIRS-T011] [DD-LOCALF-DIRS-T012] [DD-LOCALF-DIRS-T013] シンボリックリンクは stat がフォルダのときだけ（隠しは除く）', async () => {
    const t = await tmpdir();
    const real = fs.stat;
    const targets: Record<string, 'dir' | 'file' | 'broken'> = { 'link-dir': 'dir', 'link-file': 'file', 'link-broken': 'broken', '.link-hidden': 'dir' };
    const env: FolderEnv = {
      home: t,
      platform: process.platform,
      fs: {
        readdir: async (p) => (p === t ? Object.keys(targets).map((n) => dirent(n, 'link')) : fs.readdir(p, { withFileTypes: true })),
        stat: async (p) => {
          const kind = targets[path.basename(p)];
          if (path.dirname(p) !== t || !kind) return real(p);
          if (kind === 'broken') throw errno('ENOENT');
          return { isDirectory: () => kind === 'dir', isFile: () => kind === 'file' };
        },
      },
    };
    const list = await listDirs(t, env);
    expect(list.entries.map((e) => e.name)).toEqual(['link-dir']);
  });

  it('[DD-LOCALF-DIRS-P008] [DD-LOCALF-DIRS-T015] 隠しフォルダ（. / $ で始まる・System Volume Information）は除く', async () => {
    const t = await tmpdir();
    for (const d of ['.git', '$RECYCLE.BIN', 'System Volume Information', 'src']) await fs.mkdir(path.join(t, d));
    expect((await listDirs(t)).entries.map((e) => e.name)).toEqual(['src']);
  });

  it(`[DD-LOCALF-DIRS-P009] ${MAX_DIR_ENTRIES} 件を超えたら打ち切って truncated、ルートの parent は null`, async () => {
    const t = await tmpdir();
    const names = Array.from({ length: MAX_DIR_ENTRIES + 3 }, (_, i) => `d${i}`);
    const env: FolderEnv = { home: t, platform: process.platform, fs: { readdir: async (p) => (p === t ? names.map((n) => dirent(n, 'dir')) : []), stat: async () => Promise.reject(errno('ENOENT')) } };
    const list = await listDirs(t, { ...env, fs: { ...env.fs, stat: async (p) => (p === t ? fs.stat(p) : Promise.reject(errno('ENOENT'))) } });
    expect(list.entries).toHaveLength(MAX_DIR_ENTRIES);
    expect(list.truncated).toBe(true);
    const root = path.parse(t).root;
    expect((await listDirs(root)).parent).toBeNull();
  });
});
