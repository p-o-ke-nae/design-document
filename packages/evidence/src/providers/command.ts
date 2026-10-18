// External commands of `evidence.commands` (detailed design evidence-runner.md#外部コマンド, ARGSUB・CMDOUT).
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeJoin } from '@ddv/core/node';
import type { CommandConfig } from '../config.ts';
import { parseCsv } from '../csv.ts';
import type { EvidenceContext } from '../index.ts';
import type { StoreOutput } from '../store.ts';
import type { ResolvedArgs } from '../with.ts';
import { fillParams } from './hooks.ts';
import type { CaptureResult, Provider } from './types.ts';

export const CONTEXT_NAMES = ['out', 'testId', 'step', 'platform', 'at'] as const;
export const NO_FILES = '出力フォルダにファイルがありません';
export const CMD_BAT = '.cmd・.bat は直接起動できません（pwsh などで包んでください）';
export const missingValueMessage = (name: string) => `引数 ${name} がありません`;
export const unknownNameMessage = (name: string) => `args の ${name} は params にありません`;
const STDERR_TAIL = 4096;

/** Replaces `{name}` in one element of `args` (ARGSUB). `{{` / `}}` are literal braces; the element is never split. */
export function substituteArg(arg: string, context: Record<string, string>, params: Record<string, unknown>, values: ResolvedArgs): string {
  let out = '';
  let i = 0;
  while (i < arg.length) {
    const c = arg[i];
    if ((c === '{' || c === '}') && arg[i + 1] === c) {
      out += c;
      i += 2;
      continue;
    }
    const m = c === '{' ? /^\{([A-Za-z0-9_-]+)\}/.exec(arg.slice(i)) : null;
    if (!m) {
      out += c;
      i++;
      continue;
    }
    const name = m[1];
    if ((CONTEXT_NAMES as readonly string[]).includes(name)) out += context[name];
    else if (name in params) {
      const v = values[name];
      if (v === undefined) throw new Error(missingValueMessage(name));
      out += Array.isArray(v) ? v.map(String).join(',') : String(v);
    } else throw new Error(unknownNameMessage(name));
    i += m[0].length;
  }
  return out;
}

/** Kind of an output file by extension (case-insensitive). */
export function kindOfExt(ext: string): 'image' | 'table' | 'json' | 'text' | 'file' {
  const e = ext.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return 'image';
  if (e === 'csv') return 'table';
  if (e === 'json') return 'json';
  if (e === 'txt' || e === 'log') return 'text';
  return 'file';
}

/** Outputs of `output: dir`: files only (no sub folders), by name. */
export async function readOutputDir(dir: string): Promise<StoreOutput[]> {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.endsWith('.tmp')).map((e) => e.name);
  entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) throw new Error(NO_FILES);
  const out: StoreOutput[] = [];
  for (const name of entries) {
    const file = path.join(dir, name);
    const ext = path.extname(name).slice(1).toLowerCase();
    const kind = kindOfExt(ext);
    if (kind === 'table') {
      const t = parseCsv(await fs.readFile(file, 'utf8'));
      out.push(t ? { kind: 'table', columns: t.columns, rows: t.rows } : { kind: 'file', path: file });
    } else if (kind === 'json') {
      const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
      try {
        out.push({ kind: 'json', data: JSON.parse(text) });
      } catch {
        out.push({ kind: 'text', text });
      }
    } else if (kind === 'text') out.push({ kind: 'text', text: (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''), ext });
    else out.push({ kind, path: file });
  }
  return out;
}

/** `output: stdout`: JSON when it starts with `{` / `[` and parses, otherwise text. */
export function stdoutOutput(stdout: string): StoreOutput {
  const t = stdout.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { kind: 'json', data: JSON.parse(t) };
    } catch {
      // text
    }
  }
  return { kind: 'text', text: stdout };
}

/** Ends the process tree (Windows: taskkill /T, others: the process group). */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already ended
  }
}

interface Collected {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutCut: boolean;
}

export class CommandProvider implements Provider {
  readonly kind = 'command' as const;
  readonly timeout?: number;

  constructor(
    private readonly name: string,
    private readonly cmd: CommandConfig,
    private readonly repoRoot: string,
    private readonly maxBytes: number,
  ) {
    if (cmd.timeout !== undefined) this.timeout = cmd.timeout;
  }

  async capture(args: ResolvedArgs, ctx: EvidenceContext): Promise<CaptureResult> {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.cmd.run)) throw new Error(CMD_BAT);
    const values = fillParams(this.cmd.params, args);
    const context: Record<string, string> = { out: ctx.outDir, testId: ctx.testId, step: String(ctx.step), platform: ctx.platform, at: ctx.at };
    const argv = this.cmd.args.map((a) => substituteArg(a, context, this.cmd.params, values));
    const cwd = safeJoin(this.repoRoot, this.cmd.cwd);
    const env = { ...process.env, DDV_EVIDENCE_OUT: ctx.outDir, DDV_TEST_ID: ctx.testId, DDV_STEP: String(ctx.step), DDV_AT: ctx.at, DDV_PLATFORM: ctx.platform };
    const r = await this.run(argv, cwd, env, ctx.signal);
    if (r.code !== 0) {
      const tail = r.stderr.subarray(Math.max(0, r.stderr.length - STDERR_TAIL)).toString('utf8').trim();
      throw new Error(`終了コード ${r.code ?? '?'}：${tail}`);
    }
    if (this.cmd.output === 'stdout') return { outputs: stdoutOutput(r.stdout.toString('utf8')), meta: r.stdoutCut ? { truncated: true } : undefined };
    return { outputs: await readOutputDir(ctx.outDir) };
  }

  private run(argv: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Collected> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cmd.run, argv, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let stdoutCut = false;
      const onAbort = () => killTree(child.pid);
      signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (b: Buffer) => {
        const room = this.maxBytes - outBytes;
        if (room <= 0) return void (stdoutCut = true);
        if (b.length > room) stdoutCut = true;
        out.push(b.subarray(0, room));
        outBytes += Math.min(b.length, room);
      });
      child.stderr.on('data', (b: Buffer) => {
        err.push(b);
        errBytes += b.length;
        while (errBytes > this.maxBytes && err.length > 1) errBytes -= err.shift()!.length;
      });
      child.on('error', (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`${this.name} を起動できません：${e.message}`));
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), stdoutCut });
      });
    });
  }
}
