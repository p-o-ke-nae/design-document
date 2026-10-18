// Fixtures of a scenario as one JSON file for the desktop app (flaui-driver.md「fixtures のファイル」).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export class FixturesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixturesError';
  }
}

type Rows = Record<string, unknown>[];

/** Tables of one fixtures YAML (`<table>: [rows]`). */
function tablesOf(raw: unknown, name: string): Record<string, Rows> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FixturesError(`fixtures ${name} が読めません（テーブル名と行の一覧で書いてください）`);
  const out: Record<string, Rows> = {};
  for (const [table, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) throw new FixturesError(`fixtures ${name} が読めません（${table} が行の一覧ではありません）`);
    out[table] = rows as Rows;
  }
  return out;
}

/** Concatenates the rows of each table in fixtures order (later fixtures append, like the mock runtime's reset). */
export async function readFixtures(mockDir: string, names: readonly string[]): Promise<Record<string, Rows>> {
  const tables: Record<string, Rows> = {};
  for (const name of names) {
    let text: string;
    try {
      text = await fs.readFile(path.join(mockDir, 'fixtures', `${name}.yaml`), 'utf8');
    } catch {
      throw new FixturesError(`fixtures ${name} が読めません`);
    }
    let raw: unknown;
    try {
      raw = YAML.parse(text);
    } catch (e) {
      throw new FixturesError(`fixtures ${name} が読めません: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const [table, rows] of Object.entries(tablesOf(raw, name))) (tables[table] ??= []).push(...rows);
  }
  return tables;
}

/** Writes `<dir>/<scenarioId>.json` = `{ scenario, fixtures, tables }`; returns its path. */
export class FixturesWriter {
  constructor(readonly dir: string) {}

  async write(mockDir: string, scenarioId: string, names: readonly string[]): Promise<string> {
    const tables = await readFixtures(mockDir, names);
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${scenarioId.replace(/[^\w.@-]/g, '_')}.json`);
    await fs.writeFile(file, JSON.stringify({ scenario: scenarioId, fixtures: [...names], tables }, null, 2));
    return file;
  }

  async dispose(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}
