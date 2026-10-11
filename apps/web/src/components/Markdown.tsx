import { createContext, useContext, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkDirective from 'remark-directive';
import { resolveRefPath, splitRef } from '@ddv/core';
import { remarkDdv } from '../remark-ddv.ts';
import type { DocResponse } from '../api.ts';
import { docHref } from '../state.tsx';
import { DiagramBlock } from './DiagramBlock.tsx';
import { MermaidView } from './MermaidView.tsx';
import { Embed, RefLink } from './Ref.tsx';
import { MockFrame } from './MockFrame.tsx';

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
  a: ({ node: _n, href, children, ...rest }: any) => <MdLink href={href} {...rest}>{children}</MdLink>,
  table: ({ node: _n, ...rest }: any) => (
    <div className="table-wrap">
      <table {...rest} />
    </div>
  ),
};

function MermaidNode({ code, line }: { code: string; line: number }) {
  const { doc, depth } = useMd();
  const dg = depth === 0 ? doc?.diagrams.find((d) => d.line === line) : undefined;
  if (dg && doc) return <DiagramBlock doc={doc} diagram={dg} />;
  return <MermaidView code={code} />;
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

export function Markdown({ text, basePath, doc, depth = 0 }: { text: string; basePath: string; doc?: DocResponse; depth?: number }) {
  const slugs = useMemo(() => (depth === 0 && doc ? doc.headings.map((h) => h.slug) : undefined), [doc, depth]);
  const remarkPlugins = useMemo(() => [remarkGfm, [remarkFrontmatter, ['yaml']], remarkDirective, [remarkDdv, { slugs }]] as any, [slugs]);
  const ctx = useMemo(() => ({ basePath, doc, depth }), [basePath, doc, depth]);
  return (
    <Ctx.Provider value={ctx}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components as Components}>
        {text}
      </ReactMarkdown>
    </Ctx.Provider>
  );
}
