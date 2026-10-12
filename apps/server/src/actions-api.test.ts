import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { createContext } from './app.ts';
import { GitCache } from './git.ts';
import { createUpstream, fakeActionsRepo, fakeGitHub, fakeGitHubState, publishFakeResult, type FakeActionsRepo, type FakeGitHubState, type Upstream } from './github-fixture.ts';
import { createServerApp } from './host.ts';
import { LocalWorkspace } from './local.ts';
import { RecentFolders } from './recent.ts';
import { WorkspaceManager } from './workspaces.ts';

const PORT = 5178;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REPO = 'acme/order-app';
const PR_WS = 'gh~acme~order-app~pr-12';

interface Env {
  tmp: string;
  up: Upstream;
  state: FakeGitHubState;
  actions: FakeActionsRepo;
  manager: WorkspaceManager;
  local: LocalWorkspace;
  mainSha: string;
  featSha: string;
  req: (p: string, init?: RequestInit) => Promise<Response>;
  json: <T = any>(p: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
}

const envs: Env[] = [];

async function setup(opts: { remote?: string | null; actions?: Partial<FakeActionsRepo>; fork?: boolean } = {}): Promise<Env> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-actions-'));
  const up = await createUpstream(path.join(tmp, 'up'));
  const mainSha = up.git('rev-parse', 'main');
  const featSha = up.commit('feature/x', { 'docs/design/basic/order.md': '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文\n---\n\n# 注文\n\n変更後\n' });
  up.setPull(12, featSha);
  const remote = opts.remote === undefined ? 'https://github.com/acme/order-app.git' : opts.remote;
  if (remote) up.git('remote', 'add', 'origin', remote);
  const actions = fakeActionsRepo(opts.actions);
  const state = fakeGitHubState({
    pulls: { [REPO]: [{ number: 12, title: '注文画面の修正', headSha: featSha, headRef: 'feature/x', baseRef: 'main', ...(opts.fork ? { headRepo: 'bob/order-app' } : {}) }] },
    refs: { [REPO]: { main: mainSha, 'feature/x': featSha } },
    actions: { [REPO]: actions },
  });
  const f = fakeGitHub(state);
  const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
  const home = path.join(tmp, 'home');
  const git = new GitCache(home, tokens, { remoteUrl: (o, r) => path.join(tmp, 'up', o, r) });
  const manager = new WorkspaceManager({ home, github: new GitHubClient(tokens, { fetch: f }), git, createContext: (d) => createContext(d, { watch: false }), pollSeconds: 0 });
  await manager.init();
  const initial = await createContext(up.dir, { watch: false });
  const recent = new RecentFolders(path.join(home, 'recent.json'), { warn: () => undefined });
  const local = new LocalWorkspace({ recent, createContext: (d) => createContext(d, { watch: false }), initial });
  const app = createServerApp({ local, manager, tokens, port: PORT, actionsIntervals: { firstFind: 5, find: 5, track: 5, findTimeout: 3000 } });
  const req = async (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('host', `127.0.0.1:${PORT}`);
    if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN);
    return app.request(`${ORIGIN}${p}`, { ...init, headers });
  };
  const json = async (p: string, init?: RequestInit) => {
    const res = await req(p, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const env = { tmp, up, state, actions, manager, local, mainSha, featSha, req, json };
  envs.push(env);
  return env;
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function openPr(env: Env): Promise<string> {
  const r = await env.json('/api/workspaces', post({ repo: REPO, pr: 12 }));
  await env.manager.settled(r.body.id);
  return r.body.id as string;
}

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

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

afterEach(async () => {
  for (const e of envs.splice(0)) {
    e.manager.dispose();
    e.local.dispose();
    await fs.rm(e.tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Actions を使えるか（BD-ACTRUN-GATE）', () => {
  it('[BD-ACTRUN-GATE-P001][BD-ACTRUN-GATE-S001][BD-ACTRUN-GATE-T001][BD-ACTRUN-GATE-T002] ローカル版で GitHub のリモートが無ければ Actions を表示しない（GitHub は呼ばない）', async () => {
    const env = await setup({ remote: null });
    expect(await env.json('/api/actions')).toEqual({ status: 200, body: { state: 'hidden', reason: '', workflow: null, canInit: false } });
    expect(await env.json('/api/actions/runs')).toMatchObject({ status: 404, body: { code: 'no-remote', error: 'GitHub のリモートがありません' } });
    expect(await env.json('/api/actions/runs', post({}))).toMatchObject({ status: 404, body: { code: 'no-remote' } });
    expect(env.state.calls).toEqual([]);
  });

  it('GitHub 以外のリモートも Actions を表示しない', async () => {
    const env = await setup({ remote: 'https://gitlab.com/acme/order-app.git' });
    expect((await env.json('/api/actions')).body).toMatchObject({ state: 'hidden' });
    expect(env.state.calls).toEqual([]);
  });

  it('[BD-ACTRUN-GATE-P002][BD-ACTRUN-GATE-S002][BD-ACTRUN-GATE-S003][BD-ACTRUN-GATE-T003][BD-ACTRUN-GATE-T004] 既定ブランチに ddv ワークフローが無ければ導入の案内（setup）', async () => {
    const env = await setup({ actions: { workflowOn: [] } });
    const r = await env.json('/api/actions');
    expect(r).toMatchObject({
      status: 200,
      body: {
        state: 'setup',
        reason: '既定ブランチ（main）に ddv ワークフロー（.github/workflows/ddv-tests.yml）がありません',
        repo: REPO,
        defaultBranch: 'main',
        workflow: false,
        workflowUrl: 'https://github.com/acme/order-app/actions/workflows/ddv-tests.yml',
        canInit: true,
        target: { ref: 'main', sha: env.mainSha, fork: false, dirty: false },
      },
    });
    expect(await env.json('/api/actions/runs', post({}))).toMatchObject({ status: 409, body: { code: 'setup' } });
  });

  it('[BD-ACTRUN-GATE-P003][BD-ACTRUN-GATE-S004][BD-ACTRUN-GATE-S005][BD-ACTRUN-GATE-T005][BD-ACTRUN-GATE-T006] fork からの PR は実行ボタンを出さず PR の CI の結果（ddv の実行を除く）を表示', async () => {
    const env = await setup({ fork: true, actions: { workflowOn: ['main', 'feature/x'] } });
    env.actions.runs.push({ id: 77, attempt: 1, title: 'ddv test ddv-0000abcd', event: 'workflow_dispatch', branch: 'feature/x', sha: env.featSha, createdAt: '2024-05-01T00:00:00Z', actor: 'bob', script: ['completed'], conclusion: 'success', polls: 0 });
    env.actions.checks[env.featSha] = [
      { id: 1, name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/order-app/runs/1', details_url: 'https://ci.example.com/1' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/order-app/runs/2', details_url: 'https://github.com/acme/order-app/actions/runs/77/job/770' },
    ];
    const id = await openPr(env);
    const st = await env.json(`/api/w/${id}/actions`);
    expect(st.body).toMatchObject({
      state: 'fork',
      reason: 'fork からの PR は Actions で実行しません。PR の CI の結果を表示します',
      canInit: false,
      target: { ref: 'feature/x', sha: env.featSha, pr: 12, headRef: 'feature/x', fork: true },
    });
    const runs = await env.json(`/api/w/${id}/actions/runs`);
    expect(runs.body.checks).toEqual([{ name: 'build', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/order-app/runs/1' }]);
    expect(await env.json(`/api/w/${id}/actions/runs`, post({}))).toMatchObject({ status: 403, body: { code: 'fork' } });
    expect(await env.json(`/api/w/${id}/actions/init`, post({}))).toMatchObject({ status: 404, body: { code: 'local-only' } });
  });

  it('[BD-ACTRUN-GATE-P004][BD-ACTRUN-GATE-S006][BD-ACTRUN-GATE-S007][BD-ACTRUN-GATE-T007][BD-ACTRUN-GATE-T008] 書き込み権限が無ければ実行ボタンを無効にし実行済みの結果を表示（readonly）', async () => {
    const env = await setup({ actions: { push: false } });
    publishFakeResult(env.actions, { id: '500-1', commit: env.mainSha, ref: 'main', status: 'passed', startedAt: '2024-05-02T00:00:00Z' }, { results: { 'BD-ORDER-A-P001': { status: 'passed', durationMs: 5 } } });
    const st = await env.json('/api/actions');
    expect(st.body).toMatchObject({ state: 'readonly', reason: '書き込み権限が無いため実行できません。実行済みの結果だけを表示します' });
    const runs = await env.json('/api/actions/runs');
    expect(runs.body).toMatchObject({ index: { state: 'ok', skipped: 0 }, rows: [{ id: '500-1', state: 'passed', commit: env.mainSha }] });
    expect(await env.json('/api/actions/runs', post({}))).toMatchObject({ status: 403, body: { code: 'readonly' } });
  });

  it('[BD-ACTRUN-GATE-P005][BD-ACTRUN-GATE-S008][BD-ACTRUN-GATE-T009] ワークフローがあり書き込み権限があれば実行できる（ready）', async () => {
    const env = await setup();
    expect((await env.json('/api/actions')).body).toMatchObject({ state: 'ready', reason: '', workflow: true, canInit: true });
    const r = await env.json('/api/actions/runs', post({ ids: [], runner: '' }));
    expect(r.status).toBe(202);
    expect(r.body.request).toMatch(/^ddv-[0-9a-f]{8}$/);
  });
});

describe('Actions の API', () => {
  it('起動 → SSE で追跡 → 完了で結果ブランチを履歴に取り込む', async () => {
    const env = await setup();
    env.actions.onDispatch = (run) => {
      run.onComplete = () =>
        publishFakeResult(
          env.actions,
          { id: `${run.id}-1`, commit: run.sha, ref: run.branch, status: 'failed', request: run.inputs?.request, actor: 'alice' },
          { results: { 'BD-ORDER-A-P001': { status: 'failed', durationMs: 5, error: 'NG' } }, traces: ['BD-ORDER-A-P001'] },
          { 'traces/BD-ORDER-A-P001.json': '{"steps":[]}' },
        );
    };
    await env.json('/api/actions');
    const sse = await env.req('/api/events');
    const r = await env.json('/api/actions/runs', post({ ids: ['BD-ORDER-A-P001'] }));
    expect(r.status).toBe(202);
    const events = await readEvents(sse, (e) => e.event === 'actions' && e.data.type === 'history' && env.actions.dispatches.length > 0 && !!env.actions.results);
    const trackers = events.filter((e) => e.event === 'actions' && e.data.type === 'tracker').map((e) => e.data);
    expect(trackers.map((t) => t.state)).toContain('Running');
    expect(trackers.at(-1)).toMatchObject({ request: r.body.request, state: 'Completed', conclusion: 'success' });
    expect(env.actions.dispatches[0]).toEqual({ ref: 'main', inputs: { request: r.body.request, mode: 'test', ids: 'BD-ORDER-A-P001', runner: '', sha: env.mainSha, run: '' } });
    const resultId = trackers.at(-1).resultId as string;

    await waitFor(async () => (await env.json('/api/results/latest')).body['BD-ORDER-A-P001']?.source === 'actions');
    const latest = (await env.json('/api/results/latest')).body;
    expect(latest['BD-ORDER-A-P001']).toMatchObject({ runId: resultId, status: 'failed', source: 'actions', trace: true });

    const list = await env.json('/api/actions/runs');
    expect(list.body.rows[0]).toMatchObject({ id: resultId, state: 'failed', request: r.body.request, mode: 'test' });
    const detail = await env.json(`/api/actions/runs/${resultId}`);
    expect(detail.body).toMatchObject({ recordState: 'ok', traceOf: { 'BD-ORDER-A-P001': true }, info: { resultId } });
    const file = await env.req(`/api/actions/runs/${resultId}/files/traces/BD-ORDER-A-P001.json`);
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(file.headers.get('content-type')).toContain('application/json');
    expect(await env.json(`/api/actions/runs/${resultId}/files/traces/BD-ORDER-B-P001.json`)).toMatchObject({ status: 404 });
    expect(await env.json(`/api/actions/runs/${resultId}/files/..%2Frun.json`)).toMatchObject({ status: 400, body: { code: 'path-invalid' } });
    expect(await env.json('/api/actions/runs/abc')).toMatchObject({ status: 400, body: { code: 'run-id-invalid' } });
    expect(await env.json('/api/actions/runs/999-1')).toMatchObject({ status: 404, body: { code: 'not-found' } });
  });

  it('要求の検査と対象の問題（ids・runner・未 push・detached）', async () => {
    const env = await setup();
    expect(await env.json('/api/actions/runs', post({ ids: ['bad id'] }))).toMatchObject({ status: 400, body: { code: 'ids-invalid' } });
    expect(await env.json('/api/actions/runs', post({ runner: 'nope' }))).toMatchObject({ status: 400, body: { code: 'runner-unknown' } });
    env.up.commit('main', { 'a.txt': 'x' });
    expect(await env.json('/api/actions/runs', post({}))).toMatchObject({ status: 409, body: { code: 'not-pushed' } });
    env.up.git('checkout', '-q', '--detach', 'HEAD');
    expect(await env.json('/api/actions?refresh=1')).toMatchObject({ body: { target: { problem: 'detached' } } });
    expect(await env.json('/api/actions/runs', post({}))).toMatchObject({ status: 409, body: { code: 'detached', error: 'ブランチをチェックアウトしてください（detached HEAD は Actions で実行できません）' } });
  });

  it('dispatch の失敗は SSE の Failed で届く（403）', async () => {
    const env = await setup();
    env.state.failOn.push({ match: 'POST /repos/acme/order-app/actions/workflows/ddv-tests.yml/dispatches', status: 403, message: 'Resource not accessible by integration' });
    await env.json('/api/actions');
    const sse = await env.req('/api/events');
    const r = await env.json('/api/actions/runs', post({}));
    const events = await readEvents(sse, (e) => e.event === 'actions' && e.data.state === 'Failed');
    expect(events.at(-1)!.data).toMatchObject({ request: r.body.request, state: 'Failed', error: 'ワークフローを起動する権限がありません（PAT に Actions: Write が必要です）', code: 'github-forbidden' });
  });

  it('ワークフローの配置（init）は手元だけ。created → unchanged、force は真偽値', async () => {
    const env = await setup({ actions: { workflowOn: [] } });
    expect(await env.json('/api/actions/init', post({ force: 'yes' }))).toMatchObject({ status: 400, body: { code: 'invalid-request' } });
    expect(await env.json('/api/actions/init', post({}))).toEqual({ status: 201, body: { status: 'created', path: '.github/workflows/ddv-tests.yml' } });
    expect(await env.json('/api/actions/init', post({}))).toEqual({ status: 200, body: { status: 'unchanged', path: '.github/workflows/ddv-tests.yml' } });
    await fs.writeFile(path.join(env.up.dir, '.github/workflows/ddv-tests.yml'), 'name: other\n');
    expect(await env.json('/api/actions/init', post({}))).toMatchObject({ status: 409, body: { code: 'workflow-differs' } });
    expect(await env.json('/api/actions/init', post({ force: true }))).toEqual({ status: 200, body: { status: 'overwritten', path: '.github/workflows/ddv-tests.yml' } });
  });

  it('PR のワークスペースで差分を承認 → 承認のコミットを SSE で知らせる', async () => {
    const env = await setup({ actions: { workflowOn: ['main', 'feature/x'] } });
    publishFakeResult(
      env.actions,
      { id: '600-1', commit: env.featSha, ref: 'feature/x', pr: 12, status: 'failed', startedAt: '2024-05-02T00:00:00Z', snapshots: { diff: 1, noBase: 0 } },
      { snapshots: [{ id: 'BD-ORDER-SCREEN-P001', status: 'failed', steps: [{ step: 1, status: 'Diff', diffRatio: 0.1 }] }], results: { 'BD-ORDER-SCREEN-P001': { status: 'failed', durationMs: 1 } } },
    );
    env.actions.onDispatch = (run) => {
      run.onComplete = () => {
        const idx = JSON.parse(String(env.actions.results!['index.json']));
        idx.runs[0].approvals.push({ actionsRunId: String(run.id), ids: ['BD-ORDER-SCREEN-P001'], commit: 'c'.repeat(40), at: '2024-05-03T00:00:00Z', actor: 'alice' });
        env.actions.results!['index.json'] = JSON.stringify(idx);
      };
    };
    const id = await openPr(env);
    expect((await env.json(`/api/w/${id}/actions`)).body).toMatchObject({ state: 'ready' });
    expect(await env.json(`/api/w/${id}/actions/runs/600-1/approve`, post({ ids: ['BD-ORDER-SCREEN-P009'] }))).toMatchObject({ status: 400, body: { code: 'ids-invalid' } });
    const sse = await env.req(`/api/w/${id}/events`);
    const r = await env.json(`/api/w/${id}/actions/runs/600-1/approve`, post({ ids: ['BD-ORDER-SCREEN-P001'] }));
    expect(r.status).toBe(202);
    const events = await readEvents(sse, (e) => e.event === 'actions' && e.data.approveCommit !== undefined);
    expect(events.at(-1)!.data).toMatchObject({ mode: 'approve', state: 'Completed', approveCommit: 'c'.repeat(40) });
    expect(env.actions.dispatches[0]).toEqual({ ref: 'feature/x', inputs: { request: r.body.request, mode: 'approve', ids: 'BD-ORDER-SCREEN-P001', runner: '', sha: '', run: '600-1' } });
    expect(await env.json('/api/actions/runs/600-1/approve', post({ ids: ['BD-ORDER-SCREEN-P001'] }))).toMatchObject({ status: 409, body: { code: 'not-pr' } });
  });
});
