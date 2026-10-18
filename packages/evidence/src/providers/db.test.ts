import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { EvidenceHost, TableDump } from '@ddv/mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceConfig } from '../config.ts';
import { MSSQL_MISSING, PG_MISSING, PostgresConnector, SqlServerConnector } from '../db/remote.ts';
import type { EvidenceContext } from '../index.ts';
import { DbProvider, maskColumns, missingEnvMessage, MOCK_ONLY, NO_TARGET, resolveDbTarget, SQL_EXT, SQL_ONE, undefinedDbMessage } from './db.ts';

const databases = {
  main: { type: 'sqlite', env: 'MAIN_DB', mask: ['Password'] },
  pg: { type: 'postgres', env: 'PG_URL', mask: [] },
  ms: { type: 'sqlserver', env: 'MS_URL', mask: [] },
} as unknown as EvidenceConfig['databases'];
const env = { MAIN_DB: 'data/app.db', PG_URL: 'postgres://x', MS_URL: 'Server=x' };

describe('接続先（DBTGT）', () => {
  const cfg = (defaultDatabase?: string) => ({ databases, ...(defaultDatabase ? { defaultDatabase } : {}) });

  it('[DD-EVRUN-DBTGT-P001][DD-EVRUN-DBTGT-T001][DD-EVRUN-DBTGT-T002][DD-EVRUN-DBTGT-T008][DD-EVRUN-DBTGT-T010][DD-EVRUN-DBTGT-T011] with.db が mock で実アプリなら失敗', () => {
    expect(() => resolveDbTarget('mock', 'app', cfg(), env)).toThrow(MOCK_ONLY);
  });
  it('[DD-EVRUN-DBTGT-P002][DD-EVRUN-DBTGT-T012] with.db が mock でモックなら mock', () => {
    expect(resolveDbTarget('mock', 'mock', cfg('main'), env)).toEqual({ name: 'mock' });
  });
  it('[DD-EVRUN-DBTGT-P003][DD-EVRUN-DBTGT-T013][DD-EVRUN-DBTGT-T014] 定義されていない名前は失敗', () => {
    expect(() => resolveDbTarget('nope', 'mock', cfg(), env)).toThrow(undefinedDbMessage('nope'));
  });
  it('[DD-EVRUN-DBTGT-P004][DD-EVRUN-DBTGT-T015][DD-EVRUN-DBTGT-T016] 環境変数が無い・空なら失敗', () => {
    expect(() => resolveDbTarget('main', 'app', cfg(), {})).toThrow(missingEnvMessage('main', 'MAIN_DB'));
    expect(() => resolveDbTarget('main', 'app', cfg(), { MAIN_DB: '' })).toThrow(missingEnvMessage('main', 'MAIN_DB'));
  });
  it('[DD-EVRUN-DBTGT-P005][DD-EVRUN-DBTGT-T017] その接続先（モックを対象にしても with.db を優先）', () => {
    expect(resolveDbTarget('main', 'mock', cfg(), env)).toEqual({ name: 'main', db: databases.main, conn: 'data/app.db' });
  });
  it('[DD-EVRUN-DBTGT-P006][DD-EVRUN-DBTGT-T003][DD-EVRUN-DBTGT-T004] with.db が無くモックなら mock（defaultDatabase より優先）', () => {
    expect(resolveDbTarget(undefined, 'mock', cfg('main'), env)).toEqual({ name: 'mock' });
  });
  it('[DD-EVRUN-DBTGT-P007][DD-EVRUN-DBTGT-T005][DD-EVRUN-DBTGT-T006][DD-EVRUN-DBTGT-T009] defaultDatabase が mock で実アプリなら失敗', () => {
    expect(() => resolveDbTarget(undefined, 'app', cfg('mock'), env)).toThrow(MOCK_ONLY);
  });
  it('[DD-EVRUN-DBTGT-P008] defaultDatabase が mock でモックなら mock', () => {
    // host.target が mock のときは with.db の無い指定が先に mock になるため、defaultDatabase=mock は with.db=mock と同じ経路で確かめる
    expect(resolveDbTarget('mock', 'mock', cfg('mock'), env)).toEqual({ name: 'mock' });
  });
  it('[DD-EVRUN-DBTGT-P009] defaultDatabase が定義されていなければ失敗', () => {
    expect(() => resolveDbTarget(undefined, 'app', cfg('nope'), env)).toThrow(undefinedDbMessage('nope'));
  });
  it('[DD-EVRUN-DBTGT-P010] defaultDatabase の環境変数が無ければ失敗', () => {
    expect(() => resolveDbTarget(undefined, 'app', cfg('pg'), {})).toThrow(missingEnvMessage('pg', 'PG_URL'));
  });
  it('[DD-EVRUN-DBTGT-P011] defaultDatabase の接続先', () => {
    expect(resolveDbTarget('', 'app', cfg('pg'), env)).toMatchObject({ name: 'pg', conn: 'postgres://x' });
  });
  it('[DD-EVRUN-DBTGT-P012][DD-EVRUN-DBTGT-T007] どれも無ければ失敗', () => {
    expect(() => resolveDbTarget(undefined, 'app', cfg(), env)).toThrow(NO_TARGET);
  });
});

describe('伏せる列（MASK）', () => {
  it('[DD-EVRUN-MASK-P001][DD-EVRUN-MASK-T001][DD-EVRUN-MASK-T002] 大文字小文字を区別せず一致した列を *** に', () => {
    expect(maskColumns(['id', 'EMAIL', 'pw'], [[1, 'a@x', 's'], [2, null, 't']], ['email', 'PW'])).toEqual({
      rows: [[1, '***', '***'], [2, '***', '***']],
      masked: ['EMAIL', 'pw'],
    });
  });
  it('[DD-EVRUN-MASK-P002][DD-EVRUN-MASK-T003] 一致しなければそのまま', () => {
    const rows = [[1, 'a']];
    expect(maskColumns(['id', 'name'], rows, ['email'])).toEqual({ rows, masked: [] });
  });
});

function host(target: 'mock' | 'app', tables: TableDump[] | null = null): EvidenceHost {
  return {
    platform: 'web',
    target,
    screenshot: async () => {},
    screenshotElement: async () => {},
    mockTables: async () => tables,
    hookContext: () => ({}),
  } as unknown as EvidenceHost;
}
const ctx = (signal = new AbortController().signal) => ({ platform: 'web', testId: 'T', step: 1, at: 'after', outDir: '.', input: {}, signal }) as EvidenceContext;
const config = (over: Partial<EvidenceConfig> = {}) => ({ maxRows: 2, databases, ...over }) as EvidenceConfig;

describe('db の取得', () => {
  let dir: string;
  let dbFile: string;
  let before: Buffer;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ddv-db-'));
    const require = createRequire(import.meta.url);
    const initSqlJs = require('sql.js') as (o?: unknown) => Promise<{ Database: new () => { run(s: string): void; export(): Uint8Array; close(): void } }>;
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE users (id INTEGER, name TEXT, Password TEXT); INSERT INTO users VALUES (1,'a','p1'),(2,'b','p2'),(3,'c','p3');");
    dbFile = path.join(dir, 'app.db');
    writeFileSync(dbFile, db.export());
    db.close();
    before = readFileSync(dbFile);
    writeFileSync(path.join(dir, 'q.sql'), '\uFEFFSELECT id, name FROM users WHERE id >= :min ORDER BY id');
    writeFileSync(path.join(dir, 'q.txt'), 'SELECT 1');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const provider = (over: Partial<EvidenceConfig> = {}) => new DbProvider({ repoRoot: dir, config: config(over), env: { MAIN_DB: 'app.db' } });

  it('[BD-EVICAP-SQLGUARD-P005][BD-EVICAP-SQLGUARD-T009][BD-EVICAP-SQLGUARD-T011][BD-EVICAP-SQLGUARD-S008][BD-EVICAP-SQLGUARD-S010] SQLite のファイルを読み取り専用で実行し、上限で切って列を伏せる（元のファイルは変えない）', async () => {
    const r = await provider().capture({ db: 'main', sql: 'SELECT * FROM users ORDER BY id' }, ctx(), host('app'));
    expect(r.outputs).toEqual({ kind: 'table', columns: ['id', 'name', 'Password'], rows: [[1, 'a', '***'], [2, 'b', '***']] });
    expect(r.meta).toEqual({ db: { name: 'main', type: 'sqlite' }, totalRows: 3, truncated: true, masked: ['Password'] });
    expect(readFileSync(dbFile).equals(before)).toBe(true);
  });

  it('SQL ファイル（BOM を除く）と :名前 の引数・maxRows・with.mask', async () => {
    const r = await provider().capture({ db: 'main', file: 'q.sql', params: { min: 2 }, maxRows: 5, mask: 'NAME' }, ctx(), host('app'));
    expect(r.outputs).toEqual({ kind: 'table', columns: ['id', 'name'], rows: [[2, '***'], [3, '***']] });
    expect(r.meta).toEqual({ db: { name: 'main', type: 'sqlite' }, totalRows: 2, masked: ['name'] });
  });

  it('sql と file・拡張子・引数・更新の文の検査', async () => {
    const p = provider();
    await expect(p.capture({ db: 'main' }, ctx(), host('app'))).rejects.toThrow(SQL_ONE);
    await expect(p.capture({ db: 'main', sql: 'SELECT 1', file: 'q.sql' }, ctx(), host('app'))).rejects.toThrow(SQL_ONE);
    await expect(p.capture({ db: 'main', file: 'q.txt' }, ctx(), host('app'))).rejects.toThrow(SQL_EXT);
    await expect(p.capture({ db: 'main', file: 'q.sql' }, ctx(), host('app'))).rejects.toThrow('SQL の引数 min がありません');
    await expect(p.capture({ db: 'main', sql: 'DELETE FROM users' }, ctx(), host('app'))).rejects.toThrow();
    expect(readFileSync(dbFile).equals(before)).toBe(true);
  });

  it('[BD-EVICAP-SQLGUARD-P004][BD-EVICAP-SQLGUARD-T008][BD-EVICAP-SQLGUARD-T010][BD-EVICAP-SQLGUARD-S007][BD-EVICAP-SQLGUARD-S009] mock は疑似 DB の今の表をメモリ上の SQLite で実行する', async () => {
    const tables: TableDump[] = [
      { name: 'orders', key: 'id', rows: [{ id: 'o1', total: 100, paid: true, meta: { a: 1 } }, { id: 'o2', total: 50, paid: false, meta: null }] },
      { name: 'empty', key: 'id', rows: [] },
    ] as unknown as TableDump[];
    const r = await provider().capture({ sql: 'SELECT id, total, paid, meta FROM orders WHERE total > :min ORDER BY id', params: { min: 10 } }, ctx(), host('mock', tables));
    expect(r.outputs).toEqual({ kind: 'table', columns: ['id', 'total', 'paid', 'meta'], rows: [['o1', 100, 1, '{"a":1}'], ['o2', 50, 0, null]] });
    expect(r.meta).toMatchObject({ db: { name: 'mock', type: 'mock' }, totalRows: 2 });
  });

  it('中止されたらワーカーを終わらせる', async () => {
    const ac = new AbortController();
    const rows = Array.from({ length: 2 }, (_, i) => ({ id: i }));
    const p = provider().capture(
      { sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c' },
      ctx(ac.signal),
      host('mock', [{ name: 't', key: 'id', rows }] as unknown as TableDump[]),
    );
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toThrow('中止しました');
  });
});

describe('SQL Server・PostgreSQL（読み取り専用・常にロールバック）', () => {
  const q = (signal = new AbortController().signal) => ({ conn: 'x', sql: 'SELECT id FROM t WHERE a = :a AND b = :b;', params: [{ name: 'a', value: 1 }, { name: 'b', value: 'x' }], limit: 2, signal, repoRoot: '.' });

  it('PostgreSQL は BEGIN READ ONLY → LIMIT 付きで実行 → ROLLBACK → end', async () => {
    const log: unknown[] = [];
    class Client {
      constructor(o: unknown) {
        log.push(['new', o]);
      }
      async connect() {
        log.push('connect');
      }
      async query(x: unknown) {
        log.push(x);
        if (typeof x === 'object') return { fields: [{ name: 'id' }], rows: [[1], [2]] };
        return {};
      }
      async end() {
        log.push('end');
      }
    }
    const r = await new PostgresConnector(async () => ({ default: { Client } })).query(q());
    expect(r).toEqual({ columns: ['id'], rows: [[1], [2]] });
    expect(log).toEqual([
      ['new', { connectionString: 'x' }],
      'connect',
      'BEGIN READ ONLY',
      { text: 'SELECT * FROM (\nSELECT id FROM t WHERE a = $1 AND b = $2\n) ddv_q LIMIT 2', values: [1, 'x'], rowMode: 'array' },
      'ROLLBACK',
      'end',
    ]);
  });

  it('SQL Server はトランザクションで実行し、上限で取り消して ROLLBACK', async () => {
    const log: string[] = [];
    const { EventEmitter } = await import('node:events');
    const mssql = {
      ConnectionPool: class {
        async connect() {
          log.push('connect');
        }
        async close() {
          log.push('close');
        }
      },
      Transaction: class {
        async begin() {
          log.push('begin');
        }
        async rollback() {
          log.push('rollback');
        }
      },
      Request: class extends EventEmitter {
        stream = false;
        input(n: string, v: unknown) {
          log.push(`input ${n}=${String(v)}`);
        }
        cancel() {
          log.push('cancel');
          setImmediate(() => this.emit('done'));
        }
        query(sql: string) {
          log.push(sql);
          setImmediate(() => {
            this.emit('recordset', { id: { index: 0, name: 'id' } });
            for (let i = 1; i <= 5; i++) this.emit('row', { id: i });
          });
        }
      },
    };
    const r = await new SqlServerConnector(async () => mssql).query(q());
    expect(r).toEqual({ columns: ['id'], rows: [[1], [2]] });
    expect(log).toEqual(['connect', 'begin', 'input a=1', 'input b=x', 'SELECT id FROM t WHERE a = @a AND b = @b', 'cancel', 'rollback', 'close']);
  });

  it('mssql・pg が無ければ導入を促す', async () => {
    const missing = async () => {
      throw new Error('Cannot find module');
    };
    await expect(new SqlServerConnector(missing).query(q())).rejects.toThrow(MSSQL_MISSING);
    await expect(new PostgresConnector(missing).query(q())).rejects.toThrow(PG_MISSING);
  });

  it('DbProvider は接続先の種類の connector に渡す', async () => {
    const calls: unknown[] = [];
    const fake = { query: async (x: unknown) => (calls.push(x), { columns: ['n'], rows: [[1n]] }) };
    const p = new DbProvider({ repoRoot: '.', config: config({ defaultDatabase: 'pg' }), env, connectors: { postgres: fake } });
    const r = await p.capture({ sql: 'SELECT 1 AS n' }, ctx(), host('app'));
    expect(calls[0]).toMatchObject({ conn: 'postgres://x', sql: 'SELECT 1 AS n', limit: 3 });
    expect(r.meta).toEqual({ db: { name: 'pg', type: 'postgres' }, totalRows: 1 });
  });
});
