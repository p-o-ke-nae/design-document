import type { Graph, GraphEdge, GraphNode } from './types.ts';

export const START = '[*]start';
export const END = '[*]end';

/** Splits `event [guard] / action`. */
export function splitLabel(label: string): { event: string; guard: string; action: string } {
  const m = /^([^[/]*)(?:\[([^\]]*)\])?\s*(?:\/(.*))?$/.exec(label.trim());
  if (!m) return { event: label.trim(), guard: '', action: '' };
  return { event: (m[1] ?? '').trim(), guard: (m[2] ?? '').trim(), action: (m[3] ?? '').trim() };
}

export class GraphBuilder {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];
  warnings: string[] = [];
  annotations: Record<string, string[]> = {};
  /** Current line in the diagram code (1-based); set by the parsers. */
  line = 0;
  private keyCount = new Map<string, number>();
  private defined = new Set<string>();

  node(id: string, patch: Partial<GraphNode> = {}): GraphNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, label: id, role: 'normal' };
      if (this.line) n.line = this.line;
      this.nodes.set(id, n);
    }
    Object.assign(n, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== '')));
    return n;
  }

  /** Marks the current line as the node's definition line (the first definition wins). */
  define(id: string): void {
    if (this.defined.has(id)) return;
    this.defined.add(id);
    const n = this.node(id);
    if (this.line) n.line = this.line;
  }

  edge(from: string, to: string, label: string): GraphEdge {
    const base = `${from}|${label}|${to}`;
    const count = (this.keyCount.get(base) ?? 0) + 1;
    this.keyCount.set(base, count);
    const { event, guard, action } = splitLabel(label);
    const e: GraphEdge = {
      index: this.edges.length,
      from,
      to,
      label,
      event,
      guard,
      action,
      key: count === 1 ? base : `${base}#${count}`,
    };
    if (this.line) e.line = this.line;
    this.edges.push(e);
    return e;
  }

  annotate(line: string): boolean {
    const m = /^%%\s*req\s*:\s*(\S+)\s+(.+)$/i.exec(line.trim());
    if (!m) return false;
    const ids = m[2].split(/[\s,]+/).filter(Boolean);
    (this.annotations[m[1]] ??= []).push(...ids);
    return true;
  }
}

export function stripComment(line: string, b: GraphBuilder): string {
  const t = line.trim();
  if (t.startsWith('%%')) {
    b.annotate(t);
    return '';
  }
  return line;
}

/** Parses the subset of Mermaid `stateDiagram-v2` used for test matrix generation. */
export function parseStateDiagram(source: string): Graph {
  const b = new GraphBuilder();
  const lines = source.split(/\r?\n/);
  let depth = 0;
  let inNote = false;
  let headerSeen = false;

  const ref = (raw: string, side: 'from' | 'to'): string => {
    const id = raw.trim().replace(/:::\S+$/, '');
    if (id === '[*]') {
      if (side === 'from') {
        b.node(START, { role: 'start', label: '開始' });
        return START;
      }
      b.node(END, { role: 'end', label: '終了' });
      return END;
    }
    b.node(id);
    return id;
  };

  for (const [i, raw] of lines.entries()) {
    b.line = i + 1;
    const line = stripComment(raw, b).trim();
    if (!line) continue;
    if (!headerSeen) {
      if (/^stateDiagram(-v2)?\b/.test(line)) {
        headerSeen = true;
        continue;
      }
      if (/^---/.test(line)) continue;
    }
    if (inNote) {
      if (/^end\s+note$/i.test(line)) inNote = false;
      continue;
    }
    if (/^note\s/i.test(line)) {
      if (!line.includes(':')) inNote = true;
      continue;
    }
    if (/^(direction|classDef|class|style|accTitle|accDescr|title)\b/.test(line)) continue;
    if (line === '--') {
      b.warnings.push('並行状態（--）は未対応のため、経路は近似になります');
      continue;
    }
    if (line === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^state\s+"([^"]*)"\s+as\s+(\S+?)(\s*\{)?$/.exec(line))) {
      b.node(m[2], { label: m[1] });
      b.define(m[2]);
      if (m[3]) {
        depth++;
        b.warnings.push(`複合状態 ${m[2]} は平坦化して扱います（未対応）`);
      }
      continue;
    }
    if ((m = /^state\s+(\S+?)\s*<<(choice|fork|join)>>$/.exec(line))) {
      b.node(m[1], { role: 'choice' });
      b.define(m[1]);
      if (m[2] !== 'choice') b.warnings.push(`<<${m[2]}>> は分岐ノードとして近似します`);
      continue;
    }
    if ((m = /^state\s+(\S+?)\s*\{$/.exec(line))) {
      b.define(m[1]);
      depth++;
      b.warnings.push(`複合状態 ${m[1]} は平坦化して扱います（未対応）`);
      continue;
    }
    if ((m = /^(\S+?)\s*-->\s*(\S+?)\s*(?::\s*(.*))?$/.exec(line))) {
      const from = ref(m[1], 'from');
      const to = ref(m[2], 'to');
      b.edge(from, to, (m[3] ?? '').trim());
      continue;
    }
    if ((m = /^state\s+(\S+)$/.exec(line))) {
      b.define(m[1]);
      continue;
    }
    if ((m = /^([^\s:]+)\s*:\s*(.+)$/.exec(line))) {
      b.node(m[1], { label: m[2].trim() });
      b.define(m[1]);
      continue;
    }
    if (/^[\w.-]+$/.test(line)) {
      b.define(line);
      continue;
    }
    b.warnings.push(`解釈できない行: ${line}`);
  }
  return {
    kind: 'state',
    nodes: [...b.nodes.values()],
    edges: b.edges,
    warnings: b.warnings,
    annotations: b.annotations,
  };
}
