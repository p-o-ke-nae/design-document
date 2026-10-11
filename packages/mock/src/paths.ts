import { generateMatrix, parseMermaidGraph, splitLabel, type Graph } from '@ddv/graph';
import type { DdvConfig, DiagramBlock } from '@ddv/core';
import type { DocEntry } from '@ddv/core/node';
import { diagramKeyOf, matrixOptionsFor, type TestIdLock } from '@ddv/testid';
import type { PathSpec, PathTransition } from './types.ts';

/**
 * Mock names (`order` for `::mock[order/index.html]`) referenced by a document, with their html target
 * and the diagram chosen by `{diagram=<id>}`.
 */
export function mockRefs(doc: DocEntry): Array<{ name: string; target: string; line: number; diagram?: string }> {
  return doc.parsed.directives
    .filter((d) => d.name === 'mock' && d.target)
    .map((d) => {
      const target = d.target.replace(/\\/g, '/').replace(/^\.?\/+/, '');
      const i = target.lastIndexOf('/');
      const diagram = d.attributes?.diagram || undefined;
      return { name: i >= 0 ? target.slice(0, i) : '', target, line: d.line, ...(diagram ? { diagram } : {}) };
    });
}

/**
 * The screen transition diagram of a mock: the `matrix` state diagram with the given id,
 * or the first `matrix` state diagram of the document when no id is given.
 */
export function screenDiagram(doc: DocEntry, id?: string): { diagram: DiagramBlock; graph: Graph } | null {
  for (const dg of doc.parsed.diagrams) {
    if (!dg.matrix || (id !== undefined && dg.id !== id)) continue;
    const graph = parseMermaidGraph(dg.code);
    if (graph?.kind === 'state') return { diagram: dg, graph };
  }
  return null;
}

/** Converts the active P cases of the diagram in the lock into path specs. */
export function pathSpecs(doc: DocEntry, diagram: DiagramBlock, lock: TestIdLock, config: DdvConfig): PathSpec[] {
  const graph = parseMermaidGraph(diagram.code);
  if (!graph) return [];
  const entry = lock.diagrams[diagramKeyOf(doc, diagram, config)];
  if (!entry) return [];
  const role = new Map(graph.nodes.map((n) => [n.id, n.role]));
  const byIndex = new Map(graph.edges.map((e) => [e.index, e]));
  const out: PathSpec[] = [];
  for (const c of generateMatrix(graph, matrixOptionsFor(diagram, config)).cases) {
    if (c.kind !== 'P') continue;
    const lc = entry.cases[c.signature];
    if (!lc || lc.status !== 'active') continue;
    const transitions: PathTransition[] = [];
    let start = '';
    for (const idx of c.edges) {
      const e = byIndex.get(idx)!;
      if (role.get(e.from) === 'start') {
        start ||= e.to;
        continue;
      }
      if (role.get(e.to) === 'end') continue;
      start ||= e.from;
      const { event, guard } = splitLabel(e.label);
      transitions.push({ from: e.from, to: e.to, event, guard, edge: e.index });
    }
    out.push({ id: lc.id, title: lc.title, start, transitions, edges: [...c.edges] });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
