// SQL Server (optional `mssql`) and PostgreSQL (optional `pg`), read-only and always rolled back.
import { rewriteSql } from '../sql-guard.ts';
import { withAbort, type DbConnector, type DbQuery, type TableResult } from './types.ts';

export const MSSQL_MISSING = 'SQL Server の証跡には mssql の導入が必要です（npm i -D mssql）';
export const PG_MISSING = 'PostgreSQL の証跡には pg の導入が必要です（npm i -D pg）';

type Loader = () => Promise<unknown>;
// Module names in variables: optional dependencies without type declarations.
const MSSQL_MODULE = 'mssql';
const PG_MODULE = 'pg';

async function load<T>(loader: Loader, missing: string): Promise<T> {
  try {
    const mod = (await loader()) as { default?: T } & T;
    return (mod.default ?? mod) as T;
  } catch {
    throw new Error(missing);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class SqlServerConnector implements DbConnector {
  constructor(private readonly loader: Loader = () => import(MSSQL_MODULE)) {}

  async query(q: DbQuery): Promise<TableResult> {
    const mssql = await load<any>(this.loader, MSSQL_MISSING);
    const pool = new mssql.ConnectionPool(q.conn);
    let req: any;
    const work = (async () => {
      await pool.connect();
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      try {
        req = new mssql.Request(tx);
        for (const p of q.params) req.input(p.name, p.value);
        return await streamRows(req, rewriteSql(q.sql, (name) => `@${name}`), q.limit);
      } finally {
        await tx.rollback().catch(() => undefined);
      }
    })();
    try {
      return await withAbort(q.signal, work, () => {
        req?.cancel();
        void pool.close().catch(() => undefined);
      });
    } finally {
      await pool.close().catch(() => undefined);
    }
  }
}

/** Streams rows and cancels the request after `limit` rows. */
function streamRows(req: any, sql: string, limit: number): Promise<TableResult> {
  return new Promise((resolve, reject) => {
    let columns: string[] = [];
    const rows: unknown[][] = [];
    let cancelled = false;
    req.stream = true;
    req.on('recordset', (cols: Record<string, { index: number; name: string }>) => {
      if (!columns.length) columns = Object.values(cols).sort((a, b) => a.index - b.index).map((c) => c.name);
    });
    req.on('row', (row: Record<string, unknown>) => {
      if (rows.length < limit) rows.push(columns.map((c) => row[c]));
      else if (!cancelled) {
        cancelled = true;
        req.cancel();
      }
    });
    req.on('error', (e: Error & { code?: string }) => {
      if (!cancelled) reject(e);
    });
    req.on('done', () => resolve({ columns, rows }));
    req.query(sql);
  });
}

export class PostgresConnector implements DbConnector {
  constructor(private readonly loader: Loader = () => import(PG_MODULE)) {}

  async query(q: DbQuery): Promise<TableResult> {
    const pg = await load<any>(this.loader, PG_MISSING);
    const client = new pg.Client({ connectionString: q.conn });
    const work = (async () => {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      try {
        const text = `SELECT * FROM (\n${rewriteSql(q.sql, (_name, n) => `$${n}`)}\n) ddv_q LIMIT ${q.limit}`;
        const r = await client.query({ text, values: q.params.map((p) => p.value), rowMode: 'array' });
        return { columns: r.fields.map((f: { name: string }) => f.name), rows: r.rows as unknown[][] };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    })();
    try {
      return await withAbort(q.signal, work, () => void client.end().catch(() => undefined));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
