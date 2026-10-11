import { existsSync } from 'node:fs';
import { parseMermaidGraph, diffGraphs } from '@ddv/graph';
import type { DdvConfig } from './config.ts';
import { findHeading, resolveRefPath, splitRef } from './markdown.ts';
import { loadDocs, safeJoin, type DocEntry } from './node.ts';

export interface LintIssue {
  severity: 'error' | 'warning';
  rule: string;
  path: string;
  line?: number;
  message: string;
}

/** Required sections of a requirements document; each entry lists accepted heading keywords. */
export const REQUIRED_REQUIREMENT_SECTIONS: Array<{ name: string; keywords: string[] }> = [
  { name: '目的', keywords: ['目的', 'purpose'] },
  { name: '現状 (As-Is)', keywords: ['as-is', '現状'] },
  { name: 'あるべき姿 (To-Be)', keywords: ['to-be', 'あるべき姿'] },
  { name: 'スコープ', keywords: ['スコープ', 'scope'] },
  { name: '受入基準', keywords: ['受入基準', '受け入れ基準', 'acceptance'] },
];

export function requirementIdsDefined(doc: DocEntry, prefix: string): string[] {
  const re = new RegExp(`^\\|\\s*(${prefix}-\\d+)\\s*\\|`, 'gm');
  return [...doc.text.matchAll(re)].map((m) => m[1]);
}

export function docCode(doc: DocEntry, config: DdvConfig): string {
  const prefix = doc.kind === 'other' ? '' : config.idPrefix[doc.kind];
  return prefix ? `${prefix}-${doc.id}` : doc.id;
}

/** Maps trace codes (document codes like `BD-ORDER`, ids and requirement ids like `REQ-001`) to the defining document path. */
export function traceIndex(docs: DocEntry[], config: DdvConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of docs) if (d.kind === 'requirements') for (const id of requirementIdsDefined(d, config.idPrefix.requirements)) if (!out.has(id)) out.set(id, d.path);
  for (const d of docs) for (const code of [docCode(d, config), d.id]) if (code && !out.has(code)) out.set(code, d.path);
  return out;
}

export type ExtraLintCheck = (repoRoot: string, config: DdvConfig, docs: DocEntry[]) => Promise<LintIssue[]> | LintIssue[];

export async function lintRepo(repoRoot: string, config: DdvConfig, opts: { extraChecks?: ExtraLintCheck[] } = {}): Promise<LintIssue[]> {
  const docs = await loadDocs(repoRoot, config);
  const issues = lintDocs(repoRoot, config, docs);
  for (const check of opts.extraChecks ?? []) issues.push(...(await check(repoRoot, config, docs)));
  return issues;
}

export function lintDocs(repoRoot: string, config: DdvConfig, docs: DocEntry[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (i: LintIssue) => issues.push(i);
  const byPath = new Map(docs.map((d) => [d.path, d]));

  const reqIds = new Set<string>();
  for (const d of docs) if (d.kind === 'requirements') requirementIdsDefined(d, config.idPrefix.requirements).forEach((id) => reqIds.add(id));
  const known = new Set<string>([...reqIds, ...docs.map((d) => docCode(d, config)), ...docs.map((d) => d.id)]);
  const traced = new Set<string>();

  for (const d of docs) {
    const fm = d.parsed.frontMatter;
    if (d.parsed.frontMatterError) add({ severity: 'error', rule: 'front-matter', path: d.path, line: 1, message: `front matter の YAML が不正: ${d.parsed.frontMatterError}` });
    if (d.kind !== 'other') {
      for (const key of ['id', 'kind', 'status']) {
        if (fm[key] === undefined) add({ severity: 'error', rule: 'front-matter', path: d.path, line: 1, message: `front matter に ${key} がありません` });
      }
    }

    if (d.kind === 'requirements') {
      for (const sec of REQUIRED_REQUIREMENT_SECTIONS) {
        const ok = d.parsed.headings.some((h) => sec.keywords.some((k) => h.text.toLowerCase().includes(k.toLowerCase())));
        if (!ok) add({ severity: 'error', rule: 'required-section', path: d.path, message: `要件定義に「${sec.name}」の節がありません` });
      }
      if (!requirementIdsDefined(d, config.idPrefix.requirements).length) {
        add({ severity: 'error', rule: 'required-section', path: d.path, message: `要件一覧の表に ${config.idPrefix.requirements}-NNN 形式の要件IDがありません` });
      }
    }

    const traces = Array.isArray(fm.traces) ? (fm.traces as unknown[]).map(String) : [];
    if ((d.kind === 'basic' || d.kind === 'detailed') && !traces.length) {
      add({ severity: 'warning', rule: 'trace', path: d.path, line: 1, message: 'traces（トレース元の要件/設計ID）がありません' });
    }
    for (const t of traces) {
      traced.add(t);
      if (!known.has(t)) add({ severity: 'error', rule: 'trace', path: d.path, line: 1, message: `traces の ${t} が定義されていません` });
    }

    for (const r of d.parsed.directives) {
      if (r.name === 'mock') {
        if (!existsSync(safeJoin(repoRoot, `${config.mocksRoot}/${r.target}`))) add({ severity: 'error', rule: 'ref', path: d.path, line: r.line, message: `モック ${r.target} が見つかりません` });
        const want = r.attributes?.diagram;
        if (want) {
          const dg = d.parsed.diagrams.find((x) => x.id === want);
          if (!dg) add({ severity: 'error', rule: 'ref', path: d.path, line: r.line, message: `モック ${r.target} の diagram=${want} が見つかりません` });
          else if (!dg.matrix || parseMermaidGraph(dg.code)?.kind !== 'state')
            add({ severity: 'error', rule: 'ref', path: d.path, line: r.line, message: `モック ${r.target} の diagram=${want} は matrix 付きの状態図ではありません` });
        }
        continue;
      }
      const { path: p, heading } = splitRef(r.target);
      const target = resolveRefPath(d.path, p);
      const td = byPath.get(target);
      if (!td) {
        if (!existsSync(safeJoin(repoRoot, target))) add({ severity: 'error', rule: 'ref', path: d.path, line: r.line, message: `参照先 ${target} が見つかりません` });
        continue;
      }
      if (heading && !findHeading(td.parsed, heading)) add({ severity: 'error', rule: 'ref', path: d.path, line: r.line, message: `参照先 ${target} に見出し「${heading}」がありません` });
    }

    const ids = new Set<string>();
    for (const dg of d.parsed.diagrams) {
      if (ids.has(dg.id)) add({ severity: 'error', rule: 'diagram', path: d.path, line: dg.line, message: `図のid ${dg.id} が重複しています` });
      ids.add(dg.id);
      const graph = dg.matrix || dg.compare ? parseMermaidGraph(dg.code) : null;
      if ((dg.matrix || dg.compare) && !graph) {
        add({ severity: 'error', rule: 'diagram', path: d.path, line: dg.line, message: `図 ${dg.id}: マトリクス/比較は stateDiagram と flowchart のみ対応です` });
        continue;
      }
      for (const w of graph?.warnings ?? []) add({ severity: 'warning', rule: 'diagram', path: d.path, line: dg.line, message: `図 ${dg.id}: ${w}` });
      if (dg.compare) {
        const other = d.parsed.diagrams.find((x) => x.id === dg.compare);
        const og = other ? parseMermaidGraph(other.code) : null;
        if (!other || !og) {
          add({ severity: 'error', rule: 'diagram', path: d.path, line: dg.line, message: `図 ${dg.id}: 比較対象 ${dg.compare} が見つからないか未対応の図です` });
        } else if (graph) {
          for (const item of diffGraphs(og, graph).items) {
            if (!item.reqs.length) add({ severity: 'warning', rule: 'gap', path: d.path, line: dg.line, message: `図 ${dg.id}: ギャップ ${item.type} ${item.key} (${item.status}) に要件IDが対応付けられていません（%% req: ${item.key} REQ-xxx）` });
            item.reqs.forEach((r) => traced.add(r));
          }
        }
      }
    }
  }

  for (const id of reqIds) {
    if (!traced.has(id)) add({ severity: 'warning', rule: 'trace', path: docs.find((d) => d.kind === 'requirements' && d.text.includes(id))?.path ?? '', message: `要件 ${id} がどの設計からもトレースされていません` });
  }
  return issues;
}

export function formatIssues(issues: LintIssue[]): string {
  return issues.map((i) => `${i.severity === 'error' ? '✗' : '!'} ${i.path}${i.line ? `:${i.line}` : ''} [${i.rule}] ${i.message}`).join('\n');
}
