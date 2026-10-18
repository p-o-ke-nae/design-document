/** Read access to the target repository. Paths are repository-relative posix paths (`..` may point outside). */
export interface TokenFs {
  /** Text of the file, or `null` when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** Repository files matching the glob (`**`, `*`, `?`), excluding bin, obj and node_modules. */
  glob(pattern: string): Promise<string[]>;
  /** Writes a generated file (only needed by `generateTokens`). */
  write?(path: string, text: string): Promise<void>;
}

/** Normalizes `\`, `.` and `..` segments; leading `..` that escape the root are kept. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, rel: string): string {
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}

const SKIPPED_DIRS = new Set(['bin', 'obj', 'node_modules', '.git']);

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Whether a repository file is listed by `glob` (not under bin, obj, node_modules or outside the repository). */
export function globListed(path: string, re: RegExp): boolean {
  const segs = path.split('/');
  if (segs[0] === '..') return false;
  return re.test(path) && segs.slice(0, -1).every((s) => !SKIPPED_DIRS.has(s));
}

/** In-memory TokenFs (tests and in-browser use). */
export class MemoryTokenFs implements TokenFs {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  constructor(files: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(files)) this.files.set(normalizePath(k), v);
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(normalizePath(path)) ?? null;
  }
  async glob(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.files.keys()].filter((p) => globListed(p, re)).sort();
  }
  async write(path: string, text: string): Promise<void> {
    this.writes.push(normalizePath(path));
    this.files.set(normalizePath(path), text);
  }
}
