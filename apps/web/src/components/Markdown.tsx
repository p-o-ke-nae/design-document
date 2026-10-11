import { createContext, Children, cloneElement, isValidElement, useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkDirective from 'remark-directive';
import { resolveRefPath, splitRef } from '@ddv/core';
import { remarkDdv } from '../remark-ddv.ts';
import { remarkReview, type ReviewMarks } from '../remark-review.ts';
import type { DocResponse } from '../api.ts';
import { docHref } from '../state.tsx';
import { DiagramBlock } from './DiagramBlock.tsx';
import { MermaidView } from './MermaidView.tsx';
import { Embed, RefLink } from './Ref.tsx';
import { MockFrame } from './MockFrame.tsx';
import { ThreadList, usePr } from './Pr.tsx';
import { CommentGutter, elementAtLine } from './Review.tsx';

interface MdCtx {
  basePath: string;
  doc?: DocResponse;
  depth: number;
}

const Ctx = createContext<MdCtx>({ basePath: '', depth: 0 });
export const useMd = () => useContext(Ctx);

function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}

function attrs(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (k.startsWith('data-attr-') && typeof v === 'string') out[k.slice(10)] = v;
  return out;
}

const components: Record<string, (p: any) => ReactNode> = {
  'ddv-mermaid': (p: any) => <MermaidNode code={textOf(p.children)} line={Number(p['data-line'])} />,
  'ddv-ref': (p: any) => <RefLink target={p['data-target'] ?? ''}>{p.children}</RefLink>,
  'ddv-embed': (p: any) => <Embed target={p['data-target'] ?? ''} />,
  'ddv-mock': (p: any) => <MockFrame target={p['data-target'] ?? ''} attrs={attrs(p)} />,
  'ddv-removed': (p: any) => <RemovedBlock index={Number(p['data-index'])} />,
  'ddv-threads': (p: any) => <ThreadList ids={String(p['data-ids'] ?? '').split(' ')} />,
  a: ({ node: _n, href, children, ...rest }: any) => <MdLink href={href} {...rest}>{children}</MdLink>,
  ...Object.fromEntries(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre'].map((t) => [t, (p: any) => <Hosted tag={t} {...p} />])),
  table: ({ node: _n, ...rest }: any) => (
    <div className="table-wrap">
      <table {...rest} />
    </div>
  ),
};

/** An element with a 💬 gutter in a PR workspace (marked `data-cmt` by remarkReview); a plain element otherwise. */
function Hosted({ tag: Tag, node: _n, children, ...rest }: any) {
  const { doc, depth } = useMd();
  const pr = usePr();
  const line = Number(rest['data-cmt']);
  const el = pr && doc && depth === 0 && line ? elementAtLine(doc, line) : undefined;
  if (!el || !doc) return <Tag {...rest}>{children}</Tag>;
  const gutter = <CommentGutter key="cmt" path={doc.path} element={el} />;
  const cls = (c?: string) => `${c ? `${c} ` : ''}cmt-host`;
  if (Tag === 'tr') {
    // A table row cannot hold a button itself: it goes into the first cell.
    const kids = Children.toArray(children);
    const i = kids.findIndex((k) => isValidElement(k));
    if (i < 0) return <Tag {...rest}>{children}</Tag>;
    const cell = kids[i] as ReactElement<any>;
    kids[i] = cloneElement(cell, { className: cls(cell.props.className) }, gutter, cell.props.children);
    return <Tag {...rest}>{kids}</Tag>;
  }
  return (
    <Tag {...rest} className={cls(rest.className)}>
      {gutter}
      {children}
    </Tag>
  );
}

function MermaidNode({ code, line }: { code: string; line: number }) {
  const { doc, depth } = useMd();
  const dg = depth === 0 ? doc?.diagrams.find((d) => d.line === line) : undefined;
  if (dg && doc) return <DiagramBlock doc={doc} diagram={dg} />;
  return <MermaidView code={code} />;
}

/** Content removed by the PR (差分 view). */
function RemovedBlock({ index }: { index: number }) {
  const { basePath, depth } = useMd();
  const r = usePr()?.diff?.removed[index];
  if (!r) return null;
  return (
    <div className="block removed" data-testid="removed-block">
      <Markdown text={r.markdown} basePath={basePath} depth={depth + 1} />
    </div>
  );
}

function MdLink({ href, children, ...rest }: { href?: string; children: ReactNode }) {
  const { basePath } = useMd();
  if (href && !/^[a-z]+:|^#/i.test(href)) {
    const { path, heading } = splitRef(decodeURI(href));
    if (path.endsWith('.md')) return <a href={docHref(resolveRefPath(basePath, path), heading)}>{children}</a>;
  }
  return (
    <a href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

export function Markdown({ text, basePath, doc, depth = 0, review }: { text: string; basePath: string; doc?: DocResponse; depth?: number; review?: ReviewMarks }) {
  const slugs = useMemo(() => (depth === 0 && doc ? doc.headings.map((h) => h.slug) : undefined), [doc, depth]);
  const remarkPlugins = useMemo(
    () => [remarkGfm, [remarkFrontmatter, ['yaml']], remarkDirective, [remarkDdv, { slugs }], ...(review ? [[remarkReview, review]] : [])] as any,
    [slugs, review],
  );
  const ctx = useMemo(() => ({ basePath, doc, depth }), [basePath, doc, depth]);
  return (
    <Ctx.Provider value={ctx}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components as Components}>
        {text}
      </ReactMarkdown>
    </Ctx.Provider>
  );
}
