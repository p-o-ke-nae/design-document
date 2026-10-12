import { describe, expect, it, vi } from 'vitest';
import { GitHubError } from '@ddv/github';
import { loadConfigFrom, MemoryRepoReader, ReviewError, type Services } from '@ddv/services';
import { PAGES_CAPABILITIES } from './capabilities.ts';
import { createPagesBackend, createPagesContext, MemoryPlayStore, pagesCall, PagesFeed, type CallDeps, type PagesContext } from './pages.ts';
import { ApiError, type BackendEvent, type GateResult, type OperationId, type PatView } from './types.ts';

const pat: PatView = { state: 'session', lastClear: null };

function deps(gate: (op: OperationId) => GateResult = () => ({ enabled: true })): CallDeps & { check: ReturnType<typeof vi.fn> } {
  const check = vi.fn(gate);
  return { capabilities: PAGES_CAPABILITIES, gate: { check }, pat, check };
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('resolved');
}

describe('pagesCall (DD-SVC-PGCALL)', () => {
  it('[DD-SVC-PGCALL-P001] [DD-SVC-PGCALL-T001] [DD-SVC-PGCALL-T002] unsupported は通信せず 405 unsupported と reason', async () => {
    const d = deps();
    const fn = vi.fn();
    const e = await rejection(pagesCall(d, 'runLocal', fn));
    expect(e).toBeInstanceOf(ApiError);
    const reason = (PAGES_CAPABILITIES.runLocal as { reason: string }).reason;
    expect(e).toMatchObject({ status: 405, code: 'unsupported', message: reason, body: { code: 'unsupported', error: reason } });
    expect(fn).not.toHaveBeenCalled();
    expect(d.check).not.toHaveBeenCalled();
  });

  it('[DD-SVC-PGCALL-P002] [DD-SVC-PGCALL-T001] [DD-SVC-PGCALL-T003] [DD-SVC-PGCALL-T007] [DD-SVC-PGCALL-T008] available（op なしの読み取り）は fn の結果を返す', async () => {
    const d = deps();
    await expect(pagesCall(d, undefined, () => ({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(pagesCall(d, undefined, async () => 42)).resolves.toBe(42);
    expect(d.check).not.toHaveBeenCalled();
    // An op whose capability is available (local-style capabilities) does not ask the gate either
    const local = { ...d, capabilities: { ...PAGES_CAPABILITIES, comment: { kind: 'available' as const } } };
    await expect(pagesCall(local, 'comment', () => 'x')).resolves.toBe('x');
    expect(d.check).not.toHaveBeenCalled();
  });

  it('[DD-SVC-PGCALL-P003] [DD-SVC-PGCALL-T003] [DD-SVC-PGCALL-T007] [DD-SVC-PGCALL-T009] available の fn の例外は toApiError で変換して投げる', async () => {
    const e = await rejection(pagesCall(deps(), undefined, () => Promise.reject(new GitHubError('notFound', 404, 'Not Found'))));
    expect(e).toMatchObject({ status: 404, code: 'github-notFound' });
    const s = await rejection(pagesCall(deps(), undefined, () => {
      throw new ReviewError(422, 'comment-required', 'コメントを入力してください');
    }));
    expect(s).toMatchObject({ status: 422, code: 'comment-required', message: 'コメントを入力してください' });
  });

  it('[DD-SVC-PGCALL-P004] [DD-SVC-PGCALL-T004] [DD-SVC-PGCALL-T005] write で OperationGate が enabled でなければ通信せず 403 permission と GateResult の reason', async () => {
    const d = deps(() => ({ enabled: false, reason: 'PAT に pull_requests の書き込み権限がありません' }));
    const fn = vi.fn();
    const e = await rejection(pagesCall(d, 'comment', fn));
    expect(e).toMatchObject({ status: 403, code: 'permission', message: 'PAT に pull_requests の書き込み権限がありません', body: { code: 'permission' } });
    expect(d.check).toHaveBeenCalledWith('comment');
    expect(fn).not.toHaveBeenCalled();
    // Several ops: all must pass
    const partial = deps((op) => (op === 'approveStatus' ? { enabled: false, reason: 'statuses がありません' } : { enabled: true }));
    const e2 = await rejection(pagesCall(partial, ['submitReview', 'approveStatus'], fn));
    expect(e2).toMatchObject({ status: 403, message: 'statuses がありません' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('[DD-SVC-PGCALL-P005] [DD-SVC-PGCALL-T004] [DD-SVC-PGCALL-T006] [DD-SVC-PGCALL-T007] [DD-SVC-PGCALL-T008] write で enabled なら fn を呼んで結果を返す', async () => {
    const d = deps();
    await expect(pagesCall(d, 'reply', () => ({ id: 1 }))).resolves.toEqual({ id: 1 });
    expect(d.check).toHaveBeenCalledWith('reply');
  });

  it('[DD-SVC-PGCALL-P006] [DD-SVC-PGCALL-T006] [DD-SVC-PGCALL-T009] write の fn の例外は toApiError で変換して投げる（forbidden は 403 github-forbidden）', async () => {
    const e = await rejection(pagesCall(deps(), 'resolveThread', () => Promise.reject(new GitHubError('forbidden', 403, 'Resource not accessible'))));
    expect(e).toMatchObject({ status: 403, code: 'github-forbidden' });
    const u = await rejection(pagesCall(deps(), 'submitReview', () => Promise.reject(new Error('壊れました'))));
    expect(u).toMatchObject({ status: 500, message: '壊れました' });
  });
});

describe('PagesFeed', () => {
  it('TargetLoader が Stale になったとき stale を 1 回だけ配る（head が変われば再度）', () => {
    const feed = new PagesFeed();
    const got: BackendEvent[] = [];
    const off = feed.add((e) => got.push(e));
    feed.onTarget({ state: 'Ready' });
    feed.onTarget({ state: 'Stale', headSha: 'aaa' });
    feed.onTarget({ state: 'Stale', headSha: 'aaa' });
    feed.onTarget({ state: 'Stale', headSha: 'bbb' });
    feed.onTarget({ state: 'Loading' });
    feed.onTarget({ state: 'Stale', headSha: 'bbb' });
    expect(got).toEqual([
      { type: 'stale', headSha: 'aaa' },
      { type: 'stale', headSha: 'bbb' },
      { type: 'stale', headSha: 'bbb' },
    ]);
    off();
    feed.onActions({ type: 'update' });
    expect(feed.size).toBe(0);
    expect(got).toHaveLength(3);
  });

  it('ActionsService のイベントを actions として配る', () => {
    const feed = new PagesFeed();
    const got: BackendEvent[] = [];
    feed.add((e) => got.push(e));
    feed.onActions({ type: 'history' });
    expect(got).toEqual([{ type: 'actions', data: { type: 'history' } }]);
  });
});

describe('createPagesBackend', () => {
  function context(services: Partial<Services>, extra: Partial<PagesContext> = {}): PagesContext {
    return { services: services as Services, reader: {} as PagesContext['reader'], pat, gate: { check: () => ({ enabled: true }) }, ...extra };
  }

  it('対象を読み込む前は 503 not-ready', async () => {
    const b = createPagesBackend('t', () => undefined);
    expect(b.edition).toBe('pages');
    await expect(b.config()).rejects.toMatchObject({ status: 503, code: 'not-ready' });
  });

  it('読み取りはサービスを呼び、ローカルだけの操作は通信せず 405', async () => {
    const config = vi.fn(async () => ({ docsDir: 'docs' }));
    const b = createPagesBackend('t', () => context({ docs: { config } as unknown as Services['docs'] }));
    await expect(b.config()).resolves.toEqual({ docsDir: 'docs' });
    await expect(b.startRun({} as never)).rejects.toMatchObject({ status: 405, code: 'unsupported' });
    await expect(b.installDeps()).rejects.toMatchObject({ status: 405, code: 'unsupported' });
    await expect(b.runs()).resolves.toEqual([]);
    expect(b.capabilities.comment.kind).toBe('write');
  });

  it('PR でない対象のレビューは 404、PR ならゲートを通してから書く', async () => {
    const add = vi.fn(async () => ({ id: 'c1' }));
    const gate = vi.fn((): GateResult => ({ enabled: false, reason: '読み取り専用です' }));
    const services = { review: { add } as unknown as Services['review'] };
    const branch = createPagesBackend('t', () => context(services));
    await expect(branch.review()).rejects.toMatchObject({ status: 404 });
    const pr = createPagesBackend('t', () => context(services, { gate: { check: gate }, prContext: async () => ({}) as never }));
    await expect(pr.addComment({} as never)).rejects.toMatchObject({ status: 403, code: 'permission', message: '読み取り専用です' });
    expect(add).not.toHaveBeenCalled();
    gate.mockReturnValue({ enabled: true });
    await expect(pr.addComment({} as never)).resolves.toEqual({ id: 'c1' });
  });

  it('シナリオの再生はタブのメモリに記録する', async () => {
    const plays = new MemoryPlayStore();
    const b = createPagesBackend('t', () => context({}, { plays }));
    const r = await b.played({ id: 's1', ok: true });
    expect(r).toMatchObject({ id: 's1', ok: true });
    expect(Object.keys(await plays.read())).toEqual(['s1']);
  });

  it('createPagesContext は対象の RepoReader だけでサービスを組み立てる（手元の実行なし・PR でなければレビューなし）', async () => {
    const reader = new MemoryRepoReader({ 'ddv.config.yaml': 'docsRoot: docs\n', 'docs/req.md': '---\nid: REQ-1\nkind: requirement\ntitle: 要件\n---\n# 要件\n' });
    const config = await loadConfigFrom(reader);
    const ctx = createPagesContext({ reader, getConfig: () => config, repoRoot: 'o/repo', repoName: 'repo', pat, gate: { check: () => ({ enabled: true }) } });
    const b = createPagesBackend('o/repo@main', () => ctx);
    await expect(b.config()).resolves.toMatchObject({ repoRoot: 'o/repo' });
    expect((await b.tree()).docs.map((d) => d.path)).toEqual(['docs/req.md']);
    await expect(b.latest()).resolves.toEqual({});
    await expect(b.review()).rejects.toMatchObject({ status: 404 });
    expect(b.repo()).toBe(reader);
    await b.played({ id: 's', ok: false });
    expect(Object.keys(await ctx.plays!.read())).toEqual(['s']);
  });
});
