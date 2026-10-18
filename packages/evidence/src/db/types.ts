// DB connectors (detailed design evidence-runner.md#接続と読み取り専用).
import type { Cell } from '../index.ts';

export interface DbQuery {
  /** Connection string (sqlite: file path; relative to `repoRoot`). */
  conn: string;
  /** Checked SQL with `:name` parameters. */
  sql: string;
  /** Values by parameter name, in `sqlParams` order. */
  params: Array<{ name: string; value: unknown }>;
  /** Rows to read at most (`maxRows + 1`). */
  limit: number;
  signal: AbortSignal;
  repoRoot: string;
}

export interface TableResult {
  columns: string[];
  rows: unknown[][];
}

export interface DbConnector {
  query(q: DbQuery): Promise<TableResult>;
}

/** Value of a cell (dates → ISO 8601, binaries → `<binary n bytes>`, bigint → string). */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) return `<binary ${v.byteLength} bytes>`;
  if (v instanceof ArrayBuffer) return `<binary ${v.byteLength} bytes>`;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export const abortError = () => new Error('中止しました');

/** Rejects when `signal` aborts (after running `onAbort`). */
export function withAbort<T>(signal: AbortSignal, work: Promise<T>, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}
