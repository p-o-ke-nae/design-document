import {
  buildToc,
  docEntryOf,
  extractSection,
  findHeading,
  lintDocsWith,
  lintTargets,
  normalizePath,
  resolveRefPath,
  splitRef,
  traceIndex,
  type DdvConfig,
  type DocEntry,
  type LintIssue,
} from '@ddv/core';
import { diffGraphs, parseMermaidGraph } from '@ddv/graph';
import type { MatrixService, MatrixWithLinks } from './matrix.ts';
import { normalizeRepoPath } from './repo-path.ts';
import type { RepoReader } from './repo-reader.ts';

export interface TreeDoc {
  path: string;
  kind: DocEntry['kind'];
  title: string;
  id: string;
  status: string;
  traces: unknown;
}

export interface TreeResponse {
  docsRoot: string;
  docs: TreeDoc[];
}

export type DocResponse = {
  path: string;
  kind: DocEntry['kind'];
  id: string;
  title: string;
  status: string;
  frontMatter: Record<string, unknown>;
  traces: Array<{ code: string; path?: string }>;
  text: string;
  headings: DocEntry['parsed']['headings'];
  toc: ReturnType<typeof buildToc>;
  diagrams: DocEntry['parsed']['diagrams'];
  directives: DocEntry['parsed']['directives'];
  blocks: DocEntry['parsed']['blocks'];
  graphs: Record<string, unknown>;
  diffs: Record<string, unknown>;
  matrices: MatrixWithLinks[];
  issues: LintIssue[];
};

export type ResolveResponse =
  | { ok: true; path: string; heading: string; slug: string; title: string; line: number; markdown: string }
  | { ok: false; path: string; heading: string; error: string };

/** Documents of the repository: tree, file, rendered document data and cross-document references. */
export class DocService {
  constructor(
    private readonly reader: RepoReader,
    private readonly getConfig: () => DdvConfig,
    private readonly matrix: Pick<MatrixService, 'matrices'>,
    private readonly info: { repoRoot: string; repoName: string },
  ) {}

  config(): { repoRoot: string; repoName: string; config: DdvConfig } {
    return { repoRoot: this.info.repoRoot, repoName: this.info.repoName, config: this.getConfig() };
  }

  async loadDoc(rel: string): Promise<DocEntry> {
    const p = normalizeRepoPath(rel);
    return docEntryOf(p, await this.reader.readText(p));
  }

  async loadDocs(): Promise<DocEntry[]> {
    const files = await this.reader.listFiles(this.getConfig().docsRoot, (rel) => rel.endsWith('.md'));
    return Promise.all(files.map(async (f) => docEntryOf(f, await this.reader.readText(f))));
  }

  /** `lintDocs` over the reader: the referenced paths are checked with `reader.exists`. */
  async lint(docs: DocEntry[]): Promise<LintIssue[]> {
    const config = this.getConfig();
    const existing = new Set<string>();
    for (const t of lintTargets(docs, config)) if (await this.reader.exists(t).catch(() => false)) existing.add(t);
    return lintDocsWith(existing, config, docs);
  }

  async tree(): Promise<TreeResponse> {
    const docs = await this.loadDocs();
    return {
      docsRoot: this.getConfig().docsRoot,
      docs: docs.map((d) => ({ path: d.path, kind: d.kind, title: d.title, id: d.id, status: d.status, traces: d.parsed.frontMatter.traces ?? [] })),
    };
  }

  file(path: string): Promise<string> {
    return this.reader.readText(path);
  }

  async doc(path: string): Promise<DocResponse> {
    const config = this.getConfig();
    const p = normalizePath(path);
    const doc = await this.loadDoc(p);
    const matrices = await this.matrix.matrices(doc);
    const graphs: Record<string, unknown> = {};
    const diffs: Record<string, unknown> = {};
    for (const dg of doc.parsed.diagrams) {
      const g = parseMermaidGraph(dg.code);
      if (g) graphs[dg.id] = g;
    }
    for (const dg of doc.parsed.diagrams) {
      if (!dg.compare) continue;
      const before = graphs[dg.compare];
      const after = graphs[dg.id];
      if (before && after) diffs[dg.id] = { compare: dg.compare, ...diffGraphs(before as never, after as never) };
    }
    const allDocs = await this.loadDocs();
    const issues = (await this.lint(allDocs)).filter((i) => i.path === p);
    const index = traceIndex(allDocs, config);
    const traces = (Array.isArray(doc.parsed.frontMatter.traces) ? (doc.parsed.frontMatter.traces as unknown[]) : []).map(String).map((code) => {
      const to = index.get(code);
      return to ? { code, path: to } : { code };
    });
    return {
      path: doc.path,
      kind: doc.kind,
      id: doc.id,
      title: doc.title,
      status: doc.status,
      frontMatter: doc.parsed.frontMatter,
      traces,
      text: doc.text,
      headings: doc.parsed.headings,
      toc: buildToc(doc.parsed.headings, config.toc.minLevel, config.toc.maxLevel),
      diagrams: doc.parsed.diagrams,
      directives: doc.parsed.directives,
      blocks: doc.parsed.blocks,
      graphs,
      diffs,
      matrices,
      issues,
    };
  }

  async resolve(from: string, ref: string): Promise<ResolveResponse> {
    const { path: rp, heading } = splitRef(ref);
    const target = resolveRefPath(from, rp);
    const text = await this.reader.tryReadText(normalizeRepoPath(target));
    if (text === null) return { ok: false, path: target, heading, error: `ファイルが見つかりません: ${target}` };
    const section = extractSection(text, heading);
    if (!section) return { ok: false, path: target, heading, error: `見出しが見つかりません: #${heading}` };
    const doc = docEntryOf(normalizeRepoPath(target), text);
    const h = heading ? findHeading(doc.parsed, heading) : undefined;
    return { ok: true, path: target, heading, slug: h?.slug ?? '', title: doc.title, line: h?.line ?? 1, markdown: section.markdown };
  }
}
