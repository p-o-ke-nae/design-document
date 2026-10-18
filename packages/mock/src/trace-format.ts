// Browser-safe trace format shared by the recorder (Node), mock-runtime (iframe) and the viewer. No Node imports.
import type { Platform } from './platform.ts';
import type { Value } from './types.ts';

export const TRACE_VERSION = 1;
/** Request / response bodies are clipped to this many UTF-8 bytes. */
export const BODY_LIMIT = 64 * 1024;
export const TRACE_DIR_ENV = 'DDV_TRACE_DIR';

export type TraceTarget = 'mock' | 'app';
export type TraceStatus = 'passed' | 'failed';
export type ExpectKind = 'screen' | 'visible' | 'hidden' | 'text' | 'count';
export type DbChangeKind = 'added' | 'changed' | 'removed';
export type Row = Record<string, unknown>;

export interface ExpectObservation {
  kind: ExpectKind;
  /** Element key (empty for `screen`). */
  key: string;
  expected: Value | null;
  actual: Value | null;
  ok: boolean;
}

export interface ApiCall {
  method: string;
  path: string;
  /** 0 = failed (network error), -1 = not finished by the end of the step. */
  status: number;
  requestBody?: string;
  responseBody?: string;
  truncated?: boolean;
  durationMs: number;
}

export interface DbChange {
  table: string;
  kind: DbChangeKind;
  key: string;
  before?: Row;
  after?: Row;
}

export interface TraceStep {
  /** 1-based (auxiliary steps included). */
  index: number;
  /** '' for auxiliary steps. */
  event: string;
  /** Platforms of the step's `only:` (`desktop` expanded). */
  only?: Platform[];
  /** Not run on this platform (`only:`); not part of the pass / fail result. */
  skipped?: true;
  input?: Record<string, Value>;
  click?: string;
  do?: string;
  screenBefore: string | null;
  screenAfter: string | null;
  expects: ExpectObservation[];
  ok: boolean;
  error?: string;
  durationMs: number;
  calls: ApiCall[];
  /** null = not applicable (real app); [] = no change. */
  db: DbChange[] | null;
  /** `<testId>/<index>.png`, relative to the run's trace directory. */
  screenshot?: string;
}

export interface TraceFile {
  version: typeof TRACE_VERSION;
  runId: string;
  testId: string;
  title: string;
  mock: string;
  target: TraceTarget;
  /** Platform the scenario ran on (absent = web). */
  platform?: Platform;
  startedAt: string;
  durationMs: number;
  status: TraceStatus;
  /** 1-based; 0 = failed before the steps. */
  failedStep?: number;
  error?: string;
  steps: TraceStep[];
}

export interface TapResult {
  calls: ApiCall[];
  db: DbChange[];
}

/** Trace attached to `ddv:result` for the live view. */
export interface LiveStepTrace {
  screenBefore: string | null;
  calls: ApiCall[];
  db: DbChange[] | null;
  expects: ExpectObservation[];
}

const utf8 = new TextEncoder();

/** Clips `text` to `limit` UTF-8 bytes at a character boundary (detailed design: 本文の切り詰め). */
export function clipBody(text: string | null | undefined, limit = BODY_LIMIT): { body: string; truncated?: true } | undefined {
  if (text === undefined || text === null) return undefined;
  if (utf8.encode(text).length <= limit) return { body: text };
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const n = utf8.encode(ch).length;
    if (bytes + n > limit) break;
    bytes += n;
    out += ch;
  }
  return { body: out, truncated: true };
}

function keyed(rows: Row[], key: string): Map<string, Row> {
  const m = new Map<string, Row>();
  rows.forEach((r, i) => {
    const v = r?.[key];
    m.set(v === undefined || v === null ? `#${i}` : String(v), r);
  });
  return m;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Row-level differences between two DB snapshots (detailed design: DB の変化). */
export function diffTables(before: Record<string, Row[]>, after: Record<string, Row[]>, keys: Record<string, string> = {}): DbChange[] {
  const out: DbChange[] = [];
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(cmp);
  for (const table of tables) {
    const key = keys[table] ?? 'id';
    const b = keyed(before[table] ?? [], key);
    const a = keyed(after[table] ?? [], key);
    const added: DbChange[] = [];
    const changed: DbChange[] = [];
    const removed: DbChange[] = [];
    for (const [k, row] of a) {
      const prev = b.get(k);
      if (!prev) added.push({ table, kind: 'added', key: k, after: row });
      else if (JSON.stringify(prev) !== JSON.stringify(row)) changed.push({ table, kind: 'changed', key: k, before: prev, after: row });
    }
    for (const [k, row] of b) if (!a.has(k)) removed.push({ table, kind: 'removed', key: k, before: row });
    for (const g of [added, changed, removed]) out.push(...g.sort((x, y) => cmp(x.key, y.key)));
  }
  return out;
}
