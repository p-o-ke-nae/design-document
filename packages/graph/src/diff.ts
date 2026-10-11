import type { Graph } from './types.ts';

export type DiffStatus = 'added' | 'removed' | 'changed';

export interface DiffItem {
  type: 'node' | 'edge';
  status: DiffStatus;
  /** node id or `from->to` */
  key: string;
  before?: string;
  after?: string;
  /** Requirement ids from `%% req:` annotations of either side. */
  reqs: string[];
}

export interface GraphDiff {
  items: DiffItem[];
  /** Node ids / edge indexes on each side, for highlighting. */
  before: { nodes: Record<string, DiffStatus>; edges: Record<number, DiffStatus> };
  after: { nodes: Record<string, DiffStatus>; edges: Record<number, DiffStatus> };
  /** Corresponding elements on both sides (unchanged and changed), for hover linking. */
  pairs: { nodes: string[]; edges: { before: number; after: number }[] };
}

/** Compares an As-Is graph with a To-Be graph. Nodes match by id, edges by `from->to`. */
export function diffGraphs(before: Graph, after: Graph): GraphDiff {
  const items: DiffItem[] = [];
  const res: GraphDiff = { items, before: { nodes: {}, edges: {} }, after: { nodes: {}, edges: {} }, pairs: { nodes: [], edges: [] } };
  const reqs = (key: string) => [...new Set([...(before.annotations[key] ?? []), ...(after.annotations[key] ?? [])])];

  const bNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const aNodes = new Map(after.nodes.map((n) => [n.id, n]));
  for (const [id, n] of aNodes) {
    const old = bNodes.get(id);
    if (old) res.pairs.nodes.push(id);
    if (!old) {
      items.push({ type: 'node', status: 'added', key: id, after: n.label, reqs: reqs(id) });
      res.after.nodes[id] = 'added';
    } else if (old.label !== n.label) {
      items.push({ type: 'node', status: 'changed', key: id, before: old.label, after: n.label, reqs: reqs(id) });
      res.after.nodes[id] = 'changed';
      res.before.nodes[id] = 'changed';
    }
  }
  for (const [id, n] of bNodes) {
    if (!aNodes.has(id)) {
      items.push({ type: 'node', status: 'removed', key: id, before: n.label, reqs: reqs(id) });
      res.before.nodes[id] = 'removed';
    }
  }

  const group = (g: Graph) => {
    const m = new Map<string, typeof g.edges>();
    for (const e of g.edges) {
      const k = `${e.from}->${e.to}`;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  };
  const bEdges = group(before);
  const aEdges = group(after);
  for (const [k, list] of aEdges) {
    const old = bEdges.get(k) ?? [];
    for (const e of list) {
      const same = old.find((o) => o.label === e.label);
      if (same) {
        res.pairs.edges.push({ before: same.index, after: e.index });
        continue;
      }
      const changedFrom = old.find((o) => !list.some((x) => x.label === o.label));
      if (changedFrom) {
        res.pairs.edges.push({ before: changedFrom.index, after: e.index });
        items.push({ type: 'edge', status: 'changed', key: k, before: changedFrom.label, after: e.label, reqs: reqs(k) });
        res.after.edges[e.index] = 'changed';
        res.before.edges[changedFrom.index] = 'changed';
      } else {
        items.push({ type: 'edge', status: 'added', key: k, after: e.label, reqs: reqs(k) });
        res.after.edges[e.index] = 'added';
      }
    }
  }
  for (const [k, list] of bEdges) {
    const now = aEdges.get(k) ?? [];
    for (const e of list) {
      if (now.some((x) => x.label === e.label)) continue;
      if (res.before.edges[e.index] === 'changed') continue;
      items.push({ type: 'edge', status: 'removed', key: k, before: e.label, reqs: reqs(k) });
      res.before.edges[e.index] = 'removed';
    }
  }
  return res;
}
