import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDoc } from '@ddv/core';
import { GitCache } from './git.ts';
import { createUpstream } from './github-fixture.ts';
import { DiffService, Hunks, matchDiagrams, type DiffTarget } from './pr-diff.ts';
import { parseConfig } from '@ddv/core';

const PATCH = `diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -2,4 +2,5 @@
 ctx2
-old3
+new3
+new3b
 ctx4
 ctx5
@@ -20 +21,0 @@
-gone20
`;

describe('Hunks', () => {
  const h = Hunks.parse(PATCH);
  it('parses ranges and changed lines', () => {
    expect(h.hunks.map((x) => [x.oldStart, x.oldLines, x.newStart, x.newLines])).toEqual([
      [2, 4, 2, 5],
      [20, 1, 21, 0],
    ]);
    expect([...h.addedLines()]).toEqual([3, 4]);
    expect([...h.removedLines()]).toEqual([
      [3, 3],
      [20, 21],
    ]);
  });
  it('contains: the range must fit one hunk on the side', () => {
    expect(h.contains('RIGHT', 2, 6)).toBe(true);
    expect(h.contains('RIGHT', 6, 7)).toBe(false);
    expect(h.contains('LEFT', 2, 5)).toBe(true);
    expect(h.contains('LEFT', 20, 20)).toBe(true);
    expect(h.contains('RIGHT', 21, 21)).toBe(false);
  });
});

const fence = (meta: string, code: string) => `\`\`\`mermaid${meta ? ` ${meta}` : ''}\n${code}\n\`\`\``;
const diagrams = (md: string) => parseDoc(md).diagrams;

describe('matchDiagrams', () => {
  const S1 = 'stateDiagram-v2\n  [*] --> A\n  A --> B : go';
  const S2 = 'stateDiagram-v2\n  [*] --> A\n  A --> B : go\n  B --> A : back';
  it('[DD-REVCMT-DGMATCH-P001] [DD-REVCMT-DGMATCH-T001] [DD-REVCMT-DGMATCH-T002] [DD-REVCMT-DGMATCH-T003] same id in base → diffGraphs', () => {
    const r = matchDiagrams(diagrams(fence('id=flow', S1)), diagrams(`# x\n\n${fence('id=flow', S2)}`));
    expect(r.flow.change).toBe('changed');
    expect(r.flow.diff?.items.some((i) => i.status === 'added')).toBe(true);
    expect(r.flow.before).toBe(S1);
  });
  it('[DD-REVCMT-DGMATCH-P001] [DD-REVCMT-DGMATCH-T001] line endings and trailing spaces do not make a diagram changed (CRLF worktree vs LF blob)', () => {
    const crlf = fence('id=flow', S1).replace(/\n/g, '\r\n');
    const r = matchDiagrams(diagrams(fence('id=flow', S1)), diagrams(crlf));
    expect(r.flow.change).toBe('unchanged');
    const spaced = fence('id=flow', S1.replace(/\n/g, '  \n'));
    expect(matchDiagrams(diagrams(fence('id=flow', S1)), diagrams(spaced)).flow.change).toBe('unchanged');
    const edited = diagrams(fence('id=flow', S2).replace(/\n/g, '\r\n'));
    const c = matchDiagrams(diagrams(fence('id=flow', S1)), edited);
    expect(c.flow.change).toBe('changed');
    expect(c.flow.before).toBe(S1);
  });
  it('[DD-REVCMT-DGMATCH-P002] [DD-REVCMT-DGMATCH-T004] id not in base → added (and base-only → removed)', () => {
    const r = matchDiagrams(diagrams(fence('id=old', S1)), diagrams(fence('id=flow', S1)));
    expect(r.flow).toEqual({ change: 'added' });
    expect(r.old).toMatchObject({ change: 'removed', before: S1 });
  });
  it('[DD-REVCMT-DGMATCH-P003] [DD-REVCMT-DGMATCH-T005] [DD-REVCMT-DGMATCH-T006] id-less diagrams pair by order', () => {
    const base = diagrams(`${fence('', S1)}\n\n${fence('id=x', S1)}\n\n${fence('', 'sequenceDiagram\n  A->>B: hi')}`);
    const head = diagrams(`${fence('id=x', S1)}\n\n${fence('', S1)}\n\n${fence('', 'sequenceDiagram\n  A->>B: bye')}`);
    const r = matchDiagrams(base, head);
    expect(r.x.change).toBe('unchanged');
    expect(r['diagram-2']).toMatchObject({ change: 'unchanged', beforeId: 'diagram-1' });
    expect(r['diagram-3']).toMatchObject({ change: 'changed', beforeId: 'diagram-3' });
    expect(r['diagram-3'].diff).toBeUndefined();
  });
  it('[DD-REVCMT-DGMATCH-P004] [DD-REVCMT-DGMATCH-T007] no id-less diagram at the same position → added', () => {
    const r = matchDiagrams(diagrams(fence('', S1)), diagrams(`${fence('', S1)}\n\n${fence('', S2)}`));
    expect(r['diagram-1'].change).toBe('unchanged');
    expect(r['diagram-2']).toEqual({ change: 'added' });
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const BASE_DOC = `---
id: ORDER
status: review
---
# 注文

## 概要

残る段落。

消える段落。

- 項目 1

\`\`\`mermaid id=flow matrix
stateDiagram-v2
  [*] --> A
  A --> B : go
\`\`\`
`;

const HEAD_DOC = `---
id: ORDER
status: review
---
# 注文

## 概要

残る段落。

- 項目 1
- 項目 2

新しい段落。

\`\`\`mermaid id=flow matrix
stateDiagram-v2
  [*] --> A
  A --> B : go
  B --> A : back
\`\`\`
`;

const lock = (ids: string[], retired: string[] = []) =>
  JSON.stringify({
    version: 1,
    diagrams: {
      'BD-ORDER-FLOW': {
        doc: 'docs/design/basic/order.md',
        diagram: 'flow',
        next: {},
        cases: Object.fromEntries([...ids.map((id) => [id, { id, status: 'active', title: id }]), ...retired.map((id) => [id, { id, status: 'retired', title: id }])]),
      },
    },
  });

describe('DiffService', () => {
  async function prepare() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-diff-'));
    dirs.push(tmp);
    const up = await createUpstream(path.join(tmp, 'up'));
    up.commit('main', { 'docs/design/basic/order.md': BASE_DOC, 'docs/design/basic/old.md': '# 旧\n', '.ddv/testids.lock.json': lock(['BD-ORDER-FLOW-P001', 'BD-ORDER-FLOW-P002']) });
    const head = up.commit('feature/x', {
      'docs/design/basic/order.md': HEAD_DOC,
      'docs/design/basic/new.md': '# 新\n\n本文。\n',
      'docs/mocks/order/index.html': '<p>x</p>\n',
      'src/app.ts': 'x\n',
      '.ddv/testids.lock.json': lock(['BD-ORDER-FLOW-P001', 'BD-ORDER-FLOW-P003'], ['BD-ORDER-FLOW-P002']),
    });
    up.git('checkout', '-q', 'feature/x');
    up.git('rm', '-q', 'docs/design/basic/old.md');
    up.git('commit', '-q', '-m', 'rm');
    const headSha = up.git('rev-parse', 'HEAD');
    up.git('checkout', '-q', 'main');
    void head;
    const git = new GitCache(path.join(tmp, 'home'), { gitEnv: async () => ({ env: {}, redact: (s) => s }) }, { remoteUrl: (o, r) => path.join(tmp, 'up', o, r) });
    await git.ensureClone('acme', 'order-app');
    const mergeBase = await git.mergeBase('acme', 'order-app', 'main', headSha);
    const dir = await git.addWorktree('acme', 'order-app', 'pr-12', headSha);
    const ws: DiffTarget = { id: 'acme~order-app~pr-12', target: { owner: 'acme', repo: 'order-app' }, headSha, mergeBase, dir };
    const config = parseConfig({ docsRoot: 'docs/design', mocksRoot: 'docs/mocks' });
    return { svc: new DiffService(git), ws, config };
  }

  it('files: docs / mocks with A/M/D, others counted', async () => {
    const { svc, ws, config } = await prepare();
    const f = await svc.files(ws, config);
    expect(f.docs.map((d) => `${d.status} ${d.path}`).sort()).toEqual(['A docs/design/basic/new.md', 'D docs/design/basic/old.md', 'M docs/design/basic/order.md']);
    expect(f.mocks.map((d) => `${d.status} ${d.path}`)).toEqual(['A docs/mocks/order/index.html']);
    expect(f.others).toBe(2);
  });

  it('docDiff: changed blocks, removed blocks, diagram diff and ID changes', async () => {
    const { svc, ws, config } = await prepare();
    const d = await svc.docDiff(ws, config, 'docs/design/basic/order.md');
    const lines = HEAD_DOC.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s)) + 1;
    expect(d.status).toBe('M');
    expect(d.blocks).toEqual(
      expect.arrayContaining([
        { line: at('- 項目 2'), endLine: at('- 項目 2'), change: 'added' },
        { line: at('新しい段落'), endLine: at('新しい段落'), change: 'added' },
        { line: at('```mermaid'), endLine: at('```mermaid') + 5, change: 'changed' },
      ]),
    );
    expect(d.blocks.some((b) => b.line === at('残る段落'))).toBe(false);
    expect(d.removed).toEqual([{ beforeLine: at('- 項目 1'), markdown: '消える段落。' }]);
    expect(d.diagrams.flow.change).toBe('changed');
    expect(d.diagrams.flow.diff?.items.filter((i) => i.status === 'added').length).toBeGreaterThan(0);
    expect(d.ids).toEqual({ added: ['BD-ORDER-FLOW-P003'], retired: ['BD-ORDER-FLOW-P002'] });
    expect(d.patch).toContain('+新しい段落。');
  });

  it('docDiff: added / deleted / unchanged documents', async () => {
    const { svc, ws, config } = await prepare();
    const a = await svc.docDiff(ws, config, 'docs/design/basic/new.md');
    expect(a.status).toBe('A');
    expect(a.blocks.map((b) => b.change)).toEqual(['added', 'added']);
    const del = await svc.docDiff(ws, config, 'docs/design/basic/old.md');
    expect(del.status).toBe('D');
    expect(del.removed).toEqual([{ beforeLine: null, markdown: '# 旧\n' }]);
    const none = await svc.docDiff(ws, config, 'docs/design/basic/none.md');
    expect(none.status).toBeNull();
  });
});
