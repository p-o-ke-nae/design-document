import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { createContext } from './app.ts';
import { GitCache, RepoLock } from './git.ts';
import { createUpstream, fakeGitHub, fakeGitHubState, type FakeGitHubState, type Upstream } from './github-fixture.ts';
import { cleanWorkspaces, isSafeRefName, nextWsState, OpenRequestError, parseOpenRequest, parseWorkspaceId, WorkspaceError, WorkspaceManager, type WorkspaceEvent } from './workspaces.ts';

function openErr(body: Parameters<typeof parseOpenRequest>[0]): string {
  try {
    parseOpenRequest(body);
  } catch (e) {
    expect(e).toBeInstanceOf(OpenRequestError);
    return (e as OpenRequestError).code;
  }
  throw new Error('should fail');
}

describe('parseOpenRequest (OPENREQ)', () => {
  it('[DD-WSPACE-OPENREQ-P001] [DD-WSPACE-OPENREQ-T001] [DD-WSPACE-OPENREQ-T002] repo が owner/repo でなければ 400', () => {
    for (const repo of ['', 'acme', 'acme/', '/x', 'a/b/c', '-acme/x', 'acme/..', 'acme/.', 'ac me/x', 'acme/x y', 42]) expect(openErr({ repo, pr: 1 })).toBe('repo');
  });
  it('[DD-WSPACE-OPENREQ-P002] [DD-WSPACE-OPENREQ-T003] [DD-WSPACE-OPENREQ-T004] pr と ref が両方なし・両方ありなら 400', () => {
    expect(openErr({ repo: 'acme/app' })).toBe('target');
    expect(openErr({ repo: 'acme/app', pr: '', ref: '' })).toBe('target');
    expect(openErr({ repo: 'acme/app', pr: 1, ref: 'main' })).toBe('target');
  });
  it('[DD-WSPACE-OPENREQ-P003] [DD-WSPACE-OPENREQ-T005] [DD-WSPACE-OPENREQ-T006] pr が 1 以上の整数でなければ 400', () => {
    for (const pr of [0, -1, 1.5, 'abc', '1e3', '12x']) expect(openErr({ repo: 'acme/app', pr })).toBe('pr');
  });
  it('[DD-WSPACE-OPENREQ-P004] [DD-WSPACE-OPENREQ-T007] pr の ID', () => {
    expect(parseOpenRequest({ repo: ' acme/order-app ', pr: '12' })).toEqual({ id: 'gh~acme~order-app~pr-12', owner: 'acme', repo: 'order-app', pr: 12, name: 'pr-12' });
  });
  it('[DD-WSPACE-OPENREQ-P005] [DD-WSPACE-OPENREQ-T008] [DD-WSPACE-OPENREQ-T009] ref が安全な名前でなければ 400', () => {
    for (const ref of ['-x', 'a..b', 'a~1', 'a b', 'a:b', 'a\\b', '/a', 'a/', 'a//b', '.a', 'a/.b', 'a.lock', 'a@{1}', '@', 'a.', 'a"b', 'a\u0001']) expect(openErr({ repo: 'acme/app', ref })).toBe('ref');
  });
  it('[DD-WSPACE-OPENREQ-P006] [DD-WSPACE-OPENREQ-T010] ref の ID（/ は ~~）', () => {
    expect(parseOpenRequest({ repo: 'acme/app', ref: 'feature/x-1' })).toMatchObject({ id: 'gh~acme~app~ref-feature~~x-1', ref: 'feature/x-1', name: 'ref-feature~~x-1' });
    expect(isSafeRefName('v1.2.0')).toBe(true);
  });
  it('ID から元の要求に戻せる', () => {
    expect(parseWorkspaceId('gh~acme~app~ref-feature~~x-1')).toMatchObject({ ref: 'feature/x-1' });
    expect(parseWorkspaceId('gh~acme~app~pr-3')).toMatchObject({ pr: 3 });
    expect(parseWorkspaceId('gh~acme~app~ref-..')).toBeNull();
    expect(parseWorkspaceId('local')).toBeNull();
  });
});

describe('RepoLock', () => {
  it('同じキーは直列、別のキーは並行', async () => {
    const lock = new RepoLock();
    const log: string[] = [];
    const task = (k: string, name: string, ms: number) =>
      lock.run(k, async () => {
        log.push(`${name}+`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}-`);
      });
    await Promise.all([task('a', 'a1', 30), task('a', 'a2', 1), task('b', 'b1', 5)]);
    expect(log.indexOf('a1-')).toBeLessThan(log.indexOf('a2+'));
    expect(log.indexOf('b1+')).toBeLessThan(log.indexOf('a1-'));
  });
  it('失敗しても次は実行される', async () => {
    const lock = new RepoLock();
    await expect(lock.run('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await lock.run('k', async () => 1)).toBe(1);
  });
});

interface Env {
  tmp: string;
  home: string;
  up: Upstream;
  state: FakeGitHubState;
  manager: WorkspaceManager;
  git: GitCache;
  mainSha: string;
  featSha: string;
  events: (id: string) => WorkspaceEvent[];
}

async function setup(opts: { remote?: (o: string, r: string) => string } = {}): Promise<Env> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-ws-'));
  const home = path.join(tmp, 'home');
  const up = await createUpstream(path.join(tmp, 'up'));
  const mainSha = up.git('rev-parse', 'main');
  const featSha = up.commit('feature/x', { 'docs/design/basic/order.md': '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文\n---\n\n# 注文\n\n変更後\n' });
  up.setPull(12, featSha);
  const state = fakeGitHubState({
    pulls: { 'acme/order-app': [{ number: 12, title: '注文画面の修正', headSha: featSha, headRef: 'feature/x', baseRef: 'main' }] },
    refs: { 'acme/order-app': { main: mainSha, 'feature/x': featSha, v1: mainSha } },
  });
  const f = fakeGitHub(state);
  const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
  const github = new GitHubClient(tokens, { fetch: f });
  const git = new GitCache(home, tokens, { remoteUrl: opts.remote ?? ((o, r) => path.join(tmp, 'up', o, r)) });
  const manager = new WorkspaceManager({ home, github, git, createContext: (dir) => createContext(dir, { watch: false }), pollSeconds: 0 });
  await manager.init();
  const log = new Map<string, WorkspaceEvent[]>();
  const origOpen = manager.open.bind(manager);
  manager.open = (body) => {
    const ws = origOpen(body);
    if (!log.has(ws.id)) {
      log.set(ws.id, []);
      ws.events.on('event', (e: WorkspaceEvent) => log.get(ws.id)!.push(e));
    }
    return ws;
  };
  return { tmp, home, up, state, manager, git, mainSha, featSha, events: (id) => log.get(id) ?? [] };
}

describe('nextWsState (BD-GHREV-WS)', () => {
  it('[BD-GHREV-WS-X001] [BD-GHREV-WS-X002] [BD-GHREV-WS-X013] [BD-GHREV-WS-X014] [BD-GHREV-WS-X017] [BD-GHREV-WS-X018] [BD-GHREV-WS-X022] [BD-GHREV-WS-X023] 取得中以外での取得完了・取得失敗（遅れて届いた結果）は無視', () => {
    for (const s of ['None', 'Ready', 'Stale', 'Error'] as const) {
      expect(nextWsState(s, 'done')).toBeNull();
      expect(nextWsState(s, 'fail')).toBeNull();
    }
    expect(nextWsState('Fetching', 'done')).toBe('Ready');
    expect(nextWsState('Fetching', 'fail')).toBe('Error');
  });

  it('[BD-GHREV-WS-X015] [BD-GHREV-WS-X019] [BD-GHREV-WS-X025] 再試行は取得失敗だけ、最新化は準備完了・更新あり だけ', () => {
    expect(nextWsState('Ready', 'retry')).toBeNull();
    expect(nextWsState('Stale', 'retry')).toBeNull();
    expect(nextWsState('Error', 'refresh')).toBeNull();
    expect(nextWsState('Error', 'retry')).toBe('Fetching');
    expect(nextWsState('Stale', 'refresh')).toBe('Fetching');
  });
});

describe('WorkspaceManager.fetchJob (FETCH)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    env.manager.dispose();
    await fs.rm(env.tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it('[DD-WSPACE-FETCH-P001] [DD-WSPACE-FETCH-T001] [DD-WSPACE-FETCH-T002] [DD-WSPACE-FETCH-T003] [DD-WSPACE-FETCH-T004] PR が無ければ Error', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 99 });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Error');
    expect(ws.error).toContain('PR #99 が見つかりません');
    expect(env.events(ws.id).at(-1)).toMatchObject({ type: 'progress', step: 'error' });
  });

  it('[DD-WSPACE-FETCH-P005] [DD-WSPACE-FETCH-T005] [DD-WSPACE-FETCH-T010] [DD-WSPACE-FETCH-T012] [DD-WSPACE-FETCH-T013] [DD-WSPACE-FETCH-T015] [DD-WSPACE-FETCH-T017] [DD-WSPACE-FETCH-T019] [DD-WSPACE-FETCH-T020] PR を clone → fetch → worktree 作成 → Ready', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    expect(ws.state).toBe('Fetching');
    await env.manager.settled(ws.id);
    expect(ws.error).toBeUndefined();
    expect(ws.state).toBe('Ready');
    expect(ws.headSha).toBe(env.featSha);
    expect(ws.mergeBase).toBe(env.mainSha);
    expect(ws.pr).toMatchObject({ number: 12, title: '注文画面の修正', baseRef: 'main', canPush: true });
    expect(await fs.readFile(path.join(ws.dir, 'docs/design/basic/order.md'), 'utf8')).toContain('変更後');
    expect(ws.ctx?.repoRoot).toBe(path.resolve(ws.dir));
    expect(env.events(ws.id).map((e) => (e.type === 'progress' ? e.step : e.type))).toEqual(['pr', 'clone', 'fetch', 'worktree', 'ready']);
    expect(existsSync(path.join(env.home, 'repos/acme/order-app.git/HEAD'))).toBe(true);
    expect(ws.dir).toBe(path.join(env.home, 'worktrees/acme/order-app/pr-12'));
    expect(env.manager.open({ repo: 'acme/order-app', pr: 12 })).toBe(ws);
  });

  it('[DD-WSPACE-FETCH-P004] [DD-WSPACE-FETCH-T016] [DD-WSPACE-FETCH-T018] 最新化は既存の worktree を新しい head に checkout する', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    await env.manager.settled(ws.id);
    const gen = ws.generation;
    const next = env.up.commit('feature/x', { 'docs/design/basic/order.md': '---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: 注文\n---\n\n# 注文\n\n再変更\n' });
    env.up.setPull(12, next);
    env.state.pulls['acme/order-app'][0].headSha = next;
    expect(await env.manager.checkHead(ws.id, true)).toBe(true);
    expect(ws.state).toBe('Stale');
    await env.manager.refresh(ws.id);
    expect(ws.state).toBe('Ready');
    expect(ws.headSha).toBe(next);
    expect(ws.generation).toBe(gen + 1);
    expect(await fs.readFile(path.join(ws.dir, 'docs/design/basic/order.md'), 'utf8')).toContain('再変更');
  });

  it('[DD-WSPACE-FETCH-P003] [DD-WSPACE-FETCH-T014] 目的の SHA を取得できなければ Error', async () => {
    env.state.pulls['acme/order-app'].push({ number: 13, title: 'x', headSha: 'f'.repeat(40), headRef: 'gone', baseRef: 'main' });
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 13 });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Error');
    expect(ws.error).toContain('fetch に失敗しました');
  });

  it('[DD-WSPACE-FETCH-P006] [DD-WSPACE-FETCH-T006] [DD-WSPACE-FETCH-T007] [DD-WSPACE-FETCH-T008] ref が無ければ Error', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', ref: 'nope' });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Error');
    expect(ws.error).toContain('「nope」が見つかりません');
  });

  it('[DD-WSPACE-FETCH-P010] [DD-WSPACE-FETCH-T009] branch の ref を開く（差分なし・mergeBase なし）', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', ref: 'feature/x' });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Ready');
    expect(ws.headSha).toBe(env.featSha);
    expect(ws.mergeBase).toBeUndefined();
    expect(ws.dir).toBe(path.join(env.home, 'worktrees/acme/order-app/ref-feature~~x'));
  });

  it('[DD-WSPACE-FETCH-P009] tag の ref は branch で失敗した後 tag で取得し、再取得は checkout', async () => {
    env.up.git('tag', 'v1', env.mainSha);
    const ws = env.manager.open({ repo: 'acme/order-app', ref: 'v1' });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Ready');
    expect(ws.headSha).toBe(env.mainSha);
    await env.manager.refresh(ws.id);
    expect(ws.state).toBe('Ready');
  });

  it('[DD-WSPACE-FETCH-P008] ref の SHA を取得できなければ Error', async () => {
    env.state.refs['acme/order-app'].ghost = 'e'.repeat(40);
    const ws = env.manager.open({ repo: 'acme/order-app', ref: 'ghost' });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Error');
    expect(ws.error).toContain('fetch に失敗しました');
  });

  it('Ready / Stale 以外の context は 409、無ければ 404', async () => {
    expect(() => env.manager.context('gh~acme~order-app~pr-12')).toThrow(WorkspaceError);
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 99 });
    await env.manager.settled(ws.id);
    try {
      env.manager.context(ws.id);
    } catch (e) {
      expect((e as WorkspaceError).status).toBe(409);
    }
  });

  it('[BD-GHREV-WS-T004] [BD-GHREV-WS-T005] [BD-GHREV-WS-X021] Error で開き直しても取得し直さず、再試行で取得中 → 準備完了', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 14 });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Error');
    const sha = env.up.commit('feature/y', { 'a.txt': 'y' });
    env.up.setPull(14, sha);
    env.state.pulls['acme/order-app'].push({ number: 14, title: 'y', headSha: sha, headRef: 'feature/y', baseRef: 'main' });
    expect(env.manager.open({ repo: 'acme/order-app', pr: 14 })).toBe(ws);
    expect(ws.state).toBe('Error');
    const job = env.manager.refresh(ws.id);
    expect(ws.state).toBe('Fetching');
    await job;
    expect(ws.state).toBe('Ready');
  });

  it('[BD-GHREV-WS-T001] [BD-GHREV-WS-T002] [BD-GHREV-WS-T003] [BD-GHREV-WS-X007] [BD-GHREV-WS-X008] [BD-GHREV-WS-X009] [BD-GHREV-WS-X010] [BD-GHREV-WS-X011] 取得中は開く・再試行・最新化・更新検知・閉じるで状態が変わらない', async () => {
    expect(env.manager.get('gh~acme~order-app~pr-12')).toBeUndefined();
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    expect(ws.state).toBe('Fetching');
    expect(env.manager.open({ repo: 'acme/order-app', pr: 12 })).toBe(ws);
    const job = env.manager.refresh(ws.id);
    expect(ws.state).toBe('Fetching');
    expect(await env.manager.checkHead(ws.id, true)).toBe(false);
    await expect(env.manager.close(ws.id)).rejects.toMatchObject({ status: 409, code: 'fetching' });
    expect(ws.state).toBe('Fetching');
    await job;
    expect(ws.state).toBe('Ready');
    expect(env.events(ws.id).filter((e) => e.type === 'ready')).toHaveLength(1);
  });

  it('[BD-GHREV-WS-T006] [BD-GHREV-WS-T007] [BD-GHREV-WS-T008] [BD-GHREV-WS-T010] [BD-GHREV-WS-X012] [BD-GHREV-WS-X016] [BD-GHREV-WS-X020] 準備完了 → 更新あり（再検知・開くでは変わらない）→ 最新化 → 閉じる', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    await env.manager.settled(ws.id);
    expect(env.manager.open({ repo: 'acme/order-app', pr: 12 }).state).toBe('Ready');
    const job = env.manager.refresh(ws.id);
    expect(ws.state).toBe('Fetching');
    await job;
    expect(ws.state).toBe('Ready');
    const next = env.up.commit('feature/x', { 'b.txt': 'b' });
    env.up.setPull(12, next);
    env.state.pulls['acme/order-app'][0].headSha = next;
    expect(await env.manager.checkHead(ws.id, true)).toBe(true);
    expect(await env.manager.checkHead(ws.id, true)).toBe(true);
    expect(env.events(ws.id).filter((e) => e.type === 'stale')).toHaveLength(1);
    expect(env.manager.open({ repo: 'acme/order-app', pr: 12 }).state).toBe('Stale');
    await env.manager.close(ws.id);
    expect(ws.state).toBe('None');
    expect(env.manager.get(ws.id)).toBeUndefined();
  });

  it('[BD-GHREV-WS-T009] [BD-GHREV-WS-T011] [BD-GHREV-WS-X024] 準備完了・取得失敗から閉じる（取得失敗は更新検知で変わらない）', async () => {
    const ok = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    const ng = env.manager.open({ repo: 'acme/order-app', pr: 99 });
    await env.manager.settled(ok.id);
    await env.manager.settled(ng.id);
    expect(ng.state).toBe('Error');
    await expect(env.manager.checkHead(ng.id, true)).rejects.toThrow();
    expect(ng.state).toBe('Error');
    await env.manager.close(ok.id);
    await env.manager.close(ng.id);
    expect(env.manager.list()).toEqual([]);
  });

  it('[BD-GHREV-WS-X003] [BD-GHREV-WS-X004] [BD-GHREV-WS-X005] [BD-GHREV-WS-X006] 未取得（開いていない）への再試行・更新検知・最新化・閉じるは 404', async () => {
    const id = 'gh~acme~order-app~pr-12';
    for (const op of [() => env.manager.refresh(id), () => env.manager.checkHead(id, true), () => env.manager.close(id)] as (() => Promise<unknown>)[]) {
      await expect(Promise.resolve().then(op)).rejects.toMatchObject({ status: 404, code: 'not-found' });
    }
  });

  it('checkHead は 30 秒以内なら前回の結果を返す', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    await env.manager.settled(ws.id);
    const before = env.state.calls.length;
    expect(await env.manager.checkHead(ws.id)).toBe(false);
    expect(await env.manager.checkHead(ws.id)).toBe(false);
    expect(env.state.calls.length - before).toBe(1);
  });

  it('gh clean は workspaces.json に無い worktree を消し、--repo 指定時は使われていない clone も消す', async () => {
    const a = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    const b = env.manager.open({ repo: 'acme/order-app', ref: 'main' });
    await env.manager.settled(a.id);
    await env.manager.settled(b.id);
    const file = path.join(env.home, 'workspaces.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.workspaces = data.workspaces.filter((w: { id: string }) => w.id === a.id);
    await fs.writeFile(file, JSON.stringify(data));
    expect(await cleanWorkspaces(env.home, env.git)).toEqual({ worktrees: [b.dir], clones: [], kept: [] });
    expect(existsSync(b.dir)).toBe(false);
    expect(existsSync(a.dir)).toBe(true);
    expect(await cleanWorkspaces(env.home, env.git, 'acme/order-app')).toMatchObject({ clones: [], kept: [env.git.repoDir('acme', 'order-app')] });
    await fs.writeFile(file, JSON.stringify({ version: 1, workspaces: [] }));
    expect(await cleanWorkspaces(env.home, env.git, 'acme/order-app')).toEqual({ worktrees: [a.dir], clones: [env.git.repoDir('acme', 'order-app')], kept: [] });
    expect(existsSync(env.git.repoDir('acme', 'order-app'))).toBe(false);
  });

  it('信頼・保存・復元・閉じる（トークンは保存しない）', async () => {
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    await env.manager.settled(ws.id);
    await env.manager.trust(ws.id);
    const saved = await fs.readFile(path.join(env.home, 'workspaces.json'), 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ version: 1, workspaces: [{ id: ws.id, repo: 'acme/order-app', pr: 12, trusted: true, headSha: env.featSha }] });
    expect(saved).not.toContain(env.state.token);

    const f = fakeGitHub(env.state);
    const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: env.state.token }, fetch: f });
    const restored = new WorkspaceManager({ home: env.home, github: new GitHubClient(tokens, { fetch: f }), git: env.git, createContext: (d) => createContext(d, { watch: false }), pollSeconds: 0 });
    await restored.init();
    expect(restored.list()).toMatchObject([{ id: ws.id, state: 'Ready', trusted: true, headSha: env.featSha }]);
    expect(await restored.pull(ws.id)).toMatchObject({ number: 12, title: '注文画面の修正' });
    restored.dispose();

    await env.manager.close(ws.id);
    expect(env.manager.list()).toEqual([]);
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(path.join(env.home, 'repos/acme/order-app.git'))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(env.home, 'workspaces.json'), 'utf8')).workspaces).toEqual([]);
  });
});

describe('WorkspaceManager clone failure', () => {
  it('[DD-WSPACE-FETCH-P002] [DD-WSPACE-FETCH-T011] PR の clone に失敗したら Error', async () => {
    const env = await setup({ remote: (_o, _r) => path.join(os.tmpdir(), 'ddv-no-such-remote-' + Date.now()) });
    const ws = env.manager.open({ repo: 'acme/order-app', pr: 12 });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Error');
    expect(ws.error).toContain('clone に失敗しました');
    expect(ws.error).not.toContain(env.state.token);
    env.manager.dispose();
    await fs.rm(env.tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it('[DD-WSPACE-FETCH-P007] ref の clone に失敗したら Error', async () => {
    const env = await setup({ remote: () => path.join(os.tmpdir(), 'ddv-no-such-remote-' + Date.now()) });
    const ws = env.manager.open({ repo: 'acme/order-app', ref: 'main' });
    await env.manager.settled(ws.id);
    expect(ws.state).toBe('Error');
    expect(ws.error).toContain('clone に失敗しました');
    env.manager.dispose();
    await fs.rm(env.tmp, { recursive: true, force: true }).catch(() => undefined);
  });
});
