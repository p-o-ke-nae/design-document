import { describe, expect, it } from 'vitest';
import { parseFlowchart, parseStateDiagram } from '@ddv/graph';
import { parseDoc } from './markdown.ts';
import { diagramLines, elementAt, elementsOf, toAnchor } from './anchor.ts';

const DOC = `---
id: ORDER
---
# 注文

## 画面遷移

本文の段落。
2 行目。

- 項目 1
- 項目 2

| 列 | 値 |
|---|---|
| a | 1 |

\`\`\`mermaid id=screen-flow matrix
stateDiagram-v2
  [*] --> Input
  state "入力" as Input
  Input --> Confirm : 次へ
  Confirm --> Input : 戻る
\`\`\`

\`\`\`mermaid
sequenceDiagram
  A->>B: hi
\`\`\`
`;

const lines = (text: string) => text.split('\n');
const lineOf = (s: string) => lines(DOC).findIndex((l) => l.includes(s)) + 1;

describe('source positions', () => {
  it('ParsedDoc.blocks: top-level blocks, list items and table rows', () => {
    const doc = parseDoc(DOC);
    expect(doc.blocks.map((b) => b.type)).toEqual(['heading', 'heading', 'paragraph', 'listItem', 'listItem', 'tableRow', 'tableRow', 'diagram', 'diagram']);
    const para = doc.blocks[2];
    expect([para.line, para.endLine]).toEqual([lineOf('本文の段落'), lineOf('2 行目')]);
    expect(doc.blocks[6].line).toBe(lineOf('| a | 1 |'));
  });

  it('GraphNode.line / GraphEdge.line: definition line, else first appearance', () => {
    const g = parseStateDiagram('stateDiagram-v2\n  [*] --> A\n  A --> B : go\n  state "ビー" as B\n  B --> [*]');
    expect(g.nodes.find((n) => n.id === 'A')?.line).toBe(2);
    expect(g.nodes.find((n) => n.id === 'B')?.line).toBe(4);
    expect(g.edges.map((e) => e.line)).toEqual([2, 3, 5]);
    const f = parseFlowchart('flowchart TD\n  A --> B{分岐}\n  B -->|yes| C[終了]');
    expect(f.nodes.find((n) => n.id === 'A')?.line).toBe(2);
    expect(f.nodes.find((n) => n.id === 'C')?.line).toBe(3);
    expect(f.edges.map((e) => e.line)).toEqual([2, 3]);
  });
});

describe('toAnchor', () => {
  const doc = parseDoc(DOC);
  const fence = lineOf('```mermaid id=screen-flow');

  it('[DD-REVCMT-ANCHOR-P001] [DD-REVCMT-ANCHOR-T001] [DD-REVCMT-ANCHOR-T002] [DD-REVCMT-ANCHOR-T009] block / tableRow → the block line range', () => {
    expect(toAnchor(doc, { kind: 'block', key: `L${lineOf('本文の段落')}`, label: '' })).toEqual({ startLine: lineOf('本文の段落'), line: lineOf('2 行目') });
    expect(toAnchor(doc, { kind: 'block', key: '画面遷移', label: '' })).toEqual({ startLine: lineOf('## 画面遷移'), line: lineOf('## 画面遷移') });
    expect(toAnchor(doc, { kind: 'tableRow', key: `L${lineOf('| a | 1 |')}`, label: '' })).toEqual({ startLine: lineOf('| a | 1 |'), line: lineOf('| a | 1 |') });
  });

  it('[DD-REVCMT-ANCHOR-P002] [DD-REVCMT-ANCHOR-T003] [DD-REVCMT-ANCHOR-T004] [DD-REVCMT-ANCHOR-T010] node / edge with line → fence line + line', () => {
    const input = lineOf('state "入力" as Input');
    expect(toAnchor(doc, { kind: 'node', key: 'screen-flow#node:Input', label: '' })).toEqual({ startLine: input, line: input });
    const back = lineOf('Confirm --> Input');
    expect(toAnchor(doc, { kind: 'edge', key: 'screen-flow#edge:Confirm|戻る|Input', label: '' })).toEqual({ startLine: back, line: back });
  });

  it('[DD-REVCMT-ANCHOR-P003] [DD-REVCMT-ANCHOR-T005] [DD-REVCMT-ANCHOR-T011] node / edge without line → the whole fence', () => {
    const d = doc.diagrams[0];
    expect(diagramLines(d, undefined)).toEqual({ startLine: fence, endLine: fence + 6 });
    const els = elementsOf(doc).map((e) => (e.key === 'screen-flow#node:Confirm' ? { ...e, ...diagramLines(d, undefined) } : e));
    expect(toAnchor(doc, { kind: 'node', key: 'screen-flow#node:Confirm', label: '' }, { elements: els })).toEqual({ startLine: fence, line: fence + 6 });
  });

  it('[DD-REVCMT-ANCHOR-P004] [DD-REVCMT-ANCHOR-T006] diagram → the whole fence', () => {
    expect(toAnchor(doc, { kind: 'diagram', key: 'screen-flow', label: '' })).toEqual({ startLine: fence, line: fence + 6 });
    expect(toAnchor(doc, { kind: 'diagram', key: 'diagram-2', label: '' })?.startLine).toBe(lineOfFrom('```mermaid', fence));
  });

  it('[DD-REVCMT-ANCHOR-P005] [DD-REVCMT-ANCHOR-T007] [DD-REVCMT-ANCHOR-T012] matrixRow → the opening fence line', () => {
    const a = toAnchor(doc, { kind: 'matrixRow', key: 'BD-ORDER-SCREEN-P001', label: '' }, { diagramOf: (id) => (id.startsWith('BD-ORDER-SCREEN') ? 'screen-flow' : undefined) });
    expect(a).toEqual({ startLine: fence, line: fence });
    expect(toAnchor(doc, { kind: 'matrixRow', key: 'X-1', label: '' }, { diagramOf: () => undefined })).toBeUndefined();
  });

  it('[DD-REVCMT-ANCHOR-P006] [DD-REVCMT-ANCHOR-T008] [DD-REVCMT-ANCHOR-T013] mockElement → the element range in the mock HTML', () => {
    const a = toAnchor(doc, { kind: 'mockElement', key: 'main > form', label: '' }, { mockRange: (k) => (k === 'main > form' ? { startLine: 10, endLine: 14 } : undefined) });
    expect(a).toEqual({ startLine: 10, line: 14 });
  });

  it('elementAt: node / edge first, then block, then the whole diagram', () => {
    const els = elementsOf(doc, DOC);
    expect(elementAt(els, lineOf('Confirm --> Input'))?.key).toBe('screen-flow#edge:Confirm|戻る|Input');
    expect(elementAt(els, fence)?.key).toBe('screen-flow');
    expect(elementAt(els, lineOf('2 行目'))?.label).toBe('本文の段落。');
    expect(elementAt(els, 2)).toBeUndefined();
  });
});

function lineOfFrom(s: string, after: number) {
  return lines(DOC).findIndex((l, i) => i >= after && l.includes(s)) + 1;
}
