// sql.js worker of the sqlite / mock connectors (detailed design evidence-runner.md#接続と読み取り専用).
// Plain ESM (not TypeScript) so that Node can start it as a worker without a loader.
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const value = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  return JSON.stringify(v);
};

function loadTables(db, tables) {
  for (const t of tables) {
    const cols = [];
    for (const row of t.rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
    if (!cols.length) cols.push(t.key || 'id');
    db.run(`CREATE TABLE ${quote(t.name)} (${cols.map(quote).join(', ')})`);
    if (!t.rows.length) continue;
    const stmt = db.prepare(`INSERT INTO ${quote(t.name)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const row of t.rows) stmt.run(cols.map((c) => value(row[c])));
    stmt.free();
  }
}

async function main() {
  const { bytes, tables, sql, params, limit } = workerData;
  const SQL = await initSqlJs();
  const db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  try {
    if (tables) loadTables(db, tables);
    const stmt = db.prepare(sql);
    try {
      const bind = {};
      for (const p of params) bind[`:${p.name}`] = value(p.value);
      if (params.length) stmt.bind(bind);
      const columns = stmt.getColumnNames();
      const rows = [];
      while (rows.length < limit && stmt.step()) rows.push(stmt.get());
      parentPort.postMessage({ ok: true, columns, rows });
    } finally {
      stmt.free();
    }
  } finally {
    db.close();
  }
}

main().catch((e) => parentPort.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) }));
