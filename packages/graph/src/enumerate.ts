import type { Graph, GraphEdge, MatrixOptions, MatrixResult, StateEventTable, TestCase } from './types.ts';

export const DEFAULT_MATRIX_OPTIONS: MatrixOptions = { nSwitch: 1, loopLimit: 1, maxPaths: 200 };

function startNodes(g: Graph): string[] {
  const explicit = g.nodes.filter((n) => n.role === 'start').map((n) => n.id);
  if (explicit.length) return explicit;
  const incoming = new Set(g.edges.map((e) => e.to));
  const roots = g.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  return roots.length ? roots : g.nodes.slice(0, 1).map((n) => n.id);
}

function outgoing(g: Graph): Map<string, GraphEdge[]> {
  const out = new Map<string, GraphEdge[]>();
  for (const n of g.nodes) out.set(n.id, []);
  for (const e of g.edges) out.get(e.from)!.push(e);
  return out;
}

/** Shortest edge path from any start node to each reachable node (BFS). */
function shortestPrefixes(g: Graph, out: Map<string, GraphEdge[]>): Map<string, GraphEdge[]> {
  const prefix = new Map<string, GraphEdge[]>();
  const queue: string[] = [];
  for (const s of startNodes(g)) {
    prefix.set(s, []);
    queue.push(s);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of out.get(cur) ?? []) {
      if (prefix.has(e.to)) continue;
      prefix.set(e.to, [...prefix.get(cur)!, e]);
      queue.push(e.to);
    }
  }
  return prefix;
}

export function edgeTitle(g: Graph, e: GraphEdge): string {
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
  return e.label ? `${label(e.from)} --[${e.label}]--> ${label(e.to)}` : `${label(e.from)} --> ${label(e.to)}`;
}

function nodeLabel(g: Graph, id: string): string {
  return g.nodes.find((n) => n.id === id)?.label ?? id;
}

function toCase(g: Graph, kind: TestCase['kind'], signature: string, prefix: GraphEdge[], body: GraphEdge[], title: string, expected: string): TestCase {
  const all = [...prefix, ...body];
  const nodes = all.length ? [all[0].from, ...all.map((e) => e.to)] : [];
  return { kind, signature, title, edges: all.map((e) => e.index), nodes, expected };
}

export function buildStateEventTable(g: Graph): StateEventTable {
  const states = g.nodes.filter((n) => n.role === 'normal').map((n) => n.id);
  const events = [...new Set(g.edges.filter((e) => e.event && g.nodes.find((n) => n.id === e.from)?.role === 'normal').map((e) => e.event))];
  const cells: StateEventTable['cells'] = {};
  for (const s of states) {
    cells[s] = {};
    for (const ev of events) cells[s][ev] = g.edges.filter((e) => e.from === s && e.event === ev).map((e) => e.to);
  }
  return { states, events, cells };
}

export function generateMatrix(g: Graph, options: Partial<MatrixOptions> = {}): MatrixResult {
  const opt = { ...DEFAULT_MATRIX_OPTIONS, ...options };
  const warnings: string[] = [];
  const cases: TestCase[] = [];
  const out = outgoing(g);
  const prefix = shortestPrefixes(g, out);

  for (const n of g.nodes) {
    if (!prefix.has(n.id)) warnings.push(`到達不能なノード: ${n.label} (${n.id})`);
  }

  // P: all simple paths from start to end (with bounded revisits)
  const isTerminal = (id: string) => {
    const node = g.nodes.find((n) => n.id === id);
    return node?.role === 'end' || (out.get(id)?.length ?? 0) === 0;
  };
  let truncated = false;
  const paths: GraphEdge[][] = [];
  const visit = (node: string, path: GraphEdge[], counts: Map<string, number>) => {
    if (paths.length >= opt.maxPaths) {
      truncated = true;
      return;
    }
    if (isTerminal(node) && path.length) {
      paths.push(path);
      return;
    }
    for (const e of out.get(node) ?? []) {
      const c = counts.get(e.to) ?? 0;
      if (c > opt.loopLimit) continue;
      counts.set(e.to, c + 1);
      visit(e.to, [...path, e], counts);
      counts.set(e.to, c);
    }
  };
  for (const s of startNodes(g)) visit(s, [], new Map([[s, 1]]));
  if (truncated) warnings.push(`経路数が上限 ${opt.maxPaths} を超えたため打ち切りました`);
  for (const p of paths) {
    const sig = 'P:' + p.map((e) => e.key).join('>');
    const title = [nodeLabel(g, p[0].from), ...p.map((e) => (e.label ? `[${e.label}] ${nodeLabel(g, e.to)}` : nodeLabel(g, e.to)))].join(' → ');
    cases.push(toCase(g, 'P', sig, [], p, title, `${nodeLabel(g, p[p.length - 1].to)} に到達する`));
  }

  // T: every transition once (0-switch), reached via the shortest prefix.
  for (const e of g.edges) {
    const pre = prefix.get(e.from);
    if (!pre) continue;
    cases.push(toCase(g, 'T', 'T:' + e.key, pre, [e], edgeTitle(g, e), `${nodeLabel(g, e.to)} に遷移する`));
  }

  // S: N-switch coverage (sequences of N+1 consecutive transitions).
  if (opt.nSwitch > 0) {
    const seqs: GraphEdge[][] = [];
    const extend = (seq: GraphEdge[]) => {
      if (seq.length === opt.nSwitch + 1) {
        seqs.push(seq);
        return;
      }
      for (const e of out.get(seq[seq.length - 1].to) ?? []) extend([...seq, e]);
    };
    for (const e of g.edges) extend([e]);
    let count = 0;
    for (const seq of seqs) {
      const pre = prefix.get(seq[0].from);
      if (!pre) continue;
      if (++count > opt.maxPaths) {
        warnings.push(`${opt.nSwitch}スイッチの組み合わせが上限 ${opt.maxPaths} を超えたため打ち切りました`);
        break;
      }
      const title = [nodeLabel(g, seq[0].from), ...seq.map((e) => (e.label ? `[${e.label}] ${nodeLabel(g, e.to)}` : nodeLabel(g, e.to)))].join(' → ');
      cases.push(toCase(g, 'S', 'S:' + seq.map((e) => e.key).join('>'), pre, seq, title, `${nodeLabel(g, seq[seq.length - 1].to)} に遷移する`));
    }
  }

  // X: invalid transitions from the state x event table (state diagrams only).
  let table: StateEventTable | undefined;
  if (g.kind === 'state') {
    table = buildStateEventTable(g);
    for (const s of table.states) {
      for (const ev of table.events) {
        if (table.cells[s][ev].length) continue;
        const pre = prefix.get(s);
        if (!pre) continue;
        const tc = toCase(g, 'X', `X:${s}|${ev}`, pre, [], `${nodeLabel(g, s)} で [${ev}]`, `${nodeLabel(g, s)} のまま（イベント無視またはエラー）`);
        if (!tc.nodes.length) tc.nodes = [s];
        tc.state = s;
        tc.event = ev;
        cases.push(tc);
      }
    }
  }

  return { cases, table, warnings: [...g.warnings, ...warnings] };
}
