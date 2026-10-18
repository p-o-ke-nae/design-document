// `ddv desktop run`: runs the scenarios on a WPF / WinForms app via FlaUI (flaui-driver.md「デスクトップの実行」).
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FLAUI_DEFAULT_AUTOMATION, FLAUI_DEFAULT_TIMEOUT, type DdvConfig, type RunnerConfig } from '@ddv/core';
import { createScreenMap, findScenarioFiles, mocksRootOf, parseScenarioFile, parseScreenMap, runScenarioWith, scenarioIdOf, SCREEN_MAP_FILE, type PlatformMap, type Scenario, type ScreenMap } from '@ddv/mock';
import { TraceRecorder, traceDirOf } from '@ddv/mock/trace';
import { traceKey } from '@ddv/mock/trace-format';
import { evidenceRunnerForRun } from '@ddv/evidence/run';
import { DriverClient } from './client.ts';
import { DriverBuilder } from './driver-build.ts';
import { FixturesWriter } from './fixtures.ts';
import type { DriverRequester } from './flaui-driver.ts';
import { DesktopGate, type RunnerGate } from './gate.ts';
import { writeJUnit, type DesktopCaseResult } from './junit.ts';
import { FlaUiSession, type DesktopHooks, type DesktopPlatform, type FlaUiSessionOptions } from './session.ts';

export const DEFAULT_HOOKS = 'e2e/ddv-hooks.ts';
export const DESKTOP_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** What `desktopRun` needs from `DriverClient`. */
export interface DesktopDriverClient extends DriverRequester {
  start(dllPath: string): Promise<void>;
  ensureStarted(): Promise<void>;
  stop(): Promise<void>;
}

export interface DesktopRunOptions {
  repoRoot: string;
  config: DdvConfig;
  runner: string;
  /** Only these test ids. */
  ids?: string[];
  junit?: string;
  /** Trace directory (default `DDV_TRACE_DIR`). */
  trace?: string;
  hooksFile?: string;
  gate?: RunnerGate;
  /** Path of FlaUiDriver.dll (default `DriverBuilder.ensure()`). */
  driverDll?: () => Promise<string>;
  client?: DesktopDriverClient;
  log?: (line: string) => void;
  /** Tests: shorter polling. */
  pollMs?: number;
}

export interface DesktopRunReport {
  runner: string;
  platform: DesktopPlatform;
  cases: DesktopCaseResult[];
  exitCode: number;
}

interface Planned {
  id: string;
  title: string;
  mock: string;
  scenario?: Scenario;
  /** Error before the run (invalid file / map). */
  error?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function loadMap(repoRoot: string, mocksRoot: string, mock: string, cache: Map<string, ScreenMap>): ScreenMap {
  const hit = cache.get(mock);
  if (hit) return hit;
  const p = path.join(repoRoot, mocksRoot, mock, 'scenarios', SCREEN_MAP_FILE);
  let map = createScreenMap();
  if (existsSync(p)) {
    try {
      map = parseScreenMap(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`対応表 ${path.relative(repoRoot, p).replace(/\\/g, '/')} の形式が不正です: ${errText(e)}`);
    }
  }
  cache.set(mock, map);
  return map;
}

export async function loadDesktopHooks(file: string): Promise<DesktopHooks> {
  if (!existsSync(file)) return {};
  const mod = (await import(pathToFileURL(file).href)) as DesktopHooks & { default?: DesktopHooks };
  return { desktopSeed: mod.desktopSeed ?? mod.default?.desktopSeed, desktopSteps: mod.desktopSteps ?? mod.default?.desktopSteps };
}

/** `type: flaui` runner of the config, or an error message. */
export function flauiRunnerOf(config: DdvConfig, name: string): RunnerConfig {
  const r = config.runners.find((x) => x.name === name);
  if (!r) throw new Error(`ランナー ${name} が設定にありません`);
  if (r.type !== 'flaui') throw new Error(`ランナー ${name} は type: flaui ではありません`);
  return r;
}

/** Scenarios to run (`ids` filter), in file order. */
export function planScenarios(repoRoot: string, config: DdvConfig, ids?: readonly string[]): Planned[] {
  const want = ids?.length ? new Set(ids) : null;
  const out: Planned[] = [];
  for (const entry of findScenarioFiles(repoRoot, config)) {
    const text = readFileSync(path.join(repoRoot, entry.file), 'utf8');
    const sf = parseScenarioFile(text, entry.file);
    const id = sf.scenario?.id ?? scenarioIdOf(text) ?? path.posix.basename(entry.file).replace(/\.ya?ml$/, '');
    if (want && !want.has(id)) continue;
    if (!sf.scenario) {
      out.push({ id, title: `${entry.file}: シナリオの形式が不正です`, mock: entry.mock, error: `シナリオの形式が不正です（${entry.file}）: ${sf.issues.map((i) => `${i.line ? `${i.line} 行目: ` : ''}${i.message}`).join(' / ')}` });
      continue;
    }
    out.push({ id, title: sf.scenario.title, mock: entry.mock, scenario: sf.scenario });
  }
  return out;
}

export async function desktopRun(opts: DesktopRunOptions): Promise<DesktopRunReport> {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const runner = flauiRunnerOf(opts.config, opts.runner);
  const platform = runner.platform as DesktopPlatform;
  const planned = planScenarios(opts.repoRoot, opts.config, opts.ids);
  const cases: DesktopCaseResult[] = [];
  const finish = async (): Promise<DesktopRunReport> => {
    if (opts.junit) await writeJUnit(opts.junit, runner.name, cases);
    const bad = cases.filter((c) => c.status !== 'passed').length;
    log(`${runner.name}: ${cases.length - bad} 件成功・${bad} 件失敗`);
    return { runner: runner.name, platform, cases, exitCode: bad ? 1 : 0 };
  };

  const gate = opts.gate ?? new DesktopGate({ repoRoot: opts.repoRoot, cacheMs: 0 });
  const g = await gate.evaluate(runner);
  if (!g.available) {
    const reason = `${g.reason ?? '実行できません'}${g.url ? `（${g.url}）` : ''}`;
    for (const p of planned) cases.push({ id: p.id, title: p.title, status: 'error', durationMs: 0, message: reason });
    log(`${runner.name}: ${reason}`);
    return finish();
  }

  const timeout = runner.timeout ?? FLAUI_DEFAULT_TIMEOUT;
  const mocksRoot = mocksRootOf(opts.config);
  const appPath = path.resolve(opts.repoRoot, runner.app!.path);
  const app = { path: appPath, args: runner.app!.args ?? [], ...(runner.app!.cwd ? { cwd: path.resolve(opts.repoRoot, runner.app!.cwd) } : {}) };
  const hooksAbs = path.resolve(opts.repoRoot, opts.hooksFile ?? DEFAULT_HOOKS);
  const hooks = await loadDesktopHooks(hooksAbs);
  const traceDir = opts.trace ?? traceDirOf(process.env);
  const runId = traceDir ? path.basename(traceDir) : `${Date.now()}`;
  const fixtures = new FixturesWriter(path.join(os.tmpdir(), `ddv-fixtures-${runId}-${process.pid}`));
  const client = opts.client ?? new DriverClient();
  const maps = new Map<string, ScreenMap>();

  try {
    try {
      const dll = await (opts.driverDll ?? (() => new DriverBuilder({ version: DESKTOP_VERSION }).ensure()))();
      await client.start(dll);
    } catch (e) {
      for (const p of planned) cases.push({ id: p.id, title: p.title, status: 'error', durationMs: 0, message: errText(e) });
      log(`${runner.name}: ${errText(e)}`);
      return await finish();
    }
    for (const p of planned) {
      const t0 = Date.now();
      const rec = traceDir ? new TraceRecorder(traceDir, { runId, testId: p.id, title: p.title, mock: p.mock, target: 'app', platform }) : undefined;
      const fail = async (message: string, status: 'failed' | 'error' = 'failed') => {
        cases.push({ id: p.id, title: p.title, status, durationMs: Date.now() - t0, message });
        log(`  ✗ [${p.id}] ${p.title}\n    ${message.replace(/\n/g, '\n    ')}`);
      };
      if (!p.scenario) {
        if (rec) await rec.fail(p.error!).catch(() => undefined);
        await fail(p.error!, 'error');
        continue;
      }
      let map: PlatformMap;
      let fixturesFile: string;
      try {
        map = loadMap(opts.repoRoot, mocksRoot, p.mock, maps).of(platform);
        fixturesFile = await fixtures.write(path.join(opts.repoRoot, mocksRoot, p.mock), p.id, p.scenario.fixtures ?? []);
      } catch (e) {
        if (rec) await rec.fail(errText(e)).catch(() => undefined);
        await fail(errText(e));
        continue;
      }
      const sessionOpts: FlaUiSessionOptions = { runner: runner.name, platform, app, automation: runner.automation ?? FLAUI_DEFAULT_AUTOMATION, timeout, map, hooks, fixturesFile, pollMs: opts.pollMs };
      const session = new FlaUiSession(client, sessionOpts);
      try {
        await client.ensureStarted();
        const evidence = await evidenceRunnerForRun({
          repoRoot: opts.repoRoot,
          config: opts.config,
          hooks: path.relative(opts.repoRoot, hooksAbs),
          traceDir: traceDir || path.join(os.tmpdir(), `ddv-evidence-untraced-${process.pid}`),
          key: rec?.key ?? traceKey(p.id, platform),
          testId: p.id,
          scenario: p.scenario,
        });
        await runScenarioWith(session, p.scenario, { timeout, trace: rec, hasOp: (n) => session.hasOp(n), evidence });
        cases.push({ id: p.id, title: p.title, status: 'passed', durationMs: Date.now() - t0 });
        log(`  ✓ [${p.id}] ${p.title}`);
      } catch (e) {
        await fail(errText(e));
      } finally {
        await session.close().catch(() => undefined);
      }
    }
  } finally {
    await client.stop().catch(() => undefined);
    await fixtures.dispose().catch(() => undefined);
  }
  return finish();
}
