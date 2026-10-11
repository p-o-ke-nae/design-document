import { parseMermaidGraph } from '@ddv/graph';
import type { ParsedDoc } from './markdown.ts';

/** Commentable element kinds (REVCMT ElementKind). */
export type ElementKind = 'block' | 'tableRow' | 'node' | 'edge' | 'diagram' | 'matrixRow' | 'mockElement';

export interface ElementRef {
  kind: ElementKind;
  /** heading slug / `L<line>` / `<diagramId>` / `<diagramId>#node:<id>` / `<diagramId>#edge:<GraphEdge.key>` / test ID / mock element path */
  key: string;
  label: string;
}

/** An element of a document with its file line range (1-based, inclusive). */
export interface DocElement extends ElementRef {
  startLine: number;
  endLine: number;
  /** diagram id for node / edge / diagram */
  diagram?: string;
}

export interface LineRange {
  startLine: number;
  line: number;
}

const clip = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Lists the commentable elements of a document: blocks / table rows, diagrams, and their nodes and edges. */
export function elementsOf(doc: ParsedDoc, text?: string): DocElement[] {
  const lines = text?.split(/\r?\n/);
  const out: DocElement[] = [];
  for (const b of doc.blocks) {
    if (b.type === 'diagram') continue;
    const heading = b.type === 'heading' ? doc.headings.find((h) => h.line === b.line) : undefined;
    out.push({
      kind: b.type === 'tableRow' ? 'tableRow' : 'block',
      key: heading ? heading.slug : `L${b.line}`,
      label: heading ? heading.text : clip(lines?.[b.line - 1] ?? `L${b.line}`),
      startLine: b.line,
      endLine: b.endLine,
    });
  }
  for (const d of doc.diagrams) {
    out.push({ kind: 'diagram', key: d.id, label: d.id, startLine: d.line, endLine: d.endLine, diagram: d.id });
    let graph;
    try {
      graph = parseMermaidGraph(d.code);
    } catch {
      continue;
    }
    if (!graph) continue;
    for (const n of graph.nodes) {
      if (n.role === 'start' || n.role === 'end') continue;
      const ref: ElementRef = { kind: 'node', key: `${d.id}#node:${n.id}`, label: n.label };
      out.push({ ...ref, ...diagramLines(d, n.line), diagram: d.id });
    }
    for (const e of graph.edges) {
      const label = `${graph.nodes.find((n) => n.id === e.from)?.label ?? e.from} → ${graph.nodes.find((n) => n.id === e.to)?.label ?? e.to}${e.label ? ` : ${e.label}` : ''}`;
      out.push({ kind: 'edge', key: `${d.id}#edge:${e.key}`, label, ...diagramLines(d, e.line), diagram: d.id });
    }
  }
  return out;
}

/** File lines of a diagram element: fence line + code line, or the whole fence when the line is unknown. */
export function diagramLines(d: { line: number; endLine: number }, codeLine: number | undefined): { startLine: number; endLine: number } {
  if (!codeLine) return { startLine: d.line, endLine: d.endLine };
  return { startLine: d.line + codeLine, endLine: d.line + codeLine };
}

export interface AnchorOptions {
  /** Elements of the document (elementsOf). Computed when omitted. */
  elements?: DocElement[];
  /** Maps a test ID to the diagram id that produced it (matrixRow). */
  diagramOf?: (testId: string) => string | undefined;
  /** Line range of a mock element in the mock HTML (mockElement). */
  mockRange?: (key: string) => { startLine: number; endLine: number } | undefined;
}

/** REVCMT ANCHOR: element → file line range. Returns undefined when the element is not found. */
export function toAnchor(doc: ParsedDoc, ref: ElementRef, opts: AnchorOptions = {}): LineRange | undefined {
  const range = (r: { startLine: number; endLine: number } | undefined) => (r ? { startLine: r.startLine, line: r.endLine } : undefined);
  switch (ref.kind) {
    case 'block':
    case 'tableRow':
    case 'node':
    case 'edge':
    case 'diagram': {
      const els = opts.elements ?? elementsOf(doc);
      return range(els.find((e) => e.kind === ref.kind && e.key === ref.key) ?? els.find((e) => e.key === ref.key));
    }
    case 'matrixRow': {
      const id = opts.diagramOf?.(ref.key);
      const d = id ? doc.diagrams.find((x) => x.id === id) : undefined;
      return d ? { startLine: d.line, line: d.line } : undefined;
    }
    case 'mockElement':
      return range(opts.mockRange?.(ref.key));
  }
}

// An edge line (A --> B) is the edge even when B first appears there.
const PRIORITY: Record<ElementKind, number> = { edge: 0, node: 0.5, matrixRow: 0, mockElement: 0, tableRow: 1, block: 1, diagram: 2 };

/** The smallest element whose line range contains `line` (edge / node → table row / block → diagram). */
export function elementAt(elements: DocElement[], line: number): DocElement | undefined {
  let best: DocElement | undefined;
  for (const e of elements) {
    if (line < e.startLine || line > e.endLine) continue;
    if (!best) best = e;
    else {
      const p = PRIORITY[e.kind] - PRIORITY[best.kind];
      if (p < 0 || (p === 0 && e.endLine - e.startLine < best.endLine - best.startLine)) best = e;
    }
  }
  return best;
}
