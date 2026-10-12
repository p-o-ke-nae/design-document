export type Row = Record<string, unknown>;

export interface TableDef {
  name: string;
  key: string;
}

export interface Table extends TableDef {
  rows: Row[];
  nextId: number;
}

const sameKey = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** In-memory tables for the mock API. Rows returned are copies. */
export class MemoryDb {
  private tables = new Map<string, Table>();

  /** Recreates the tables from `defs`, then layers `rows` (fixtures, in order; same key = overwritten). */
  reset(defs: TableDef[], rows: Array<Record<string, Row[]>> = []): void {
    this.tables = new Map();
    for (const d of defs) this.ensure(d.name, d.key);
    for (const fixture of rows) {
      for (const [name, list] of Object.entries(fixture ?? {})) {
        const t = this.ensure(name);
        for (const r of list ?? []) this.put(t, { ...r });
      }
    }
    for (const t of this.tables.values()) t.nextId = this.computeNextId(t);
  }

  has(table: string): boolean {
    return this.tables.has(table);
  }

  table(name: string): Table | undefined {
    return this.tables.get(name);
  }

  /** All tables (live objects; callers must copy rows they keep). */
  all(): Table[] {
    return [...this.tables.values()];
  }

  /** Creates the table (key `id`) when it does not exist. */
  ensure(name: string, key = 'id'): Table {
    let t = this.tables.get(name);
    if (!t) {
      t = { name, key, rows: [], nextId: 1 };
      this.tables.set(name, t);
    }
    return t;
  }

  list(table: string, filter: Record<string, unknown> = {}): Row[] {
    const t = this.tables.get(table);
    if (!t) return [];
    const conds = Object.entries(filter);
    return t.rows.filter((r) => conds.every(([k, v]) => String(r[k]) === String(v))).map(clone);
  }

  get(table: string, key: unknown): Row | undefined {
    const t = this.tables.get(table);
    return clone(t?.rows.find((r) => sameKey(r[t.key], key)));
  }

  /** Inserts a row; assigns `nextId` when the key is missing. A row with an existing key replaces it. */
  insert(table: string, row: Row): Row {
    const t = this.ensure(table);
    const r = { ...row };
    if (r[t.key] === undefined || r[t.key] === null || r[t.key] === '') r[t.key] = t.nextId;
    this.put(t, r);
    t.nextId = Math.max(t.nextId, this.computeNextId(t));
    return clone(r);
  }

  update(table: string, key: unknown, patch: Row): Row | undefined {
    const t = this.tables.get(table);
    const i = t ? t.rows.findIndex((r) => sameKey(r[t.key], key)) : -1;
    if (!t || i < 0) return undefined;
    t.rows[i] = { ...t.rows[i], ...patch, [t.key]: t.rows[i][t.key] };
    return clone(t.rows[i]);
  }

  remove(table: string, key: unknown): Row | undefined {
    const t = this.tables.get(table);
    const i = t ? t.rows.findIndex((r) => sameKey(r[t.key], key)) : -1;
    if (!t || i < 0) return undefined;
    return t.rows.splice(i, 1)[0];
  }

  private put(t: Table, r: Row) {
    const k = r[t.key];
    const i = k === undefined ? -1 : t.rows.findIndex((x) => sameKey(x[t.key], k));
    if (i >= 0) t.rows[i] = r;
    else {
      if (k === undefined) r[t.key] = this.computeNextId(t);
      t.rows.push(r);
    }
  }

  private computeNextId(t: Table): number {
    let max = 0;
    for (const r of t.rows) {
      const n = Number(r[t.key]);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return Math.max(max + 1, 1);
  }
}
