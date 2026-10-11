import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { fakeGitHub, fakeGitHubState } from './github-fixture.ts';
import { Hunks } from './pr-diff.ts';
import { composeBody, judgePlacement, PendingStore, ReviewService, type ReviewTarget } from './review.ts';
import { setStatus, StatusCommitter } from './status-commit.ts';

const P = 'docs/design/basic/order.md';
const HEAD = [
  '---',
  'id: ORDER',
  'kind: basic',
  'status: review',
  'title: 注文',
  '---',
  '',
  '# 注文',
  '',
  '段落 A。',
  '',
  '段落 B。',
  '',
  '```mermaid id=flow',
  'stateDiagram-v2',
  '  [*] --> A',
  '  A --> B : go',
  '```',
  '',
].join('\n');
const lineOf = (s: string) => HEAD.split('\n').findIndex((l) => l.includes(s)) + 1;

/** RIGHT 8..12, LEFT 8..10 */
const PATCH = '@@ -8,3 +8,5 @@\n # 注文\n \n+段落 A。\n';
const BIG_PATCH = '@@ -1,6 +1,6 @@\n';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function setup(opts: { patch?: string; canPush?: boolean } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-rev-'));
  dirs.push(tmp);
  const dir = path.join(tmp, 'wt');
  await fs.mkdir(path.dirname(path.join(dir, P)), { recursive: true });
  await fs.writeFile(path.join(dir, P), HEAD);
  const state = fakeGitHubState({ pulls: { 'acme/order-app': [{ number: 12, title: 't', headSha: 'h1', headRef: 'feature/x', baseRef: 'main' }] } });
  const f = fakeGitHub(state);
  const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
  const github = new GitHubClient(tokens, { fetch: f });
  const patches: Record<string, string> = { [P]: opts.patch ?? PATCH };
  const bases: Record<string, string | null> = {};
  const ws: ReviewTarget = {
    id: 'w',
    target: { owner: 'acme', repo: 'order-app', pr: 12 },
    headSha: 'h1',
    mergeBase: 'm1',
    dir,
    pr: { headRepo: 'acme/order-app', headRef: 'feature/x', canPush: opts.canPush ?? true },
  };
  const changed: string[] = [];
  const store = new PendingStore(path.join(tmp, 'home'));
  const make = () =>
    new ReviewService({
      store,
      github,
      git: { diff: async (_o, _r, _a, _b, paths) => patches[paths[0]] ?? '', show: async (_o, _r, _sha, file) => bases[file] ?? null },
      committer: new StatusCommitter(github),
      refresh: async () => {
        ws.headSha = state.pulls['acme/order-app'][0].headSha;
        const file = path.join(dir, P);
        await fs.writeFile(file, setStatus(await fs.readFile(file, 'utf8')).text);
      },
      onChange: (id) => changed.push(id),
    });
  const write = (text: string) => fs.writeFile(path.join(dir, P), text);
  return { tmp, dir, state, ws, svc: make(), make, store, patches, bases, changed, write };
}

const el = (kind: string, key: string) => ({ path: P, element: { kind, key, label: key } });
const posts = (state: ReturnType<typeof fakeGitHubState>, suffix: string) => state.requests.filter((q) => q.method === 'POST' && q.path.endsWith(suffix));

describe('judgePlacement（PLACE）', () => {
  const h = Hunks.parse(PATCH);
  it('[DD-REVCMT-PLACE-P001] [DD-REVCMT-PLACE-T001] [DD-REVCMT-PLACE-T002] file not changed in the PR → file', () => {
    expect(judgePlacement(null, { side: 'RIGHT', startLine: 10, line: 10 }, false)).toEqual({ placement: 'file', shrunk: false });
    expect(judgePlacement(Hunks.parse(''), { side: 'RIGHT', startLine: 10, line: 10 }, false).placement).toBe('file');
  });
  it('[DD-REVCMT-PLACE-P002] [DD-REVCMT-PLACE-T003] [DD-REVCMT-PLACE-T004] range inside one hunk → line (with start_line when multi-line)', () => {
    expect(judgePlacement(h, { side: 'RIGHT', startLine: 10, line: 12 }, true)).toEqual({ placement: 'line', shrunk: false });
    expect(judgePlacement(h, { side: 'LEFT', startLine: 8, line: 10 }, false)).toEqual({ placement: 'line', shrunk: false });
  });
  it('[DD-REVCMT-PLACE-P003] [DD-REVCMT-PLACE-T005] [DD-REVCMT-PLACE-T006] only the last line fits → single line, never with a suggestion', () => {
    expect(judgePlacement(h, { side: 'RIGHT', startLine: 6, line: 10 }, false)).toEqual({ placement: 'line', shrunk: true });
  });
  it('[DD-REVCMT-PLACE-P004] [DD-REVCMT-PLACE-T005] [DD-REVCMT-PLACE-T007] outside the hunk, or a shrunk range with a suggestion → file', () => {
    expect(judgePlacement(h, { side: 'RIGHT', startLine: 17, line: 17 }, false).placement).toBe('file');
    expect(judgePlacement(h, { side: 'RIGHT', startLine: 6, line: 10 }, true).placement).toBe('file');
  });
});

describe('ReviewService: 追加・修正・削除', () => {
  it('adds a comment from an element: anchor computed (lines, lineText, element), placed by the hunks, saved to DDV_HOME/reviews', async () => {
    const { svc, ws, store, make } = await setup();
    const a = await svc.add(ws, { ...el('block', `L${lineOf('段落 A')}`), body: '直してください' });
    expect(a).toMatchObject({ state: 'Pending', placement: 'line', commitId: 'h1', anchor: { path: P, side: 'RIGHT', startLine: 10, line: 10, lineText: ['段落 A。'] } });
    const edge = await svc.add(ws, { anchor: el('edge', 'flow#edge:A|go|B'), body: '遷移' });
    expect(edge).toMatchObject({ placement: 'file', anchor: { startLine: 17, line: 17, lineText: ['  A --> B : go'], element: { kind: 'edge' } } });
    const dg = await svc.add(ws, { ...el('diagram', 'flow'), body: '図' });
    expect(dg.anchor).toMatchObject({ startLine: 14, line: 18 });
    expect(store.file('acme', 'order-app', 12)).toContain(path.join('reviews', 'acme', 'order-app', 'pr-12.json'));
    expect((await make().get(ws)).comments.map((c) => c.id)).toEqual([a.id, edge.id, dg.id]);
    await expect(fs.readdir(path.dirname(store.file('acme', 'order-app', 12)))).resolves.toEqual(['pr-12.json']);
  });

  it('accepts a ready anchor (re-reads lineText) and LEFT lines from the merge-base', async () => {
    const { svc, ws, bases } = await setup();
    bases[P] = '---\n---\n\n\n\n\n\n# 注文\n\n旧い段落\n';
    const left = await svc.add(ws, { anchor: { path: P, side: 'LEFT', startLine: 10, line: 10, lineText: ['でたらめ'], element: { kind: 'block', key: 'x', label: 'x' } }, body: '削除の理由は？' });
    expect(left).toMatchObject({ placement: 'line', anchor: { side: 'LEFT', lineText: ['旧い段落'] } });
  });

  it('validates: empty / too long body, suggestion on LEFT, unknown element, out of range', async () => {
    const { svc, ws, bases } = await setup();
    bases[P] = HEAD;
    const base = el('block', 'L10');
    await expect(svc.add(ws, { ...base, body: '  ' })).rejects.toMatchObject({ status: 422, message: 'コメントを入力してください' });
    await expect(svc.add(ws, { ...base, body: 'あ'.repeat(2001) })).rejects.toMatchObject({ status: 422, code: 'comment-too-long' });
    await expect(svc.add(ws, { ...base, body: 'あ'.repeat(2000) })).resolves.toBeTruthy();
    await expect(svc.add(ws, { anchor: { path: P, side: 'LEFT', line: 10 }, body: 'x', suggestion: 'y' })).rejects.toMatchObject({ code: 'suggestion-invalid' });
    await expect(svc.add(ws, { ...el('block', 'L999'), body: 'x' })).rejects.toMatchObject({ code: 'anchor-not-found' });
    await expect(svc.add(ws, { anchor: { path: P, line: 999 }, body: 'x' })).rejects.toMatchObject({ code: 'anchor-invalid' });
    await expect(svc.add(ws, { anchor: { path: '../secret', line: 1 }, body: 'x' })).rejects.toMatchObject({ status: 422 });
  });

  it('update edits the body / suggestion; picking a new anchor returns a Drifted comment to Pending; remove deletes', async () => {
    const { svc, ws, write } = await setup();
    const c = await svc.add(ws, { ...el('block', 'L10'), body: '元', suggestion: '段落 A（修正）。' });
    expect(c.suggestion).toBe('段落 A（修正）。');
    expect(await svc.update(ws, c.id, { body: '直し', suggestion: null })).toMatchObject({ body: '直し', placement: 'line' });
    expect((await svc.get(ws)).comments[0].suggestion).toBeUndefined();
    await write(HEAD.replace('段落 A。', '全然違う。'));
    ws.headSha = 'h2';
    expect((await svc.get(ws)).comments[0].state).toBe('Drifted');
    const moved = await svc.update(ws, c.id, { ...el('block', 'L10') });
    expect(moved).toMatchObject({ state: 'Pending', commitId: 'h2', anchor: { lineText: ['全然違う。'] } });
    expect(moved.reason).toBeUndefined();
    await expect(svc.update(ws, 'nope', { body: 'x' })).rejects.toMatchObject({ status: 404 });
    await svc.remove(ws, c.id);
    expect((await svc.get(ws)).comments).toEqual([]);
    await expect(svc.remove(ws, c.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('ReviewService.relocate（RELOC）', () => {
  const addA = (svc: ReviewService, ws: ReviewTarget) => svc.add(ws, { ...el('block', 'L10'), body: 'c' });
  const moveHead = (ws: ReviewTarget, sha = 'h2') => void (ws.headSha = sha);

  it('[DD-REVCMT-RELOC-P001] [DD-REVCMT-RELOC-T001] [DD-REVCMT-RELOC-T002] file deleted in the new head → Drifted', async () => {
    const { svc, ws, dir } = await setup();
    await addA(svc, ws);
    await fs.rm(path.join(dir, P));
    moveHead(ws);
    const r = await svc.relocate(ws, 'h2');
    expect(r.comments[0]).toMatchObject({ state: 'Drifted', reason: 'ファイルが削除された', commitId: 'h1' });
  });

  it('[DD-REVCMT-RELOC-P002] [DD-REVCMT-RELOC-T003] [DD-REVCMT-RELOC-T004] [DD-REVCMT-RELOC-T009] same content at the same line → kept, commitId updated, placement redone', async () => {
    const { svc, ws, patches } = await setup();
    const c = await addA(svc, ws);
    expect(c.placement).toBe('line');
    patches[P] = '';
    moveHead(ws);
    const r = await svc.relocate(ws, 'h2');
    expect(r.headSha).toBe('h2');
    expect(r.comments[0]).toMatchObject({ state: 'Pending', commitId: 'h2', placement: 'file', anchor: { startLine: 10, line: 10 } });
  });

  it('[DD-REVCMT-RELOC-P003] [DD-REVCMT-RELOC-T005] [DD-REVCMT-RELOC-T006] content gone → Drifted (not submittable)', async () => {
    const { svc, ws, write } = await setup();
    await addA(svc, ws);
    await write(HEAD.replace('段落 A。', '別の文'));
    moveHead(ws);
    expect((await svc.relocate(ws, 'h2')).comments[0]).toMatchObject({ state: 'Drifted', reason: '内容が変わった' });
    await expect(svc.submit(ws, 'COMMENT', '本文')).rejects.toMatchObject({ status: 422, code: 'drifted', message: '位置を確認していないコメントがあります' });
  });

  it('[DD-REVCMT-RELOC-P004] [DD-REVCMT-RELOC-T005] [DD-REVCMT-RELOC-T007] [DD-REVCMT-RELOC-T010] one matching place → moved there', async () => {
    const { svc, ws, write } = await setup();
    await svc.add(ws, { anchor: { path: P, startLine: 10, line: 12 }, body: 'c' });
    await write(HEAD.replace('# 注文\n', '# 注文\n\n追加\n追加2\n'));
    moveHead(ws);
    const r = await svc.relocate(ws, 'h2');
    expect(r.comments[0]).toMatchObject({ state: 'Pending', anchor: { startLine: 13, line: 15, lineText: ['段落 A。', '', '段落 B。'] } });
  });

  it('[DD-REVCMT-RELOC-P005] [DD-REVCMT-RELOC-T005] [DD-REVCMT-RELOC-T008] [DD-REVCMT-RELOC-T011] several places → the nearest to the old line', async () => {
    const { svc, ws, write } = await setup();
    await svc.add(ws, { anchor: { path: P, line: 10 }, body: 'c' });
    await write(HEAD.replace('# 注文\n', '# 注文\n\n段落 A。\n\n段落 A。\n\n段落 A。\n').replace('\n\n段落 B。', '\n\n別'));
    moveHead(ws);
    const lines = (await fs.readFile(path.join(ws.dir, P), 'utf8')).split('\n');
    const hits = lines.flatMap((l, i) => (l === '段落 A。' ? [i + 1] : []));
    const nearest = hits.reduce((p, h) => (Math.abs(h - 10) < Math.abs(p - 10) ? h : p));
    const r = await svc.relocate(ws, 'h2');
    expect(r.comments[0].anchor.line).toBe(nearest);
    expect(hits.length).toBeGreaterThan(1);
  });

  it('LEFT comments stay when the merge-base is unchanged and are searched again in the new merge-base otherwise', async () => {
    const { svc, ws, bases } = await setup();
    bases[P] = '\n\n\n\n\n\n\n# 注文\n\n旧い段落\n';
    await svc.add(ws, { anchor: { path: P, side: 'LEFT', line: 10 }, body: 'c' });
    moveHead(ws);
    expect((await svc.relocate(ws, 'h2')).comments[0]).toMatchObject({ state: 'Pending', commitId: 'h2', anchor: { line: 10 } });
    ws.mergeBase = 'm2';
    bases[P] = '\n\n\n\n\n\n\n\n\n\n\n# 注文\n\n旧い段落\n';
    moveHead(ws, 'h3');
    expect((await svc.relocate(ws, 'h3')).comments[0]).toMatchObject({ state: 'Pending', anchor: { side: 'LEFT', line: 14 } });
    bases[P] = null;
    ws.mergeBase = 'm3';
    expect((await svc.relocate(ws, 'h3')).comments[0].state).toBe('Drifted');
  });

  it('relocates lazily when the saved review belongs to an older head', async () => {
    const { svc, ws, make, write } = await setup();
    await addA(svc, ws);
    await write(HEAD.replace('# 注文\n', '# 注文\n\n新\n'));
    moveHead(ws);
    expect((await make().get(ws)).comments[0].anchor.line).toBe(12);
  });
});

describe('ReviewService.submit（SUBMIT / POST）', () => {
  it('[BD-GHREV-SUBMIT-P001] [BD-GHREV-SUBMIT-T001] [BD-GHREV-SUBMIT-T002] a Drifted comment blocks the submission (nothing is sent)', async () => {
    const { svc, ws, write, state } = await setup();
    await svc.add(ws, { anchor: { path: P, line: 10 }, body: 'c' });
    await write(HEAD.replace('段落 A。', 'x'));
    ws.headSha = 'h2';
    await expect(svc.submit(ws, 'APPROVE', '')).rejects.toMatchObject({ code: 'drifted', message: '位置を確認していないコメントがあります' });
    expect(state.requests).toEqual([]);
  });

  it('[BD-GHREV-SUBMIT-P006] [BD-GHREV-SUBMIT-T008] [BD-GHREV-SUBMIT-T009] Comment / Request changes need a body (or a line comment)', async () => {
    const { svc, ws, state } = await setup();
    for (const ev of ['COMMENT', 'REQUEST_CHANGES']) {
      await expect(svc.submit(ws, ev, '  ')).rejects.toMatchObject({ status: 422, code: 'body-required', message: 'Comment / Request changes には本文が必要です' });
    }
    await svc.add(ws, { anchor: { path: P, line: 17 }, body: '図の外（file）' });
    await expect(svc.submit(ws, 'COMMENT', '')).rejects.toMatchObject({ code: 'body-required' });
    await expect(svc.submit(ws, 'COMMENT', 'あ'.repeat(5001))).rejects.toMatchObject({ code: 'body-too-long' });
    await expect(svc.submit(ws, 'MERGE', 'x')).rejects.toMatchObject({ code: 'invalid-event' });
    expect(state.requests).toEqual([]);
  });

  it('[BD-GHREV-SUBMIT-P007] [BD-GHREV-SUBMIT-T010] [BD-GHREV-SUBMIT-T011] [BD-GHREV-SUBMIT-T012] [BD-GHREV-SUBMIT-T014] [DD-REVCMT-POST-P003] [DD-REVCMT-POST-P004] [DD-REVCMT-POST-T004] [DD-REVCMT-POST-T005] [DD-REVCMT-POST-T006] [DD-REVCMT-POST-T007] [DD-REVCMT-POST-T009] [DD-REVCMT-POST-T011] line comments in one review, then each file comment; the pending review ends empty', async () => {
    const { svc, ws, state, make, changed } = await setup();
    await svc.add(ws, { anchor: { path: P, startLine: 10, line: 12 }, body: '範囲', suggestion: '段落\n\n段落' });
    await svc.add(ws, { anchor: { path: P, line: 17 }, body: '差分の外' });
    await svc.add(ws, { anchor: { path: P, startLine: 14, line: 18 }, body: '図' });
    const r = await svc.submit(ws, 'REQUEST_CHANGES', '全体の所感');
    expect(r).toMatchObject({ posted: { line: 1, file: 2 }, failed: [], reviewUrl: expect.stringContaining('pullrequestreview-') });
    expect(r.statusCommit).toBeUndefined();
    const [review] = posts(state, '/pulls/12/reviews');
    expect(review.body).toMatchObject({ commit_id: 'h1', event: 'REQUEST_CHANGES', body: '全体の所感' });
    expect(review.body.comments).toEqual([{ path: P, body: '範囲\n\n```suggestion\n段落\n\n段落\n```', line: 12, side: 'RIGHT', start_line: 10, start_side: 'RIGHT' }]);
    const files = posts(state, '/pulls/12/comments');
    expect(files.map((q) => q.body)).toEqual([
      { commit_id: 'h1', path: P, body: '> L17:   A --> B : go\n\n差分の外', subject_type: 'file' },
      { commit_id: 'h1', path: P, body: '> L14-18: ```mermaid id=flow\n> stateDiagram-v2\n>   [*] --> A\n>   A --> B : go\n> ```\n\n図', subject_type: 'file' },
    ]);
    expect(state.requests.map((q) => q.path.split('/').pop())).toEqual(['reviews', 'comments', 'comments']);
    expect((await make().get(ws)).comments).toEqual([]);
    expect(changed).toContain('w');
  });

  it('a shrunk range is posted as a single line without start_line', async () => {
    const { svc, ws, state } = await setup();
    await svc.add(ws, { anchor: { path: P, startLine: 6, line: 10 }, body: '縮める' });
    await svc.submit(ws, 'COMMENT', '');
    expect(posts(state, '/reviews')[0].body.comments).toEqual([{ path: P, body: '縮める', line: 10, side: 'RIGHT' }]);
  });

  it('[DD-REVCMT-POST-P001] [DD-REVCMT-POST-T001] [DD-REVCMT-POST-T002] review creation 422 → everything stays pending, GitHub\'s reason is raised', async () => {
    const { svc, ws, state } = await setup();
    await svc.add(ws, { anchor: { path: P, line: 10 }, body: 'a' });
    await svc.add(ws, { anchor: { path: P, line: 17 }, body: 'b' });
    state.failOn.push({ match: 'POST /repos/acme/order-app/pulls/12/reviews', status: 422, message: 'Unprocessable', errors: ['line must be part of the diff'] });
    await expect(svc.submit(ws, 'COMMENT', 'x')).rejects.toMatchObject({ kind: 'validation', message: expect.stringContaining('line must be part of the diff') });
    expect((await svc.get(ws)).comments).toHaveLength(2);
    expect(posts(state, '/comments')).toEqual([]);
  });

  it('[DD-REVCMT-POST-P002] [DD-REVCMT-POST-T001] [DD-REVCMT-POST-T003] other failures keep everything pending as well', async () => {
    const { svc, ws, state } = await setup();
    await svc.add(ws, { anchor: { path: P, line: 10 }, body: 'a' });
    state.failOn.push({ match: 'POST /repos/acme/order-app/pulls/12/reviews', status: 500, message: 'boom' });
    await expect(svc.submit(ws, 'COMMENT', 'x')).rejects.toMatchObject({ kind: 'network' });
    expect((await svc.get(ws)).comments).toHaveLength(1);
  });

  it('[DD-REVCMT-POST-P005] [DD-REVCMT-POST-T008] [DD-REVCMT-POST-T009] [DD-REVCMT-POST-T010] partial failure: posted file comments are removed, the failed one and the rest stay with the reason', async () => {
    const { svc, ws, state } = await setup();
    const a = await svc.add(ws, { anchor: { path: P, line: 16 }, body: 'a' });
    const b = await svc.add(ws, { anchor: { path: P, line: 17 }, body: 'b' });
    const c = await svc.add(ws, { anchor: { path: P, line: 18 }, body: 'c' });
    state.failOn.push({ match: 'POST /repos/acme/order-app/pulls/12/comments', skip: 1, status: 422, message: 'Validation Failed' });
    const r = await svc.submit(ws, 'COMMENT', '本文');
    expect(r.posted).toEqual({ line: 0, file: 1 });
    expect(r.failed.map((f) => f.id)).toEqual([b.id, c.id]);
    expect(r.failed[0].message).toContain('Validation Failed');
    expect((await svc.get(ws)).comments.map((x) => x.id)).toEqual([b.id, c.id]);
    expect(a.placement).toBe('file');
    state.failOn.length = 0;
    expect((await svc.submit(ws, 'COMMENT', '再送')).posted.file).toBe(2);
  });

  it('[DD-REVCMT-POST-P006] [DD-REVCMT-POST-T008] [DD-REVCMT-POST-T010] first file comment fails → all file comments stay', async () => {
    const { svc, ws, state } = await setup();
    await svc.add(ws, { anchor: { path: P, line: 17 }, body: 'b' });
    state.failOn.push({ match: 'POST /repos/acme/order-app/pulls/12/comments', status: 500, message: 'boom' });
    const r = await svc.submit(ws, 'COMMENT', '本文');
    expect(r).toMatchObject({ posted: { line: 0, file: 0 }, failed: [{ message: expect.stringContaining('boom') }] });
    expect((await svc.get(ws)).comments).toHaveLength(1);
  });

  it('composeBody: matrix rows quote the test ID; file comments with a suggestion show it as plain code', async () => {
    const { svc, ws } = await setup();
    const c = await svc.add(ws, { anchor: { path: P, line: 17, element: { kind: 'matrixRow', key: 'DD-X-P001', label: 'A → B' } }, body: '本文', suggestion: '```x```' });
    expect(composeBody(c)).toBe('> DD-X-P001: A → B\n\n> L17:   A --> B : go\n\n本文\n\n提案する変更:\n\n````\n```x```\n````');
  });
});

describe('ReviewService.submit: Approve 時の status 連動（APPROVE）', () => {
  it('[BD-GHREV-SUBMIT-P002] [BD-GHREV-SUBMIT-T004] [BD-GHREV-SUBMIT-T005] [BD-GHREV-SUBMIT-T007] [BD-GHREV-APPROVE-P002] [BD-GHREV-APPROVE-T006] writable head branch → status commit, workspace refreshed, Approve on the new head (pending comments follow)', async () => {
    const { svc, ws, state, patches } = await setup();
    await svc.add(ws, { anchor: { path: P, line: 17 }, body: '図' });
    patches[P] = '';
    const r = await svc.submit(ws, 'APPROVE', '', [P]);
    const newHead = state.pulls['acme/order-app'][0].headSha;
    expect(newHead).not.toBe('h1');
    expect(r.statusCommit).toEqual({ mode: 'commit', sha: newHead, paths: [P] });
    expect(ws.headSha).toBe(newHead);
    const [review] = posts(state, '/reviews');
    expect(review.body).toMatchObject({ commit_id: newHead, event: 'APPROVE', comments: [] });
    expect(posts(state, '/pulls/12/comments')[0].body).toMatchObject({ commit_id: newHead });
    expect(state.requests.findIndex((q) => q.path.endsWith('/git/refs/heads/feature/x'))).toBeLessThan(state.requests.findIndex((q) => q.path.endsWith('/reviews')));
  });

  it('[BD-GHREV-APPROVE-P001] [BD-GHREV-APPROVE-T002] every selected document already approved → Approve only', async () => {
    const { svc, ws, state, write } = await setup();
    await write(HEAD.replace('status: review', 'status: approved'));
    const r = await svc.submit(ws, 'APPROVE', '', [P]);
    expect(r.statusCommit).toBeUndefined();
    expect(state.requests.map((q) => q.path.split('/').pop())).toEqual(['reviews']);
  });

  it('[BD-GHREV-APPROVE-P003] [BD-GHREV-APPROVE-T007] the head moved → aborted before the review, pending kept', async () => {
    const { svc, ws, state } = await setup();
    await svc.add(ws, { anchor: { path: P, line: 10 }, body: 'a' });
    state.pulls['acme/order-app'][0].headSha = 'h9';
    await expect(svc.submit(ws, 'APPROVE', '', [P])).rejects.toMatchObject({ status: 409, code: 'stale' });
    expect(posts(state, '/reviews')).toEqual([]);
    expect((await svc.get(ws)).comments).toHaveLength(1);
  });

  it('[BD-GHREV-APPROVE-P004] [BD-GHREV-APPROVE-T008] [BD-GHREV-APPROVE-T009] cannot write, status line inside the diff → suggestion on the status line', async () => {
    const { svc, ws, state } = await setup({ canPush: false, patch: BIG_PATCH });
    const r = await svc.submit(ws, 'APPROVE', '', [P]);
    expect(r.statusCommit).toEqual({ mode: 'suggestion', paths: [P] });
    expect(posts(state, '/git/blobs')).toEqual([]);
    const [review] = posts(state, '/reviews');
    expect(review.body.event).toBe('APPROVE');
    expect(review.body.comments).toEqual([{ path: P, body: 'status を approved にします（ddv の Approve 連動）\n\n```suggestion\nstatus: approved\n```', line: 4, side: 'RIGHT' }]);
    expect(posts(state, '/pulls/12/comments')).toEqual([]);
  });

  it('[BD-GHREV-APPROVE-P005] [BD-GHREV-APPROVE-T008] [BD-GHREV-APPROVE-T010] cannot write, status line outside the diff → file comment describing the change', async () => {
    const { svc, ws, state } = await setup({ canPush: false });
    await svc.submit(ws, 'APPROVE', '', [P]);
    expect(posts(state, '/reviews')[0].body.comments).toEqual([]);
    expect(posts(state, '/pulls/12/comments')[0].body).toMatchObject({
      subject_type: 'file',
      body: '> L4: status: review\n\nstatus を approved にします（ddv の Approve 連動）\n\n提案する変更:\n\n```\nstatus: approved\n```',
    });
  });

  it('approveDocs is ignored unless the event is APPROVE', async () => {
    const { svc, ws, state } = await setup();
    await svc.submit(ws, 'COMMENT', '本文', [P]);
    expect(state.requests.map((q) => q.path.split('/').pop())).toEqual(['reviews']);
  });
});
