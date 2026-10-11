import type { Graph, GraphNode } from './types.ts';
import { GraphBuilder, stripComment } from './parse-state.ts';

const SHAPES: Array<[string, string, GraphNode['role']]> = [
  ['(((', ')))', 'normal'],
  ['([', '])', 'normal'],
  ['[[', ']]', 'normal'],
  ['[(', ')]', 'normal'],
  ['((', '))', 'normal'],
  ['{{', '}}', 'normal'],
  ['[/', '/]', 'normal'],
  ['[\\', '\\]', 'normal'],
  ['[/', '\\]', 'normal'],
  ['[\\', '/]', 'normal'],
  ['[', ']', 'normal'],
  ['(', ')', 'normal'],
  ['{', '}', 'choice'],
  ['>', ']', 'normal'],
];

const SKIP = /^(subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr|title)\b/;

interface Cursor {
  s: string;
  i: number;
}

function skipWs(c: Cursor) {
  while (c.i < c.s.length && /\s/.test(c.s[c.i])) c.i++;
}

function unquote(t: string): string {
  const s = t.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/** Reads `id`, `id[text]`, `id{text}` ... Returns node id or null. */
function readNode(c: Cursor, b: GraphBuilder): string | null {
  skipWs(c);
  const m = /^[A-Za-z0-9_\u0080-\uffff][\w\-\u0080-\uffff.]*/.exec(c.s.slice(c.i));
  if (!m) return null;
  let id = m[0];
  // Avoid swallowing the start of an arrow like `A--B` (rare) or `A-->`.
  const dash = id.search(/-{2,}|-\./);
  if (dash > 0) id = id.slice(0, dash);
  c.i += id.length;
  for (const [open, close, role] of SHAPES) {
    if (!c.s.startsWith(open, c.i)) continue;
    let j = c.i + open.length;
    let inQuote = false;
    while (j < c.s.length) {
      if (c.s[j] === '"') inQuote = !inQuote;
      if (!inQuote && c.s.startsWith(close, j)) break;
      j++;
    }
    if (j >= c.s.length) continue;
    const text = unquote(c.s.slice(c.i + open.length, j));
    b.node(id, { label: text, role });
    c.i = j + close.length;
    break;
  }
  b.node(id);
  const cls = /^:::[\w-]+/.exec(c.s.slice(c.i));
  if (cls) c.i += cls[0].length;
  return id;
}

function readGroup(c: Cursor, b: GraphBuilder): string[] {
  const ids: string[] = [];
  const first = readNode(c, b);
  if (!first) return ids;
  ids.push(first);
  for (;;) {
    const save = c.i;
    skipWs(c);
    if (c.s[c.i] !== '&') {
      c.i = save;
      break;
    }
    c.i++;
    const n = readNode(c, b);
    if (!n) break;
    ids.push(n);
  }
  return ids;
}

/** Reads an arrow and optional label. Returns null if no arrow at cursor. */
function readArrow(c: Cursor): { label: string } | null {
  skipWs(c);
  const rest = c.s.slice(c.i);
  let m = /^<?(?:-{2,}>|-{3,}|-\.+->|-\.+-|={2,}>|={3,}|-{2,}[xo]|~~~)/.exec(rest);
  if (m) {
    c.i += m[0].length;
    skipWs(c);
    const lm = /^\|([^|]*)\|/.exec(c.s.slice(c.i));
    if (lm) {
      c.i += lm[0].length;
      return { label: unquote(lm[1]) };
    }
    return { label: '' };
  }
  m = /^<?(--|==|-\.)\s*(.+?)\s*(-{2,}>|-{3,}|\.-+>|\.-+|={2,}>|={3,})/.exec(rest);
  if (m) {
    c.i += m[0].length;
    return { label: unquote(m[2]) };
  }
  return null;
}

/** Parses the subset of Mermaid `flowchart` / `graph` used for test matrix generation. */
export function parseFlowchart(source: string): Graph {
  const b = new GraphBuilder();
  let headerSeen = false;
  for (const raw of source.split(/\r?\n/)) {
    const body = stripComment(raw, b).trim();
    if (!body) continue;
    if (!headerSeen && /^(flowchart|graph)\b/.test(body)) {
      headerSeen = true;
      continue;
    }
    if (body.startsWith('---')) continue;
    for (const stmt of body.split(';')) {
      const line = stmt.trim();
      if (!line || SKIP.test(line)) continue;
      const c: Cursor = { s: line, i: 0 };
      let left = readGroup(c, b);
      if (!left.length) {
        b.warnings.push(`解釈できない行: ${line}`);
        continue;
      }
      for (;;) {
        const arrow = readArrow(c);
        if (!arrow) break;
        const right = readGroup(c, b);
        if (!right.length) {
          b.warnings.push(`矢印の先が解釈できない行: ${line}`);
          break;
        }
        for (const f of left) for (const t of right) b.edge(f, t, arrow.label);
        left = right;
      }
      skipWs(c);
      if (c.i < c.s.length) b.warnings.push(`行末を解釈できません: ${line.slice(c.i)}`);
    }
  }
  return {
    kind: 'flowchart',
    nodes: [...b.nodes.values()],
    edges: b.edges,
    warnings: b.warnings,
    annotations: b.annotations,
  };
}
