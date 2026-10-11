import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DdvConfig, RunnerConfig } from '@ddv/core';
import { safeJoin, toPosix } from '@ddv/core/node';

/** Package each Node-based runner needs to be resolvable from its cwd. */
export const RUNNER_PACKAGES: Partial<Record<RunnerConfig['type'], string>> = { vitest: 'vitest', playwright: '@playwright/test' };

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DepsTarget {
  /** Directory to install in (repository-relative, posix, '.' = root). */
  dir: string;
  lockfile?: string;
  manager: PackageManager;
  command: string;
  args: string[];
  runners: string[];
  missing: string[];
}

export interface DepsStatus {
  needed: boolean;
  targets: DepsTarget[];
  /** Runners whose packages are missing but that have no package.json to install from. */
  problems: string[];
}

const LOCKS: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export function canResolve(cwd: string, pkg: string): boolean {
  try {
    createRequire(path.join(cwd, '__ddv__.js')).resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/** `cwd` and its parents up to `root` (inclusive), nearest first. */
function ancestors(root: string, cwd: string): string[] {
  const out: string[] = [];
  let d = cwd;
  for (;;) {
    out.push(d);
    if (path.relative(root, d) === '') break;
    const up = path.dirname(d);
    if (up === d || path.relative(root, up).startsWith('..')) break;
    d = up;
  }
  return out;
}

export function installCommand(manager: PackageManager, lockfile: string | undefined, dir: string): { command: string; args: string[] } {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['install', '--frozen-lockfile'] };
    case 'yarn':
      // Yarn Berry (has .yarnrc.yml) renamed --frozen-lockfile to --immutable.
      return { command: 'yarn', args: ['install', existsSync(path.join(dir, '.yarnrc.yml')) ? '--immutable' : '--frozen-lockfile'] };
    case 'bun':
      return { command: 'bun', args: ['install', '--frozen-lockfile'] };
    case 'npm':
      return { command: 'npm', args: lockfile ? ['ci'] : ['install'] };
  }
}

/** Nearest directory with a lock file (from `cwd` up to `root`); without one, the nearest package.json (installed with `npm install`). */
export function findInstallDir(root: string, cwd: string): { dir: string; lockfile?: string; manager: PackageManager } | null {
  const dirs = ancestors(root, cwd);
  for (const d of dirs) {
    for (const [file, manager] of LOCKS) if (existsSync(path.join(d, file))) return { dir: d, lockfile: file, manager };
  }
  const pkg = dirs.find((d) => existsSync(path.join(d, 'package.json')));
  return pkg ? { dir: pkg, manager: 'npm' } : null;
}

/** Which Node runners cannot resolve their package, and the command that would install it (grouped by install directory). */
export function checkDeps(repoRoot: string, config: DdvConfig): DepsStatus {
  const root = path.resolve(repoRoot);
  const targets = new Map<string, DepsTarget>();
  const problems: string[] = [];
  for (const r of config.runners) {
    const pkg = RUNNER_PACKAGES[r.type];
    if (!pkg) continue;
    const cwd = safeJoin(root, r.cwd);
    if (canResolve(cwd, pkg)) continue;
    const found = findInstallDir(root, cwd);
    if (!found) {
      problems.push(`${r.name}: ${pkg} が見つからず、${r.cwd} から上に package.json もありません`);
      continue;
    }
    const rel = toPosix(path.relative(root, found.dir)) || '.';
    let t = targets.get(rel);
    if (!t) {
      t = { dir: rel, lockfile: found.lockfile, manager: found.manager, ...installCommand(found.manager, found.lockfile, found.dir), runners: [], missing: [] };
      targets.set(rel, t);
    }
    t.runners.push(r.name);
    if (!t.missing.includes(pkg)) t.missing.push(pkg);
  }
  return { needed: targets.size > 0, targets: [...targets.values()], problems };
}

export function commandLine(t: Pick<DepsTarget, 'command' | 'args'>): string {
  return [t.command, ...t.args].join(' ');
}

/** Runs the install command of each target in order; stops at the first failure. Returns true when all succeeded. */
export async function installDeps(repoRoot: string, targets: DepsTarget[], log: (line: string) => void): Promise<boolean> {
  for (const t of targets) {
    const cwd = safeJoin(repoRoot, t.dir);
    const line = commandLine(t);
    log(`$ ${line}  (${t.dir})`);
    const code = await new Promise<number | null>((resolve) => {
      // npm / pnpm / yarn are .cmd shims on Windows and need a shell; the command line is built only from fixed values.
      const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
      const child = process.platform === 'win32' ? spawn(line, { cwd, shell: true, windowsHide: true, env }) : spawn(t.command, t.args, { cwd, env });
      const pipe = (buf: Buffer) => buf.toString('utf8').split(/\r?\n/).filter((l) => l.length).forEach(log);
      child.stdout?.on('data', pipe);
      child.stderr?.on('data', pipe);
      child.on('error', (e) => {
        log(`! ${e.message}`);
        resolve(null);
      });
      child.on('close', (c) => resolve(c));
    });
    if (code !== 0) {
      log(`! ${line} が失敗しました（終了コード ${code ?? '不明'}）`);
      return false;
    }
  }
  return true;
}
