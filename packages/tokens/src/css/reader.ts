import postcss, { type AtRule, type ChildNode, type Root, type Rule } from 'postcss';
import type { TokenSetConfig } from '@ddv/core';
import { dirname, joinPath, normalizePath, type TokenFs } from '../fs.ts';
import { emptyResult, sha256Hex, type ReadResult, type Token, type TokenWarning } from '../schema.ts';

const FILE_SCHEME = 'ddv://';
const ROOT_SELECTORS = new Set([':root', 'html', ':host']);
const NESTING_AT_RULES = new Set(['media', 'supports', 'layer']);
const BUILD_VALUE = /theme\(|--spacing\(/;

interface VarEntry {
  value: string;
  /** Defined by `@theme` (removed by `--*: initial`). */
  theme: boolean;
  note?: string;
  override?: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `.cls` followed by the end, `__`, `--`, `:`, `.`, `[`, a space or a combinator. */
export function classMatches(selector: string, cls: string): boolean {
  return new RegExp(`^\\.${esc(cls)}(?=$|__|--|[:.[\\s>+~])`).test(selector.trim());
}

/** `el` alone or followed by a pseudo class / element. */
export function elementMatches(selector: string, el: string): boolean {
  return new RegExp(`^${esc(el)}(?=$|:)`, 'i').test(selector.trim());
}

/** Parsed `@import` argument: url and the trailing conditions (layer, supports, media). */
export function parseImport(params: string): { url: string; conditions: string } | null {
  const m = /^\s*(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)\s*(.*)$/s.exec(params);
  if (!m) return null;
  return { url: m[2] ?? m[4], conditions: (m[5] ?? '').replace(/;$/, '').trim() };
}

const fileOf = (node: { source?: { input: { file?: string; id?: string } } }): string | undefined => {
  const f = node.source?.input.file;
  return f?.startsWith(FILE_SCHEME) ? f.slice(FILE_SCHEME.length) : f;
};
const lineOf = (node: { source?: { start?: { line: number } } }) => node.source?.start?.line;

/** Reads a `kind: css` token set (variables, `@theme`, listed classes and elements). */
export class CssReader {
  async read(set: TokenSetConfig, fs: TokenFs): Promise<ReadResult> {
    return new CssReadRun(set, fs).run();
  }
}

class CssReadRun {
  private readonly result = emptyResult();
  private readonly vars = new Map<string, VarEntry>();
  private readonly out: ChildNode[] = [];
  private packageRoot = '';

  constructor(
    private readonly set: TokenSetConfig,
    private readonly fs: TokenFs,
  ) {}

  private warn(node: ChildNode | null, message: string) {
    const w: TokenWarning = { message };
    if (node) {
      const file = fileOf(node);
      const line = lineOf(node);
      if (file) w.file = file;
      if (line) w.line = line;
    }
    this.result.warnings.push(w);
  }

  private parse(path: string, text: string): Root {
    return postcss.parse(text.replace(/\r\n?/g, '\n'), { from: FILE_SCHEME + path, map: { prev: false } });
  }

  async run(): Promise<ReadResult> {
    const entries: Array<{ path: string; text: string }> = [];
    for (const src of this.set.sources) {
      const path = normalizePath(src);
      const text = await this.fs.read(path);
      if (text === null) this.result.errors.push(`生成元のファイルを読めません: ${src}（見つからないか、読み取れません）`);
      else entries.push({ path, text });
    }
    if (this.result.errors.length) return this.result;
    for (const e of entries) {
      this.packageRoot = await this.findPackageRoot(e.path);
      this.result.sources.push({ path: e.path, sha256: await sha256Hex(e.text) });
      let root: Root;
      try {
        root = await this.inline(e.path, e.text, [e.path.toLowerCase()]);
      } catch (err) {
        this.result.errors.push(`CSS を読めません: ${e.path}（${err instanceof Error ? err.message : String(err)}）`);
        return this.result;
      }
      this.out.push(...this.collect(root.nodes, false));
    }
    this.finish();
    return this.result;
  }

  /** Directory of the first `package.json` walking up from the entry (`/` imports are resolved from there). */
  private async findPackageRoot(entry: string): Promise<string> {
    let dir = dirname(entry);
    for (;;) {
      if ((await this.fs.read(joinPath(dir, 'package.json'))) !== null) return dir;
      if (dir === '' || dir === '..' || dir.endsWith('/..')) return dirname(entry);
      dir = dirname(dir);
    }
  }

  /** Parses the file and replaces relative `@import`s with the imported nodes (`CIMPORT`). */
  async inline(path: string, text: string, chain: string[]): Promise<Root> {
    const root = this.parse(path, text);
    for (const node of [...root.nodes]) {
      if (node.type !== 'atrule' || node.name.toLowerCase() !== 'import') continue;
      const imp = parseImport(node.params);
      if (!imp || !/^(\.\/|\.\.\/|\/)/.test(imp.url)) {
        this.result.skipped++;
        node.remove();
        continue;
      }
      if (imp.conditions) {
        this.warn(node, `条件付きの @import は辿りません: ${node.params}`);
        node.remove();
        continue;
      }
      const target = imp.url.startsWith('/') ? joinPath(this.packageRoot, imp.url.slice(1)) : joinPath(dirname(path), imp.url);
      if (chain.includes(target.toLowerCase())) {
        this.warn(node, `循環して読み込んでいます: ${imp.url}`);
        node.remove();
        continue;
      }
      const sub = await this.fs.read(target);
      if (sub === null) {
        this.warn(node, `ファイルが読めません: ${imp.url}（${target}）`);
        node.remove();
        continue;
      }
      this.result.sources.push({ path: target, sha256: await sha256Hex(sub) });
      const subRoot = await this.inline(target, sub, [...chain, target.toLowerCase()]);
      node.replaceWith(subRoot.nodes);
    }
    return root;
  }

  private setVar(name: string, entry: VarEntry) {
    if (this.vars.has(name)) {
      this.result.dropped++;
      this.vars.delete(name);
    }
    this.vars.set(name, entry);
  }

  /** Classifies nodes (`CRULE`) and returns the nodes to output. */
  private collect(nodes: ChildNode[], nested: boolean): ChildNode[] {
    const kept: ChildNode[] = [];
    for (const node of nodes) {
      if (node.type === 'atrule') {
        const name = node.name.toLowerCase();
        if (name === 'theme' && !nested) this.theme(node);
        else if (NESTING_AT_RULES.has(name) && node.nodes) {
          const inner = this.collect(node.nodes, true);
          if (inner.length) {
            const clone = node.clone({ nodes: [] }) as AtRule;
            clone.append(...inner);
            kept.push(clone);
          }
        }
        continue;
      }
      if (node.type === 'rule') kept.push(...this.rule(node, nested));
    }
    return kept;
  }

  private rule(rule: Rule, nested: boolean): ChildNode[] {
    const sels = rule.selectors.map((s) => s.trim());
    const kept: ChildNode[] = [];
    if (sels.every((s) => ROOT_SELECTORS.has(s.toLowerCase()))) {
      const varDecls = rule.nodes.filter((n) => n.type === 'decl' && n.prop.startsWith('--'));
      if (nested) {
        if (varDecls.length) {
          const clone = rule.clone({ nodes: [] }) as Rule;
          clone.append(...varDecls.map((d) => d.clone()));
          kept.push(clone);
        }
      } else {
        for (const d of varDecls) if (d.type === 'decl') this.setVar(d.prop, { value: d.important ? `${d.value} !important` : d.value, theme: false });
      }
      const els = sels.filter((s) => this.set.elements.some((e) => elementMatches(s, e)));
      if (els.length) {
        const clone = rule.clone({ selectors: els }) as Rule;
        clone.each((n) => {
          if (n.type === 'decl' && n.prop.startsWith('--')) n.remove();
        });
        kept.push(this.sanitize(clone));
      }
      return kept;
    }
    const matched = sels.filter((s) => this.set.classes.some((c) => classMatches(s, c)) || this.set.elements.some((e) => elementMatches(s, e)));
    if (!matched.length) return kept;
    kept.push(this.sanitize(rule.clone({ selectors: matched }) as Rule));
    return kept;
  }

  /** Removes comments, `@apply` and values needing a build from an output rule. */
  private sanitize(rule: Rule): Rule {
    rule.walk((n) => {
      if (n.type === 'comment') n.remove();
      else if (n.type === 'atrule' && n.name.toLowerCase() === 'apply') {
        this.warn(n, `@apply は展開しません: ${rule.selector}`);
        n.remove();
      } else if (n.type === 'decl' && BUILD_VALUE.test(n.value)) {
        this.warn(n, `ビルドが必要な値です: ${rule.selector} { ${n.prop}: ${n.value} }`);
        n.remove();
      }
    });
    return rule;
  }

  /** `@theme` (`THEME`). */
  private theme(node: AtRule) {
    const mods = node.params.toLowerCase().split(/\s+/).filter(Boolean);
    if (mods.includes('reference')) return;
    const inline = mods.includes('inline');
    for (const d of node.nodes ?? []) {
      if (d.type !== 'decl') continue;
      if (d.value.trim() === 'initial' && d.prop.endsWith('*')) {
        const ns = d.prop === '--*' ? '--' : d.prop.slice(0, -1);
        for (const [k, v] of [...this.vars]) {
          if (v.theme && k.startsWith(ns)) {
            this.vars.delete(k);
            this.result.dropped++;
          }
        }
        continue;
      }
      this.setVar(d.prop, { value: d.value, theme: true, ...(inline ? { note: '@theme inline' } : {}) });
    }
  }

  private finish() {
    for (const [k, v] of Object.entries(this.set.overrides)) this.setVar(k, { value: v, theme: false, note: 'override', override: true });
    const tokens: Token[] = [...this.vars]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, v]) => ({ name, value: v.value, kind: 'css' as const, origin: v.override ? ('override' as const) : ('defined' as const), ...(v.note ? { note: v.note } : {}) }));
    const rules = this.out.map((n) => {
      n.raws.before = '';
      return n.toString();
    });
    const defined = new Set(this.vars.keys());
    const tmp = postcss.root();
    for (const n of this.out) tmp.append(n.clone());
    tmp.walkDecls((d) => {
      if (d.prop.startsWith('--')) defined.add(d.prop);
    });
    const missing = new Set<string>();
    for (const text of [...tokens.map((t) => t.value), ...rules]) {
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) if (!defined.has(m[1])) missing.add(m[1]);
    }
    for (const name of [...missing].sort()) this.warn(null, `未定義の変数を参照しています（overrides で値を与えてください）: ${name}`);
    this.result.tokens = tokens;
    this.result.rules = rules;
  }
}
