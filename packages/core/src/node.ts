import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { parseConfig, type DdvConfig } from './config.ts';
import { CONFIG_FILES, docEntryOf, parseConfigText, type DocEntry } from './doc.ts';

export { CONFIG_FILES, docEntryOf, parseConfigText, type DocEntry } from './doc.ts';

export async function loadConfig(repoRoot: string): Promise<DdvConfig> {
  for (const name of CONFIG_FILES) {
    const p = path.join(repoRoot, name);
    if (existsSync(p)) return parseConfigText(name, await fs.readFile(p, 'utf8'));
  }
  return parseConfig({});
}

/** Resolves a repo-relative path and rejects anything escaping the repository root. */
export function safeJoin(repoRoot: string, rel: string): string {
  const root = path.resolve(repoRoot);
  const abs = path.resolve(root, rel.replace(/^[/\\]+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes repository: ${rel}`);
  return abs;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', '.ddv', 'test-results', 'playwright-report']);

/** Recursively lists files (repo-relative, posix) under `dir` matching `filter`. */
export async function walk(repoRoot: string, dir: string, filter: (rel: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const base = safeJoin(repoRoot, dir);
  if (!existsSync(base)) return out;
  const rec = async (abs: string) => {
    for (const ent of await fs.readdir(abs, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!IGNORED_DIRS.has(ent.name)) await rec(path.join(abs, ent.name));
      } else {
        const rel = toPosix(path.relative(repoRoot, path.join(abs, ent.name)));
        if (filter(rel)) out.push(rel);
      }
    }
  };
  await rec(base);
  return out.sort();
}

export async function loadDoc(repoRoot: string, rel: string): Promise<DocEntry> {
  return docEntryOf(rel, await fs.readFile(safeJoin(repoRoot, rel), 'utf8'));
}

export async function loadDocs(repoRoot: string, config: DdvConfig): Promise<DocEntry[]> {
  const files = await walk(repoRoot, config.docsRoot, (rel) => rel.endsWith('.md'));
  return Promise.all(files.map((f) => loadDoc(repoRoot, f)));
}
