// Built-in `db` (detailed design evidence-runner.md#db, DBTGT・MASK).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeJoin } from '@ddv/core/node';
import type { EvidenceHost } from '@ddv/mock';
import { MOCK_DB, type DatabaseConfig, type DbType, type EvidenceConfig } from '../config.ts';
import { MockConnector, SqliteConnector } from '../db/sqlite.ts';
import { PostgresConnector, SqlServerConnector } from '../db/remote.ts';
import { toCell, type DbConnector, type TableResult } from '../db/types.ts';
import type { Cell, EvidenceContext } from '../index.ts';
import { checkSql, sqlParams } from '../sql-guard.ts';
import type { ResolvedArgs } from '../with.ts';
import type { CaptureResult, Provider } from './types.ts';

export const NO_TARGET = '接続先が決まりません（with.db か evidence.defaultDatabase を書いてください）';
export const MOCK_ONLY = 'mock の疑似 DB はモックを対象にした実行でだけ使えます';
export const SQL_EXT = 'SQL ファイルは .sql です';
export const SQL_ONE = 'sql か file のどちらか 1 つを書いてください';
export const undefinedDbMessage = (name: string) => `接続先 ${name} は定義されていません`;
export const missingEnvMessage = (name: string, env: string) => `接続先 ${name} の環境変数 ${env} がありません`;
export const MASKED = '***';

export type DbTarget = { name: typeof MOCK_DB } | { name: string; db: DatabaseConfig; conn: string };

/** Decides the database of a `db` spec (DBTGT). Throws with the message of the diagram. */
export function resolveDbTarget(withDb: unknown, hostTarget: 'mock' | 'app', config: Pick<EvidenceConfig, 'defaultDatabase' | 'databases'>, env: NodeJS.ProcessEnv): DbTarget {
  let name: string;
  if (withDb !== undefined && withDb !== '') name = String(withDb);
  else if (hostTarget === 'mock') return { name: MOCK_DB };
  else if (config.defaultDatabase !== undefined) name = config.defaultDatabase;
  else throw new Error(NO_TARGET);
  if (name === MOCK_DB) {
    if (hostTarget !== 'mock') throw new Error(MOCK_ONLY);
    return { name: MOCK_DB };
  }
  const db = config.databases[name];
  if (!db) throw new Error(undefinedDbMessage(name));
  const conn = env[db.env];
  if (!conn) throw new Error(missingEnvMessage(name, db.env));
  return { name, db, conn };
}

/** Replaces masked columns (case-insensitive) with `***` in every row (MASK). */
export function maskColumns(columns: string[], rows: Cell[][], mask: readonly string[]): { rows: Cell[][]; masked: string[] } {
  const want = new Set(mask.map((m) => m.toLowerCase()));
  const idx = columns.map((c, i) => (want.has(c.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return { rows, masked: [] };
  return { rows: rows.map((r) => r.map((v, i) => (idx.includes(i) ? MASKED : v))), masked: idx.map((i) => columns[i]) };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);

export interface DbProviderOptions {
  repoRoot: string;
  config: EvidenceConfig;
  env?: NodeJS.ProcessEnv;
  connectors?: Partial<Record<DbType, DbConnector>>;
  mock?: { query: MockConnector['query'] };
}

export class DbProvider implements Provider {
  readonly kind = 'builtin' as const;
  private readonly connectors: Record<DbType, DbConnector>;
  private readonly mock: { query: MockConnector['query'] };

  constructor(private readonly opts: DbProviderOptions) {
    this.connectors = { sqlite: new SqliteConnector(), sqlserver: new SqlServerConnector(), postgres: new PostgresConnector(), ...opts.connectors };
    this.mock = opts.mock ?? new MockConnector();
  }

  async capture(args: ResolvedArgs, ctx: EvidenceContext, host: EvidenceHost): Promise<CaptureResult> {
    const { config, repoRoot } = this.opts;
    const target = resolveDbTarget(args.db, host.target, config, this.opts.env ?? process.env);
    const sql = await this.readSql(args);
    const guard = checkSql(sql);
    if (!guard.ok) throw new Error(guard.reason);
    const values = (args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {}) as Record<string, unknown>;
    const params = sqlParams(sql).map((name) => {
      if (values[name] === undefined) throw new Error(`SQL の引数 ${name} がありません`);
      const v = values[name];
      return { name, value: Array.isArray(v) ? v.join(',') : v };
    });
    const maxRows = typeof args.maxRows === 'number' ? args.maxRows : config.maxRows;
    const q = { sql, params, limit: maxRows + 1, signal: ctx.signal };
    let result: TableResult;
    let type: string;
    let mask = strings(args.mask);
    if ('db' in target) {
      type = target.db.type;
      mask = [...mask, ...target.db.mask];
      result = await this.connectors[target.db.type].query({ ...q, conn: target.conn, repoRoot });
    } else {
      type = MOCK_DB;
      const tables = await host.mockTables();
      if (!tables) throw new Error(MOCK_ONLY);
      result = await this.mock.query(tables, q);
    }
    const truncated = result.rows.length > maxRows;
    const cells = result.rows.slice(0, maxRows).map((r) => r.map(toCell));
    const m = maskColumns(result.columns, cells, mask);
    return {
      outputs: { kind: 'table', columns: result.columns, rows: m.rows },
      meta: { db: { name: target.name, type }, totalRows: truncated ? maxRows + 1 : cells.length, ...(truncated ? { truncated } : {}), ...(m.masked.length ? { masked: m.masked } : {}) },
    };
  }

  private async readSql(args: ResolvedArgs): Promise<string> {
    const hasSql = typeof args.sql === 'string';
    const hasFile = typeof args.file === 'string';
    if (hasSql === hasFile) throw new Error(SQL_ONE);
    if (hasSql) return args.sql as string;
    const file = args.file as string;
    if (path.extname(file).toLowerCase() !== '.sql') throw new Error(SQL_EXT);
    return (await fs.readFile(safeJoin(this.opts.repoRoot, file), 'utf8')).replace(/^\uFEFF/, '');
  }
}
