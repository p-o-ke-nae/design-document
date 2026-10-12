import type { Graph } from './api.ts';

/** Mermaid (v11) SVG element lookup for parsed graphs. Kept in one place because ids are version dependent. */

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mermaidNodeId(graph: Graph, id: string): string {
  if (graph.kind === 'state') {
    if (id === '[*]start') return 'root_start';
    if (id === '[*]end') return 'root_end';
  }
  return id;
}

export function findNodeElements(svg: SVGSVGElement, graph: Graph, nodeId: string): Element[] {
  const mid = mermaidNodeId(graph, nodeId);
  const re = new RegExp(`-(?:state|flowchart)-${escapeRe(mid)}-\\d+$`);
  return [...svg.querySelectorAll('g.node')].filter((g) => re.test(g.id));
}

/** data-id of each edge in source order. */
export function edgeDataIds(graph: Graph): string[] {
  if (graph.kind === 'state') return graph.edges.map((e) => `edge${e.index}`);
  const count = new Map<string, number>();
  return [...graph.edges]
    .sort((a, b) => a.index - b.index)
    .map((e) => {
      const k = `${e.from}_${e.to}`;
      const n = count.get(k) ?? 0;
      count.set(k, n + 1);
      return `L_${k}_${n}`;
    });
}

export function findEdgeElements(svg: SVGSVGElement, graph: Graph, edgeIndex: number): Element[] {
  const ids = edgeDataIds(graph);
  const pos = [...graph.edges].sort((a, b) => a.index - b.index).findIndex((e) => e.index === edgeIndex);
  const dataId = ids[pos];
  if (!dataId) return [];
  const out = [...svg.querySelectorAll(`[data-id="${CSS.escape(dataId)}"]`)];
  // Edge labels are wrapped in g.edgeLabel > g.label[data-id]
  return out.flatMap((el) => (el.parentElement?.classList.contains('edgeLabel') ? [el, el.parentElement] : [el]));
}

const COVERAGE_MARKS = ['ddv-cov-passed', 'ddv-cov-failed', 'ddv-cov-skipped', 'ddv-cov-unexecuted', 'ddv-cov-unlinked'];
const MARKS = ['ddv-hl', 'ddv-hl-last', 'ddv-diff-added', 'ddv-diff-removed', 'ddv-diff-changed', 'ddv-pair-hl', ...COVERAGE_MARKS];

export type HoverTarget = { type: 'node'; id: string } | { type: 'edge'; index: number };

/** Resolves the graph node/edge under an SVG element (mouse event target). */
export function targetFromElement(svg: SVGSVGElement, graph: Graph, el: Element | null): HoverTarget | null {
  const g = el?.closest('g.node');
  if (g && svg.contains(g)) {
    const n = graph.nodes.find((x) => findNodeElements(svg, graph, x.id).includes(g));
    if (n) return { type: 'node', id: n.id };
  }
  const withId = el?.closest('[data-id]');
  const dataId = withId?.getAttribute('data-id');
  if (dataId && svg.contains(withId!)) {
    const sorted = [...graph.edges].sort((a, b) => a.index - b.index);
    const pos = edgeDataIds(graph).indexOf(dataId);
    if (pos >= 0 && sorted[pos]) return { type: 'edge', index: sorted[pos].index };
  }
  return null;
}

export function applyPairHighlight(svg: SVGSVGElement, graph: Graph, target: HoverTarget) {
  const els = target.type === 'node' ? findNodeElements(svg, graph, target.id) : findEdgeElements(svg, graph, target.index);
  els.forEach((e) => e.classList.add('ddv-pair-hl'));
}

export function clearPairHighlight(svg: SVGSVGElement) {
  svg.querySelectorAll('.ddv-pair-hl').forEach((e) => e.classList.remove('ddv-pair-hl'));
}

export function clearMarks(svg: SVGSVGElement) {
  svg.classList.remove('ddv-dim');
  for (const c of MARKS) svg.querySelectorAll(`.${c}`).forEach((e) => e.classList.remove(c));
  svg.querySelectorAll('.ddv-step').forEach((e) => e.remove());
}

export function applyPathHighlight(svg: SVGSVGElement, graph: Graph, path: { edges: number[]; nodes: string[] }, steps = true) {
  svg.classList.add('ddv-dim');
  path.nodes.forEach((n) => findNodeElements(svg, graph, n).forEach((e) => e.classList.add('ddv-hl')));
  path.edges.forEach((idx, i) => {
    const els = findEdgeElements(svg, graph, idx);
    els.forEach((e) => e.classList.add('ddv-hl'));
    if (!steps) return;
    if (i === path.edges.length - 1) els.forEach((e) => e.classList.add('ddv-hl-last'));
    // Step badge at the middle of the edge path
    const p = els.find((e): e is SVGPathElement => e instanceof SVGPathElement);
    if (p && typeof p.getTotalLength === 'function') {
      try {
        const len = p.getTotalLength();
        const pt = p.getPointAtLength(len * 0.3);
        const ns = 'http://www.w3.org/2000/svg';
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'ddv-step');
        g.setAttribute('transform', `translate(${pt.x},${pt.y})`);
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('r', '9');
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('dy', '4');
        t.textContent = String(i + 1);
        g.append(c, t);
        p.parentElement?.appendChild(g);
      } catch {
        /* ignore geometry errors (e.g. hidden svg) */
      }
    }
  });
}

export function applyDiff(svg: SVGSVGElement, graph: Graph, side: { nodes: Record<string, string>; edges: Record<number, string> }) {
  for (const [n, st] of Object.entries(side.nodes)) findNodeElements(svg, graph, n).forEach((e) => e.classList.add(`ddv-diff-${st}`));
  for (const [i, st] of Object.entries(side.edges)) findEdgeElements(svg, graph, Number(i)).forEach((e) => e.classList.add(`ddv-diff-${st}`));
}

export function applyCoverage(svg: SVGSVGElement, graph: Graph, cov: { nodes: Record<string, string>; edges: Record<number, string> }) {
  for (const [n, c] of Object.entries(cov.nodes)) findNodeElements(svg, graph, n).forEach((e) => e.classList.add(`ddv-cov-${c}`));
  for (const [i, c] of Object.entries(cov.edges)) findEdgeElements(svg, graph, Number(i)).forEach((e) => e.classList.add(`ddv-cov-${c}`));
}
