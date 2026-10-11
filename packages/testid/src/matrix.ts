import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { generateMatrix, parseMermaidGraph, type Graph, type MatrixOptions, type StateEventTable } from '@ddv/graph';
import type { DdvConfig, DiagramBlock } from '@ddv/core';
import { loadDocs, safeJoin, type DocEntry } from '@ddv/core/node';
import { assignIds, emptyLock, LOCK_PATH, sanitizeCode, type AssignedCase, type TestIdLock } from './lock.ts';

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

export async function readLock(repoRoot: string): Promise<TestIdLock> {
  const p = safeJoin(repoRoot, LOCK_PATH);
  if (!existsSync(p)) return emptyLock();
  return JSON.parse(await fs.readFile(p, 'utf8')) as TestIdLock;
}

export async function writeLock(repoRoot: string, lock: TestIdLock): Promise<void> {
  const p = safeJoin(repoRoot, LOCK_PATH);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const sorted: TestIdLock = { version: 1, diagrams: Object.fromEntries(Object.entries(lock.diagrams).sort(([a], [b]) => a.localeCompare(b))) };
  await fs.writeFile(p, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
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

/** Generates matrices for all documents; when `write` is true the lock file is updated. */
export async function generateAll(repoRoot: string, config: DdvConfig, opts: { write: boolean }): Promise<GenerateResult> {
  const original = await readLock(repoRoot);
  const lock = structuredClone(original);
  const docs = await loadDocs(repoRoot, config);
  const matrices = docs.flatMap((d) => docMatrices(d, config, lock));
  // Diagrams that disappeared entirely: retire their cases.
  const live = new Set(matrices.map((m) => m.diagramKey));
  for (const [key, entry] of Object.entries(lock.diagrams)) {
    if (live.has(key)) continue;
    for (const c of Object.values(entry.cases)) c.status = 'retired';
  }
  const changed = JSON.stringify(original) !== JSON.stringify(lock);
  if (opts.write && changed) await writeLock(repoRoot, lock);
  return { matrices, lock, changed };
}

export function activeIds(lock: TestIdLock): Map<string, { diagramKey: string; signature: string; title: string; doc: string }> {
  const m = new Map<string, { diagramKey: string; signature: string; title: string; doc: string }>();
  for (const [key, entry] of Object.entries(lock.diagrams)) {
    for (const [sig, c] of Object.entries(entry.cases)) if (c.status === 'active') m.set(c.id, { diagramKey: key, signature: sig, title: c.title, doc: entry.doc });
  }
  return m;
}
