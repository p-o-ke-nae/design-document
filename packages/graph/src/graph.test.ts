import { describe, expect, it } from 'vitest';
import { pathsThrough, diffGraphs, generateMatrix, parseFlowchart, parseMermaidGraph, parseStateDiagram, START, END } from './index.ts';

const ORDER = `stateDiagram-v2
  [*] --> Draft
  state "下書き" as Draft
  Draft --> Submitted : submit [valid]
  Draft --> Draft : edit
  Submitted --> Approved : approve / notify
  Submitted --> Draft : reject
  Approved --> [*]
`;

describe('parseStateDiagram', () => {
  it('parses states, labels and pseudo states', () => {
    const g = parseStateDiagram(ORDER);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([START, END, 'Approved', 'Draft', 'Submitted'].sort());
    expect(g.nodes.find((n) => n.id === 'Draft')!.label).toBe('下書き');
    const submit = g.edges.find((e) => e.event === 'submit')!;
    expect(submit).toMatchObject({ from: 'Draft', to: 'Submitted', guard: 'valid', action: '' });
    expect(g.edges.find((e) => e.event === 'approve')!.action).toBe('notify');
    expect(g.warnings).toEqual([]);
  });

  it('collects req annotations and warns for unsupported syntax', () => {
    const g = parseStateDiagram(`stateDiagram-v2\n%% req: Draft REQ-001, REQ-002\nstate Busy {\n[*] --> X\n}\n`);
    expect(g.annotations.Draft).toEqual(['REQ-001', 'REQ-002']);
    expect(g.warnings.some((w) => w.includes('複合状態'))).toBe(true);
  });

  it('keeps duplicate edge keys unique', () => {
    const g = parseStateDiagram(`stateDiagram-v2\nA --> B : go\nA --> B : go\n`);
    expect(g.edges.map((e) => e.key)).toEqual(['A|go|B', 'A|go|B#2']);
  });
});

describe('parseFlowchart', () => {
  it('parses shapes, labels, chains and &', () => {
    const g = parseFlowchart(`flowchart TD
      A([開始]) --> B{在庫あり?}
      B -->|はい| C[引当] --> E((終了))
      B -- いいえ --> D["入荷待ち (通知)"]
      D -.-> E
      X & Y --> Z
      subgraph S
      end
    `);
    expect(g.nodes.find((n) => n.id === 'B')).toMatchObject({ label: '在庫あり?', role: 'choice' });
    expect(g.nodes.find((n) => n.id === 'D')!.label).toBe('入荷待ち (通知)');
    expect(g.edges.map((e) => `${e.from}>${e.to}:${e.label}`)).toEqual([
      'A>B:',
      'B>C:はい',
      'C>E:',
      'B>D:いいえ',
      'D>E:',
      'X>Z:',
      'Y>Z:',
    ]);
    expect(g.warnings).toEqual([]);
  });

  it('detects diagram type', () => {
    expect(parseMermaidGraph('graph LR\nA-->B')!.kind).toBe('flowchart');
    expect(parseMermaidGraph('sequenceDiagram\nA->>B: hi')).toBeNull();
  });
});

describe('generateMatrix', () => {
  const g = parseStateDiagram(ORDER);

  it('covers every transition with an executable prefix', () => {
    const m = generateMatrix(g, { nSwitch: 0 });
    const t = m.cases.filter((c) => c.kind === 'T');
    expect(t).toHaveLength(g.edges.length);
    const approve = t.find((c) => c.signature === 'T:Submitted|approve / notify|Approved')!;
    expect(approve.nodes).toEqual([START, 'Draft', 'Submitted', 'Approved']);
  });

  it('enumerates simple paths with loop limit', () => {
    const p0 = generateMatrix(g, { loopLimit: 0, nSwitch: 0 }).cases.filter((c) => c.kind === 'P');
    expect(p0.map((c) => c.nodes.join('>'))).toEqual([`${START}>Draft>Submitted>Approved>${END}`]);
    const p1 = generateMatrix(g, { loopLimit: 1, nSwitch: 0 }).cases.filter((c) => c.kind === 'P');
    expect(p1.length).toBeGreaterThan(1);
    expect(p1.every((c) => c.nodes[c.nodes.length - 1] === END)).toBe(true);
  });

  it('builds the state x event table and invalid transitions', () => {
    const m = generateMatrix(g);
    expect(m.table!.events).toEqual(['submit', 'edit', 'approve', 'reject']);
    expect(m.table!.cells.Draft.submit).toEqual(['Submitted']);
    const x = m.cases.filter((c) => c.kind === 'X').map((c) => c.signature);
    expect(x).toContain('X:Approved|submit');
    expect(x).not.toContain('X:Draft|submit');
  });

  it('generates 1-switch sequences', () => {
    const s = generateMatrix(g, { nSwitch: 1 }).cases.filter((c) => c.kind === 'S');
    expect(s.some((c) => c.signature === 'S:Draft|submit [valid]|Submitted>Submitted|reject|Draft')).toBe(true);
    expect(s.every((c) => c.signature.split('>').length === 2)).toBe(true);
  });

  it('caps the number of paths', () => {
    const big = parseFlowchart('flowchart LR\n' + Array.from({ length: 12 }, (_, i) => `N${i} --> N${i + 1}\nN${i} --> M${i} --> N${i + 1}`).join('\n'));
    const m = generateMatrix(big, { maxPaths: 50, nSwitch: 0 });
    expect(m.cases.filter((c) => c.kind === 'P')).toHaveLength(50);
    expect(m.warnings.some((w) => w.includes('上限'))).toBe(true);
  });

  it('reports unreachable nodes', () => {
    const m = generateMatrix(parseStateDiagram('stateDiagram-v2\n[*] --> A\nB --> A'));
    expect(m.warnings.some((w) => w.includes('到達不能'))).toBe(true);
  });
});

describe('pathsThrough', () => {
  it('collects all paths through a node or edge', () => {
    const g = parseFlowchart('flowchart LR\nS[開始] --> A[a] --> E[終了]\nS --> B[b] --> E\n');
    const n = pathsThrough(g, { type: 'node', id: 'A' });
    expect(n.nodes.sort()).toEqual(['A', 'E', 'S']);
    const e = pathsThrough(g, { type: 'edge', index: g.edges.find((x) => x.to === 'B')!.index });
    expect(e.nodes).toContain('B');
    expect(e.nodes).not.toContain('A');
  });
});

describe('diffGraphs', () => {
  it('detects added, removed and changed nodes and edges', () => {
    const asis = parseFlowchart('flowchart LR\nA[受付] --> B[紙で記入] --> C[入力]\n');
    const tobe = parseFlowchart('flowchart LR\n%% req: D REQ-010\nA[受付] --> D[Web入力] --> C[システム登録]\n');
    const d = diffGraphs(asis, tobe);
    const s = d.items.map((i) => `${i.type}:${i.status}:${i.key}`).sort();
    expect(s).toEqual(['edge:added:A->D', 'edge:added:D->C', 'edge:removed:A->B', 'edge:removed:B->C', 'node:added:D', 'node:changed:C', 'node:removed:B'].sort());
    expect(d.items.find((i) => i.key === 'D' && i.type === 'node')!.reqs).toEqual(['REQ-010']);
    expect(d.after.nodes.D).toBe('added');
    expect(d.before.nodes.B).toBe('removed');
  });

  it('pairs corresponding nodes and edges across both sides', () => {
    const asis = parseStateDiagram('stateDiagram-v2\nA --> B : x\nB --> C : go');
    const tobe = parseStateDiagram('stateDiagram-v2\nA --> B : y\nB --> C : go');
    const d = diffGraphs(asis, tobe);
    expect(d.pairs.nodes.sort()).toEqual(['A', 'B', 'C']);
    expect(d.pairs.edges).toHaveLength(2);
    expect(d.pairs.edges.every((p) => typeof p.before === 'number' && typeof p.after === 'number')).toBe(true);
  });

  it('detects changed edge labels', () => {
    const d = diffGraphs(parseStateDiagram('stateDiagram-v2\nA --> B : x'), parseStateDiagram('stateDiagram-v2\nA --> B : y'));
    expect(d.items).toEqual([{ type: 'edge', status: 'changed', key: 'A->B', before: 'x', after: 'y', reqs: [] }]);
  });
});
