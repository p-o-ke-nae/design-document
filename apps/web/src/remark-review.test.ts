import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import { remarkReview, type ReviewMarks } from './remark-review.ts';

const TEXT = ['---', 'id: X', '---', '', '# 見出し', '', '本文A', '', '- 項目1', '- 項目2', '', '| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '', '最後'].join('\n');

function run(marks: ReviewMarks) {
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkReview, marks);
  const mdast = p.runSync(p.parse(TEXT)) as any;
  const hast = unified().use(remarkRehype).runSync(structuredClone(mdast)) as any;
  return { mdast, hast };
}

function find(n: any, pred: (x: any) => boolean, out: any[] = []): any[] {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) find(c, pred, out);
  return out;
}

describe('remarkReview（PR 差分・スレッドの重ね合わせ）', () => {
  it('追加・変更のブロック（最上位・リスト項目・表の行）に class を付ける', () => {
    const { hast } = run({ blocks: [{ line: 7, endLine: 7, change: 'added' }, { line: 10, endLine: 10, change: 'changed' }, { line: 15, endLine: 15, change: 'added' }] });
    const p = find(hast, (x) => x.tagName === 'p' && x.properties?.className?.includes('added'));
    expect(p).toHaveLength(1);
    const li = find(hast, (x) => x.tagName === 'li' && x.properties?.className?.includes('changed'));
    expect(li).toHaveLength(1);
    const tr = find(hast, (x) => x.tagName === 'tr' && x.properties?.className?.includes('added'));
    expect(tr).toHaveLength(1);
  });

  it('削除された内容を、直後にあった head の行を含むブロックの前（null は末尾）に差し込む', () => {
    const { mdast } = run({ removed: [{ beforeLine: 10 }, { beforeLine: null }, { beforeLine: 8 }] });
    const types = mdast.children.map((n: any) => (n.type === 'ddvRemoved' ? `R${n.data.hProperties.dataIndex}` : n.type));
    expect(types).toEqual(['yaml', 'heading', 'paragraph', 'R0', 'R2', 'list', 'table', 'paragraph', 'R1']);
  });

  it('スレッドを、その行を含む最上位ブロックの後ろにまとめて差し込む', () => {
    const { mdast } = run({ threads: [{ id: 't1', line: 14 }, { id: 't2', line: 15 }, { id: 't3', line: 5 }, { id: 't4', line: 99 }] });
    const types = mdast.children.map((n: any) => (n.type === 'ddvThreads' ? `T:${n.data.hProperties.dataIds}` : n.type));
    expect(types).toEqual(['yaml', 'heading', 'T:t3', 'paragraph', 'list', 'table', 'T:t1 t2', 'paragraph']);
  });

  it('何も無いときは木を変えない', () => {
    const { mdast } = run({});
    expect(mdast.children.map((n: any) => n.type)).toEqual(['yaml', 'heading', 'paragraph', 'list', 'table', 'paragraph']);
  });
});
