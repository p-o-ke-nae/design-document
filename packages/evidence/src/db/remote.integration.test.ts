// Integration tests against real servers (CI: the `db` job's service containers). Skipped without the connection strings.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresConnector, SqlServerConnector } from './remote.ts';
import type { DbConnector, DbQuery } from './types.ts';

const PG = process.env.DDV_IT_POSTGRES;
const MSSQL = process.env.DDV_IT_SQLSERVER;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Server {
  name: string;
  conn: string | undefined;
  connector: () => DbConnector;
  /** Runs setup SQL outside the connector (committed). */
  exec: (conn: string, sql: string) => Promise<unknown[][]>;
  sleep: string;
}

// Module names in variables: pg / mssql are optional and have no type declarations installed.
const PG_MODULE = 'pg';
const MSSQL_MODULE = 'mssql';

const servers: Server[] = [
  {
    name: 'PostgreSQL',
    conn: PG,
    connector: () => new PostgresConnector(),
    exec: async (conn, sql) => {
      const pg = ((await import(PG_MODULE)) as any).default;
      const c = new pg.Client({ connectionString: conn });
      await c.connect();
      try {
        const r = await c.query({ text: sql, rowMode: 'array' });
        return (r.rows ?? []) as unknown[][];
      } finally {
        await c.end();
      }
    },
    sleep: 'SELECT pg_sleep(10) AS s',
  },
  {
    name: 'SQL Server',
    conn: MSSQL,
    connector: () => new SqlServerConnector(),
    exec: async (conn, sql) => {
      const mssql = ((await import(MSSQL_MODULE)) as any).default;
      const pool = await new mssql.ConnectionPool(conn).connect();
      try {
        const r = await pool.request().query(sql);
        return (r.recordset ?? []).map((row: Record<string, unknown>) => Object.values(row));
      } finally {
        await pool.close();
      }
    },
    sleep: "WAITFOR DELAY '00:00:10'; SELECT 1 AS s",
  },
];

const query = (conn: string, sql: string, over: Partial<DbQuery> = {}): DbQuery => ({
  conn,
  sql,
  params: [],
  limit: 100,
  signal: new AbortController().signal,
  repoRoot: process.cwd(),
  ...over,
});

for (const s of servers) {
  describe.skipIf(!s.conn)(`${s.name} の証跡（実際のサーバ）`, () => {
    const conn = s.conn!;
    beforeAll(async () => {
      await s.exec(conn, 'DROP TABLE IF EXISTS ddv_it_orders');
      await s.exec(conn, 'CREATE TABLE ddv_it_orders (id INT PRIMARY KEY, customer VARCHAR(40), amount INT)');
      await s.exec(conn, "INSERT INTO ddv_it_orders VALUES (1, 'yamada', 1200), (2, 'suzuki', 800), (3, 'tanaka', 500)");
    }, 60_000);
    afterAll(async () => {
      await s.exec(conn, 'DROP TABLE IF EXISTS ddv_it_orders');
    });

    it('引数を渡して読み、列の順と行が返る', async () => {
      const r = await s.connector().query(
        query(conn, 'SELECT id, customer FROM ddv_it_orders WHERE amount >= :min ORDER BY id', { params: [{ name: 'min', value: 800 }] }),
      );
      expect(r.columns).toEqual(['id', 'customer']);
      expect(r.rows).toEqual([
        [1, 'yamada'],
        [2, 'suzuki'],
      ]);
    });

    it('limit の行数までしか読まない', async () => {
      const r = await s.connector().query(query(conn, 'SELECT id FROM ddv_it_orders ORDER BY id', { limit: 2 }));
      expect(r.rows).toEqual([[1], [2]]);
    });

    it('書き込みは残らない（読み取り専用・ロールバック）', async () => {
      await s
        .connector()
        .query(query(conn, "UPDATE ddv_it_orders SET customer = 'x' WHERE id = 1"))
        .catch(() => undefined);
      expect(await s.exec(conn, 'SELECT customer FROM ddv_it_orders WHERE id = 1')).toEqual([['yamada']]);
    });

    it('中止すると待たずに失敗する', async () => {
      const ac = new AbortController();
      const started = Date.now();
      const p = s.connector().query(query(conn, s.sleep, { signal: ac.signal }));
      setTimeout(() => ac.abort(), 500);
      await expect(p).rejects.toThrow('中止しました');
      expect(Date.now() - started).toBeLessThan(5_000);
    }, 20_000);
  });
}
