// Static reading of `export const evidence` in e2e/ddv-hooks.ts (detailed design evidence-spec.md#hooks-の静的な読み取り).
// The file is parsed (syntax tree only), never executed.
import ts from 'typescript';
import type { ParamDef } from './config.ts';
import type { Scalar } from './spec.ts';

export type ProviderKind = 'builtin' | 'hooks' | 'command';

export interface ProviderInfo {
  name: string;
  kind: ProviderKind;
  params: Record<string, ParamDef>;
  /** false = the params could not be read statically (required params are not checked). */
  paramsKnown: boolean;
  timeout?: number;
  /** `builtin`, the hooks file or the config file. */
  source: string;
}

export interface HooksScan {
  /** `export const evidence` exists. */
  found: boolean;
  /** The names could be read (found and the initializer is an object literal). */
  readable: boolean;
  providers: ProviderInfo[];
  warnings: string[];
}

export const DEFAULT_HOOKS_FILE = 'e2e/ddv-hooks.ts';
export const HOOKS_UNREADABLE = 'hooks の evidence を読めません。名前と引数の検査を省きます';

/** Removes `satisfies X`, `as X`, `<X>` and parentheses around an expression. */
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  for (;;) {
    if (ts.isSatisfiesExpression(x) || ts.isAsExpression(x) || ts.isParenthesizedExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
    else return x;
  }
}

function keyOf(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function literal(e: ts.Expression): Scalar | undefined {
  const x = unwrap(e);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
  if (ts.isNumericLiteral(x)) return Number(x.text.replace(/_/g, ''));
  if (x.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (x.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand)) return -Number(x.operand.text.replace(/_/g, ''));
  return undefined;
}

function prop(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) if (ts.isPropertyAssignment(p) && keyOf(p.name) === key) return p.initializer;
  return undefined;
}

const isDefineEvidence = (e: ts.Expression) =>
  (ts.isIdentifier(e) && e.text === 'defineEvidence') || (ts.isPropertyAccessExpression(e) && e.name.text === 'defineEvidence');

function readParams(obj: ts.ObjectLiteralExpression): Record<string, ParamDef> {
  const params: Record<string, ParamDef> = {};
  for (const p of obj.properties) {
    const key = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? keyOf(p.name) : undefined;
    if (key === undefined) continue;
    const def: ParamDef = { required: false };
    const v = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined;
    if (v && ts.isObjectLiteralExpression(v)) {
      const req = prop(v, 'required');
      if (req && literal(req) === true) def.required = true;
      const d = prop(v, 'default');
      const dv = d ? literal(d) : undefined;
      if (dv !== undefined) def.default = dv;
    }
    params[key] = def;
  }
  return params;
}

/** Reads the providers of `export const evidence = { ... }` (HOOKSCAN). `source` is the file name for `ProviderInfo.source`. */
export function scanEvidenceHooks(text: string, source = DEFAULT_HOOKS_FILE): HooksScan {
  const sf = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let init: ts.Expression | undefined;
  let found = false;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === 'evidence') {
        found = true;
        init = d.initializer;
      }
    }
  }
  if (!found) return { found: false, readable: false, providers: [], warnings: [] };
  const obj = init ? unwrap(init) : undefined;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return { found: true, readable: false, providers: [], warnings: [HOOKS_UNREADABLE] };
  const providers: ProviderInfo[] = [];
  const warnings: string[] = [];
  for (const p of obj.properties) {
    const name = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p) ? keyOf(p.name) : undefined;
    if (name === undefined) {
      warnings.push(`hooks の evidence に名前を読めないプロパティがあります（${sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1} 行目）`);
      continue;
    }
    const info: ProviderInfo = { name, kind: 'hooks', params: {}, paramsKnown: false, source };
    const v = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined;
    if (v && ts.isCallExpression(v) && isDefineEvidence(v.expression) && v.arguments[0] && ts.isObjectLiteralExpression(unwrap(v.arguments[0]))) {
      const def = unwrap(v.arguments[0]) as ts.ObjectLiteralExpression;
      const t = prop(def, 'timeout');
      const tv = t ? literal(t) : undefined;
      if (typeof tv === 'number') info.timeout = tv;
      const params = prop(def, 'params');
      const po = params ? unwrap(params) : undefined;
      if (po && ts.isObjectLiteralExpression(po)) {
        info.params = readParams(po);
        info.paramsKnown = true;
      }
    }
    providers.push(info);
  }
  return { found: true, readable: true, providers, warnings };
}
