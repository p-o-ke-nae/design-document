// E2E runner: `defineScenarioTests` declares one Playwright test per scenario YAML (detailed design: E2E 実行).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { test } from '@playwright/test';
import { ScreenMapSchema, SCREEN_MAP_FILE, type ScreenMap } from './map.ts';
import { runScenario, type ScenarioHooks, type ScenarioTarget } from './run-scenario.ts';
import { findScenarioFiles, loadConfigSync, mocksRootOf, scenarioIdOf } from './scenario-files.ts';
import { parseScenarioFile } from './scenario.ts';
import { startStaticServer, type StaticServer } from './static-server.ts';
import { recorderFor, traceDirOf } from './trace.ts';

export { runScenario, PlaywrightDriver } from './run-scenario.ts';
export type { RunScenarioOptions, ScenarioHooks, ScenarioTarget, SeedContext, StepHook } from './run-scenario.ts';
export { browserChannel, channelName, BrowserLauncher, launchBrowser, BrowserLaunchError } from './browser.ts';
export { startStaticServer } from './static-server.ts';
export { loadConfigSync, findScenarioFiles } from './scenario-files.ts';

export const DEFAULT_HOOKS = 'e2e/ddv-hooks.ts';
export const BASE_URL_ENV = 'DDV_BASE_URL';

export interface ScenarioTestOptions {
  /** Repository root, relative to the spec file's folder or absolute. */
  repoRoot: string;
  /** Expect retry timeout per step (ms). Default 5000. */
  timeout?: number;
  /** Hooks module (relative to repoRoot). Default `e2e/ddv-hooks.ts`. */
  hooks?: string;
}

const SELF = fileURLToPath(import.meta.url);

/** File of the caller of `defineScenarioTests` (the spec), from the stack trace. */
function callerDir(): string | null {
  const orig = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_e, frames) => frames;
    const frames = (new Error().stack as unknown as NodeJS.CallSite[]) ?? [];
    for (const f of frames) {
      let name = f.getFileName?.() ?? '';
      if (!name) continue;
      if (name.startsWith('file:')) name = fileURLToPath(name);
      if (path.resolve(name) === SELF || name.includes(`${path.sep}node_modules${path.sep}`) || name.startsWith('node:')) continue;
      return path.dirname(name);
    }
  } catch {
    /* fall through */
  } finally {
    Error.prepareStackTrace = orig;
  }
  return null;
}

function resolveRepoRoot(repoRoot: string): string {
  if (path.isAbsolute(repoRoot)) return repoRoot;
  const dir = callerDir();
  return path.resolve(dir ?? process.cwd(), repoRoot);
}

function loadMap(repoRoot: string, mocksRoot: string, mock: string): ScreenMap {
  const p = path.join(repoRoot, mocksRoot, mock, 'scenarios', SCREEN_MAP_FILE);
  if (!existsSync(p)) return ScreenMapSchema.parse({});
  const r = ScreenMapSchema.safeParse(YAML.parse(readFileSync(p, 'utf8')) ?? {});
  if (!r.success) throw new Error(`対応表 ${path.relative(repoRoot, p)} の形式が不正です: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`);
  return r.data;
}

async function loadHooks(file: string): Promise<ScenarioHooks> {
  if (!existsSync(file)) return {};
  const mod = (await import(pathToFileURL(file).href)) as ScenarioHooks & { default?: ScenarioHooks };
  return { seed: mod.seed ?? mod.default?.seed, steps: mod.steps ?? mod.default?.steps };
}

/** Declares `test('[ID] title')` for every scenario under `<mocksRoot>/*\/scenarios/`. */
export function defineScenarioTests(opts: ScenarioTestOptions): void {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const config = loadConfigSync(repoRoot);
  const mocksRoot = mocksRootOf(config);
  const baseURL = process.env[BASE_URL_ENV]?.trim() || '';
  const hooksFile = path.resolve(repoRoot, opts.hooks ?? DEFAULT_HOOKS);
  const traceDir = traceDirOf(process.env);
  let server: StaticServer | null = null;
  let hooks: ScenarioHooks = {};

  test.beforeAll(async () => {
    if (baseURL) hooks = await loadHooks(hooksFile);
    else server = await startStaticServer(path.join(repoRoot, mocksRoot));
  });
  test.afterAll(async () => {
    await server?.close();
    server = null;
  });

  for (const entry of findScenarioFiles(repoRoot, config)) {
    const text = readFileSync(path.join(repoRoot, entry.file), 'utf8');
    const sf = parseScenarioFile(text, entry.file);
    if (!sf.scenario) {
      const id = scenarioIdOf(text) ?? path.posix.basename(entry.file).replace(/\.ya?ml$/, '');
      test(`[${id}] ${entry.file}: シナリオの形式が不正です`, () => {
        throw new Error(`シナリオの形式が不正です（${entry.file}）: ${sf.issues.map((i) => `${i.line ? `${i.line} 行目: ` : ''}${i.message}`).join(' / ')}`);
      });
      continue;
    }
    const scenario = sf.scenario;
    test(`[${scenario.id}] ${scenario.title}`, async ({ page }) => {
      let target: ScenarioTarget;
      if (baseURL) target = { kind: 'app', url: baseURL, mock: entry.mock, map: loadMap(repoRoot, mocksRoot, entry.mock), hooks };
      else {
        if (!server) throw new Error('モックの静的配信が開始されていません');
        target = { kind: 'mock', url: new URL(`${entry.mock}/index.html`, server.url).href, mock: entry.mock };
      }
      const trace = traceDir ? recorderFor(traceDir, test.info().title, entry.mock, target.kind) : undefined;
      await runScenario(page, scenario, target, { timeout: opts.timeout, trace });
    });
  }
}

