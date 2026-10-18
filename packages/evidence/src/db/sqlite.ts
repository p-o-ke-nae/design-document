// SQLite (file) and the mock's pseudo DB, run by sql.js in a worker (terminated on abort).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { TableDump } from '@ddv/mock';
import { withAbort, type DbConnector, type DbQuery, type TableResult } from './types.ts';

export const SQLITE_MAX_BYTES = 256 * 1024 * 1024;
export const SQLITE_TOO_LARGE = 'SQLite のファイルが大きすぎます';
const WORKER = new URL('./sqlite-worker.mjs', import.meta.url);

interface WorkerInput {
  bytes?: Uint8Array;
  tables?: TableDump[];
  sql: string;
  params: Array<{ name: string; value: unknown }>;
  limit: number;
}

/** Runs one query in a fresh worker; `terminate()` on abort. */
export function runInWorker(input: WorkerInput, signal: AbortSignal): Promise<TableResult> {
  const worker = new Worker(WORKER, { workerData: input });
  const work = new Promise<TableResult>((resolve, reject) => {
    worker.once('message', (m: { ok: true; columns: string[]; rows: unknown[][] } | { ok: false; message: string }) => {
      if (m.ok) resolve({ columns: m.columns, rows: m.rows });
      else reject(new Error(m.message));
      void worker.terminate();
    });
    worker.once('error', (e) => reject(e));
    worker.once('exit', (code) => reject(new Error(`SQLite のワーカーが終了しました（${code}）`)));
  });
  return withAbort(signal, work, () => void worker.terminate());
}

/** `type: sqlite`: the file is read as bytes and opened in memory (the original file is never written). */
export class SqliteConnector implements DbConnector {
  async query(q: DbQuery): Promise<TableResult> {
    const file = path.resolve(q.repoRoot, q.conn);
    const stat = await fs.stat(file);
    if (stat.size > SQLITE_MAX_BYTES) throw new Error(SQLITE_TOO_LARGE);
    const bytes = new Uint8Array(await fs.readFile(file));
    return runInWorker({ bytes, sql: q.sql, params: q.params, limit: q.limit }, q.signal);
  }
}

/** `mock`: tables of `mockTables()` loaded into an in-memory SQLite. */
export class MockConnector {
  async query(tables: TableDump[], q: Omit<DbQuery, 'conn' | 'repoRoot'>): Promise<TableResult> {
    return runInWorker({ tables, sql: q.sql, params: q.params, limit: q.limit }, q.signal);
  }
}
