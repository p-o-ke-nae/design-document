// Browser-safe: evidence counts of a trace (evidence-trace.md#構造).
import type { TraceFile, TraceStep } from '@ddv/mock/trace-format';

export interface EvidenceCounts {
  /** Records other than `skipped`. */
  evidence: number;
  /** `warn` and `failed` records. */
  evidenceWarnings: number;
}

/** Totals over all steps of the trace. */
export function evidenceCounts(trace: Pick<TraceFile, 'steps'> | { steps?: Array<Pick<TraceStep, 'evidence'>> }): EvidenceCounts {
  let evidence = 0;
  let evidenceWarnings = 0;
  for (const s of trace.steps ?? []) {
    for (const e of s.evidence ?? []) {
      if (e.status !== 'skipped') evidence++;
      if (e.status === 'warn' || e.status === 'failed') evidenceWarnings++;
    }
  }
  return { evidence, evidenceWarnings };
}

/** The `CaseResult` fields: absent when there is no evidence (run-record.md「構造」). */
export function evidenceResultFields(trace: Parameters<typeof evidenceCounts>[0]): Partial<EvidenceCounts> {
  const c = evidenceCounts(trace);
  if (!c.evidence && !c.evidenceWarnings) return {};
  return { ...(c.evidence ? { evidence: c.evidence } : {}), ...(c.evidenceWarnings ? { evidenceWarnings: c.evidenceWarnings } : {}) };
}
