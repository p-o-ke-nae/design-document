import { generateMatrix, parseMermaidGraph, type Graph, type MatrixOptions, type StateEventTable } from '@ddv/graph';
import type { DdvConfig, DiagramBlock, DocEntry } from '@ddv/core';
import { assignIds, emptyLock, sanitizeCode, type AssignedCase, type TestIdLock } from './lock.ts';

export interface DiagramMatrix {
  doc: string;
  diagram: string;
  diagramKey: string;
  level: 'unit' | 'integration';
  graph: Graph;
  cases: AssignedCase[];
  table?: StateEventTable;
  retired: Array<{ signature: string; id: string }>;
  warnings: string[];
}

/** Parses the lock file text; null (no file) is an empty lock. */
export function parseLock(text: string | null): TestIdLock {
  return text === null ? emptyLock() : (JSON.parse(text) as TestIdLock);
}

/** Serializes the lock with sorted diagram keys (the on-disk form). */
export function formatLock(lock: TestIdLock): string {
  const sorted: TestIdLock = { version: 1, diagrams: Object.fromEntries(Object.entries(lock.diagrams).sort(([a], [b]) => a.localeCompare(b))) };
  return JSON.stringify(sorted, null, 2) + '\n';
}

export function diagramKeyOf(doc: Pick<DocEntry, 'kind' | 'id'>, diagram: DiagramBlock, config: DdvConfig): string {
  const prefix = doc.kind === 'other' ? 'DOC' : config.idPrefix[doc.kind];
  const code = typeof diagram.meta.code === 'string' ? diagram.meta.code : diagram.id;
  return `${prefix}-${sanitizeCode(doc.id)}-${sanitizeCode(code)}`;
}

export function matrixOptionsFor(diagram: DiagramBlock, config: DdvConfig): MatrixOptions {
  const num = (v: unknown, d: number) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : d);
  return {
    nSwitch: num(diagram.meta.nswitch, config.matrix.nSwitch),
    loopLimit: num(diagram.meta.loop, config.matrix.loopLimit),
    maxPaths: num(diagram.meta.max, config.matrix.maxPaths),
  };
}

/** Builds matrices of one document. Mutates `lock` (pass a clone for preview). */
export function docMatrices(doc: DocEntry, config: DdvConfig, lock: TestIdLock): DiagramMatrix[] {
  const out: DiagramMatrix[] = [];
  for (const dg of doc.parsed.diagrams) {
    if (!dg.matrix) continue;
    const graph = parseMermaidGraph(dg.code);
    if (!graph) continue;
    const key = diagramKeyOf(doc, dg, config);
    const m = generateMatrix(graph, matrixOptionsFor(dg, config));
    const entry = (lock.diagrams[key] ??= { doc: doc.path, diagram: dg.id, next: {}, cases: {} });
    entry.doc = doc.path;
    entry.diagram = dg.id;
    const r = assignIds(entry, key, m.cases);
    out.push({
      doc: doc.path,
      diagram: dg.id,
      diagramKey: key,
      level: dg.meta.level === 'unit' || dg.meta.level === 'integration' ? dg.meta.level : doc.kind === 'detailed' ? 'unit' : 'integration',
      graph,
      cases: r.cases,
      table: m.table,
      retired: r.retired,
      warnings: m.warnings,
    });
  }
  return out;
}

export interface GenerateResult {
  matrices: DiagramMatrix[];
  lock: TestIdLock;
  changed: boolean;
}

/** Generates matrices for all documents against `original` (not mutated). */
export function generateFrom(docs: DocEntry[], config: DdvConfig, original: TestIdLock): GenerateResult {
  const lock = structuredClone(original);
  const matrices = docs.flatMap((d) => docMatrices(d, config, lock));
  // Diagrams that disappeared entirely: retire their cases.
  const live = new Set(matrices.map((m) => m.diagramKey));
  for (const [key, entry] of Object.entries(lock.diagrams)) {
    if (live.has(key)) continue;
    for (const c of Object.values(entry.cases)) c.status = 'retired';
  }
  const changed = JSON.stringify(original) !== JSON.stringify(lock);
  return { matrices, lock, changed };
}

export function activeIds(lock: TestIdLock): Map<string, { diagramKey: string; signature: string; title: string; doc: string }> {
  const m = new Map<string, { diagramKey: string; signature: string; title: string; doc: string }>();
  for (const [key, entry] of Object.entries(lock.diagrams)) {
    for (const [sig, c] of Object.entries(entry.cases)) if (c.status === 'active') m.set(c.id, { diagramKey: key, signature: sig, title: c.title, doc: entry.doc });
  }
  return m;
}
