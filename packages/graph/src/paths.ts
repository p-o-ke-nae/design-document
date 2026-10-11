import { generateMatrix } from './enumerate.ts';
import type { Graph } from './types.ts';

export type ElementRef = { type: 'node'; id: string } | { type: 'edge'; index: number };

/** Union of nodes/edges on every enumerated path (P cases) that passes through the element. */
export function pathsThrough(graph: Graph, target: ElementRef): { nodes: string[]; edges: number[] } {
  const nodes = new Set<string>();
  const edges = new Set<number>();
  const { cases } = generateMatrix(graph, { nSwitch: 0 });
  for (const c of cases) {
    if (c.kind !== 'P') continue;
    const hit = target.type === 'node' ? c.nodes.includes(target.id) : c.edges.includes(target.index);
    if (!hit) continue;
    c.nodes.forEach((n) => nodes.add(n));
    c.edges.forEach((e) => edges.add(e));
  }
  if (target.type === 'node') nodes.add(target.id);
  else edges.add(target.index);
  return { nodes: [...nodes], edges: [...edges] };
}
