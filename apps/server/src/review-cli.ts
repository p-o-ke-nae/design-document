import type { DdvConfig } from '@ddv/core';
import type { DocEntry } from '@ddv/core/node';
import { loadDocs } from '@ddv/core/node';
import { pathsThrough } from '@ddv/graph';
import { docMatrices, readLock, type DiagramMatrix, type TestIdLock } from '@ddv/testid';
import { ThreadService, type Thread, type ThreadComment } from './threads.ts';
import { parseOpenRequest, type Workspace, type WorkspaceManager } from './workspaces.ts';

/** REVCMT CLI: `ddv review comments` の出力。 */
export interface ReviewThreadOut {
  id: string;
  url: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  doc: { id: string; status: string; heading: string | null } | null;
  element: { kind: string; key: string; label: string } | null;
  testIds: string[];
  suggestion: string | null;
  comments: { id: number; author: string; body: string; createdAt: string }[];
}

export interface ReviewOutput {
  pr: number;
  headSha: string;
  threads: ReviewThreadOut[];
}

/** 先頭コメントの ```suggestion ブロックの中身（無ければ null）。 */
export function extractSuggestion(body: string | undefined): string | null {
  const m = /```suggestion[^\r\n]*\r?\n([\s\S]*?)\r?\n?```/.exec(body ?? '');
  return m ? m[1] : null;
}

/** element を通る経路（P）のテストID。図そのものは、その図の全経路。 */
export function testIdsFor(element: { kind: string; key: string; diagram?: string } | undefined, matrices: DiagramMatrix[]): string[] {
  if (!element?.diagram) return [];
  const m = matrices.find((x) => x.diagram === element.diagram);
  if (!m) return [];
  const paths = m.cases.filter((c) => c.kind === 'P');
  if (element.kind === 'diagram') return paths.map((c) => c.id);
  let target: Parameters<typeof pathsThrough>[1] | undefined;
  if (element.kind === 'node') {
    const id = element.key.slice(element.key.indexOf('#node:') + '#node:'.length);
    if (m.graph.nodes.some((n) => n.id === id)) target = { type: 'node', id };
  } else if (element.kind === 'edge') {
    const key = element.key.slice(element.key.indexOf('#edge:') + '#edge:'.length);
    const e = m.graph.edges.find((x) => x.key === key);
    if (e) target = { type: 'edge', index: e.index };
  }
  if (!target) return [];
  const through = pathsThrough(m.graph, target);
  const edges = new Set(through.edges);
  const nodes = new Set(through.nodes);
  return paths.filter((c) => (target!.type === 'node' ? c.nodes.includes(target!.id) : c.edges.includes(target!.index)) && c.edges.every((i) => edges.has(i)) && c.nodes.every((n) => nodes.has(n))).map((c) => c.id);
}

export interface BuildInput {
  pr: number;
  headSha: string;
  threads: Thread[];
  docs: Pick<DocEntry, 'path' | 'id' | 'status' | 'kind' | 'parsed' | 'text'>[];
  config: DdvConfig;
  lock: TestIdLock;
  all?: boolean;
}

/** スレッドと解析済みの文書から出力を組み立てる（純粋関数）。 */
export function buildReviewOutput(input: BuildInput): ReviewOutput {
  const matrixCache = new Map<string, DiagramMatrix[]>();
  const matricesOf = (doc: BuildInput['docs'][number]): DiagramMatrix[] => {
    let m = matrixCache.get(doc.path);
    if (!m) {
      try {
        m = docMatrices(doc as DocEntry, input.config, structuredClone(input.lock));
      } catch {
        m = [];
      }
      matrixCache.set(doc.path, m);
    }
    return m;
  };
  const threads = input.threads
    .filter((t) => input.all || !t.resolved)
    .map((t): ReviewThreadOut => {
      const doc = input.docs.find((d) => d.path === t.path);
      const el = t.placement?.kind === 'element' ? t.placement.element : undefined;
      const at = el?.startLine ?? (t.outdated ? null : t.line);
      const heading = doc && at ? ([...doc.parsed.headings].reverse().find((h) => h.line <= at)?.text ?? null) : null;
      return {
        id: t.id,
        url: t.url,
        resolved: t.resolved,
        outdated: t.outdated,
        path: t.path,
        line: t.line,
        startLine: t.startLine,
        doc: doc ? { id: doc.id, status: doc.status, heading } : null,
        element: el ? { kind: el.kind, key: el.key, label: el.label } : null,
        testIds: doc ? testIdsFor(el, matricesOf(doc)) : [],
        suggestion: extractSuggestion(t.comments[0]?.body),
        comments: t.comments.map((c: ThreadComment) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
      };
    });
  return { pr: input.pr, headSha: input.headSha, threads };
}

/** 文書・見出しごとにまとめた人向けの一覧。 */
export function formatReviewText(out: ReviewOutput): string {
  const lines: string[] = [`PR #${out.pr}（head ${out.headSha.slice(0, 7)}）: ${out.threads.length} スレッド`];
  if (!out.threads.length) return lines.join('\n');
  const groups = new Map<string, Map<string, ReviewThreadOut[]>>();
  for (const t of out.threads) {
    const doc = groups.get(t.path) ?? new Map<string, ReviewThreadOut[]>();
    groups.set(t.path, doc);
    const h = t.doc?.heading ?? '（文書全体・見出し外）';
    doc.set(h, [...(doc.get(h) ?? []), t]);
  }
  for (const [p, headings] of groups) {
    const info = [...headings.values()][0][0].doc;
    lines.push('', `■ ${p}${info ? `（${info.id}, status: ${info.status}）` : ''}`);
    for (const [h, ts] of headings) {
      lines.push(`  ## ${h}`);
      for (const t of ts) {
        const pos = t.line == null ? 'ファイル' : t.startLine && t.startLine !== t.line ? `L${t.startLine}-${t.line}` : `L${t.line}`;
        const flags = [t.resolved ? '解決済み' : '', t.outdated ? '古い位置' : ''].filter(Boolean).join('・');
        lines.push(`    - ${pos}${t.element ? ` [${t.element.kind}] ${t.element.label}` : ''}${flags ? `（${flags}）` : ''}`);
        if (t.testIds.length) lines.push(`      テストID: ${t.testIds.join(', ')}`);
        for (const c of t.comments) lines.push(`      @${c.author}: ${c.body.replace(/\r?\n/g, '\n        ')}`);
        if (t.suggestion !== null) lines.push(`      suggestion:\n        ${t.suggestion.replace(/\r?\n/g, '\n        ')}`);
        lines.push(`      ${t.url}`);
      }
    }
  }
  return lines.join('\n');
}

export class ReviewCliError extends Error {}

export interface ReviewCommentsArgs {
  repo: string;
  pr: number;
  json: boolean;
  all: boolean;
}

export function parseReviewArgs(argv: string[]): ReviewCommentsArgs {
  const val = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = val('--github');
  const pr = val('--pr');
  if (!repo || !pr) throw new ReviewCliError('--github <owner/repo> と --pr <n> を指定してください');
  parseOpenRequest({ repo, pr });
  return { repo, pr: Number(pr), json: argv.includes('--json'), all: argv.includes('--all') };
}

/** ワークスペースが無ければ取得し、スレッドを集めて出力を返す。 */
export async function reviewComments(manager: WorkspaceManager, args: ReviewCommentsArgs): Promise<ReviewOutput> {
  const ws: Workspace = manager.open({ repo: args.repo, pr: String(args.pr) });
  await manager.settled(ws.id);
  if (ws.state === 'Ready' || ws.state === 'Stale') {
    // 既存のワークスペースは、PR の head が進んでいれば最新にしてから読む
    if (await manager.checkHead(ws.id, true).catch(() => false)) await manager.refresh(ws.id);
  }
  if (ws.state !== 'Ready' || !ws.ctx) throw new ReviewCliError(`ワークスペースを準備できません（${ws.state}${ws.error ? `: ${ws.error}` : ''}）`);
  const threads = await new ThreadService(manager.github).list(ws);
  const docs = await loadDocs(ws.dir, ws.ctx.config);
  const lock = await readLock(ws.dir);
  return buildReviewOutput({ pr: args.pr, headSha: ws.headSha, threads, docs, config: ws.ctx.config, lock, all: args.all });
}
