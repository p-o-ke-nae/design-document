import type { Plugin } from 'unified';
import type { Root } from 'mdast';

export interface ReviewMarks {
  /** Changed source blocks of the PR diff (head lines); absent = body view. */
  blocks?: { line: number; endLine: number; change: 'added' | 'changed' }[];
  /** Removed content, inserted before the head line it preceded (null = end of the document). */
  removed?: { beforeLine: number | null }[];
  /** Review threads anchored to an element (head lines). */
  threads?: { id: string; line: number }[];
  /** Start lines of the commentable source blocks; matching nodes get `data-cmt` (the 💬 gutter). */
  commentLines?: number[];
}

const startOf = (n: any): number | undefined => n.position?.start?.line;
const endOf = (n: any): number | undefined => n.position?.end?.line;

function mark(node: any, change: string) {
  node.data ??= {};
  const hp = (node.data.hProperties ??= {});
  const cls = Array.isArray(hp.className) ? hp.className : hp.className ? [hp.className] : [];
  hp.className = [...cls, 'block', change];
  hp.dataChange = change;
}

/**
 * PR review overlay: marks added / changed blocks (top-level, list items, table rows),
 * inserts removed content (`ddv-removed`) and the threads of each top-level block (`ddv-threads`).
 * Run after `remarkDdv`.
 */
export const remarkReview: Plugin<[ReviewMarks?], Root> = (opts = {}) => (tree) => {
  const changes = new Map((opts.blocks ?? []).map((b) => [b.line, b.change]));
  const top = tree.children.filter((n) => n.type !== 'yaml' && startOf(n) !== undefined);

  if (opts.commentLines?.length) {
    const lines = new Set(opts.commentLines);
    const walk = (node: any, isTop: boolean) => {
      const s = startOf(node);
      if (s !== undefined && lines.has(s) && (isTop || node.type === 'listItem' || node.type === 'tableRow') && node.type !== 'list' && node.type !== 'table') {
        node.data ??= {};
        node.data.hProperties = { ...(node.data.hProperties ?? {}), dataCmt: `${s}` };
      }
      for (const ch of node.children ?? []) walk(ch, false);
    };
    for (const n of top) walk(n, true);
  }
  if (changes.size) {
    const walk = (node: any, isTop: boolean) => {
      const s = startOf(node);
      if ((isTop || node.type === 'listItem' || node.type === 'tableRow') && s !== undefined) {
        const c = changes.get(s);
        if (c) mark(node, c);
      }
      for (const ch of node.children ?? []) walk(ch, false);
    };
    for (const n of top) walk(n, true);
  }

  const before = new Map<any, any[]>();
  const after = new Map<any, any[]>();
  const tail: any[] = [];
  const push = (m: Map<any, any[]>, k: any, v: any) => m.set(k, [...(m.get(k) ?? []), v]);

  (opts.removed ?? []).forEach((r, i) => {
    const node = { type: 'ddvRemoved', data: { hName: 'ddv-removed', hProperties: { dataIndex: i } } };
    const target =
      r.beforeLine === null
        ? undefined
        : top.find((n) => startOf(n)! <= r.beforeLine! && r.beforeLine! <= endOf(n)!) ?? top.find((n) => startOf(n)! >= r.beforeLine!);
    if (target) push(before, target, node);
    else tail.push(node);
  });

  const byTop = new Map<any, string[]>();
  for (const t of opts.threads ?? []) {
    const n = top.find((x) => startOf(x)! <= t.line && t.line <= endOf(x)!);
    if (n) byTop.set(n, [...(byTop.get(n) ?? []), t.id]);
  }
  for (const [n, ids] of byTop) push(after, n, { type: 'ddvThreads', data: { hName: 'ddv-threads', hProperties: { dataIds: ids.join(' ') } } });

  if (!before.size && !after.size && !tail.length) return;
  const out: any[] = [];
  for (const n of tree.children) {
    out.push(...(before.get(n) ?? []), n, ...(after.get(n) ?? []));
  }
  out.push(...tail);
  tree.children = out;
};
