// SELECT-only check of SQL (detailed design evidence-runner.md#sql-の検査). Shared by lint and the runner. Browser-safe.

export const FORBIDDEN_WORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL',
  'COPY', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REPLACE', 'UPSERT', 'LOCK', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'DECLARE',
] as const;

export type GuardResult = { ok: true } | { ok: false; reason: string };

interface Lexed {
  /** Words (upper case) per statement, outside strings / quoted names / comments. */
  statements: string[][];
  /** `:name` parameters in order of appearance (no duplicates). */
  params: string[];
  /** Positions of the `:name` parameters (`start` at the colon, `end` exclusive). */
  paramSpans: Array<{ start: number; end: number; name: string }>;
  /** Positions of `;` in the normal state. */
  semicolons: number[];
  unclosed: boolean;
}

const WORD = /[A-Za-z0-9_]/;

function lex(sql: string): Lexed {
  const statements: string[][] = [[]];
  const params: string[] = [];
  const paramSpans: Lexed['paramSpans'] = [];
  const semicolons: number[] = [];
  type State = 'normal' | 'str' | 'quoted' | 'line' | 'block';
  let state: State = 'normal';
  let close = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (state === 'str') {
      if (c === "'" && n === "'") i += 2;
      else {
        if (c === "'") state = 'normal';
        i++;
      }
      continue;
    }
    if (state === 'quoted') {
      if (c === close) state = 'normal';
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'normal';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'normal';
        i += 2;
      } else i++;
      continue;
    }
    if (c === "'") {
      state = 'str';
      i++;
    } else if (c === '"' || c === '[') {
      state = 'quoted';
      close = c === '"' ? '"' : ']';
      i++;
    } else if (c === '-' && n === '-') {
      state = 'line';
      i += 2;
    } else if (c === '/' && n === '*') {
      state = 'block';
      i += 2;
    } else if (c === ';') {
      semicolons.push(i);
      statements.push([]);
      i++;
    } else if (c === ':' && n === ':') {
      i += 2;
      while (i < sql.length && WORD.test(sql[i])) i++;
    } else if (c === ':' && n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = i + 1;
      while (j < sql.length && WORD.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (!params.includes(name)) params.push(name);
      paramSpans.push({ start: i, end: j, name });
      i = j;
    } else if (WORD.test(c)) {
      let j = i;
      while (j < sql.length && WORD.test(sql[j])) j++;
      statements[statements.length - 1].push(sql.slice(i, j).toUpperCase());
      i = j;
    } else i++;
  }
  return { statements: statements.filter((s) => s.length > 0), params, paramSpans, semicolons, unclosed: state === 'str' || state === 'quoted' || state === 'block' };
}

/** Checks that `sql` is one SELECT / WITH statement without update or definition words (SQLGUARD). */
export function checkSql(sql: string): GuardResult {
  const l = lex(sql);
  if (l.unclosed) return { ok: false, reason: 'SQL の文字列かコメントが閉じていません' };
  if (l.statements.length > 1) return { ok: false, reason: '複数の文は実行しない' };
  const words = l.statements[0] ?? [];
  if (words[0] !== 'SELECT' && words[0] !== 'WITH') return { ok: false, reason: 'SELECT 以外の文は実行しない' };
  const bad = words.find((w) => (FORBIDDEN_WORDS as readonly string[]).includes(w));
  if (bad) return { ok: false, reason: `読み取りでない文は実行しない（${bad}）` };
  return { ok: true };
}

/** `:name` parameters outside strings / comments (`::type` casts excluded), in order, unique. */
export function sqlParams(sql: string): string[] {
  return lex(sql).params;
}

/**
 * Rewrites a checked SQL for a driver: `;` outside strings / comments are removed and each `:name` is replaced by
 * `param(name, n)` (`n` = 1-based position of the name in `sqlParams`).
 */
export function rewriteSql(sql: string, param: (name: string, n: number) => string): string {
  const l = lex(sql);
  const cuts = [...l.paramSpans.map((s) => ({ ...s, text: param(s.name, l.params.indexOf(s.name) + 1) })), ...l.semicolons.map((i) => ({ start: i, end: i + 1, text: '' }))].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const c of cuts) {
    out += sql.slice(at, c.start) + c.text;
    at = c.end;
  }
  return out + sql.slice(at);
}

export const SqlGuard = { check: checkSql, params: sqlParams, rewrite: rewriteSql };
