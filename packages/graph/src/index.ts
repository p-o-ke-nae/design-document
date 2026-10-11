import type { Graph } from './types.ts';
import { parseStateDiagram } from './parse-state.ts';
import { parseFlowchart } from './parse-flowchart.ts';

export * from './types.ts';
export { parseStateDiagram, splitLabel, START, END } from './parse-state.ts';
export { parseFlowchart } from './parse-flowchart.ts';
export { generateMatrix, buildStateEventTable, edgeTitle, DEFAULT_MATRIX_OPTIONS } from './enumerate.ts';
export { diffGraphs } from './diff.ts';
export { pathsThrough } from './paths.ts';
export type { ElementRef } from './paths.ts';
export type { GraphDiff, DiffItem, DiffStatus } from './diff.ts';

/** Returns the diagram type keyword (first meaningful line) of a Mermaid source. */
export function mermaidType(source: string): string {
  let inFrontMatter = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '---') {
      inFrontMatter = !inFrontMatter;
      continue;
    }
    if (inFrontMatter || !line || line.startsWith('%%')) continue;
    return line.split(/\s+/)[0];
  }
  return '';
}

/** Parses state diagrams and flowcharts. Returns null for other diagram types. */
export function parseMermaidGraph(source: string): Graph | null {
  const type = mermaidType(source);
  if (type === 'stateDiagram' || type === 'stateDiagram-v2') return parseStateDiagram(source);
  if (type === 'flowchart' || type === 'graph') return parseFlowchart(source);
  return null;
}
