// Safe condition evaluator for api.yaml `when.if` (no eval / Function).
// Grammar:
//   or      := and ('||' and)*
//   and     := unary ('&&' unary)*
//   unary   := '!' unary | cmp
//   cmp     := primary (('=='|'!='|'<'|'<='|'>'|'>=') primary)?
//   primary := number | string | true | false | null | '(' or ')' | ref
//   ref     := ident ('.' ident | '[' or ']')*

export interface ExprScope {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  /** Looks up a row of `table` by its key; undefined when the table or row does not exist. */
  lookup?: (table: string, key: unknown) => Record<string, unknown> | undefined;
  hasTable?: (table: string) => boolean;
}

export interface ExprResult {
  value: boolean;
  error?: string;
}

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

class ExprError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('<>!()[].'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError('文字列が閉じていません');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (c !== '-' || !out.length || out[out.length - 1].t === 'op')) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new ExprError(`解釈できない文字です: ${c}`);
  }
  return out;
}

const ROOTS = new Set(['body', 'params', 'query']);

function isNumeric(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

/** Coerces numeric strings when compared against numbers (form values are strings). */
function coerce(a: unknown, b: unknown): [unknown, unknown] {
  if (typeof a === 'number' && isNumeric(b)) return [a, Number(b)];
  if (typeof b === 'number' && isNumeric(a)) return [Number(a), b];
  return [a, b];
}

function compare(op: string, l: unknown, r: unknown): boolean {
  const [a, b] = coerce(l, r);
  if (op === '==') return a === b || (a == null && b == null);
  if (op === '!=') return !(a === b || (a == null && b == null));
  const ok = (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');
  if (!ok) return false;
  const x = a as number | string;
  const y = b as number | string;
  if (op === '<') return x < y;
  if (op === '<=') return x <= y;
  if (op === '>') return x > y;
  return x >= y;
}

const truthy = (v: unknown) => !(v === false || v === null || v === undefined || v === 0 || v === '');

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly scope: ExprScope,
  ) {}

  parse(): unknown {
    const v = this.or();
    if (this.i < this.toks.length) throw new ExprError(`余分な字句があります: ${this.toks[this.i].v}`);
    return v;
  }

  private peekOp(...ops: string[]): string | null {
    const t = this.toks[this.i];
    return t && t.t === 'op' && ops.includes(t.v) ? t.v : null;
  }

  private expectOp(op: string) {
    if (!this.peekOp(op)) throw new ExprError(`「${op}」が必要です`);
    this.i++;
  }

  private or(): unknown {
    let v = this.and();
    while (this.peekOp('||')) {
      this.i++;
      const r = this.and();
      v = truthy(v) || truthy(r);
    }
    return v;
  }

  private and(): unknown {
    let v = this.unary();
    while (this.peekOp('&&')) {
      this.i++;
      const r = this.unary();
      v = truthy(v) && truthy(r);
    }
    return v;
  }

  private unary(): unknown {
    if (this.peekOp('!')) {
      this.i++;
      return !truthy(this.unary());
    }
    return this.cmp();
  }

  private cmp(): unknown {
    const l = this.primary();
    const op = this.peekOp('==', '!=', '<', '<=', '>', '>=');
    if (!op) return l;
    this.i++;
    return compare(op, l, this.primary());
  }

  private primary(): unknown {
    const t = this.toks[this.i];
    if (!t) throw new ExprError('式が途中で終わっています');
    if (t.t === 'num' || t.t === 'str') {
      this.i++;
      return t.v;
    }
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const v = this.or();
      this.expectOp(')');
      return v;
    }
    if (t.t === 'id') {
      this.i++;
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return this.ref(t.v);
    }
    throw new ExprError(`解釈できない字句です: ${t.v}`);
  }

  private ref(root: string): unknown {
    let cur: unknown;
    if (ROOTS.has(root)) {
      cur = root === 'body' ? this.scope.body : root === 'params' ? this.scope.params : this.scope.query;
      if (!this.peekOp('.', '[')) throw new ExprError(`${root} の項目を指定してください`);
    } else {
      if (!this.peekOp('[')) throw new ExprError(`不明な参照です: ${root}`);
      if (this.scope.hasTable && !this.scope.hasTable(root)) throw new ExprError(`表がありません: ${root}`);
      this.i++;
      const key = this.or();
      this.expectOp(']');
      cur = this.scope.lookup?.(root, key);
    }
    for (;;) {
      if (this.peekOp('.')) {
        this.i++;
        const t = this.toks[this.i++];
        if (!t || t.t !== 'id') throw new ExprError('「.」の後に項目名が必要です');
        cur = cur != null && typeof cur === 'object' ? (cur as Record<string, unknown>)[t.v] : undefined;
      } else if (this.peekOp('[')) {
        this.i++;
        const k = this.or();
        this.expectOp(']');
        cur = cur != null && typeof cur === 'object' ? (cur as Record<string, unknown>)[String(k)] : undefined;
      } else return cur;
    }
  }
}

/** Evaluates a condition. Unevaluable expressions yield `{ value: false, error }`. */
export function evalCondition(expr: string, scope: ExprScope): ExprResult {
  try {
    return { value: truthy(new Parser(tokenize(expr), scope).parse()) };
  } catch (e) {
    const msg = e instanceof ExprError ? e.message : e instanceof Error ? e.message : String(e);
    return { value: false, error: `条件式を評価できません（${expr}）: ${msg}` };
  }
}
