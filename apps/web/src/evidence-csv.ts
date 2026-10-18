/** Body of a `table` evidence (`.table.json`, evidence-trace.md「保存の形式」). */
export interface EvidenceTable {
  columns: string[];
  rows: unknown[][];
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of a table (evidence-trace.md「CSV への変換」): BOM, CRLF, `columns` first, RFC 4180 quoting. */
export function toCsv(t: EvidenceTable): string {
  const lines = [t.columns, ...t.rows].map((r) => r.map(cell).join(','));
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Parses a `.table.json` body; null when it is not a table. */
export function parseTable(text: string): EvidenceTable | null {
  try {
    const t = JSON.parse(text) as EvidenceTable;
    return t && Array.isArray(t.columns) && Array.isArray(t.rows) ? t : null;
  } catch {
    return null;
  }
}
