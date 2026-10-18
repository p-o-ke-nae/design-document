// `ddv desktop run / doctor` (flaui-driver.md「デスクトップの実行」「ddv desktop doctor」).
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig, RunnerConfig } from '@ddv/core';
import { DriverBuilder } from './driver-build.ts';
import { DesktopGate, DOTNET_URL, GATE_MESSAGES } from './gate.ts';
import { desktopRun, DESKTOP_VERSION, type DesktopRunOptions, type DesktopRunReport } from './run.ts';
import { nodeScreenDefFs, scanScreenDefs } from './screen-defs.ts';

export const DESKTOP_HELP = `ddv desktop run --runner <name> [--repo <path>] [--ids <id,...>] [--junit <file>] [--trace <dir>]
      type: flaui のランナーで、シナリオをデスクトップアプリ（WPF・WinForms）に対して実行します（Windows だけ）
  ddv desktop doctor [--runner <name>] [--repo <path>]
      type: flaui のランナーごとに OS・.NET SDK・実行ファイル・ドライバ・画面定義を確かめます（✗ があれば終了コード 1）`;

export interface DesktopCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  help: string;
  loadConfig: (repoRoot: string) => Promise<DdvConfig>;
  /** Tests: replace the run / the environment. */
  run?: (opts: DesktopRunOptions) => Promise<DesktopRunReport>;
  platform?: NodeJS.Platform;
  listSdks?: () => Promise<string>;
  driver?: { cached(): Promise<string | null>; ensure(): Promise<string> };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `ddv desktop <run|doctor>`; returns the exit code. */
export async function desktopCommand(argv: string[], io: DesktopCliIo): Promise<number> {
  const sub = argv[0];
  if (sub !== 'run' && sub !== 'doctor') {
    io.err(`不明なサブコマンド: desktop ${sub ?? ''}\n\n${io.help}`);
    return 2;
  }
  const repo = path.resolve(io.cwd, arg(argv, '--repo') ?? '.');
  if (!existsSync(repo)) {
    io.err(`リポジトリが見つかりません: ${repo}`);
    return 2;
  }
  let config: DdvConfig;
  try {
    config = await io.loadConfig(repo);
  } catch (e) {
    io.err(`ddv.config.yaml を読めません: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const runnerName = arg(argv, '--runner');
  if (sub === 'run') {
    if (!runnerName) {
      io.err(`--runner を指定してください\n\n${io.help}`);
      return 2;
    }
    const ids = arg(argv, '--ids')?.split(',').map((s) => s.trim()).filter(Boolean);
    const junit = arg(argv, '--junit');
    const trace = arg(argv, '--trace');
    try {
      const report = await (io.run ?? desktopRun)({
        repoRoot: repo,
        config,
        runner: runnerName,
        ...(ids?.length ? { ids } : {}),
        ...(junit ? { junit: path.resolve(io.cwd, junit) } : {}),
        ...(trace ? { trace: path.resolve(io.cwd, trace) } : {}),
        log: io.out,
      });
      return report.exitCode;
    } catch (e) {
      io.err(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }
  return doctor(repo, config, runnerName, io);
}

async function doctor(repo: string, config: DdvConfig, name: string | undefined, io: DesktopCliIo): Promise<number> {
  const runners = config.runners.filter((r) => r.type === 'flaui' && (!name || r.name === name));
  if (!runners.length) {
    io.err(name ? `type: flaui のランナー ${name} が設定にありません` : 'type: flaui のランナーが設定にありません');
    return 2;
  }
  const platform = io.platform ?? process.platform;
  const gate = new DesktopGate({ repoRoot: repo, platform, cacheMs: 0, ...(io.listSdks ? { listSdks: io.listSdks } : {}) });
  let bad = false;
  const line = (ok: boolean, label: string, text: string) => {
    if (!ok) bad = true;
    io.out(`  ${ok ? '✓' : '✗'} ${label}: ${text}`);
  };
  const windows = platform === 'win32';
  const sdk = windows ? await gate.dotnetSdk() : null;
  let driverLine: { ok: boolean; text: string } | null = null;
  const driverStatus = async () => {
    if (driverLine) return driverLine;
    if (!windows || !sdk) return (driverLine = { ok: false, text: 'ビルドできません（Windows と .NET SDK が必要です）' });
    const builder = io.driver ?? new DriverBuilder({ version: DESKTOP_VERSION });
    try {
      const hit = await builder.cached();
      if (hit) return (driverLine = { ok: true, text: `キャッシュあり（${hit}）` });
      io.out('  … ドライバをビルドしています');
      return (driverLine = { ok: true, text: `ビルドしました（${await builder.ensure()}）` });
    } catch (e) {
      return (driverLine = { ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  for (const r of runners) {
    io.out(`${r.name}（${r.platform ?? '?'}）`);
    line(windows, 'OS', windows ? 'win32' : `${platform}（${GATE_MESSAGES['not-windows']}）`);
    line(!!sdk, '.NET SDK', sdk ?? `${GATE_MESSAGES['no-dotnet']} ${DOTNET_URL}`);
    const app = appPath(repo, r);
    line(!!app && existsSync(app), '実行ファイル', app ? (existsSync(app) ? app : `${app}（${GATE_MESSAGES['app-missing']}）`) : 'app.path がありません');
    const d = await driverStatus();
    line(d.ok, 'ドライバ', d.text);
    const p = r.platform === 'wpf' || r.platform === 'winforms' ? r.platform : null;
    const index = p && r.source ? await scanScreenDefs(nodeScreenDefFs(repo), r.source, p) : null;
    line(!!index, '画面定義', index ? `${index.defs.length} 件（source: ${r.source}）` : `見つかりません（source: ${r.source ?? '未設定'}）`);
  }
  return bad ? 1 : 0;
}

const appPath = (repo: string, r: RunnerConfig) => (r.app?.path ? path.resolve(repo, r.app.path) : null);
