// Builds the C# FlaUI driver once per driver source (flaui-driver.md「ドライバの用意」).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DRIVER_DLL = 'FlaUiDriver.dll';
const OK_FILE = '.ok';
const LOCK_FILE = '.lock';
const LOG_FILE = 'build.log';

/** The C# project of the driver in this package. */
export const DRIVER_DIR = path.join(import.meta.dirname, '..', 'driver');

export interface BuildOutcome {
  code: number | null;
  output: string;
}

export interface DriverBuilderOptions {
  /** Version of ddv (part of the cache key). */
  version: string;
  /** C# project folder. Default: `driver/` of this package. */
  driverDir?: string;
  /** Default `~/.ddv/cache/flaui-driver`. */
  cacheRoot?: string;
  /** Runs `dotnet build -c Release -o <outDir>` in `driverDir`. */
  build?: (driverDir: string, outDir: string) => Promise<BuildOutcome>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for another build (default 5 minutes). */
  waitMs?: number;
  /** Locks older than this are removed (default 10 minutes). */
  staleMs?: number;
  pollMs?: number;
}

export class DriverBuildError extends Error {
  constructor(
    message: string,
    readonly log: string,
  ) {
    super(message);
    this.name = 'DriverBuildError';
  }
}

/** Last `n` lines (without trailing blank lines). */
export function tailLines(text: string, n = 20): string {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

/** SHA-256 (first 12 hex digits) of the driver sources: relative paths and contents, without bin/obj. */
export async function hashDriverSources(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== 'bin' && e.name !== 'obj') await walk(r);
      } else if (e.isFile()) files.push(r);
    }
  };
  await walk('');
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update((await fs.readFile(path.join(dir, f), 'utf8')).replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

function dotnetBuild(driverDir: string, outDir: string): Promise<BuildOutcome> {
  return new Promise((resolve) => {
    const child = spawn('dotnet', ['build', '-c', 'Release', '-o', outDir, '-nologo'], {
      cwd: driverDir,
      windowsHide: true,
      env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: process.env.DOTNET_CLI_UI_LANGUAGE ?? 'ja', DOTNET_NOLOGO: '1' },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('error', (e) => resolve({ code: null, output: `${output}${e.message}\n` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** `ensure()` returns the path of `FlaUiDriver.dll`, building it into the cache when needed (DD-FLAUI-DBUILD). */
export class DriverBuilder {
  private dir: string | null = null;

  constructor(private readonly opts: DriverBuilderOptions) {}

  private get driverDir(): string {
    return this.opts.driverDir ?? DRIVER_DIR;
  }

  /** `<cacheRoot>/<version>-<hash>/`. */
  async cacheDir(): Promise<string> {
    if (!this.dir) {
      const root = this.opts.cacheRoot ?? path.join(os.homedir(), '.ddv', 'cache', 'flaui-driver');
      this.dir = path.join(root, `${this.opts.version}-${await hashDriverSources(this.driverDir)}`);
    }
    return this.dir;
  }

  /** Whether the cache already has a finished build (no build). */
  async cached(): Promise<string | null> {
    const dir = await this.cacheDir();
    const dll = path.join(dir, DRIVER_DLL);
    return existsSync(dll) && existsSync(path.join(dir, OK_FILE)) ? dll : null;
  }

  async ensure(): Promise<string> {
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const dir = await this.cacheDir();
    const deadline = now() + (this.opts.waitMs ?? 5 * 60_000);
    for (;;) {
      const done = await this.cached();
      if (done) return done;
      const lock = await this.lock(dir, now);
      if (!lock) {
        if (now() >= deadline) throw new DriverBuildError(`ドライバのビルドを待ちきれませんでした（ほかのビルドのロック: ${path.join(dir, LOCK_FILE)}）`, '');
        await sleep(this.opts.pollMs ?? 1000);
        continue;
      }
      try {
        const r = await (this.opts.build ?? dotnetBuild)(this.driverDir, dir);
        if (r.code !== 0) {
          await fs.writeFile(path.join(dir, LOG_FILE), r.output).catch(() => undefined);
          throw new DriverBuildError(`ドライバのビルドに失敗しました（${path.join(dir, LOG_FILE)}）\n${tailLines(r.output)}`, r.output);
        }
        await fs.writeFile(path.join(dir, OK_FILE), new Date(now()).toISOString());
        return path.join(dir, DRIVER_DLL);
      } finally {
        await fs.rm(path.join(dir, LOCK_FILE), { force: true });
      }
    }
  }

  /** Takes `<dir>/.lock` (`wx`); removes a stale lock first. false: another build holds it. */
  private async lock(dir: string, now: () => number): Promise<boolean> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const h = await fs.open(file, 'wx');
        await h.writeFile(`${process.pid}\n`);
        await h.close();
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const st = await fs.stat(file).catch(() => null);
        if (st && now() - st.mtimeMs <= (this.opts.staleMs ?? 10 * 60_000)) return false;
        await fs.rm(file, { force: true });
      }
    }
    return false;
  }
}
