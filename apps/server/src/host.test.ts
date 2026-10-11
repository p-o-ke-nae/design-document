import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { createContext, type ServerContext } from './app.ts';
import { GitCache } from './git.ts';
import { createUpstream, fakeGitHub, fakeGitHubState, type FakeGitHubState, type Upstream } from './github-fixture.ts';
import { createServerApp } from './host.ts';
import { WorkspaceManager } from './workspaces.ts';

const PORT = 5178;
const ORIGIN = `http://127.0.0.1:${PORT}`;

interface Env {
  tmp: string;
  up: Upstream;
  state: FakeGitHubState;
  manager: WorkspaceManager;
  local?: ServerContext;
  bodies: string[];
  req: (p: string, init?: RequestInit) => Promise<Response>;
  json: <T = any>(p: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
}

const envs: Env[] = [];

async function setup(opts: { local?: boolean; gh?: string | null; envToken?: string; dist?: boolean } = {}): Promise<Env> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-host-'));
  const up = await createUpstream(path.join(tmp, 'up'));
  const mainSha = up.git('rev-parse', 'main');
  const featSha = up.commit('feature/x', { 'docs/design/basic/order.md': '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文\n---\n\n# 注文\n\n変更後\n' });
  up.setPull(12, featSha);
  const state = fakeGitHubState({
    pulls: { 'acme/order-app': [{ number: 12, title: '注文画面の修正', headSha: featSha, headRef: 'feature/x', baseRef: 'main' }] },
    refs: { 'acme/order-app': { main: mainSha } },
  });
  const f = fakeGitHub(state);
  const gh = opts.gh === undefined ? null : opts.gh;
  const tokens = new TokenResolver({
    runGh: async () => (gh === null ? null : { code: 0, stdout: `${gh}\n` }),
    env: { GITHUB_TOKEN: opts.envToken ?? (gh === null ? state.token : undefined) },
    fetch: f,
  });
  const home = path.join(tmp, 'home');
  const git = new GitCache(home, tokens, { remoteUrl: (o, r) => path.join(tmp, 'up', o, r) });
  const manager = new WorkspaceManager({ home, github: new GitHubClient(tokens, { fetch: f }), git, createContext: (d) => createContext(d, { watch: false }), pollSeconds: 0 });
  await manager.init();
  const local = opts.local ? await createContext(path.join(tmp, 'up', 'acme', 'order-app'), { watch: false }) : undefined;
  let dist: string | undefined;
  if (opts.dist) {
    dist = path.join(tmp, 'dist');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  const app = createServerApp({ local, manager, tokens, port: PORT, dist });
  const bodies: string[] = [];
  const req = async (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', `127.0.0.1:${PORT}`);
    if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
    return app.request(`${ORIGIN}${p}`, { ...init, headers });
  };
  const json = async (p: string, init?: RequestInit) => {
    const res = await req(p, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const env = { tmp, up, state, manager, local, bodies, req, json };
  envs.push(env);
  return env;
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Reads SSE events until `until` returns true. */
async function readEvents(res: Response, until: (ev: { event: string; data: any }) => boolean): Promise<{ event: string; data: any }[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: { event: string; data: any }[] = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
      const ev = { event, data: data ? JSON.parse(data) : null };
      out.push(ev);
      if (until(ev)) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

afterEach(async () => {
  for (const e of envs.splice(0)) {
    e.manager.dispose();
    e.local?.close();
    await fs.rm(e.tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('認証の状態（BD-GHREV-AUTH）', () => {
  it('[BD-GHREV-AUTH-P002] [BD-GHREV-AUTH-T001] [BD-GHREV-AUTH-T002] [BD-GHREV-AUTH-T006] [BD-GHREV-AUTH-T009] [BD-GHREV-AUTH-S001] [BD-GHREV-AUTH-S003] [BD-GHREV-AUTH-S008] gh のトークンが有効ならログイン名を返す（トークンは返さない）', async () => {
    const env = await setup({ gh: 'ghp_test_token' });
    const r = await env.json('/api/github/auth');
    expect(r).toEqual({ status: 200, body: { source: 'gh', login: 'alice' } });
    expect(env.bodies.join('')).not.toContain(env.state.token);
  });

  it('[BD-GHREV-AUTH-P001] [BD-GHREV-AUTH-T008] [BD-GHREV-AUTH-S007] gh のトークンが 401 なら未認証（invalid）', async () => {
    const env = await setup({ gh: 'ghp_revoked' });
    expect((await env.json('/api/github/auth')).body).toEqual({ source: 'none', login: '', reason: 'invalid' });
    expect(env.bodies.join('')).not.toContain('ghp_revoked');
  });

  it('[BD-GHREV-AUTH-P004] [BD-GHREV-AUTH-T003] [BD-GHREV-AUTH-T004] [BD-GHREV-AUTH-T007] [BD-GHREV-AUTH-S002] [BD-GHREV-AUTH-S004] [BD-GHREV-AUTH-S006] [BD-GHREV-AUTH-S010] gh が使えなければ GITHUB_TOKEN を使う', async () => {
    const env = await setup();
    expect((await env.json('/api/github/auth')).body).toEqual({ source: 'env', login: 'alice' });
  });

  it('[BD-GHREV-AUTH-P003] [BD-GHREV-AUTH-S009] GITHUB_TOKEN が 401 なら未認証（invalid）', async () => {
    const env = await setup({ envToken: 'ghp_bad_env' });
    expect((await env.json('/api/github/auth')).body).toEqual({ source: 'none', login: '', reason: 'invalid' });
  });

  it('[BD-GHREV-AUTH-P005] [BD-GHREV-AUTH-T005] [BD-GHREV-AUTH-S005] トークンが無ければ未認証（missing）で、開いても GitHub は呼ばない', async () => {
    const env = await setup({ envToken: '' });
    expect((await env.json('/api/github/auth')).body).toEqual({ source: 'none', login: '', reason: 'missing' });
    const r = await env.json('/api/workspaces', post({ repo: 'acme/order-app', pr: 12 }));
    expect(r.status).toBe(202);
    await env.manager.settled(r.body.id);
    expect((await env.json(`/api/workspaces/${r.body.id}`)).body).toMatchObject({ state: 'Error' });
    expect(env.state.calls).toEqual([]);
  });
});

describe('ワークスペースの API とルーティング', () => {
  it('[DD-WSPACE-OPENREQ-P001] 開く要求の入力エラーは 400 と文言', async () => {
    const env = await setup();
    expect(await env.json('/api/workspaces', post({ repo: 'acme', pr: 1 }))).toMatchObject({ status: 400, body: { code: 'repo', message: 'owner/repo の形式で入力してください' } });
    expect(await env.json('/api/workspaces', post({ repo: 'acme/order-app', pr: 'x' }))).toMatchObject({ status: 400, body: { code: 'pr', message: 'PR 番号を入力してください' } });
    expect(await env.json('/api/workspaces', post({ repo: 'acme/order-app', ref: 'a..b' }))).toMatchObject({ status: 400, body: { code: 'ref', message: 'branch・tag 名を確認してください' } });
  });

  it('開く → SSE で進捗 → /api/w/:ws/* と /w/:ws/raw/* が worktree を返す（トークンは応答に出ない）', async () => {
    const env = await setup({ local: true });
    const opened = await env.json('/api/workspaces', post({ repo: 'acme/order-app', pr: 12 }));
    expect(opened).toEqual({ status: 202, body: { id: 'gh~acme~order-app~pr-12', state: 'Fetching' } });
    const id = opened.body.id as string;

    expect(await env.json(`/api/w/${id}/config`)).toMatchObject({ status: 409, body: { code: 'not-ready' } });

    const events = await readEvents(await env.req(`/api/workspaces/${id}/events`), (e) => e.event === 'ready' || e.data?.state === 'Ready');
    expect(events[0]).toMatchObject({ event: 'state' });
    await env.manager.settled(id);

    const doc = await env.req(`/api/w/${id}/doc?path=docs/design/basic/order.md`);
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain('変更後');
    const raw = await env.req(`/w/${id}/raw/docs/design/basic/order.md`);
    expect(await raw.text()).toContain('変更後');
    // The local workspace is unchanged.
    const localDoc = await env.req('/api/doc?path=docs/design/basic/order.md');
    expect(await localDoc.text()).not.toContain('変更後');

    const pr = await env.json(`/api/w/${id}/pr`);
    expect(pr).toMatchObject({ status: 200, body: { id, state: 'Ready', pr: { number: 12, title: '注文画面の修正', baseRef: 'main', headRef: 'feature/x' } } });
    expect((await env.json('/api/workspaces')).body).toMatchObject({ local: true, workspaces: [{ id, state: 'Ready', trusted: false }] });
    expect((await env.json(`/api/workspaces/${id}/check`, post())).body).toMatchObject({ stale: false });
    expect(await env.json('/api/github/pulls?repo=acme/order-app')).toMatchObject({ status: 200, body: [{ number: 12, title: '注文画面の修正', headRef: 'feature/x' }] });
    expect(env.bodies.join('\n')).not.toContain(env.state.token);
  });

  it('実行系 API は信頼されるまで 403 untrusted、信頼後は既存の API に渡る', async () => {
    const env = await setup();
    const id = (await env.json('/api/workspaces', post({ repo: 'acme/order-app', pr: 12 }))).body.id;
    await env.manager.settled(id);
    expect(await env.json(`/api/w/${id}/tests/run`, post({ runner: 'nope' }))).toMatchObject({ status: 403, body: { code: 'untrusted' } });
    expect(await env.json(`/api/w/${id}/snapshots/run`, post({}))).toMatchObject({ status: 403, body: { code: 'untrusted' } });
    expect(await env.json(`/api/w/${id}/deps/install`, post())).toMatchObject({ status: 403, body: { code: 'untrusted' } });
    expect(env.manager.get(id)!.ctx!.checkDeps).toBe(true);
    expect((await env.json(`/api/workspaces/${id}/trust`, post())).body).toMatchObject({ trusted: true });
    expect(await env.json(`/api/w/${id}/tests/run`, post({ runner: 'nope' }))).toMatchObject({ status: 400, body: { error: 'unknown runner: nope' } });
  });

  it('無いワークスペースは 404、閉じると一覧から消える。取得中は閉じられない', async () => {
    const env = await setup();
    expect(await env.json('/api/w/gh~acme~order-app~pr-1/config')).toMatchObject({ status: 404, body: { code: 'not-found' } });
    expect((await env.req('/w/gh~acme~order-app~pr-1/raw/a.md')).status).toBe(404);
    const id = (await env.json('/api/workspaces', post({ repo: 'acme/order-app', pr: 12 }))).body.id;
    expect(await env.json(`/api/workspaces/${id}`, { method: 'DELETE' })).toMatchObject({ status: 409, body: { code: 'fetching' } });
    await env.manager.settled(id);
    expect((await env.json(`/api/workspaces/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await env.json('/api/workspaces')).body).toEqual({ local: false, workspaces: [] });
  });

  it('最新化は 202 で取得し直す', async () => {
    const env = await setup();
    const id = (await env.json('/api/workspaces', post({ repo: 'acme/order-app', pr: 12 }))).body.id;
    await env.manager.settled(id);
    expect(await env.json(`/api/workspaces/${id}/refresh`, post())).toMatchObject({ status: 202, body: { state: 'Fetching' } });
    await env.manager.settled(id);
    expect((await env.json(`/api/workspaces/${id}`)).body).toMatchObject({ state: 'Ready' });
  });

  it('手元のワークスペースが無いとき既存の API は 404 no-local', async () => {
    const env = await setup();
    expect(await env.json('/api/config')).toMatchObject({ status: 404, body: { code: 'no-local' } });
  });

  it('未知の /api/* は画面の HTML でなく JSON の 404 を返す（エラー表示（共通））', async () => {
    for (const local of [true, false]) {
      const env = await setup({ local, dist: true });
      const res = await env.req('/api/no-such-api');
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/json/);
      expect(await res.json()).toHaveProperty('error');
      expect(await (await env.req('/some/page')).text()).toContain('<div id="root">');
    }
  });
  it('手元の既存 API にも Host / Origin の検査をかける', async () => {
    const env = await setup({ local: true });
    expect((await env.req('/api/config')).status).toBe(200);
    expect((await env.req('/api/config', { headers: { host: 'evil.example:5178' } })).status).toBe(400);
    expect((await env.req('/api/testids/generate', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
});

describe('PR の差分・スレッド・レビュー状態の API（REVCMT 段階A）', () => {
  it('/pr/files・/pr/diff・/pr/threads・/pr の reviews を返す', async () => {
    const env = await setup();
    const P = 'docs/design/basic/order.md';
    env.state.threads['acme/order-app#12'] = [
      { id: 'T1', path: P, line: 10, comments: [{ id: 11, author: 'bob', body: 'ここを確認' }] },
      { id: 'T2', path: P, line: null, comments: [{ id: 12, author: 'bob', body: 'ファイル全体' }] },
    ];
    env.state.reviews['acme/order-app#12'] = [
      { user: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'carol' }, state: 'APPROVED' },
      { user: { login: 'carol' }, state: 'COMMENTED' },
    ];
    const id = (await env.json('/api/workspaces', post({ repo: 'acme/order-app', pr: 12 }))).body.id;
    await env.manager.settled(id);

    const files = await env.json(`/api/w/${id}/pr/files`);
    expect(files).toMatchObject({ status: 200, body: { docs: [{ status: 'M', path: P }], mocks: [], others: 0 } });
    const diff = await env.json(`/api/w/${id}/pr/diff?path=${encodeURIComponent(P)}`);
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({
      status: 'M',
      blocks: [
        { line: 8, endLine: 8, change: 'added' },
        { line: 10, endLine: 10, change: 'added' },
      ],
      removed: [
        { beforeLine: 8, markdown: '# 注文 基本設計' },
        { beforeLine: 10, markdown: '## 概要' },
        { beforeLine: 10, markdown: '注文を受け付ける。' },
      ],
    });

    const threads = await env.json(`/api/w/${id}/pr/threads?path=${encodeURIComponent(P)}`);
    expect(threads.body.map((t: any) => [t.id, t.placement.kind])).toEqual([
      ['T1', 'element'],
      ['T2', 'file'],
    ]);

    const pr = await env.json(`/api/w/${id}/pr`);
    expect(pr.body.reviews).toEqual([
      { login: 'bob', state: 'CHANGES_REQUESTED' },
      { login: 'carol', state: 'APPROVED' },
    ]);
    expect(env.bodies.join('\n')).not.toContain(env.state.token);
  });
});
