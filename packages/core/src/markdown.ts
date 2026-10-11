import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkDirective from 'remark-directive';
import { visit } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import GithubSlugger from 'github-slugger';
import YAML from 'yaml';
import type { Root } from 'mdast';

export interface Heading {
  depth: number;
  text: string;
  slug: string;
  line: number;
  endLine: number;
}

export interface DiagramBlock {
  /** `id` from the fence meta, or `diagram-<n>` */
  id: string;
  code: string;
  /** line of the opening fence (1-based) */
  line: number;
  endLine: number;
  meta: Record<string, string | true>;
  /** Generate a test matrix from this diagram */
  matrix: boolean;
  /** id of another diagram in the same document to compare with (As-Is / To-Be) */
  compare?: string;
}

export interface DirectiveRef {
  name: 'ref' | 'embed' | 'mock';
  target: string;
  attributes: Record<string, string>;
  line: number;
}

/** A commentable source block (REVCMT ソース位置): top-level blocks, list items and table rows. Lines are 1-based. */
export interface SourceBlock {
  /** mdast type: heading / paragraph / listItem / tableRow / code / diagram / blockquote / html / thematicBreak / leafDirective … */
  type: string;
  line: number;
  endLine: number;
}

export interface ParsedDoc {
  frontMatter: Record<string, unknown>;
  frontMatterError?: string;
  title: string;
  headings: Heading[];
  diagrams: DiagramBlock[];
  directives: DirectiveRef[];
  blocks: SourceBlock[];
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkDirective);

export function parseMarkdownAst(text: string): Root {
  return processor.parse(text) as Root;
}

/** Parses fence meta like `id=order-state matrix compare=asis`. */
export function parseFenceMeta(meta: string | null | undefined): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  if (!meta) return out;
  for (const m of meta.matchAll(/([\w-]+)(?:=("[^"]*"|\S+))?/g)) {
    out[m[1]] = m[2] === undefined ? true : m[2].replace(/^"|"$/g, '');
  }
  return out;
}

export function slugify(text: string): string {
  return new GithubSlugger().slug(text);
}

/** Top-level blocks; lists are split into items and tables into rows (1 row = 1 element). Front matter is excluded. */
export function sourceBlocks(tree: Root): SourceBlock[] {
  const out: SourceBlock[] = [];
  const pos = (n: any) => ({ line: n.position.start.line as number, endLine: n.position.end.line as number });
  const listItems = (list: any) => {
    for (const item of list.children ?? []) if (item.position) out.push({ type: 'listItem', ...pos(item) });
  };
  for (const n of tree.children as any[]) {
    if (!n.position || n.type === 'yaml' || n.type === 'definition') continue;
    if (n.type === 'list') listItems(n);
    else if (n.type === 'table') {
      for (const row of n.children ?? []) if (row.position) out.push({ type: 'tableRow', ...pos(row) });
    } else if (n.type === 'code') out.push({ type: n.lang === 'mermaid' ? 'diagram' : 'code', ...pos(n) });
    else out.push({ type: n.type, ...pos(n) });
  }
  return out;
}

export function parseDoc(text: string): ParsedDoc {
  const tree = parseMarkdownAst(text);
  const slugger = new GithubSlugger();
  const doc: ParsedDoc = { frontMatter: {}, title: '', headings: [], diagrams: [], directives: [], blocks: sourceBlocks(tree) };
  let diagramCount = 0;
  const totalLines = text.split(/\r?\n/).length;

  visit(tree, (node: any) => {
    if (node.type === 'yaml') {
      try {
        const v = YAML.parse(node.value);
        if (v && typeof v === 'object') doc.frontMatter = v;
      } catch (e) {
        doc.frontMatterError = (e as Error).message;
      }
    } else if (node.type === 'heading') {
      const t = toString(node);
      doc.headings.push({ depth: node.depth, text: t, slug: slugger.slug(t), line: node.position.start.line, endLine: totalLines });
    } else if (node.type === 'code' && node.lang === 'mermaid') {
      diagramCount++;
      const meta = parseFenceMeta(node.meta);
      doc.diagrams.push({
        id: typeof meta.id === 'string' ? meta.id : `diagram-${diagramCount}`,
        code: node.value,
        line: node.position.start.line,
        endLine: node.position.end.line,
        meta,
        matrix: meta.matrix === true || meta.matrix === 'true',
        compare: typeof meta.compare === 'string' ? meta.compare : undefined,
      });
    } else if ((node.type === 'leafDirective' || node.type === 'textDirective') && ['ref', 'embed', 'mock'].includes(node.name)) {
      doc.directives.push({
        name: node.name,
        target: toString(node).trim(),
        attributes: (node.attributes ?? {}) as Record<string, string>,
        line: node.position.start.line,
      });
    }
  });

  // A section ends right before the next heading of the same or higher level.
  for (let i = 0; i < doc.headings.length; i++) {
    const h = doc.headings[i];
    const next = doc.headings.slice(i + 1).find((n) => n.depth <= h.depth);
    h.endLine = next ? next.line - 1 : totalLines;
  }

  const fmTitle = doc.frontMatter.title;
  doc.title = typeof fmTitle === 'string' ? fmTitle : (doc.headings.find((h) => h.depth === 1)?.text ?? '');
  return doc;
}

export interface TocEntry {
  depth: number;
  text: string;
  slug: string;
  line: number;
}

export function buildToc(headings: Heading[], minLevel = 2, maxLevel = 3): TocEntry[] {
  return headings.filter((h) => h.depth >= minLevel && h.depth <= maxLevel).map(({ depth, text, slug, line }) => ({ depth, text, slug, line }));
}

/** Splits `path#heading` into parts. Heading may be a slug or raw heading text. */
export function splitRef(target: string): { path: string; heading: string } {
  const i = target.indexOf('#');
  if (i < 0) return { path: target.trim(), heading: '' };
  return { path: target.slice(0, i).trim(), heading: target.slice(i + 1).trim() };
}

/** Resolves a reference path against the referring document path (both repo-relative, `/` separated). */
export function resolveRefPath(fromDoc: string, refPath: string): string {
  if (!refPath) return fromDoc;
  if (refPath.startsWith('/')) return normalizePath(refPath.slice(1));
  const dir = fromDoc.includes('/') ? fromDoc.slice(0, fromDoc.lastIndexOf('/')) : '';
  return normalizePath(dir ? `${dir}/${refPath}` : refPath);
}

export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function findHeading(doc: ParsedDoc, heading: string): Heading | undefined {
  if (!heading) return undefined;
  const slug = slugify(heading);
  return doc.headings.find((h) => h.slug === heading || h.slug === slug || h.text === heading);
}

/** Extracts the markdown of a section (heading line through the end of the section). */
export function extractSection(text: string, heading: string): { markdown: string; heading?: Heading } | null {
  const doc = parseDoc(text);
  if (!heading) {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    return { markdown: body };
  }
  const h = findHeading(doc, heading);
  if (!h) return null;
  const lines = text.split(/\r?\n/);
  return { markdown: lines.slice(h.line - 1, h.endLine).join('\n'), heading: h };
}
