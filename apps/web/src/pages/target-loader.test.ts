import { describe, expect, it } from 'vitest';
import { parseConfig } from '@ddv/core';
import { GitHubError } from '@ddv/github';
import { MemoryBlobStore, TreeTooLargeError } from '@ddv/services';
import { parseHostedHash } from './hash-route.ts';
import { RATE_LIMIT_PAT_HINT } from './errors.ts';
import {
  classifyLoadError,
  ConfigLoadError,
  INVALID_TOKEN_MESSAGE,
  NEED_TOKEN_MESSAGE,
  NOT_FOUND_MESSAGE,
  RateMeter,
  selectPrefetch,
  TargetLoader,
  type LoaderState,
  type TargetLoaderDeps,
  type TargetSnapshot,
} from './target-loader.ts';

const none = { state: 'none' as const, lastClear: null };
const withPat = { state: 'session' as const, lastClear: null };

describe('classifyLoadError（DD-PAGESV-LOADERR）', () => {
  it('[DD-PAGESV-LOADERR-P001] [DD-PAGESV-LOADERR-T001] [DD-PAGESV-LOADERR-T002] [DD-PAGESV-LOADERR-T003] TreeTooLargeError は Failed tooLarge（部分木のパス）', () => {
    expect(classifyLoadError(new TreeTooLargeError('docs/design'), none)).toEqual({
      state: 'Failed',
      error: { kind: 'tooLarge', message: '取得できませんでした：ファイルが多すぎて一覧を取得できません（docs/design）' },
    });
  });

  it('[DD-PAGESV-LOADERR-P002] [DD-PAGESV-LOADERR-T004] その他の例外は Failed network（設定のエラーは文言をそのまま）', () => {
    expect(classifyLoadError(new TypeError('Failed to fetch'), none)).toEqual({
      state: 'Failed',
      error: { kind: 'network', message: '取得できませんでした：GitHub との通信に失敗しました（Failed to fetch）' },
    });
    expect(classifyLoadError(new ConfigLoadError('docsRoot: expected string'), none).error).toEqual({ kind: 'network', message: 'ddv.config.yaml を読めません：docsRoot: expected string' });
  });

  it('[DD-PAGESV-LOADERR-P003] [DD-PAGESV-LOADERR-T005] [DD-PAGESV-LOADERR-T006] auth は NeedToken invalidToken', () => {
    expect(classifyLoadError(new GitHubError('auth', 401, 'Bad credentials'), withPat)).toEqual({ state: 'NeedToken', error: { kind: 'invalidToken', message: INVALID_TOKEN_MESSAGE } });
    expect(INVALID_TOKEN_MESSAGE).toBe('PAT が無効です（失効・取り消しの可能性があります）。設定し直してください');
  });

  it('[DD-PAGESV-LOADERR-P004] [DD-PAGESV-LOADERR-T007] [DD-PAGESV-LOADERR-T008] notFound で PAT があれば Failed notFound', () => {
    expect(classifyLoadError(new GitHubError('notFound', 404, 'Not Found'), withPat)).toEqual({ state: 'Failed', error: { kind: 'notFound', message: NOT_FOUND_MESSAGE } });
    expect(NOT_FOUND_MESSAGE).toBe('取得できませんでした：リポジトリ・branch・tag・PR が見つからないか、PAT にこのリポジトリの権限がありません');
  });

  it('[DD-PAGESV-LOADERR-P005] [DD-PAGESV-LOADERR-T009] [DD-PAGESV-LOADERR-T010] PAT が 401 で消された直後の notFound は NeedToken invalidToken', () => {
    expect(classifyLoadError(new GitHubError('notFound', 404, 'Not Found'), { state: 'none', lastClear: 'invalid' })).toEqual({
      state: 'NeedToken',
      error: { kind: 'invalidToken', message: INVALID_TOKEN_MESSAGE },
    });
  });

  it('[DD-PAGESV-LOADERR-P006] [DD-PAGESV-LOADERR-T011] PAT なしの notFound は NeedToken needToken', () => {
    expect(classifyLoadError(new GitHubError('notFound', 404, 'Not Found'), { state: 'none', lastClear: 'user' })).toEqual({
      state: 'NeedToken',
      error: { kind: 'needToken', message: NEED_TOKEN_MESSAGE },
    });
    expect(NEED_TOKEN_MESSAGE).toBe('非公開のリポジトリ、または見つからないリポジトリです。PAT を設定すると取得し直します。');
  });

  it('[DD-PAGESV-LOADERR-P007] [DD-PAGESV-LOADERR-T012] [DD-PAGESV-LOADERR-T013] PAT なしの rateLimit は再開時刻と PAT の案内', () => {
    const at = new Date(2025, 0, 1, 9, 5);
    const r = classifyLoadError(new GitHubError('rateLimit', 403, 'limit', at), none);
    expect(r).toEqual({ state: 'Failed', error: { kind: 'rateLimit', message: `取得できませんでした：GitHub API の利用上限に達しました（09:05 に再開）。${RATE_LIMIT_PAT_HINT}`, resetAt: at } });
  });

  it('[DD-PAGESV-LOADERR-P008] [DD-PAGESV-LOADERR-T014] PAT ありの rateLimit は PAT の案内なし', () => {
    const at = new Date(2025, 0, 1, 18, 30);
    expect(classifyLoadError(new GitHubError('rateLimit', 429, 'limit', at), withPat).error.message).toBe('取得できませんでした：GitHub API の利用上限に達しました（18:30 に再開）');
  });

  it('[DD-PAGESV-LOADERR-P009] [DD-PAGESV-LOADERR-T015] forbidden は GitHub の文言をそのまま', () => {
    const e = new GitHubError('forbidden', 403, 'Resource protected by organization SAML enforcement');
    expect(classifyLoadError(e, withPat)).toEqual({ state: 'Failed', error: { kind: 'forbidden', message: '取得できませんでした：Resource protected by organization SAML enforcement' } });
  });

  it('[DD-PAGESV-LOADERR-P010] [DD-PAGESV-LOADERR-T016] validation・network は Failed network', () => {
    expect(classifyLoadError(new GitHubError('validation', 422, 'bad'), withPat).error).toEqual({ kind: 'network', message: '取得できませんでした：GitHub との通信に失敗しました（bad）' });
    expect(classifyLoadError(new GitHubError('network', 0, 'offline'), withPat).error.kind).toBe('network');
  });
});

// ---- state machine ----

const A = parseHostedHash('#/gh/o/r/pr/1', {});
const A2 = parseHostedHash('#/gh/o/r/pr/1/doc/docs/a.md', {});
const B = parseHostedHash('#/gh/o/r/ref/main', {});
const NG = parseHostedHash('#/gh/o', {});
const pendingForever = () => new Promise<never>(() => {});

function harness(pat: { state: 'none' | 'session' | 'stored'; lastClear: null | 'invalid' | 'user' | 'otherTab' } = { ...none }) {
  const watchers: { started: number; stopped: number }[] = [];
  const recent: string[] = [];
  const deps: TargetLoaderDeps = {
    client: { rest: pendingForever, restWithHeaders: pendingForever } as never,
    pat,
    store: new MemoryBlobStore(),
    recent: { add: (t, label) => recent.push(`${t.owner}/${t.repo}:${label}`) },
    watcher: () => {
      const w = { started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; } };
      watchers.push(w);
      return w;
    },
  };
  const l = new TargetLoader(deps);
  const snap = (): TargetSnapshot => ({
    target: l.target!,
    defaultBranch: 'main',
    private: false,
    permission: 'read',
    commitSha: 'c'.repeat(40),
    reader: {} as never,
    config: parseConfig({}),
    pr: { number: 1, title: 'T', state: 'open', merged: false, htmlUrl: '', author: '', baseRef: 'main', headRef: 'f', headSha: 'c'.repeat(40), headRepo: 'o/r', canPush: false },
  });
  const to = (s: LoaderState) => {
    if (s === 'Idle') return;
    l.open(A);
    if (s === 'Loading') return;
    if (s === 'NeedToken') return l.onFailed(l.gen, new GitHubError('notFound', 404, 'x'));
    if (s === 'Failed') return l.onFailed(l.gen, new Error('boom'));
    l.onLoaded(l.gen, snap());
    if (s === 'Stale') l.onHeadChanged('d'.repeat(40));
  };
  return { l, to, snap, watchers, recent };
}

describe('TargetLoader の状態（DD-PAGESV-LOADER）', () => {
  it('[DD-PAGESV-LOADER-T001] 初めは対象なし', () => {
    expect(harness().l.state).toBe('Idle');
  });

  it('[DD-PAGESV-LOADER-T002] 対象なしで検査 NG の open は対象なしのまま open-error', () => {
    const { l } = harness();
    l.open(NG);
    expect(l.state).toBe('Idle');
    expect(l.openError?.message).toBe('URL を解釈できません（#/gh/owner/repo/… の形式）');
  });

  it('[DD-PAGESV-LOADER-T003] 対象なしで検査 OK の open は取得中', () => {
    const { l } = harness();
    l.open(A);
    expect(l.state).toBe('Loading');
    expect(l.progress.step).toBe('info');
  });

  it('[DD-PAGESV-LOADER-T004] 取得中で loaded は表示中（HeadWatcher を始め RecentTargets に足す）', () => {
    const { l, to, watchers, recent } = harness();
    to('Ready');
    expect(l.state).toBe('Ready');
    expect(watchers).toEqual([{ started: 1, stopped: 0, start: expect.any(Function), stop: expect.any(Function) }]);
    expect(recent).toEqual(['o/r:T']);
  });

  it('[DD-PAGESV-LOADER-T005] 取得中で PAT が必要な failed は PAT が必要', () => {
    const { l, to } = harness();
    to('NeedToken');
    expect(l.state).toBe('NeedToken');
    expect(l.error?.kind).toBe('needToken');
  });

  it('[DD-PAGESV-LOADER-T006] 取得中でその他の failed は取得失敗', () => {
    const { l, to } = harness();
    to('Failed');
    expect(l.state).toBe('Failed');
    expect(l.error?.kind).toBe('network');
  });

  it('[DD-PAGESV-LOADER-T007] 取得中で別の対象の open は取得中（前の取得の結果は捨てる）', () => {
    const { l, to, snap } = harness();
    to('Loading');
    const old = l.gen;
    l.open(B);
    expect(l.state).toBe('Loading');
    expect(l.gen).toBeGreaterThan(old);
    l.onLoaded(old, snap());
    expect(l.state).toBe('Loading');
    // 同じ対象の open は route だけ
    const gen = l.gen;
    l.open(parseHostedHash('#/gh/o/r/ref/main/doc/docs/a.md', {}));
    expect(l.gen).toBe(gen);
    expect(l.route?.path).toBe('docs/a.md');
  });

  it('[DD-PAGESV-LOADER-T008] 取得中で changeTarget は対象なし', () => {
    const { l, to } = harness();
    to('Loading');
    l.changeTarget();
    expect(l.state).toBe('Idle');
    expect(l.target).toBeNull();
  });

  it('[DD-PAGESV-LOADER-T009] PAT が必要で onPatChanged は取得中', () => {
    const { l, to } = harness();
    to('NeedToken');
    l.onPatChanged();
    expect(l.state).toBe('Loading');
  });

  it('[DD-PAGESV-LOADER-T010] PAT が必要で changeTarget は対象なし', () => {
    const { l, to } = harness();
    to('NeedToken');
    l.changeTarget();
    expect(l.state).toBe('Idle');
  });

  it('[DD-PAGESV-LOADER-T011] 取得失敗で検査 OK の open は取得中', () => {
    const { l, to } = harness();
    to('Failed');
    l.open(A);
    expect(l.state).toBe('Loading');
    expect(l.error).toBeNull();
  });

  it('[DD-PAGESV-LOADER-T012] 取得失敗で検査 NG の open は対象なし', () => {
    const { l, to } = harness();
    to('Failed');
    l.open(NG);
    expect(l.state).toBe('Idle');
    expect(l.openError).not.toBeNull();
  });

  it('[DD-PAGESV-LOADER-T013] 表示中で onHeadChanged は更新あり（HeadWatcher を止める）', () => {
    const { l, to, watchers } = harness();
    to('Stale');
    expect(l.state).toBe('Stale');
    expect(l.staleSha).toBe('d'.repeat(40));
    expect(watchers[0]!.stopped).toBe(1);
  });

  it('[DD-PAGESV-LOADER-T014] 表示中で reload は取得中', () => {
    const { l, to, watchers } = harness();
    to('Ready');
    l.reload();
    expect(l.state).toBe('Loading');
    expect(watchers[0]!.stopped).toBe(1);
  });

  it('[DD-PAGESV-LOADER-T015] 表示中で onPatChanged は取得中', () => {
    const { l, to } = harness();
    to('Ready');
    l.onPatChanged();
    expect(l.state).toBe('Loading');
  });

  it('[DD-PAGESV-LOADER-T016] 表示中で別の対象の open は取得中・同じ対象は route だけ差し替える', () => {
    const { l, to } = harness();
    to('Ready');
    const gen = l.gen;
    l.open(A2);
    expect(l.state).toBe('Ready');
    expect(l.gen).toBe(gen);
    expect(l.route?.path).toBe('docs/a.md');
    l.open(B);
    expect(l.state).toBe('Loading');
    expect(l.target?.kind).toBe('ref');
  });

  it('[DD-PAGESV-LOADER-T017] 表示中で changeTarget は対象なし', () => {
    const { l, to, watchers } = harness();
    to('Ready');
    l.changeTarget();
    expect(l.state).toBe('Idle');
    expect(watchers[0]!.stopped).toBe(1);
  });

  it('[DD-PAGESV-LOADER-T018] 更新ありで reload は取得中', () => {
    const { l, to } = harness();
    to('Stale');
    l.reload();
    expect(l.state).toBe('Loading');
  });

  it('[DD-PAGESV-LOADER-T019] 更新ありで onPatChanged は取得中', () => {
    const { l, to } = harness();
    to('Stale');
    l.onPatChanged();
    expect(l.state).toBe('Loading');
  });

  it('[DD-PAGESV-LOADER-T020] 更新ありで changeTarget は対象なし', () => {
    const { l, to } = harness();
    to('Stale');
    l.changeTarget();
    expect(l.state).toBe('Idle');
  });

  // 不正遷移：状態を変えない
  type Ev = 'open' | 'loaded' | 'failed' | 'changeTarget' | 'onPatChanged' | 'onHeadChanged' | 'reload';
  function expectUnchanged(state: LoaderState, ev: Ev) {
    const { l, to, snap } = harness();
    to(state);
    const gen = l.gen;
    const s = snap();
    const before = { target: l.target, error: l.error, snapshot: l.snapshot, staleSha: l.staleSha };
    switch (ev) {
      case 'open':
        // 同じ対象の open（URL の文書だけが変わる）
        l.open(A2);
        break;
      case 'loaded':
        l.onLoaded(gen - 1, s);
        l.onLoaded(gen, s);
        break;
      case 'failed':
        l.onFailed(gen - 1, new Error('late'));
        l.onFailed(gen, new Error('late'));
        break;
      case 'changeTarget':
        l.changeTarget();
        break;
      case 'onPatChanged':
        l.onPatChanged();
        break;
      case 'onHeadChanged':
        l.onHeadChanged('e'.repeat(40));
        break;
      case 'reload':
        l.reload();
        break;
    }
    expect(l.state).toBe(state);
    if (ev !== 'changeTarget' && ev !== 'open') expect(l.gen).toBe(gen);
    if (ev !== 'changeTarget') expect({ target: l.target, error: l.error, snapshot: l.snapshot, staleSha: l.staleSha }).toEqual(before);
  }

  it('[DD-PAGESV-LOADER-X001] 対象なしで loaded は状態を変えない（取得をやり直さない）', () => expectUnchanged('Idle', 'loaded'));
  it('[DD-PAGESV-LOADER-X002] 対象なしで failed は状態を変えない（取得をやり直さない）', () => expectUnchanged('Idle', 'failed'));
  it('[DD-PAGESV-LOADER-X003] 対象なしで changeTarget は状態を変えない（取得をやり直さない）', () => expectUnchanged('Idle', 'changeTarget'));
  it('[DD-PAGESV-LOADER-X004] 対象なしで onPatChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('Idle', 'onPatChanged'));
  it('[DD-PAGESV-LOADER-X005] 対象なしで onHeadChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('Idle', 'onHeadChanged'));
  it('[DD-PAGESV-LOADER-X006] 対象なしで reload は状態を変えない（取得をやり直さない）', () => expectUnchanged('Idle', 'reload'));
  it('[DD-PAGESV-LOADER-X007] 取得中で onPatChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('Loading', 'onPatChanged'));
  it('[DD-PAGESV-LOADER-X008] 取得中で onHeadChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('Loading', 'onHeadChanged'));
  it('[DD-PAGESV-LOADER-X009] 取得中で reload は状態を変えない（取得をやり直さない）', () => expectUnchanged('Loading', 'reload'));
  it('[DD-PAGESV-LOADER-X010] PAT が必要で open は状態を変えない（取得をやり直さない）', () => expectUnchanged('NeedToken', 'open'));
  it('[DD-PAGESV-LOADER-X011] PAT が必要で loaded は状態を変えない（取得をやり直さない）', () => expectUnchanged('NeedToken', 'loaded'));
  it('[DD-PAGESV-LOADER-X012] PAT が必要で failed は状態を変えない（取得をやり直さない）', () => expectUnchanged('NeedToken', 'failed'));
  it('[DD-PAGESV-LOADER-X013] PAT が必要で onHeadChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('NeedToken', 'onHeadChanged'));
  it('[DD-PAGESV-LOADER-X014] PAT が必要で reload は状態を変えない（取得をやり直さない）', () => expectUnchanged('NeedToken', 'reload'));
  it('[DD-PAGESV-LOADER-X015] 表示中で loaded は状態を変えない（取得をやり直さない）', () => expectUnchanged('Ready', 'loaded'));
  it('[DD-PAGESV-LOADER-X016] 表示中で failed は状態を変えない（取得をやり直さない）', () => expectUnchanged('Ready', 'failed'));
  it('[DD-PAGESV-LOADER-X017] 更新ありで open は状態を変えない（取得をやり直さない）', () => expectUnchanged('Stale', 'open'));
  it('[DD-PAGESV-LOADER-X018] 更新ありで loaded は状態を変えない（取得をやり直さない）', () => expectUnchanged('Stale', 'loaded'));
  it('[DD-PAGESV-LOADER-X019] 更新ありで failed は状態を変えない（取得をやり直さない）', () => expectUnchanged('Stale', 'failed'));
  it('[DD-PAGESV-LOADER-X020] 更新ありで onHeadChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('Stale', 'onHeadChanged'));
  it('[DD-PAGESV-LOADER-X021] 取得失敗で loaded は状態を変えない（取得をやり直さない）', () => expectUnchanged('Failed', 'loaded'));
  it('[DD-PAGESV-LOADER-X022] 取得失敗で failed は状態を変えない（取得をやり直さない）', () => expectUnchanged('Failed', 'failed'));
  it('[DD-PAGESV-LOADER-X023] 取得失敗で changeTarget は状態を変えない（取得をやり直さない）', () => expectUnchanged('Failed', 'changeTarget'));
  it('[DD-PAGESV-LOADER-X024] 取得失敗で onPatChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('Failed', 'onPatChanged'));
  it('[DD-PAGESV-LOADER-X025] 取得失敗で onHeadChanged は状態を変えない（取得をやり直さない）', () => expectUnchanged('Failed', 'onHeadChanged'));
  it('[DD-PAGESV-LOADER-X026] 取得失敗で reload は状態を変えない（取得をやり直さない）', () => expectUnchanged('Failed', 'reload'));
});

// ---- loading against a fake GitHub ----

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeGitHub(files: Record<string, string>, opts: { compareFails?: boolean; repoStatus?: number; config?: string } = {}) {
  const calls: string[] = [];
  const blobs = Object.entries({ ...files, ...(opts.config !== undefined ? { 'ddv.config.yaml': opts.config } : {}) }).map(([path, text], i) => ({ path, text, sha: `b${i}`.padEnd(40, '0') }));
  const fetch = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    if (u.host === 'raw.githubusercontent.com') {
      const b = blobs.find((x) => u.pathname.endsWith(`/${x.path}`));
      return b ? new Response(b.text) : new Response('nf', { status: 404 });
    }
    const p = u.pathname;
    const rate = { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '55', 'x-ratelimit-reset': '1800000000' };
    if (p === '/repos/o/r') return opts.repoStatus ? json(opts.repoStatus, { message: 'Not Found' }, rate) : json(200, { default_branch: 'main', private: false }, rate);
    if (p === '/repos/o/r/pulls/1') return json(200, { number: 1, title: 'Add docs', state: 'open', html_url: 'h', head: { sha: 'h'.repeat(40), ref: 'feat', repo: { full_name: 'o/r' } }, base: { sha: 'a'.repeat(40), ref: 'main' } }, rate);
    if (p.startsWith('/repos/o/r/compare/')) return opts.compareFails ? json(404, { message: 'Not Found' }) : json(200, { merge_base_commit: { sha: 'm'.repeat(40) } }, rate);
    if (p === '/repos/o/r/commits/release/1.0' || p === '/repos/o/r/commits/main') return json(200, { sha: 'r'.repeat(40) }, rate);
    if (p.startsWith('/repos/o/r/commits/')) return json(422, { message: 'No commit found' }, rate);
    if (p.startsWith('/repos/o/r/git/trees/')) return json(200, { sha: 'x', truncated: false, tree: blobs.map((b) => ({ path: b.path, type: 'blob', mode: '100644', sha: b.sha, size: b.text.length })) }, rate);
    return json(404, { message: 'Not Found' });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

async function loadWith(gh: ReturnType<typeof fakeGitHub>, hash: string, pat: { state: 'none' | 'session'; lastClear: null } = { ...none }, store = new MemoryBlobStore()) {
  const { GitHubClient } = await import('@ddv/github');
  const rate = new RateMeter();
  const client = new GitHubClient({ authorization: async () => null, unauthorized: () => false }, { anonymous: true, fetch: gh.fetch, onResponse: (h) => rate.update(h) });
  const probed: unknown[] = [];
  const built: TargetSnapshot[] = [];
  const steps: string[] = [];
  const l = new TargetLoader({
    client,
    pat,
    store,
    fetch: gh.fetch,
    probe: { fromRepo: (json) => probed.push(json), reset: () => probed.push('reset') },
    build: async (s) => (built.push(s), 'built'),
  });
  l.subscribe(() => {
    const s = l.progress.step;
    if (s && steps.at(-1) !== s) steps.push(s);
  });
  l.open(parseHostedHash(hash, {}));
  for (let i = 0; i < 200 && l.state === 'Loading'; i++) await new Promise((r) => setTimeout(r, 0));
  return { l, rate, probed, built, steps };
}

describe('TargetLoader.load', () => {
  const files = { 'docs/design/a.md': '# A', 'docs/mocks/s.yaml': 'id: s', 'docs/mocks/app.css': 'x{}', 'src/a.test.ts': "it('x')", 'README.md': 'r', '.ddv/testids.lock.json': '{}' };

  it('PR：repo・pulls・compare・trees の 4 回、ファイルは raw（API を使わない）・段階 1 を先読み', async () => {
    const gh = fakeGitHub(files, { config: 'docsRoot: docs/design\nmocksRoot: docs/mocks\nrunners:\n  - name: web\n    type: vitest\n    cwd: src\n' });
    const { l, rate, probed, built, steps } = await loadWith(gh, '#/gh/o/r/pr/1');
    expect(l.state).toBe('Ready');
    const api = gh.calls.filter((c) => c.startsWith('https://api.github.com'));
    expect(api.map((c) => new URL(c).pathname)).toEqual(['/repos/o/r', '/repos/o/r/pulls/1', `/repos/o/r/compare/${'a'.repeat(40)}...${'h'.repeat(40)}`, `/repos/o/r/git/trees/${'h'.repeat(40)}`]);
    const raw = gh.calls.filter((c) => c.startsWith('https://raw.githubusercontent.com')).map((c) => new URL(c).pathname.split('/').slice(4).join('/'));
    expect(raw.sort()).toEqual(['.ddv/testids.lock.json', 'ddv.config.yaml', 'docs/design/a.md', 'docs/mocks/s.yaml', 'src/a.test.ts']);
    const s = l.snapshot!;
    expect(s).toMatchObject({ defaultBranch: 'main', private: false, permission: 'read', commitSha: 'h'.repeat(40), baseSha: 'a'.repeat(40), mergeBase: 'm'.repeat(40), built: 'built' });
    expect(s.pr?.title).toBe('Add docs');
    expect(s.config.docsRoot).toBe('docs/design');
    expect(built).toHaveLength(1);
    expect(probed[0]).toBe('reset');
    expect(steps).toEqual(['info', 'tree', 'files', 'build']);
    expect(rate).toMatchObject({ limit: 60, remaining: 55, known: true });
  });

  it('compare の失敗は mergeBase 無しで続ける・2 回目はキャッシュから読む', async () => {
    const store = new MemoryBlobStore();
    const gh = fakeGitHub(files, { compareFails: true });
    const first = await loadWith(gh, '#/gh/o/r/pr/1', { ...none }, store);
    expect(first.l.state).toBe('Ready');
    expect(first.l.snapshot?.mergeBase).toBeUndefined();
    const gh2 = fakeGitHub(files, { compareFails: true });
    const { l } = await loadWith(gh2, '#/gh/o/r/pr/1', { ...none }, store);
    expect(l.state).toBe('Ready');
    expect(gh2.calls.filter((c) => c.includes('raw.githubusercontent.com') && !c.endsWith('ddv.config.yaml'))).toEqual([]);
  });

  it('ref：repo・commits・trees の 3 回（ref はセグメントごとにエンコード）、422 は notFound', async () => {
    const gh = fakeGitHub(files);
    const { l } = await loadWith(gh, '#/gh/o/r/ref/release%2F1.0');
    expect(l.state).toBe('Ready');
    expect(gh.calls.filter((c) => c.startsWith('https://api.github.com')).map((c) => new URL(c).pathname)).toEqual(['/repos/o/r', '/repos/o/r/commits/release/1.0', `/repos/o/r/git/trees/${'r'.repeat(40)}`]);
    const bad = await loadWith(fakeGitHub(files), '#/gh/o/r/ref/nope', { ...withPat });
    expect(bad.l.state).toBe('Failed');
    expect(bad.l.error?.kind).toBe('notFound');
  });

  it('PAT なしの 404 は PAT が必要・設定のエラーは取得失敗', async () => {
    expect((await loadWith(fakeGitHub(files, { repoStatus: 404 }), '#/gh/o/r')).l.state).toBe('NeedToken');
    const bad = await loadWith(fakeGitHub(files, { config: 'docsRoot: [1' }), '#/gh/o/r');
    expect(bad.l.state).toBe('Failed');
    expect(bad.l.error?.message).toMatch(/^ddv\.config\.yaml を読めません：/);
  });
});

describe('selectPrefetch / RateMeter', () => {
  it('段階 1：docsRoot の md・ロック・ランナーのテスト・mocksRoot の YAML（その他は読まない）', () => {
    const config = parseConfig({ docsRoot: 'docs', mocksRoot: 'docs/mocks', runners: [{ name: 'net', type: 'dotnet', cwd: 'tests' }, { name: 'web', type: 'vitest', cwd: '.', include: ['e2e/**/*.spec.ts'] }] });
    const tree = ['docs/a.md', 'docs/mocks/s.yml', 'docs/mocks/x.png', 'docs/img.png', 'tests/A.cs', 'tests/b.txt', 'e2e/a.spec.ts', 'src/x.ts', '.ddv/testids.lock.json', 'README.md'].map((path) => ({ path }));
    expect(selectPrefetch(tree, config)).toEqual(['.ddv/testids.lock.json', 'docs/a.md', 'docs/mocks/s.yml', 'e2e/a.spec.ts', 'tests/A.cs']);
  });

  it('RateMeter は x-ratelimit-* を読み、残り 10 未満で low', () => {
    const r = new RateMeter();
    let n = 0;
    r.subscribe(() => n++);
    r.update(new Headers());
    expect(r.known).toBe(false);
    r.update(new Headers({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': '1800000000' }));
    expect(r).toMatchObject({ limit: 60, remaining: 9, low: true });
    expect(r.resetAt?.getTime()).toBe(1800000000 * 1000);
    expect(n).toBe(1);
  });
});
