import { EventEmitter } from 'node:events';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig } from '@ddv/core';
import { safeJoin } from '@ddv/core/node';
import { idPattern, scanTestLinks, type TestLink } from '@ddv/testid';
import { executeRunner, type CaseResult } from './runner.ts';

export interface RunRequest {
  ids?: string[];
  runner?: string;
}

export type RunKind = 'test' | 'snapshot' | 'deps';

export interface RunEvent {
  event: string;
  data: string;
}

/** Given to task runs (e.g. snapshots) to report progress through the run's SSE stream. */
export interface TaskHandle {
  runId: string;
  log(line: string): void;
  event(name: string, data: unknown): void;
}

export interface RunRecord {
  id: string;
  /** Absent in older records = test. */
  kind?: RunKind;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  request: RunRequest;
  runners: Array<{ name: string; command: string; exitCode: number | null; error?: string }>;
  results: Record<string, CaseResult>;
  log: string[];
  /** Custom SSE events of task runs (replayed to late subscribers). */
  events?: RunEvent[];
}

export const RUNS_DIR = '.ddv/runs';

export class RunManager extends EventEmitter {
  runs = new Map<string, RunRecord>();
  active: RunRecord | null = null;

  constructor(
    private repoRoot: string,
    private getConfig: () => DdvConfig,
  ) {
    super();
  }

  async load(): Promise<void> {
    const dir = safeJoin(this.repoRoot, RUNS_DIR);
    if (!existsSync(dir)) return;
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as RunRecord;
        if (r.status === 'running') r.status = 'error';
        this.runs.set(r.id, r);
      } catch {
        /* ignore broken files */
      }
    }
  }

  /** Test runs, newest first (task runs such as snapshots are kept in memory only and not listed). */
  list(): RunRecord[] {
    return [...this.runs.values()].filter((r) => (r.kind ?? 'test') === 'test').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Latest result per test id (most recent run that produced a result for it). */
  latest(): Record<string, CaseResult & { runId: string; at: string }> {
    const out: Record<string, CaseResult & { runId: string; at: string }> = {};
    for (const r of this.list().reverse()) for (const [id, res] of Object.entries(r.results)) out[id] = { ...res, runId: r.id, at: r.finishedAt ?? r.startedAt };
    return out;
  }

  private async save(r: RunRecord) {
    const dir = safeJoin(this.repoRoot, RUNS_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${r.id}.json`), JSON.stringify(r, null, 2), 'utf8');
  }

  start(req: RunRequest): RunRecord {
    if (this.active) throw new Error('別のテスト実行が進行中です');
    const now = new Date();
    const id = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 6);
    const run: RunRecord = { id, kind: 'test', startedAt: now.toISOString(), status: 'running', request: req, runners: [], results: {}, log: [] };
    this.runs.set(id, run);
    this.active = run;
    void this.execute(run);
    return run;
  }

  private tasks = new Map<RunKind, RunRecord>();

  activeTask(kind: RunKind): RunRecord | null {
    return this.tasks.get(kind) ?? null;
  }

  /** Starts a non-test run (one per kind at a time). Progress goes to the same SSE stream (`log`, custom events, `end`). */
  startTask(kind: Exclude<RunKind, 'test'>, request: RunRequest, exec: (h: TaskHandle) => Promise<RunRecord['status']>): RunRecord {
    if (this.tasks.has(kind)) throw new Error(kind === 'snapshot' ? '別のスナップショット撮影が進行中です' : kind === 'deps' ? '依存の導入が進行中です' : `別の ${kind} 実行が進行中です`);
    const now = new Date();
    const id = `${kind}-` + now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 6);
    const run: RunRecord = { id, kind, startedAt: now.toISOString(), status: 'running', request, runners: [], results: {}, log: [], events: [] };
    this.runs.set(id, run);
    this.tasks.set(kind, run);
    const handle: TaskHandle = {
      runId: id,
      log: (line) => this.log(run, line),
      event: (name, data) => {
        const ev = { event: name, data: typeof data === 'string' ? data : JSON.stringify(data) };
        run.events!.push(ev);
        this.emit('event', id, ev);
      },
    };
    void (async () => {
      try {
        run.status = await exec(handle);
      } catch (e) {
        run.status = 'error';
        this.log(run, `! ${e instanceof Error ? e.message : String(e)}`);
      }
      run.finishedAt = new Date().toISOString();
      if (this.tasks.get(kind) === run) this.tasks.delete(kind);
      this.emit('end', run.id, run);
    })();
    return run;
  }

  private log(run: RunRecord, line: string) {
    run.log.push(line);
    if (run.log.length > 5000) run.log.splice(0, run.log.length - 5000);
    this.emit('log', run.id, line);
  }

  private async execute(run: RunRecord) {
    const config = this.getConfig();
    try {
      const links: TestLink[] = await scanTestLinks(this.repoRoot, config);
      const idRe = idPattern(Object.values(config.idPrefix));
      const requested = run.request.ids?.length ? run.request.ids : null;
      const runners = config.runners.filter((r) => !run.request.runner || r.name === run.request.runner);
      for (const r of runners) {
        let ids: string[] | null = null;
        if (requested) {
          ids = [...new Set(links.filter((l) => l.runner === r.name && requested.includes(l.id)).map((l) => l.id))];
          if (!ids.length) continue;
        }
        this.log(run, `── ${r.name} (${r.type}, ${r.level}) ──`);
        const res = await executeRunner(this.repoRoot, r, ids, links, idRe, (l) => this.log(run, l));
        run.runners.push({ name: r.name, command: res.command, exitCode: res.exitCode, error: res.error });
        if (res.error) this.log(run, `! ${res.error}`);
        Object.assign(run.results, res.results);
        const startFailed = res.error ?? (res.exitCode === null && !Object.keys(res.results).length ? 'プロセスを起動できませんでした' : undefined);
        if (startFailed) {
          const message = `ランナー ${r.name} を起動できませんでした: ${startFailed}`;
          const failedIds = ids ?? [...new Set(links.filter((l) => l.runner === r.name).map((l) => l.id))];
          for (const id of failedIds) run.results[id] ??= { status: 'error', durationMs: 0, message, runner: r.name, test: '' };
        }
      }
      if (requested) {
        for (const id of requested) {
          if (!run.results[id]) run.results[id] = { status: 'error', durationMs: 0, message: '紐づくテストが無いか、結果が見つかりませんでした', runner: '', test: '' };
        }
      }
      const statuses = Object.values(run.results).map((r) => r.status);
      const runnerFailed = run.runners.some((r) => r.error || r.exitCode === null);
      run.status = runnerFailed || statuses.includes('error') ? (statuses.includes('failed') ? 'failed' : 'error') : statuses.includes('failed') ? 'failed' : 'passed';
      if (!run.runners.length) {
        run.status = 'error';
        this.log(run, '! 実行対象のランナーがありません');
      }
    } catch (e) {
      run.status = 'error';
      this.log(run, `! ${(e as Error).stack ?? e}`);
    }
    run.finishedAt = new Date().toISOString();
    try {
      await this.save(run);
    } catch (e) {
      this.log(run, `! 実行結果を保存できませんでした: ${(e as Error).message}`);
    }
    // Release before notifying so listeners can start the next run immediately.
    if (this.active === run) this.active = null;
    this.emit('end', run.id, run);
  }
}
