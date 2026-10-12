import { clipBody, diffTables, type ApiCall, type TapResult } from '@ddv/mock/trace-format';
import type { MemoryDb, Row } from './db.ts';

export interface RawCall {
  method: string;
  path: string;
  status: number;
  requestBody: string | null;
  responseBody: string | null;
  durationMs: number;
}

/** Records the API calls and DB changes of one step (detailed design: mock-runtime の記録). */
export class TraceTap {
  private calls: ApiCall[] = [];
  private snapshot: Map<string, Row[]> | null = null;

  /** `defaultDb` lets `window.__ddv.trace.begin()` be called without arguments (from Playwright). */
  constructor(private readonly defaultDb?: () => MemoryDb) {}

  get recording(): boolean {
    return this.snapshot !== null;
  }

  begin(db: MemoryDb | undefined = this.defaultDb?.()): void {
    if (!db) return;
    this.calls = [];
    this.snapshot = new Map(db.all().map((t) => [t.name, structuredClone(t.rows)]));
  }

  record(call: RawCall): void {
    if (!this.snapshot) return;
    const out: ApiCall = { method: call.method, path: call.path, status: call.status, durationMs: call.durationMs };
    const req = clipBody(call.requestBody);
    const res = clipBody(call.responseBody);
    if (req) out.requestBody = req.body;
    if (res) out.responseBody = res.body;
    if (req?.truncated || res?.truncated) out.truncated = true;
    this.calls.push(out);
  }

  /** Returns what was recorded since `begin` and stops recording. */
  take(db: MemoryDb | undefined = this.defaultDb?.()): TapResult {
    if (!db) return { calls: [], db: [] };
    const before = Object.fromEntries(this.snapshot ?? []);
    const tables = db.all();
    const after = Object.fromEntries(tables.map((t) => [t.name, structuredClone(t.rows)]));
    const keys = Object.fromEntries(tables.map((t) => [t.name, t.key]));
    const r: TapResult = { calls: this.calls, db: this.snapshot ? diffTables(before, after, keys) : [] };
    this.calls = [];
    this.snapshot = null;
    return r;
  }
}
