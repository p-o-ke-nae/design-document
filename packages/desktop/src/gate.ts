// Whether a runner can run here (flaui-driver.md「実行の可否」). Used by the server (targets) and `ddv desktop doctor`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RunnerConfig } from '@ddv/core';

export type GateCode = 'not-windows' | 'no-dotnet' | 'app-missing';

export interface GateResult {
  available: boolean;
  code?: GateCode;
  reason?: string;
  /** no-dotnet: where to get the SDK. */
  url?: string;
}

export type GateRunner = Pick<RunnerConfig, 'name' | 'type' | 'platform' | 'app'>;

/** The judgement of one runner (the server can replace it, e.g. in E2E). */
export interface RunnerGate {
  evaluate(runner: GateRunner): Promise<GateResult>;
}

export const DOTNET_URL = 'https://dotnet.microsoft.com/download';

export const GATE_MESSAGES: Record<GateCode, string> = {
  'not-windows': 'デスクトップアプリの実行は Windows でだけ行えます',
  'no-dotnet': '.NET SDK が見つかりません（導入の案内）',
  'app-missing': 'アプリの実行ファイルが見つかりません（ビルドしてください）',
};

/** Highest SDK version with major ≥ 8 in `dotnet --list-sdks` output, or null. */
export function sdkFromList(output: string): string | null {
  let best: { text: string; parts: number[] } | null = null;
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\.(\d+)\.(\d+)\S*/.exec(line);
    if (!m || Number(m[1]) < 8) continue;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || compare(parts, best.parts) > 0) best = { text: m[0].trim(), parts };
  }
  return best?.text ?? null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function listSdks(): Promise<string> {
  return new Promise((resolve) => {
    execFile('dotnet', ['--list-sdks'], { windowsHide: true, timeout: 15_000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

export interface DesktopGateOptions {
  /** Repository root (`app.path` is relative to it). */
  repoRoot: string;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Output of `dotnet --list-sdks` ('' when dotnet cannot be started). */
  listSdks?: () => Promise<string>;
  exists?: (file: string) => boolean;
  now?: () => number;
  /** How long the dotnet result is kept (ms). 0 = always ask (doctor). Default 30 s. */
  cacheMs?: number;
}

/** The default gate: web → usable; desktop → Windows, .NET SDK 8+, `app.path` exists (DD-FLAUI-GATE). */
export class DesktopGate implements RunnerGate {
  private sdkCache: { at: number; value: Promise<string | null> } | null = null;

  constructor(private readonly opts: DesktopGateOptions) {}

  async evaluate(runner: GateRunner): Promise<GateResult> {
    const platform = runner.platform ?? 'web';
    if (platform === 'web') return { available: true };
    if (!this.isWindows()) return this.fail('not-windows');
    if (!(await this.dotnetSdk())) return { ...this.fail('no-dotnet'), url: DOTNET_URL };
    const app = runner.app?.path;
    const exists = this.opts.exists ?? existsSync;
    if (!app || !exists(path.resolve(this.opts.repoRoot, app))) return this.fail('app-missing');
    return { available: true };
  }

  private fail(code: GateCode): GateResult {
    return { available: false, code, reason: GATE_MESSAGES[code] };
  }

  private isWindows(): boolean {
    return (this.opts.platform ?? process.platform) === 'win32';
  }

  /** SDK version (≥ 8) or null; kept for `cacheMs` within the process. */
  dotnetSdk(): Promise<string | null> {
    const now = (this.opts.now ?? Date.now)();
    const keep = this.opts.cacheMs ?? 30_000;
    if (this.sdkCache && keep > 0 && now - this.sdkCache.at < keep) return this.sdkCache.value;
    const value = (this.opts.listSdks ?? listSdks)().then(sdkFromList, () => null);
    this.sdkCache = { at: now, value };
    return value;
  }
}
