import { promises as fs, realpath as realpathCb, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_FILES } from '@ddv/core/node';

export type BusyKind = 'test' | 'snapshot' | 'deps';

export type LocalErrorCode =
  | 'bad-request'
  | 'path-empty'
  | 'path-relative'
  | 'not-found'
  | 'not-directory'
  | 'unreadable'
  | 'config-invalid'
  | 'busy'
  | 'swapping'
  | 'no-folder';

/** Error of the local workspace / folder APIs: `{ error, code, message, removed?, kind? }` with `status`. */
export class LocalError extends Error {
  removed?: boolean;
  kind?: BusyKind;
  /** The checked path (`~` expanded, `path.resolve`d); used to remove it from the recent folders. Not sent. */
  target?: string;
  constructor(
    readonly status: 400 | 409 | 422,
    readonly code: LocalErrorCode,
    message: string,
    extra: { removed?: boolean; kind?: BusyKind; target?: string } = {},
  ) {
    super(message);
    Object.assign(this, extra);
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      message: this.message,
      ...(this.removed !== undefined ? { removed: this.removed } : {}),
      ...(this.kind ? { kind: this.kind } : {}),
    };
  }
}

export const PATH_RELATIVE_MESSAGE = '絶対パスで指定してください（例 C:\\Users\\taro\\source\\order-app、~/source/order-app）';

/** File system calls used by `resolveFolder` / `listDirs` (replaced in tests). */
export interface FolderFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readdir(p: string): Promise<Dirent[]>;
  access(p: string): Promise<void>;
}

export interface FolderEnv {
  home: string;
  platform: NodeJS.Platform;
  fs?: Partial<FolderFs>;
}

export function defaultFolderEnv(): FolderEnv {
  return { home: os.homedir(), platform: process.platform };
}

const nodeFs: FolderFs = {
  realpath: promisify(realpathCb.native),
  stat: (p) => fs.stat(p),
  readdir: (p) => fs.readdir(p, { withFileTypes: true }),
  access: (p) => fs.access(p),
};

function fsOf(env: FolderEnv): FolderFs {
  return { ...nodeFs, ...env.fs };
}

export interface ResolvedFolder {
  root: string;
  hasConfig: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  kind: 'dir' | 'home' | 'drive';
  hasConfig: boolean;
}

export interface DirList {
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
  truncated: boolean;
}

export const MAX_DIR_ENTRIES = 500;
const DRIVE_TIMEOUT_MS = 500;

/** Same path: case-insensitive on Windows, case-sensitive elsewhere. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `ddv.config.yaml` / `.yml` / `.json` directly under `dir`. */
export async function hasConfigFile(dir: string, env: FolderEnv = defaultFolderEnv()): Promise<boolean> {
  const f = fsOf(env);
  for (const name of CONFIG_FILES) {
    const st = await f.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) return true;
  }
  return false;
}

/** `~` expansion and `path.resolve` (no file system access). `null` when the input is not absolute. */
export function normalizeInput(input: string, env: FolderEnv): string | null {
  let p = input.trim();
  if (/^~(?=$|[\\/])/.test(p)) p = env.home + p.slice(1);
  if (/^[A-Za-z]:$/.test(p)) p += '\\';
  if (!path.isAbsolute(p)) return null;
  return path.resolve(p);
}

function code(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? '';
}

/** Checks a folder path given by the user (FOLDER). Throws `LocalError` 422. */
export async function resolveFolder(input: string, env: FolderEnv = defaultFolderEnv()): Promise<ResolvedFolder> {
  if (!input.trim()) throw new LocalError(422, 'path-empty', 'パスを入力してください');
  const target = normalizeInput(input, env);
  if (target === null) throw new LocalError(422, 'path-relative', PATH_RELATIVE_MESSAGE);
  const f = fsOf(env);
  let root: string;
  try {
    root = await f.realpath(target);
  } catch (e) {
    if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') throw new LocalError(422, 'not-found', `フォルダが見つかりません: ${target}`, { target });
    throw new LocalError(422, 'unreadable', `フォルダを読めません（権限を確認してください）: ${target}`, { target });
  }
  const st = await f.stat(root).catch(() => null);
  if (!st?.isDirectory()) throw new LocalError(422, 'not-directory', `フォルダではありません: ${target}`, { target });
  try {
    await f.readdir(root);
  } catch {
    throw new LocalError(422, 'unreadable', `フォルダを読めません（権限を確認してください）: ${target}`, { target });
  }
  return { root, hasConfig: await hasConfigFile(root, env) };
}

function hidden(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$') || name === 'System Volume Information';
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' });

async function roots(env: FolderEnv): Promise<DirEntry[]> {
  const f = fsOf(env);
  const home: DirEntry = { name: 'ホーム', path: env.home, kind: 'home', hasConfig: await hasConfigFile(env.home, env) };
  if (env.platform !== 'win32') return [home, { name: '/', path: '/', kind: 'drive', hasConfig: await hasConfigFile('/', env) }];
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const found = await Promise.all(
    letters.map(async (l) => {
      const p = `${l}:\\`;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), DRIVE_TIMEOUT_MS)));
      const ok = await Promise.race([f.access(p).then(() => true, () => false), timeout]);
      clearTimeout(timer);
      return ok ? p : null;
    }),
  );
  const drives = await Promise.all(
    found.filter((p): p is string => !!p).map(async (p): Promise<DirEntry> => ({ name: p.slice(0, 2), path: p, kind: 'drive', hasConfig: await hasConfigFile(p, env) })),
  );
  return [home, ...drives];
}

/** Lists the sub folders of `input` (DIRS); without `input` the home folder and the drives / root. */
export async function listDirs(input: string | undefined, env: FolderEnv = defaultFolderEnv()): Promise<DirList> {
  if (input === undefined || !input.trim()) return { path: null, parent: null, entries: await roots(env), truncated: false };
  const { root } = await resolveFolder(input, env);
  const f = fsOf(env);
  const names: string[] = [];
  for (const d of await f.readdir(root)) {
    let dir = d.isDirectory();
    if (!dir && d.isSymbolicLink()) dir = (await f.stat(path.join(root, d.name)).catch(() => null))?.isDirectory() ?? false;
    if (dir && !hidden(d.name)) names.push(d.name);
  }
  const sorted = names.map((name) => ({ name })).sort(byName);
  const shown = sorted.slice(0, MAX_DIR_ENTRIES);
  const entries = await Promise.all(
    shown.map(async ({ name }): Promise<DirEntry> => {
      const p = path.join(root, name);
      return { name, path: p, kind: 'dir', hasConfig: await hasConfigFile(p, env) };
    }),
  );
  const parent = path.dirname(root);
  return { path: root, parent: parent === root ? null : parent, entries, truncated: sorted.length > MAX_DIR_ENTRIES };
}
