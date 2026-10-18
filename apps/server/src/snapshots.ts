import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { Browser } from '@playwright/test';
import type { DdvConfig } from '@ddv/core';
import { safeJoin } from '@ddv/core/node';
import {
  BrowserLauncher,
  compareImages,
  findScenarioFiles,
  mocksRootOf,
  parseScenarioFile,
  runScenario,
  stepApplies,
  startStaticServer,
  type CompareStatus,
  type Scenario,
  type ScenarioEntry,
} from '@ddv/mock';
import type { RunManager, RunRecord, TaskHandle } from './runs.ts';

export const SNAPSHOTS_DIR = '.ddv/snapshots';

export type SnapKind = 'baseline' | 'current' | 'diff';
export type SnapStatus = 'None' | CompareStatus;

export interface Viewport {
  width: number;
  height: number;
}

export interface StepResultMeta {
  step: number;
  status: CompareStatus;
  diffRatio?: number;
}

export interface SnapshotMeta {
  browser: string;
  browserVersion?: string;
  viewport: Viewport;
  takenAt: string;
  steps: number;
  /** current only: comparison result per captured step. */
  results?: StepResultMeta[];
}

export interface StepSnapshot {
  step: number;
  status: SnapStatus;
  /** Not run on the web (`only:`), so never captured. */
  skipped?: true;
  diffRatio?: number;
  warnings: string[];
  images: { baseline?: string; current?: string; diff?: string };
}

export interface SnapshotList {
  id: string;
  browser?: string;
  takenAt?: string;
  steps: StepSnapshot[];
}

export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const pad = (n: number) => String(n).padStart(3, '0');

export function checkId(id: string): string {
  if (!ID_RE.test(id) || id.includes('..')) throw new SnapshotError(`不正なテストIDです: ${id}`);
  return id;
}

/** `.ddv/snapshots/{baseline,current,diff}/<ID>/<NNN>.png` and `meta.json`. */
export class SnapshotStore {
  readonly root: string;
  constructor(repoRoot: string) {
    this.root = safeJoin(repoRoot, SNAPSHOTS_DIR);
  }
  dir(kind: SnapKind, id: string): string {
    return path.join(this.root, kind, checkId(id));
  }
  file(kind: SnapKind, id: string, step: number): string {
    return path.join(this.dir(kind, id), `${pad(step)}.png`);
  }
  baseline(id: string, step: number) {
    return this.file('baseline', id, step);
  }
  current(id: string, step: number) {
    return this.file('current', id, step);
  }
  diff(id: string, step: number) {
    return this.file('diff', id, step);
  }
  async readMeta(kind: SnapKind, id: string): Promise<SnapshotMeta | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(kind, id), 'meta.json'), 'utf8')) as SnapshotMeta;
    } catch {
      return null;
    }
  }
  async writeMeta(kind: SnapKind, id: string, meta: SnapshotMeta): Promise<void> {
    await fs.mkdir(this.dir(kind, id), { recursive: true });
    await fs.writeFile(path.join(this.dir(kind, id), 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }
  async clear(kind: SnapKind, id: string): Promise<void> {
    await fs.rm(this.dir(kind, id), { recursive: true, force: true });
  }
  /** Step numbers of the PNG files present. */
  async stepsOf(kind: SnapKind, id: string): Promise<number[]> {
    const names = await fs.readdir(this.dir(kind, id)).catch(() => [] as string[]);
    return names.map((n) => /^(\d{3,})\.png$/.exec(n)?.[1]).filter((x): x is string => !!x).map(Number).sort((a, b) => a - b);
  }
}

export interface SnapshotEvents {
  log(line: string): void;
  event(name: string, data: unknown): void;
}

export interface CaptureSummary {
  status: RunRecord['status'];
  scenarios: Array<{ id: string; status: 'passed' | 'failed' | 'error'; captured: number; message?: string; steps: StepResultMeta[] }>;
}

const sameEnv = (a: SnapshotMeta, b: SnapshotMeta) => a.browser === b.browser && a.viewport?.width === b.viewport?.width && a.viewport?.height === b.viewport?.height;
const envText = (m: SnapshotMeta) => `${m.browser} ${m.viewport?.width}×${m.viewport?.height}`;

export class SnapshotService {
  readonly store: SnapshotStore;

  constructor(
    readonly repoRoot: string,
    private getConfig: () => DdvConfig,
    private opts: { launcher?: (config: DdvConfig) => BrowserLauncher; stepTimeout?: number } = {},
  ) {
    this.store = new SnapshotStore(repoRoot);
  }

  private launcher(config: DdvConfig): BrowserLauncher {
    return this.opts.launcher?.(config) ?? new BrowserLauncher(config);
  }

  /** Valid, non-retired scenarios by id. */
  async scenarios(): Promise<Map<string, { entry: ScenarioEntry; scenario: Scenario }>> {
    const out = new Map<string, { entry: ScenarioEntry; scenario: Scenario }>();
    for (const entry of findScenarioFiles(this.repoRoot, this.getConfig())) {
      const sf = parseScenarioFile(await fs.readFile(safeJoin(this.repoRoot, entry.file), 'utf8'), entry.file);
      if (sf.scenario && !out.has(sf.scenario.id)) out.set(sf.scenario.id, { entry, scenario: sf.scenario });
    }
    return out;
  }

  /** Starts a snapshot run on the RunManager (kind: snapshot). */
  run(runs: RunManager, ids?: string[]): RunRecord {
    return runs.startTask('snapshot', { ids }, async (h: TaskHandle) => (await this.capture(ids, h)).status);
  }

  /** Replays scenarios against the static-served mocks and captures each step after its expect succeeded. */
  async capture(ids: string[] | undefined, ev: SnapshotEvents): Promise<CaptureSummary> {
    const config = this.getConfig();
    const all = await this.scenarios();
    const summary: CaptureSummary = { status: 'passed', scenarios: [] };
    const targets: Array<{ entry: ScenarioEntry; scenario: Scenario }> = [];
    for (const id of ids?.length ? ids : [...all.keys()]) {
      const s = all.get(id);
      if (s) targets.push(s);
      else {
        ev.log(`! シナリオが見つからないか形式が不正です: ${id}`);
        ev.event('scenario', { id, status: 'error', captured: 0, message: 'シナリオが見つからないか形式が不正です' });
        summary.scenarios.push({ id, status: 'error', captured: 0, message: 'シナリオが見つからないか形式が不正です', steps: [] });
      }
    }
    if (!targets.length) {
      ev.log('! 撮影対象のシナリオがありません');
      summary.status = 'error';
      return summary;
    }
    const viewport = { width: config.mock.snapshot.viewport.width, height: config.mock.snapshot.viewport.height };
    const threshold = config.mock.snapshot.threshold;
    const launcher = this.launcher(config);
    const channel = launcher.channel();
    ev.log(`ブラウザ: ${channel}、画面: ${viewport.width}×${viewport.height}、閾値: ${threshold}`);
    let browser: Browser;
    try {
      browser = await launcher.launch();
    } catch (e) {
      ev.log(`! ${(e as Error).message}`);
      summary.status = 'error';
      return summary;
    }
    const server = await startStaticServer(safeJoin(this.repoRoot, mocksRootOf(config)));
    try {
      for (const { entry, scenario } of targets) {
        const id = scenario.id;
        await this.store.clear('current', id);
        await this.store.clear('diff', id);
        await fs.mkdir(this.store.dir('current', id), { recursive: true });
        const results: StepResultMeta[] = [];
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        const page = await context.newPage();
        let status: 'passed' | 'failed' = 'passed';
        let message: string | undefined;
        ev.log(`── ${id} ${scenario.title}`);
        try {
          await runScenario(page, scenario, { kind: 'mock', url: new URL(`${entry.mock}/index.html`, server.url).href, mock: entry.mock }, {
            timeout: this.opts.stepTimeout,
            onStep: async (i) => {
              const step = i + 1;
              const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
              await fs.writeFile(this.store.current(id, step), png);
              const basePath = this.store.baseline(id, step);
              const base = existsSync(basePath) ? await fs.readFile(basePath) : null;
              const r = compareImages(base, png, threshold);
              if (r.diffPng) {
                await fs.mkdir(this.store.dir('diff', id), { recursive: true });
                await fs.writeFile(this.store.diff(id, step), r.diffPng);
              }
              const res: StepResultMeta = { step, status: r.status, ...(r.ratio !== undefined ? { diffRatio: r.ratio } : {}) };
              results.push(res);
              ev.log(`  ${pad(step)} ${r.status}${r.ratio !== undefined ? ` (${(r.ratio * 100).toFixed(3)}%)` : ''}`);
              ev.event('step', { id, ...res });
            },
          });
        } catch (e) {
          status = 'failed';
          message = e instanceof Error ? e.message : String(e);
          ev.log(`! ${message}`);
        } finally {
          await context.close().catch(() => {});
        }
        await this.store.writeMeta('current', id, { browser: channel, browserVersion: browser.version(), viewport, takenAt: new Date().toISOString(), steps: scenario.steps.length, results });
        ev.event('scenario', { id, status, captured: results.length, ...(message ? { message } : {}) });
        summary.scenarios.push({ id, status, captured: results.length, ...(message ? { message } : {}), steps: results });
      }
    } finally {
      await server.close();
      await browser.close().catch(() => {});
    }
    const sts = summary.scenarios.map((s) => s.status);
    summary.status = sts.includes('error') ? 'error' : sts.includes('failed') ? 'failed' : 'passed';
    return summary;
  }

  private imageUrl(id: string, step: number, kind: SnapKind, mtimeMs: number) {
    return `/api/snapshots/image?id=${encodeURIComponent(id)}&step=${step}&kind=${kind}&v=${Math.round(mtimeMs)}`;
  }

  /** Step states of a scenario, or null when neither the scenario nor any snapshot exists. */
  async list(id: string): Promise<SnapshotList | null> {
    checkId(id);
    const [cur, base, scenarios] = await Promise.all([this.store.readMeta('current', id), this.store.readMeta('baseline', id), this.scenarios()]);
    const scenario = scenarios.get(id)?.scenario;
    if (!cur && !base && !scenario) return null;
    const n = cur?.steps ?? scenario?.steps.length ?? base?.steps ?? 0;
    const results = new Map((cur?.results ?? []).map((r) => [r.step, r]));
    const warnings = cur && base && !sameEnv(cur, base) ? [`撮影環境が基準と異なります（基準: ${envText(base)}、今回: ${envText(cur)}）`] : [];
    const steps: StepSnapshot[] = [];
    for (let step = 1; step <= n; step++) {
      const images: StepSnapshot['images'] = {};
      for (const kind of ['baseline', 'current', 'diff'] as const) {
        const st = await fs.stat(this.store.file(kind, id, step)).catch(() => null);
        if (st?.isFile()) images[kind] = this.imageUrl(id, step, kind, st.mtimeMs);
      }
      const r = results.get(step);
      const status: SnapStatus = images.current && r ? r.status : 'None';
      const skipped = scenario?.steps[step - 1] !== undefined && !stepApplies(scenario.steps[step - 1], 'web');
      steps.push({ step, status, ...(skipped ? { skipped: true as const } : {}), ...(status !== 'None' && r?.diffRatio !== undefined ? { diffRatio: r.diffRatio } : {}), warnings: status !== 'None' ? warnings : [], images });
    }
    return { id, ...(cur?.browser ?? base?.browser ? { browser: cur?.browser ?? base?.browser } : {}), ...(cur?.takenAt ? { takenAt: cur.takenAt } : {}), steps };
  }

  /** Copies current → baseline for the given steps (all when omitted). None steps cannot be approved. */
  async approve(id: string, steps?: number[]): Promise<SnapshotList & { approved: number[] }> {
    const list = await this.list(id);
    if (!list) throw new SnapshotError(`シナリオが見つかりません: ${id}`, 404);
    const cur = await this.store.readMeta('current', id);
    if (!cur) throw new SnapshotError(`${id} は未撮影のため承認できません`);
    const all = steps === undefined;
    const targets = all ? list.steps.map((s) => s.step) : [...new Set(steps)].sort((a, b) => a - b);
    if (!targets.length) throw new SnapshotError('承認するステップがありません');
    for (const n of targets) {
      const s = list.steps.find((x) => x.step === n);
      if (!s) throw new SnapshotError(`ステップ ${n} はありません`);
      if (s.status === 'None') throw new SnapshotError(`ステップ ${n} は未撮影のため承認できません`);
    }
    await fs.mkdir(this.store.dir('baseline', id), { recursive: true });
    const results = new Map((cur.results ?? []).map((r) => [r.step, r]));
    for (const n of targets) {
      await fs.copyFile(this.store.current(id, n), this.store.baseline(id, n));
      await fs.rm(this.store.diff(id, n), { force: true });
      results.set(n, { step: n, status: 'Match', diffRatio: 0 });
    }
    if (all) for (const n of await this.store.stepsOf('baseline', id)) if (n > cur.steps) await fs.rm(this.store.baseline(id, n), { force: true });
    const { results: _r, ...meta } = cur;
    await this.store.writeMeta('baseline', id, meta);
    await this.store.writeMeta('current', id, { ...cur, results: [...results.values()].sort((a, b) => a.step - b.step) });
    return { ...(await this.list(id))!, approved: targets };
  }
}
