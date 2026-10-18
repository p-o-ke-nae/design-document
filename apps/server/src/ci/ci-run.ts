import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig } from '@ddv/core';
import { loadConfig, safeJoin } from '@ddv/core/node';
import { TRACES_DIR } from '../prune.ts';
import { RepoStateReader } from '../repo-state.ts';
import { runTests as defaultRunTests, writeEvidenceCounts, type RunRecord, type RunTestsDeps, type SnapshotOutcome } from '../runs.ts';
import { branchLimitWarning, limitEvidenceForBranch, type BranchLimits } from '@ddv/evidence/branch-limit';
import { SnapshotService, SnapshotStore, type CaptureSummary, type SnapshotEvents } from '../snapshots.ts';
import type { CiRunRecord } from './results-index.ts';

/** Values of the default Actions environment variables. */
export interface CiEnv {
  runId: string;
  runAttempt: string;
  /** GITHUB_SHA: head of the dispatched branch. */
  sha: string;
  ref: string;
  refType: string;
  actor: string;
  repository: string;
  apiUrl: string;
  token?: string;
}

export function ciEnvFrom(env: NodeJS.ProcessEnv = process.env): CiEnv {
  return {
    runId: env.GITHUB_RUN_ID ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT || '1',
    sha: env.GITHUB_SHA ?? '',
    ref: env.GITHUB_REF_NAME ?? '',
    refType: env.GITHUB_REF_TYPE ?? '',
    actor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || '',
    repository: env.GITHUB_REPOSITORY ?? '',
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    token: env.GITHUB_TOKEN || undefined,
  };
}

export const OUTSIDE_ACTIONS = 'Actions の中で実行してください（GITHUB_RUN_ID がありません）';

/** Splits `a, b,,c` into ids (blank = none). */
export function parseIds(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const short = (sha: string) => sha.slice(0, 7);

/** The parts of SnapshotService used by `ci run` (replaced in tests). */
export type SnapshotCapturer = Pick<SnapshotService, 'scenarios' | 'capture' | 'store'>;

export interface CiRunOptions {
  repoRoot: string;
  out?: string;
  ids?: string[];
  runner?: string;
  request?: string;
  sha?: string;
  /** `--evidence-max-bytes` / `--evidence-max-total` (absent = the defaults). */
  evidenceLimits?: BranchLimits;
  env: CiEnv;
  repoState?: RepoStateReader;
  runTests?: (repoRoot: string, config: DdvConfig, run: RunRecord, log: (line: string) => void, deps?: RunTestsDeps) => Promise<void>;
  /** process.platform (tests). */
  platform?: NodeJS.Platform;
  snapshots?: (repoRoot: string, config: DdvConfig) => SnapshotCapturer;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export interface CiRunOutcome {
  /** null = not run (exit code 2). */
  status: RunRecord['status'] | null;
  exitCode: 0 | 1 | 2;
  run?: CiRunRecord;
}

const sameSha = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

export const NOT_WINDOWS_SKIP = 'Windows 以外のため実行しません';

/** `ddv ci run` (DD-ACTWF-CIRUN): runs the runners and scenarios inside the workflow and writes run.json / traces / snapshots to `out`. */
export class CiRun {
  constructor(private opts: CiRunOptions) {}

  private get out() {
    return path.resolve(this.opts.out || path.join(this.opts.repoRoot, '.ddv', 'ci-out'));
  }

  async run(): Promise<CiRunOutcome> {
    const { opts } = this;
    const error = opts.error ?? ((l: string) => console.error(l));
    const print = opts.log ?? ((l: string) => console.log(l));
    if (!opts.env.runId) return this.abort(OUTSIDE_ACTIONS);
    const repoRoot = path.resolve(opts.repoRoot);
    if (!existsSync(repoRoot)) return this.abort(`リポジトリが見つかりません: ${repoRoot}`);
    if (opts.sha && !/^[0-9a-f]{4,64}$/i.test(opts.sha)) return this.abort(`--sha はコミットの SHA です: ${opts.sha}`);
    const out = this.out;
    await fs.rm(out, { recursive: true, force: true }).catch(() => {});
    let config: DdvConfig;
    try {
      config = await loadConfig(repoRoot);
    } catch (e) {
      return this.abort(`ddv.config.yaml を読めません: ${e instanceof Error ? e.message : e}`);
    }
    if (opts.runner && !config.runners.some((r) => r.name === opts.runner)) return this.abort(`ランナーがありません: ${opts.runner}`);

    const state = await (opts.repoState ?? new RepoStateReader()).read(repoRoot);
    const warnings: string[] = [];
    if (opts.sha) {
      if (opts.env.sha && !sameSha(opts.sha, opts.env.sha)) warnings.push(`ブランチの先頭（${short(opts.env.sha)}）ではなく、指定のコミット（${short(opts.sha)}）で実行しました`);
      if (state && !state.commit.toLowerCase().startsWith(opts.sha.toLowerCase())) warnings.push(`指定のコミット（${short(opts.sha)}）と実行したコミット（${short(state.commit)}）が違います`);
    }
    const request: RunRecord['request'] = { ...(opts.ids?.length ? { ids: opts.ids } : {}), ...(opts.runner ? { runner: opts.runner } : {}) };
    const run: CiRunRecord = {
      id: `${opts.env.runId}-${opts.env.runAttempt || '1'}`,
      kind: 'test',
      startedAt: new Date().toISOString(),
      status: 'running',
      request,
      runners: [],
      results: {},
      log: [],
      source: 'actions',
      actionsRunId: opts.env.runId,
      ...(opts.request ? { actionsRequest: opts.request } : {}),
      ref: opts.env.ref,
      commit: state?.commit ?? (opts.sha || opts.env.sha),
      dirty: false,
      warnings,
    };
    const log = (line: string) => {
      run.log.push(line);
      if (run.log.length > 5000) run.log.splice(0, run.log.length - 5000);
      print(line);
    };
    for (const w of warnings) log(`! ${w}`);
    try {
      const windows = (opts.platform ?? process.platform) === 'win32';
      await (opts.runTests ?? defaultRunTests)(repoRoot, config, run, log, { skip: (r) => (r.type === 'flaui' && !windows ? NOT_WINDOWS_SKIP : undefined) });
    } catch (e) {
      run.status = 'error';
      log(`! ${(e as Error).stack ?? e}`);
    }
    const capturer = (opts.snapshots ?? ((root, c) => new SnapshotService(root, () => c)))(repoRoot, config);
    const targets = await this.snapshotTargets(config, capturer, log);
    let summary: CaptureSummary | null = null;
    if (targets) summary = await this.captureSnapshots(capturer, targets, run, log);
    run.finishedAt = new Date().toISOString();
    try {
      await this.writeOut(repoRoot, run, capturer.store, summary);
    } catch (e) {
      await fs.rm(path.join(out, 'run.json'), { force: true }).catch(() => {});
      error(`出力先に書き込めませんでした: ${out}（${e instanceof Error ? e.message : e}）`);
      return { status: null, exitCode: 2 };
    }
    log(`実行 ${run.id}: ${run.status}（出力: ${out}）`);
    return { status: run.status, exitCode: run.status === 'passed' ? 0 : 1, run };
  }

  private abort(message: string): CiRunOutcome {
    (this.opts.error ?? ((l: string) => console.error(l)))(message);
    return { status: null, exitCode: 2 };
  }

  /** Scenario ids to capture, or null when nothing is captured. */
  private async snapshotTargets(config: DdvConfig, capturer: SnapshotCapturer, log: (l: string) => void): Promise<string[] | null> {
    const { runner, ids } = this.opts;
    if (runner) {
      const r = config.runners.find((x) => x.name === runner);
      if (!r || r.type !== 'playwright' || !r.scenarios) return null;
    }
    let all: string[];
    try {
      all = [...(await capturer.scenarios()).keys()];
    } catch (e) {
      log(`! シナリオを読み込めませんでした: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    const targets = ids?.length ? ids.filter((id) => all.includes(id)) : all;
    return targets.length ? targets : null;
  }

  private async captureSnapshots(capturer: SnapshotCapturer, targets: string[], run: CiRunRecord, log: (l: string) => void): Promise<CaptureSummary | null> {
    let reason = '';
    const ev: SnapshotEvents = {
      log: (l) => {
        if (l.startsWith('! ')) reason = l.slice(2);
        log(l);
      },
      event: () => {},
    };
    let summary: CaptureSummary;
    try {
      summary = await capturer.capture(this.opts.ids?.length ? targets : undefined, ev);
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
      summary = { status: 'error', scenarios: [] };
    }
    if (!summary.scenarios.length) {
      const w = `スナップショットを撮影できませんでした: ${reason || '不明なエラー'}`;
      run.warnings.push(w);
      log(`! ${w}`);
      return null;
    }
    run.snapshots = summary.scenarios.map((s): SnapshotOutcome => ({ id: s.id, status: s.status, steps: s.steps }));
    return summary;
  }

  /** run.json (last, so that a partial output has none), traces and snapshots in the layout of `.ddv/snapshots/`. */
  private async writeOut(repoRoot: string, run: CiRunRecord, store: SnapshotStore, summary: CaptureSummary | null): Promise<void> {
    const out = this.out;
    await fs.mkdir(out, { recursive: true });
    run.traces = [];
    const traceDir = safeJoin(repoRoot, `${TRACES_DIR}/${run.id}`);
    if (existsSync(traceDir)) {
      const files = (await fs.readdir(traceDir)).filter((f) => f.endsWith('.json'));
      if (files.length) {
        run.traces = files.map((f) => f.slice(0, -'.json'.length)).sort();
        await fs.mkdir(path.join(out, 'traces'), { recursive: true });
        for (const f of files) await fs.copyFile(path.join(traceDir, f), path.join(out, 'traces', f));
        await writeEvidenceCounts(traceDir, run.traces, run.results);
        // Evidence bodies (`traces/<key>/evidence/`), then the results-branch limits (evidence-trace.md「結果ブランチの大きさの上限」).
        for (const key of run.traces) {
          const ev = path.join(traceDir, key, 'evidence');
          if (existsSync(ev)) await fs.cp(ev, path.join(out, 'traces', key, 'evidence'), { recursive: true });
        }
        const w = branchLimitWarning(await limitEvidenceForBranch(path.join(out, 'traces'), this.opts.evidenceLimits));
        if (w) run.warnings.push(w);
      }
    }
    for (const s of summary?.scenarios ?? []) {
      const curDir = store.dir('current', s.id);
      if (!existsSync(path.join(curDir, 'meta.json'))) continue;
      const dest = (kind: string) => path.join(out, 'snapshots', kind, s.id);
      await fs.mkdir(dest('current'), { recursive: true });
      await fs.copyFile(path.join(curDir, 'meta.json'), path.join(dest('current'), 'meta.json'));
      const diffSteps = s.steps.filter((x) => x.status === 'Diff').map((x) => x.step);
      if (!s.steps.some((x) => x.status === 'Diff' || x.status === 'NoBase')) continue;
      for (const n of await store.stepsOf('current', s.id)) await fs.copyFile(store.current(s.id, n), path.join(dest('current'), path.basename(store.current(s.id, n))));
      if (!diffSteps.length) continue;
      await fs.mkdir(dest('diff'), { recursive: true });
      for (const n of diffSteps) if (existsSync(store.diff(s.id, n))) await fs.copyFile(store.diff(s.id, n), path.join(dest('diff'), path.basename(store.diff(s.id, n))));
      const baseDir = store.dir('baseline', s.id);
      if (existsSync(baseDir)) await fs.cp(baseDir, dest('baseline'), { recursive: true });
    }
    await fs.writeFile(path.join(out, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
  }
}
