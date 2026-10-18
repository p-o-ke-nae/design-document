// RFC 4180 CSV reading for command outputs (detailed design evidence-runner.md#外部コマンド).

/** Parses CSV (quotes, `""`, CRLF / LF). Returns null when a quote is not closed or rows have different lengths. */
export function parseCsv(text: string): { columns: string[]; rows: string[][] } | null {
  const src = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  let any = false;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      any = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
      any = true;
    } else if (c === '\r' && src[i + 1] === '\n') {
      i++;
      continue;
    } else if (c === '\n') {
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
      any = false;
    } else {
      cell += c;
      any = true;
    }
    i++;
  }
  if (quoted) return null;
  if (any || row.length) {
    row.push(cell);
    records.push(row);
  }
  if (!records.length) return null;
  const [columns, ...rows] = records;
  if (rows.some((r) => r.length !== columns.length)) return null;
  return { columns, rows };
}
