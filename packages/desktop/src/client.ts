// Talks to the C# driver over stdin/stdout JSON lines (flaui-driver.md「通信の形式」).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** `error.code` of a driver response, or `timeout` / `exited` from the client. */
export class DriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

interface Pending {
  cmd: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DriverClientOptions {
  /** Default `dotnet <dll>`. Tests run a Node script. */
  command?: (dllPath: string) => { file: string; args: string[] };
  /** Time to wait for the ready line (default 30 s). */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

export const LAUNCH_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 10_000;

export function defaultTimeout(cmd: string): number {
  return cmd === 'launch' ? LAUNCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

export class DriverClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private dll = '';
  version = '';

  constructor(private readonly opts: DriverClientOptions = {}) {}

  get running(): boolean {
    return this.child !== null;
  }

  async start(dllPath: string): Promise<void> {
    if (this.child) return;
    this.dll = dllPath;
    const { file, args } = (this.opts.command ?? ((d) => ({ file: 'dotnet', args: [d] })))(dllPath);
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const log = this.opts.log ?? ((l: string) => process.stderr.write(`[flaui-driver] ${l}\n`));
    createInterface({ input: child.stderr }).on('line', (l) => log(l));
    const lines = createInterface({ input: child.stdout });
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        this.kill();
        reject(new DriverError('timeout', 'FlaUI のドライバが応答しません（ready）'));
      }, this.opts.readyTimeoutMs ?? LAUNCH_TIMEOUT_MS);
      lines.on('line', (line) => {
        if (!ready) {
          try {
            const msg = JSON.parse(line) as { ready?: boolean; version?: string };
            if (msg.ready) {
              ready = true;
              this.version = msg.version ?? '';
              clearTimeout(timer);
              resolve();
              return;
            }
          } catch {
            // not the ready line
          }
          log(line);
          return;
        }
        this.onLine(line, log);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        if (!ready) reject(new DriverError('exited', `FlaUI のドライバを起動できません: ${e.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        const err = new DriverError('exited', `FlaUI のドライバが終了しました（終了コード ${code ?? '不明'}）`);
        if (!ready) reject(err);
        this.failAll(err);
      });
    });
  }

  /** Restarts the driver if a timeout killed it. */
  async ensureStarted(): Promise<void> {
    if (!this.child && this.dll) await this.start(this.dll);
  }

  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = defaultTimeout(cmd)): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new DriverError('exited', `FlaUI のドライバが起動していません（${cmd}）`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DriverError('timeout', `FlaUI のドライバが応答しません（${cmd}）`));
        this.kill();
      }, timeoutMs);
      this.pending.set(id, { cmd, resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.stdin.end();
    const t = setTimeout(() => this.kill(), 5000);
    await exited;
    clearTimeout(t);
  }

  private kill(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill();
    this.failAll(new DriverError('exited', 'FlaUI のドライバを止めました'));
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new DriverError((err as DriverError).code ?? 'exited', `${err.message}（${p.cmd}）`));
    }
  }

  private onLine(line: string, log: (l: string) => void): void {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      log(`不正な応答: ${line}`);
      return;
    }
    const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (!p) {
      log(`待っていない応答を捨てました: ${line}`);
      return;
    }
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new DriverError(msg.error?.code ?? 'error', msg.error?.message ?? 'ドライバのエラー'));
  }
}
