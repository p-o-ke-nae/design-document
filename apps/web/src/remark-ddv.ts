import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';

export interface RemarkDdvOptions {
  /** Heading slugs in document order (from the server) to keep ids identical to the TOC. */
  slugs?: string[];
}

const BLOCKS = new Set(['heading', 'paragraph', 'table', 'list', 'blockquote']);

/**
 * Turns Mermaid fences and ddv directives into custom hast elements
 * (`ddv-mermaid`, `ddv-ref`, `ddv-embed`, `ddv-mock`) and annotates blocks with source lines.
 */
export const remarkDdv: Plugin<[RemarkDdvOptions?], Root> = (opts = {}) => (tree) => {
  let h = 0;
  visit(tree, (node: any, index, parent: any) => {
    const line = node.position?.start?.line;
    if (node.type === 'code' && node.lang === 'mermaid' && parent && index !== undefined) {
      parent.children[index] = {
        type: 'ddvMermaid',
        position: node.position,
        data: { hName: 'ddv-mermaid', hProperties: { dataLine: line, dataMeta: node.meta ?? '' }, hChildren: [{ type: 'text', value: node.value }] },
      };
      return SKIP;
    }
    if (node.type === 'textDirective' || node.type === 'leafDirective' || node.type === 'containerDirective') {
      const name = node.name as string;
      if (name === 'ref' || name === 'embed' || name === 'mock') {
        const target = toString(node).trim();
        const attrs = (node.attributes ?? {}) as Record<string, string>;
        node.data = {
          hName: `ddv-${name}`,
          hProperties: { dataTarget: target, dataLine: line, ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [`data-attr-${k}`, v])) },
        };
        return SKIP;
      }
      // Unknown directive: render back as text so content like `10:30` is not lost.
      if (parent && index !== undefined) {
        const prefix = node.type === 'textDirective' ? ':' : node.type === 'leafDirective' ? '::' : ':::';
        parent.children[index] = { type: 'text', value: `${prefix}${name}${node.children?.length ? `[${toString(node)}]` : ''}` };
      }
      return SKIP;
    }
    if (BLOCKS.has(node.type)) {
      node.data ??= {};
      node.data.hProperties = { ...(node.data.hProperties ?? {}), dataLine: line };
      if (node.type === 'heading' && opts.slugs) {
        const slug = opts.slugs[h++];
        if (slug) node.data.hProperties.id = slug;
      }
    }
  });
};
