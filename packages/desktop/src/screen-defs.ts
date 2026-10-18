// Index of the screen definitions of a WPF / WinForms project (desktop-scenario.md「画面定義の走査」). Reads files only.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export type ScreenDefKind = 'Window' | 'Page' | 'UserControl' | 'Form';

export interface ScreenDef {
  /** Path relative to the repository root (posix). */
  file: string;
  kind: ScreenDefKind;
  /** Last part of `x:Class` / the `partial class` name. */
  className: string;
  rootName?: string;
  /** x:Name / Name / AutomationId of the descendants (WinForms: `this.x.Name`). */
  names: Set<string>;
  /** Project types used inside (UserControls). */
  uses: string[];
  /** Named element → its project type (for screens that are a named UserControl in another file). */
  namedTypes: Map<string, string>;
}

export interface ScreenDefIndex {
  platform: 'wpf' | 'winforms';
  source: string;
  defs: ScreenDef[];
}

/** File access of the scan (tests can replace it). Paths are relative to the repository root (posix). */
export interface ScreenDefFs {
  /** All files below `dir` (recursive), or null when `dir` does not exist. */
  list(dir: string): Promise<string[] | null>;
  read(file: string): Promise<string | null>;
}

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs']);

export function nodeScreenDefFs(repoRoot: string): ScreenDefFs {
  return {
    async list(dir) {
      const abs = path.join(repoRoot, dir);
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isDirectory()) return null;
      const out: string[] = [];
      const walk = async (rel: string) => {
        for (const e of await fs.readdir(path.join(repoRoot, rel), { withFileTypes: true })) {
          const r = `${rel}/${e.name}`;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name.toLowerCase())) await walk(r);
          } else if (e.isFile()) out.push(r);
        }
      };
      await walk(dir.replace(/\\/g, '/').replace(/\/+$/, ''));
      return out.sort();
    },
    read: (file) => fs.readFile(path.join(repoRoot, file), 'utf8').catch(() => null),
  };
}

const NAME_ATTRS = ['x:Name', 'Name', 'AutomationProperties.AutomationId'];
const local = (tag: string) => tag.slice(tag.indexOf(':') + 1);
const prefixOf = (tag: string) => (tag.includes(':') ? tag.slice(0, tag.indexOf(':')) : '');

type XNode = Record<string, unknown>;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, allowBooleanAttributes: true, parseTagValue: false, parseAttributeValue: false, trimValues: true });

/** WPF: one `.xaml` file (null for App.xaml, ResourceDictionary and unreadable files). */
export function scanXaml(file: string, text: string): ScreenDef | null {
  if (/(^|\/)App\.xaml$/i.test(file)) return null;
  let doc: XNode[];
  try {
    doc = parser.parse(text) as XNode[];
  } catch {
    return null;
  }
  const tagOf = (n: XNode) => Object.keys(n).find((k) => k !== ':@' && k !== '#text' && !k.startsWith('?'));
  const rootNode = doc.find((n) => tagOf(n) !== undefined);
  if (!rootNode) return null;
  const rootTag = tagOf(rootNode)!;
  const attrs = (n: XNode) => (n[':@'] ?? {}) as Record<string, string>;
  const kindName = local(rootTag);
  if (kindName === 'ResourceDictionary' || kindName === 'Application') return null;
  const rootAttrs = attrs(rootNode);
  const clrPrefixes = new Set(
    Object.entries(rootAttrs)
      .filter(([k, v]) => k.startsWith('@_xmlns:') && /^clr-namespace:/.test(v) && !/;assembly=/.test(v))
      .map(([k]) => k.slice('@_xmlns:'.length)),
  );
  const nameOf = (a: Record<string, string>) => {
    for (const k of NAME_ATTRS) if (a[`@_${k}`]) return a[`@_${k}`];
    return undefined;
  };
  const names = new Set<string>();
  const uses = new Set<string>();
  const namedTypes = new Map<string, string>();
  const walk = (nodes: XNode[]) => {
    for (const n of nodes) {
      const tag = tagOf(n);
      if (!tag) continue;
      const a = attrs(n);
      for (const k of NAME_ATTRS) if (a[`@_${k}`]) names.add(a[`@_${k}`]);
      const isType = !local(tag).includes('.');
      if (isType && clrPrefixes.has(prefixOf(tag))) {
        uses.add(local(tag));
        const nm = nameOf(a);
        if (nm) namedTypes.set(nm, local(tag));
      }
      walk((n[tag] as XNode[]) ?? []);
    }
  };
  walk((rootNode[rootTag] as XNode[]) ?? []);
  const cls = rootAttrs['@_x:Class'];
  const kind: ScreenDefKind = kindName === 'Page' || kindName === 'UserControl' ? kindName : 'Window';
  return {
    file,
    kind,
    className: cls ? cls.slice(cls.lastIndexOf('.') + 1) : path.posix.basename(file).replace(/\.xaml$/i, ''),
    ...(nameOf(rootAttrs) ? { rootName: nameOf(rootAttrs) } : {}),
    names,
    uses: [...uses],
    namedTypes,
  };
}

/** WinForms: one `*.Designer.cs` and (optional) its `*.cs` for the base class. */
export function scanDesigner(file: string, text: string, codeBehind: string | null): ScreenDef | null {
  const cls = /\bpartial\s+class\s+(\w+)/.exec(text)?.[1];
  if (!cls) return null;
  const base = codeBehind ? new RegExp(`\\bpartial\\s+class\\s+${cls}\\s*:\\s*([\\w.]+)`).exec(codeBehind)?.[1] : undefined;
  const kind: ScreenDefKind = base && /(^|\.)UserControl$/.test(base) ? 'UserControl' : 'Form';
  const rootName = /\bthis\.Name\s*=\s*"([^"]*)"\s*;/.exec(text)?.[1];
  const names = new Set<string>();
  const fieldName = new Map<string, string>();
  for (const m of text.matchAll(/\bthis\.(\w+)\.Name\s*=\s*"([^"]*)"\s*;/g)) {
    names.add(m[2]);
    fieldName.set(m[1], m[2]);
  }
  const fieldType = new Map<string, string>();
  for (const m of text.matchAll(/\bthis\.(\w+)\s*=\s*new\s+([\w.]+)\s*\(/g)) fieldType.set(m[1], m[2].slice(m[2].lastIndexOf('.') + 1));
  const namedTypes = new Map<string, string>();
  for (const [f, t] of fieldType) {
    const n = fieldName.get(f);
    if (n) namedTypes.set(n, t);
  }
  return { file, kind, className: cls, ...(rootName ? { rootName } : {}), names, uses: [...new Set(fieldType.values())], namedTypes };
}

/** Scans `source` (null when it cannot be read or has no screen definitions). */
export async function scanScreenDefs(io: ScreenDefFs, source: string, platform: 'wpf' | 'winforms'): Promise<ScreenDefIndex | null> {
  const files = await io.list(source);
  if (!files) return null;
  const defs: ScreenDef[] = [];
  if (platform === 'wpf') {
    for (const f of files.filter((x) => /\.xaml$/i.test(x))) {
      const text = await io.read(f);
      const d = text === null ? null : scanXaml(f, text);
      if (d) defs.push(d);
    }
  } else {
    for (const f of files.filter((x) => /\.Designer\.cs$/i.test(x))) {
      const text = await io.read(f);
      if (text === null) continue;
      const d = scanDesigner(f, text, await io.read(f.replace(/\.Designer\.cs$/i, '.cs')));
      if (d) defs.push(d);
    }
  }
  if (!defs.length) return null;
  // uses: only project types (WinForms `new T()` also creates framework controls)
  const classes = new Set(defs.map((d) => d.className));
  for (const d of defs) {
    d.uses = d.uses.filter((u) => classes.has(u));
    for (const [n, t] of d.namedTypes) if (!classes.has(t)) d.namedTypes.delete(n);
  }
  return { platform, source, defs };
}

export type ScreenScope = { kind: 'file'; def: ScreenDef; names: Set<string> } | { kind: 'project'; names: Set<string> } | { kind: 'missing'; name: string };

/** Names of `def` and of the UserControls it uses (transitively, without cycles). */
export function scopeNames(index: ScreenDefIndex, def: ScreenDef): Set<string> {
  const byClass = new Map(index.defs.map((d) => [d.className, d]));
  const out = new Set<string>();
  const seen = new Set<ScreenDef>();
  const visit = (d: ScreenDef) => {
    if (seen.has(d)) return;
    seen.add(d);
    for (const n of d.names) out.add(n);
    for (const u of d.uses) {
      const ud = byClass.get(u);
      if (ud) visit(ud);
    }
  };
  visit(def);
  return out;
}

/**
 * Definition file of a screen (DD-DSCN-SCRFILE): title rule → whole project; otherwise the file whose rootName /
 * className is the name, else the type of a named UserControl element in another file, else missing.
 */
export function screenScope(index: ScreenDefIndex, rule: { automationId?: string; title?: string } | undefined, stateId: string): ScreenScope {
  if (rule?.title !== undefined && rule.automationId === undefined) {
    const names = new Set<string>();
    for (const d of index.defs) for (const n of d.names) names.add(n);
    return { kind: 'project', names };
  }
  const name = rule?.automationId ?? stateId;
  const own = index.defs.find((d) => d.rootName === name || d.className === name);
  if (own) return { kind: 'file', def: own, names: scopeNames(index, own) };
  for (const d of index.defs) {
    const type = d.namedTypes.get(name);
    const target = type ? index.defs.find((x) => x.className === type && x.kind === 'UserControl') : undefined;
    if (target) return { kind: 'file', def: target, names: scopeNames(index, target) };
  }
  return { kind: 'missing', name };
}
