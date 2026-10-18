// Capturing the evidence of steps (detailed design evidence-runner.md#時点ごとの取得・#1-つの指定の取得).
import { existsSync, promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AtResult, EvidenceHost, EvidenceInputScope, StepEvidenceRunner, StepPlan } from '@ddv/mock';
import type { EvidenceProviderKind, TraceEvidence } from '@ddv/mock/trace-format';
import type { Step } from '@ddv/mock';
import { evidenceConfigOf, type DbType, type EvidenceConfig } from './config.ts';
import type { DbConnector } from './db/types.ts';
import type { Cell, EvidenceContext, EvidenceHooks } from './index.ts';
import { CommandProvider } from './providers/command.ts';
import { DbProvider } from './providers/db.ts';
import { HooksProvider } from './providers/hooks.ts';
import { ScreenshotProvider } from './providers/screenshot.ts';
import type { CaptureResult, Provider } from './providers/types.ts';
import { Redactor } from './redact.ts';
import { normalizeSpec, type EvidenceAt, type EvidenceSpec, type EvidenceSpecInput, type Scalar } from './spec.ts';
import type { EvidenceStore, StoreOutput } from './store.ts';
import { InputScope, resolveWith } from './with.ts';

export const NO_OUTPUT = '取得手段が証跡を返しませんでした';
export const BAD_OUTPUT = '戻り値の形が不正です';
export const unregisteredMessage = (use: string) => `取得手段 ${use} は登録されていません`;
export const timeoutMessage = (ms: number) => `時間の上限 ${ms} ms を超えました`;
const AT_LABEL: Record<EvidenceAt, string> = { before: '操作前', after: '判定後' };
const BUILTINS = ['screenshot', 'db'];

/** Finds the provider of `use`: built-in → hooks → commands. */
export class ProviderResolver {
  constructor(
    private readonly builtins: ReadonlyMap<string, Provider>,
    private readonly hooks: EvidenceHooks,
    private readonly commands: ReadonlyMap<string, Provider>,
  ) {}

  resolve(use: string): Provider | null {
    const b = this.builtins.get(use);
    if (b) return b;
    const def = Object.prototype.hasOwnProperty.call(this.hooks, use) ? this.hooks[use] : undefined;
    if (def && typeof def.run === 'function') return new HooksProvider(def);
    return this.commands.get(use) ?? null;
  }

  kindOf(use: string): EvidenceProviderKind {
    if (BUILTINS.includes(use)) return 'builtin';
    if (this.commands.has(use)) return 'command';
    return 'hooks';
  }
}

/** Limit of one spec (TMO): spec → provider → config. */
export function timeoutOf(spec: Pick<EvidenceSpec, 'timeout'>, provider: Pick<Provider, 'timeout'> | null, config: Pick<EvidenceConfig, 'timeout'>): number {
  return spec.timeout ?? provider?.timeout ?? config.timeout;
}

const inside = (dir: string, p: string) => {
  const rel = path.relative(dir, path.resolve(dir, p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const isCell = (v: unknown) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Checks the outputs (one or more, known kinds, files inside `outDir`, table shape). Returns an error message or the list. */
export function checkOutputs(raw: unknown, outDir: string): StoreOutput[] | string {
  const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  if (!list.length) return NO_OUTPUT;
  const out: StoreOutput[] = [];
  for (const o of list) {
    if (!o || typeof o !== 'object') return BAD_OUTPUT;
    const r = o as Record<string, unknown>;
    switch (r.kind) {
      case 'image':
      case 'file': {
        if (typeof r.path !== 'string' || !inside(outDir, r.path)) return BAD_OUTPUT;
        const abs = path.resolve(outDir, r.path);
        if (!existsSync(abs) || !statSync(abs).isFile()) return BAD_OUTPUT;
        out.push({ kind: r.kind, path: abs });
        break;
      }
      case 'table': {
        const cols = r.columns;
        if (!Array.isArray(cols) || !cols.every((c) => typeof c === 'string')) return BAD_OUTPUT;
        if (!Array.isArray(r.rows) || !r.rows.every((row) => Array.isArray(row) && row.length === cols.length && row.every(isCell))) return BAD_OUTPUT;
        out.push({ kind: 'table', columns: cols as string[], rows: r.rows as Cell[][] });
        break;
      }
      case 'json':
        if (!('data' in r)) return BAD_OUTPUT;
        out.push({ kind: 'json', data: r.data });
        break;
      case 'text':
        if (typeof r.text !== 'string') return BAD_OUTPUT;
        out.push({ kind: 'text', text: r.text, ...(typeof r.ext === 'string' ? { ext: r.ext } : {}) });
        break;
      default:
        return BAD_OUTPUT;
    }
  }
  return out;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const safeSegment = (s: string) => s.replace(/[\\/:*?"<>|\s]/g, '_') || '_';

export interface EvidenceRunnerOptions {
  config: EvidenceConfig;
  resolver: ProviderResolver;
  store: EvidenceStore;
  testId: string;
  redactor?: Redactor;
  /** Root of the per-spec output folders (default `os.tmpdir()/ddv-evidence-<pid>`). */
  tmpRoot?: string;
}

/** Position of a spec in its step. */
export interface SpecPosition {
  /** 1-based step number in the file. */
  step: number;
  seq: number;
}

const specsOf = (step: { evidence?: readonly EvidenceSpecInput[] }): EvidenceSpec[] => {
  const all = (step.evidence ?? []).map((s) => normalizeSpec(s as EvidenceSpecInput));
  return [...all.filter((s) => s.at === 'before'), ...all.filter((s) => s.at === 'after')];
};

export class EvidenceRunner implements StepEvidenceRunner {
  private readonly redactor: Redactor;
  private readonly tmpRoot: string;

  constructor(private readonly opts: EvidenceRunnerOptions) {
    this.redactor = opts.redactor ?? new Redactor([]);
    this.tmpRoot = opts.tmpRoot ?? path.join(os.tmpdir(), `ddv-evidence-${process.pid}`);
  }

  scopeOf(scenario: { steps: readonly Step[] }, plans: readonly StepPlan<Step>[]): EvidenceInputScope {
    return InputScope.of(scenario, plans);
  }

  async runAt(at: EvidenceAt, plan: StepPlan<Step>, host: EvidenceHost, scope: EvidenceInputScope): Promise<AtResult> {
    const specs = specsOf(plan.step);
    const input = scope.at(at, plan.index);
    const records: TraceEvidence[] = [];
    for (let i = 0; i < specs.length; i++) {
      if (specs[i].at !== at) continue;
      records.push(await this.captureOne(specs[i], host, input, { step: plan.index + 1, seq: i + 1 }));
    }
    return {
      records,
      failures: records.filter((r) => r.status === 'failed').map((r) => r.reason ?? ''),
      warnings: records.filter((r) => r.status === 'warn').length,
    };
  }

  skip(plan: StepPlan<Step>): TraceEvidence[] {
    return specsOf(plan.step).map((s, i) => ({ seq: i + 1, label: s.label, use: s.use, at: s.at, provider: this.opts.resolver.kindOf(s.use), status: 'skipped', durationMs: 0, files: [] }));
  }

  /** Captures one spec (CAPONE). Never throws. */
  async captureOne(spec: EvidenceSpec, host: EvidenceHost, input: ReadonlyMap<string, Scalar>, pos: SpecPosition): Promise<TraceEvidence> {
    const { resolver, config, store, testId } = this.opts;
    const t0 = Date.now();
    const base = { seq: pos.seq, label: spec.label, use: spec.use, at: spec.at, provider: resolver.kindOf(spec.use) };
    const fail = (message: string): TraceEvidence => ({
      ...base,
      status: spec.onError === 'warn' ? 'warn' : 'failed',
      reason: this.redactor.redact(`${spec.use}（${AT_LABEL[spec.at]}）— ${message}`),
      durationMs: Date.now() - t0,
      files: [],
    });
    const resolved = resolveWith(spec.with, input);
    if (!resolved.ok) return fail(resolved.message);
    const provider = resolver.resolve(spec.use);
    if (!provider) return fail(unregisteredMessage(spec.use));
    const outDir = path.join(this.tmpRoot, safeSegment(testId), `${pos.step}-${pos.seq}`);
    try {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.mkdir(outDir, { recursive: true });
      const timeout = timeoutOf(spec, provider, config);
      const ac = new AbortController();
      const hc = host.hookContext();
      const ctx: EvidenceContext = {
        platform: host.platform,
        testId,
        step: pos.step,
        at: spec.at,
        outDir,
        input: Object.fromEntries(input),
        signal: ac.signal,
        ...(hc.page ? { page: hc.page } : {}),
        ...(hc.app ? { app: hc.app } : {}),
      };
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeout);
      });
      let result: CaptureResult | 'timeout';
      try {
        result = await Promise.race([provider.capture(resolved.args, ctx, host), timedOut]);
      } catch (e) {
        return fail(errText(e));
      } finally {
        clearTimeout(timer);
      }
      if (result === 'timeout') {
        ac.abort();
        return fail(timeoutMessage(timeout));
      }
      const outputs = checkOutputs(result.outputs, outDir);
      if (typeof outputs === 'string') return fail(outputs);
      let saved;
      try {
        saved = await store.save(pos.step, pos.seq, spec.label, spec.use, outputs);
      } catch (e) {
        return fail(errText(e));
      }
      const meta = result.meta ?? {};
      const truncated = !!meta.truncated || saved.truncated;
      return {
        ...base,
        status: 'ok',
        durationMs: Date.now() - t0,
        ...(meta.db ? { db: meta.db } : {}),
        ...(truncated ? { truncated } : {}),
        ...(meta.totalRows !== undefined ? { totalRows: meta.totalRows } : {}),
        ...(meta.masked?.length ? { masked: meta.masked } : {}),
        files: saved.files,
      };
    } catch (e) {
      return fail(errText(e));
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface CreateEvidenceRunnerOptions {
  repoRoot: string;
  /** The ddv config (`evidence` is read from it). */
  config: { evidence?: unknown };
  /** `evidence` exported by e2e/ddv-hooks.ts (`{}` when none). */
  hooks?: EvidenceHooks;
  store: EvidenceStore | ((config: EvidenceConfig) => EvidenceStore);
  testId: string;
  /** When given and neither the config nor the scenario has evidence, no runner is made (REQ-810). */
  scenario?: { steps: readonly { evidence?: readonly unknown[] }[] };
  env?: NodeJS.ProcessEnv;
  connectors?: Partial<Record<DbType, DbConnector>>;
  tmpRoot?: string;
}

/** Built-in and command providers of a config. */
export function createResolver(repoRoot: string, config: EvidenceConfig, hooks: EvidenceHooks, opts: Pick<CreateEvidenceRunnerOptions, 'env' | 'connectors'> = {}): ProviderResolver {
  const builtins = new Map<string, Provider>([
    ['screenshot', new ScreenshotProvider()],
    ['db', new DbProvider({ repoRoot, config, env: opts.env, connectors: opts.connectors })],
  ]);
  const commands = new Map<string, Provider>(Object.entries(config.commands).map(([name, c]) => [name, new CommandProvider(name, c, repoRoot, config.maxBytes)]));
  return new ProviderResolver(builtins, hooks, commands);
}

export function createEvidenceRunner(opts: CreateEvidenceRunnerOptions): EvidenceRunner | undefined {
  if (opts.scenario && opts.config.evidence === undefined && !opts.scenario.steps.some((s) => s.evidence?.length)) return undefined;
  const config = evidenceConfigOf(opts.config);
  const env = opts.env ?? process.env;
  return new EvidenceRunner({
    config,
    resolver: createResolver(opts.repoRoot, config, opts.hooks ?? {}, { env, connectors: opts.connectors }),
    store: typeof opts.store === 'function' ? opts.store(config) : opts.store,
    testId: opts.testId,
    redactor: Redactor.fromConfig(config, env),
    tmpRoot: opts.tmpRoot,
  });
}
