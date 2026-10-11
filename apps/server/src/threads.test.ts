import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { elementsOf, parseDoc } from '@ddv/core';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { fakeGitHub, fakeGitHubState } from './github-fixture.ts';
import { anchorThread, ThreadService, THREAD_CACHE_MS } from './threads.ts';

const DOC = `# 注文

段落。

\`\`\`mermaid id=flow
stateDiagram-v2
  [*] --> A
  A --> B : go
\`\`\`
`;
const lines = DOC.split('\n');
const at = (s: string) => lines.findIndex((l) => l.includes(s)) + 1;
const P = 'docs/design/basic/order.md';
const els = elementsOf(parseDoc(DOC), DOC);
const t = (patch: Partial<{ path: string; line: number | null; outdated: boolean; side: 'LEFT' | 'RIGHT' }>) => ({ path: P, line: null, outdated: false, side: 'RIGHT' as const, ...patch });

describe('anchorThread', () => {
  it('[DD-REVCMT-THREAD-P001] [DD-REVCMT-THREAD-T001] [DD-REVCMT-THREAD-T002] other file → excluded', () => {
    expect(anchorThread(t({ path: 'docs/other.md', line: 1 }), P, els)).toBeUndefined();
  });
  it('[DD-REVCMT-THREAD-P002] [DD-REVCMT-THREAD-T003] [DD-REVCMT-THREAD-T004] no line → file comment at the top', () => {
    expect(anchorThread(t({ line: null }), P, els)).toEqual({ kind: 'file' });
  });
  it('[DD-REVCMT-THREAD-P003] [DD-REVCMT-THREAD-T005] [DD-REVCMT-THREAD-T006] outdated → top as an old-position comment', () => {
    expect(anchorThread(t({ line: at('段落'), outdated: true }), P, els)).toEqual({ kind: 'outdated' });
  });
  it('[DD-REVCMT-THREAD-P004] [DD-REVCMT-THREAD-T007] [DD-REVCMT-THREAD-T008] the smallest element containing the line', () => {
    const r = anchorThread(t({ line: at('A --> B') }), P, els);
    expect(r?.kind === 'element' && r.element.key).toBe('flow#edge:A|go|B');
    const p = anchorThread(t({ line: at('段落') }), P, els);
    expect(p?.kind === 'element' && p.element.kind).toBe('block');
  });
  it('[DD-REVCMT-THREAD-P005] [DD-REVCMT-THREAD-T009] no element contains the line → file comment', () => {
    expect(anchorThread(t({ line: at('段落') + 1 }), P, els)).toEqual({ kind: 'file' });
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe('ThreadService', () => {
  it('lists threads via GraphQL (unresolved first), places them and caches 30 s', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-thr-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, 'docs/design/basic'), { recursive: true });
    await fs.writeFile(path.join(dir, P), DOC);
    const state = fakeGitHubState({
      threads: {
        'acme/order-app#12': [
          { id: 'T1', path: P, line: at('段落'), resolved: true, comments: [{ id: 1, author: 'bob', body: '済' }] },
          { id: 'T2', path: P, line: at('A --> B'), comments: [{ id: 2, author: 'bob', body: '戻る遷移は？' }, { id: 3, author: 'alice', body: '追加します' }] },
          { id: 'T3', path: 'src/app.ts', line: 1, comments: [{ id: 4, author: 'bob', body: 'x' }] },
        ],
      },
    });
    const f = fakeGitHub(state);
    const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
    const gh = new GitHubClient(tokens, { fetch: f });
    let now = 1000;
    const svc = new ThreadService(gh, () => now);
    const ws = { id: 'w', target: { owner: 'acme', repo: 'order-app', pr: 12 }, headSha: 'h', dir };
    const list = await svc.list(ws, P);
    expect(list.map((x) => x.id)).toEqual(['T2', 'T1']);
    expect(list[0].comments.map((c) => c.body)).toEqual(['戻る遷移は？', '追加します']);
    expect(list[0].placement).toMatchObject({ kind: 'element', element: { kind: 'edge' } });
    expect((await svc.list(ws)).map((x) => x.id)).toEqual(['T2', 'T1', 'T3']);
    expect(state.calls.filter((c) => c === 'POST /graphql')).toHaveLength(1);
    now += THREAD_CACHE_MS;
    await svc.list(ws, P);
    expect(state.calls.filter((c) => c === 'POST /graphql')).toHaveLength(2);
    svc.invalidate('w');
    await svc.list(ws, P);
    expect(state.calls.filter((c) => c === 'POST /graphql')).toHaveLength(3);
  });
});
