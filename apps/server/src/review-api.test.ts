import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { createContext } from './app.ts';
import { GitCache } from './git.ts';
import { createUpstream, fakeGitHub, fakeGitHubState, type FakeGitHubState, type Upstream } from './github-fixture.ts';
import { createServerApp } from './host.ts';
import { WorkspaceManager } from './workspaces.ts';

const PORT = 5179;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DOC_PATH = 'docs/design/basic/order.md';
const FEATURE_DOC = '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文\n---\n\n# 注文\n\n変更後\n';

interface Env {
  tmp: string;
  up: Upstream;
  state: FakeGitHubState;
  manager: WorkspaceManager;
  id: string;
  json: <T = any>(p: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  req: (p: string, init?: RequestInit) => Promise<Response>;
}

const envs: Env[] = [];

async function setup(): Promise<Env> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-rapi-'));
  const up = await createUpstream(path.join(tmp, 'up'));
  const mainSha = up.git('rev-parse', 'main');
  const featSha = up.commit('feature/x', { [DOC_PATH]: FEATURE_DOC });
  up.setPull(12, featSha);
  const state = fakeGitHubState({
    pulls: { 'acme/order-app': [{ number: 12, title: '注文画面の修正', headSha: featSha, headRef: 'feature/x', baseRef: 'main' }] },
    refs: { 'acme/order-app': { main: mainSha } },
    upstream: up,
  });
  const f = fakeGitHub(state);
  const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
  const home = path.join(tmp, 'home');
  const git = new GitCache(home, tokens, { remoteUrl: (o, r) => path.join(tmp, 'up', o, r) });
  const manager = new WorkspaceManager({ home, github: new GitHubClient(tokens, { fetch: f }), git, createContext: (d) => createContext(d, { watch: false }), pollSeconds: 0 });
  await manager.init();
  const app = createServerApp({ manager, tokens, port: PORT });
  const req = async (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('host', `127.0.0.1:${PORT}`);
    if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
    return app.request(`${ORIGIN}${p}`, { ...init, headers });
  };
  const json = async (p: string, init?: RequestInit) => {
    const res = await req(p, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const opened = await json('/api/workspaces', send('POST', { repo: 'acme/order-app', pr: 12 }));
  await manager.settled(opened.body.id);
  const env = { tmp, up, state, manager, id: opened.body.id as string, json, req };
  envs.push(env);
  return env;
}

const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

afterEach(async () => {
  for (const e of envs.splice(0)) {
    e.manager.dispose();
    await fs.rm(e.tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('レビューの書き込み API（REVCMT）', () => {
  it('コメントの追加 → 保留の取得 → 修正 → 削除。エラーは { code, message }', async () => {
    const { json, id } = await setup();
    const base = `/api/w/${id}/review`;
    expect(await json(base)).toMatchObject({ status: 200, body: { comments: [] } });

    const added = await json(`${base}/comments`, send('POST', { path: DOC_PATH, element: { kind: 'block', key: 'L10', label: '変更後' }, body: 'ここは？' }));
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ state: 'Pending', placement: 'line', anchor: { path: DOC_PATH, side: 'RIGHT', startLine: 10, line: 10, lineText: ['変更後'] } });
    expect((await json(base)).body.comments).toHaveLength(1);

    const patched = await json(`${base}/comments/${added.body.id}`, send('PATCH', { body: '修正', suggestion: '変更後（案）' }));
    expect(patched).toMatchObject({ status: 200, body: { body: '修正', suggestion: '変更後（案）' } });

    expect(await json(`${base}/comments`, send('POST', { path: DOC_PATH, element: { kind: 'block', key: 'L10' }, body: '' }))).toMatchObject({
      status: 422,
      body: { code: 'comment-required', message: 'コメントを入力してください', error: 'コメントを入力してください' },
    });
    expect((await json(`${base}/comments`, send('POST', { anchor: { path: DOC_PATH, line: 999 }, body: 'x' }))).status).toBe(422);
    expect((await json(`${base}/comments`, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await json(`${base}/comments/nope`, send('DELETE'))).status).toBe(404);
    expect(await json(`${base}/comments/${added.body.id}`, send('DELETE'))).toEqual({ status: 200, body: { ok: true } });
    expect((await json(base)).body.comments).toEqual([]);
  });

  it('書き込みの経路は Host / Origin の確認を通る', async () => {
    const { req, id } = await setup();
    const bad = await req(`/api/w/${id}/review/comments`, { ...send('POST', { path: DOC_PATH, line: 10, body: 'x' }), headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
    expect(bad.status).toBe(403);
    const submit = await req(`/api/w/${id}/review/submit`, { ...send('POST', { event: 'APPROVE' }), headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
    expect(submit.status).toBe(403);
    const reply = await req(`/api/w/${id}/pr/threads/T1/replies`, { ...send('POST', { body: 'x' }), headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
    expect(reply.status).toBe(403);
  });

  it('送信：行コメントを 1 つのレビューにまとめて投稿し、保留が空になる。Drifted・本文なしは 422', async () => {
    const { json, id, state } = await setup();
    const base = `/api/w/${id}/review`;
    await json(`${base}/comments`, send('POST', { path: DOC_PATH, element: { kind: 'block', key: 'L10' }, body: 'ここは？' }));
    expect(await json(`${base}/submit`, send('POST', { event: 'MERGE' }))).toMatchObject({ status: 422, body: { code: 'invalid-event' } });
    const r = await json(`${base}/submit`, send('POST', { event: 'REQUEST_CHANGES', body: '直してください' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ posted: { line: 1, file: 0 }, failed: [], reviewUrl: expect.stringContaining('/pull/12#pullrequestreview-') });
    const review = state.requests.find((q) => q.method === 'POST' && q.path.endsWith('/pulls/12/reviews'))!;
    expect(review.body).toMatchObject({ event: 'REQUEST_CHANGES', body: '直してください', comments: [{ path: DOC_PATH, line: 10, side: 'RIGHT', body: 'ここは？' }] });
    expect((await json(base)).body.comments).toEqual([]);
    expect(await json(`${base}/submit`, send('POST', { event: 'COMMENT', body: '' }))).toMatchObject({ status: 422, body: { message: 'Comment / Request changes には本文が必要です' } });
    expect((await json(`/api/w/${id}/reviews`)).body).toEqual([{ login: 'alice', state: 'CHANGES_REQUESTED', submittedAt: expect.any(String) }]);
  });

  it('[BD-GHREV-APPROVE-P002] Approve + status 連動：head ブランチへ 1 コミット → ワークスペースを新しい head に最新化 → 新しい head へ Approve', async () => {
    const { json, id, state, manager, up } = await setup();
    const base = `/api/w/${id}/review`;
    await json(`${base}/comments`, send('POST', { path: DOC_PATH, element: { kind: 'block', key: 'L10' }, body: 'ここは？' }));
    const before = manager.get(id)!.headSha;
    const r = await json(`${base}/submit`, send('POST', { event: 'APPROVE', body: 'LGTM', approveDocs: [DOC_PATH] }));
    expect(r.status).toBe(200);
    const newHead = state.pulls['acme/order-app'][0].headSha;
    expect(newHead).not.toBe(before);
    expect(r.body.statusCommit).toEqual({ mode: 'commit', sha: newHead, paths: [DOC_PATH] });
    expect(manager.get(id)!.headSha).toBe(newHead);
    expect(up.git('show', `${newHead}:${DOC_PATH}`)).toContain('status: approved');
    expect(await fs.readFile(path.join(manager.get(id)!.dir, DOC_PATH), 'utf8')).toContain('status: approved');
    const review = state.requests.find((q) => q.method === 'POST' && q.path.endsWith('/pulls/12/reviews'))!;
    expect(review.body).toMatchObject({ commit_id: newHead, event: 'APPROVE', comments: [{ line: 10 }] });
  });

  it('push 権限がない PR では status 行への suggestion を付けて Approve する', async () => {
    const { json, id, state } = await setup();
    state.pulls['acme/order-app'][0].canPush = false;
    await json(`/api/w/${id}/pr`);
    const manager = envs[0].manager;
    manager.get(id)!.pr = undefined;
    const r = await json(`/api/w/${id}/review/submit`, send('POST', { event: 'APPROVE', approveDocs: [DOC_PATH] }));
    expect(r.body.statusCommit).toEqual({ mode: 'suggestion', paths: [DOC_PATH] });
    const review = state.requests.find((q) => q.method === 'POST' && q.path.endsWith('/pulls/12/reviews'))!;
    expect(review.body.comments[0]).toMatchObject({ line: 4, body: expect.stringContaining('```suggestion\nstatus: approved\n```') });
    expect(state.requests.some((q) => q.path.endsWith('/git/blobs'))).toBe(false);
  });

  it('最新化すると保留コメントが新しい head の行へ付け直される', async () => {
    const { json, id, up, manager, state } = await setup();
    const base = `/api/w/${id}/review`;
    const c = await json(`${base}/comments`, send('POST', { path: DOC_PATH, element: { kind: 'block', key: 'L10' }, body: 'ここは？' }));
    const sha = up.commit('feature/x', { [DOC_PATH]: FEATURE_DOC.replace('# 注文\n', '# 注文\n\n追加の段落\n') });
    up.setPull(12, sha);
    state.pulls['acme/order-app'][0].headSha = sha;
    const res = await json(`/api/workspaces/${id}/refresh`, send('POST'));
    expect(res.status).toBe(202);
    await manager.settled(id);
    await expect
      .poll(async () => (await json(base)).body.comments[0])
      .toMatchObject({ id: c.body.id, state: 'Pending', commitId: sha, anchor: { startLine: 12, line: 12 } });
  });

  it('スレッドへの返信と解決 / 未解決', async () => {
    const { json, id, state } = await setup();
    state.threads['acme/order-app#12'] = [{ id: 'T1', path: DOC_PATH, line: 10, comments: [{ id: 7, author: 'bob', body: '質問' }] }];
    const reply = await json(`/api/w/${id}/pr/threads/T1/replies`, send('POST', { body: '回答' }));
    expect(reply).toMatchObject({ status: 201, body: { author: 'alice', body: '回答' } });
    expect((await json(`/api/w/${id}/pr/threads?path=${DOC_PATH}`)).body[0].comments).toHaveLength(2);
    expect(await json(`/api/w/${id}/pr/threads/T1/resolve`, send('POST', { resolved: true }))).toEqual({ status: 200, body: { id: 'T1', resolved: true } });
    expect((await json(`/api/w/${id}/pr/threads?path=${DOC_PATH}`)).body[0].resolved).toBe(true);
    expect((await json(`/api/w/${id}/pr/threads/T1/resolve`, send('POST', { resolved: 'yes' }))).status).toBe(422);
    expect((await json(`/api/w/${id}/pr/threads/zzz/replies`, send('POST', { body: 'x' }))).status).toBe(404);
    expect((await json(`/api/w/${id}/pr/threads/T1/replies`, send('POST', { body: '' }))).body.message).toBe('コメントを入力してください');
  });
});
