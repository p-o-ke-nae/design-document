import type { DdvConfig } from '@ddv/core';
import { TRACE_VERSION, type TraceFile } from '@ddv/mock/browser';
import { idPattern } from '@ddv/testid/core';
import { TraceError } from './errors.ts';
import type { LocalRuns, RunRecord } from './history.ts';
import type { RepoReader } from './repo-reader.ts';

export { TraceError };

export const TRACES_DIR = '.ddv/traces';

export type NoTraceReason = 'unknownRun' | 'notInRun' | 'beforeTrace' | 'pruned' | 'aborted' | 'notRecorded';

export const NO_TRACE_MESSAGE: Record<NoTraceReason, string> = {
  unknownRun: 'この実行の記録はありません（保持件数を超えて削除されました）',
  notInRun: 'この実行ではこのテストを実行していません',
  beforeTrace: 'トレースの導入前の実行です',
  pruned: 'トレースは保持件数を超えたため削除されました',
  aborted: '実行が途中で止まったため、トレースはありません（ランナーの起動失敗など）',
  notRecorded: 'このテストのトレースは記録されていません（シナリオの E2E ではないか、記録を有効にせずに実行しました）',
};

export type TraceRead = { ok: true; trace: TraceFile & { commit?: string; dirty?: boolean } } | { ok: false; reason: NoTraceReason };

const RUN_ID = /^[0-9A-Za-z-]{1,64}$/;

/** Reads the traces under `.ddv/traces/<runId>/` (detailed design: トレースの読み込み). */
export class TraceService {
  constructor(
    private readonly reader: RepoReader,
    private readonly runs: Pick<LocalRuns, 'list'> & { get?(id: string): RunRecord | undefined },
    private readonly getConfig: () => DdvConfig,
  ) {}

  private validate(runId: string, testId: string): void {
    const re = idPattern(Object.values(this.getConfig().idPrefix));
    const m = testId.match(re);
    if (!RUN_ID.test(runId) || !m || m[0] !== testId) throw new TraceError(400, 'invalid-id', '実行ID またはテストID の形式が不正です');
  }

  private run(runId: string): RunRecord | undefined {
    return this.runs.get ? this.runs.get(runId) : this.runs.list().find((r) => r.id === runId);
  }

  /** Whether the trace file still exists (no validation of the ids beyond the path). */
  async exists(runId: string, testId: string): Promise<boolean> {
    try {
      return await this.reader.exists(`${TRACES_DIR}/${runId}/${testId}.json`);
    } catch {
      return false;
    }
  }

  async read(runId: string, testId: string): Promise<TraceRead> {
    this.validate(runId, testId);
    const run = this.run(runId);
    if (!run) return { ok: false, reason: 'unknownRun' };
    const res = run.results[testId];
    if (!res) return { ok: false, reason: 'notInRun' };
    if (!run.traces) return { ok: false, reason: 'beforeTrace' };
    if (!run.traces.includes(testId)) return { ok: false, reason: res.status === 'error' ? 'aborted' : 'notRecorded' };
    let trace: TraceFile;
    try {
      trace = JSON.parse(await this.reader.readText(`${TRACES_DIR}/${runId}/${testId}.json`)) as TraceFile;
    } catch {
      return { ok: false, reason: 'pruned' };
    }
    if (!trace || trace.version !== TRACE_VERSION) throw new TraceError(500, 'trace-version', 'トレースの形式が古いか新しすぎます');
    return { ok: true, trace: { ...trace, ...(run.commit !== undefined ? { commit: run.commit } : {}), ...(run.dirty !== undefined ? { dirty: run.dirty } : {}) } };
  }

  /** PNG bytes of step `n`'s screenshot, or null when it does not exist. */
  async screenshot(runId: string, testId: string, n: number): Promise<Uint8Array | null> {
    this.validate(runId, testId);
    if (!Number.isInteger(n) || n < 1) return null;
    const p = `${TRACES_DIR}/${runId}/${testId}/${n}.png`;
    try {
      if (!(await this.reader.exists(p))) return null;
      return await this.reader.readBinary(p);
    } catch {
      return null;
    }
  }
}
