import { describe, expect, it, vi } from 'vitest';
import { GitHubError } from '@ddv/github';
import { GATE_MESSAGES, loadConfigFrom, MemoryRepoReader, type TrackerUpdate } from '@ddv/services';
import { createPagesBackend } from '../backend/pages.ts';
import type { ActionsEvent, BackendEvent, GateResult, PatView } from '../backend/types.ts';
import { buildTarget, type TargetContextDeps } from './target-context.ts';
import type { TargetSnapshot } from './target-loader.ts';

const SHA = 'a1b2c3d'.padEnd(40, '0');

/** GitHub of one repository `o/r` with the ddv workflow on `main` (actions-run.md の API だけ). */
function fakeGitHub(opts: { push?: boolean } = {}) {
  const runs: { id: number; display_title: string; head_sha: string; status: string; conclusion: string | null; created_at: string; html_url: string; head_branch: string }[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const rest = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const p = path.split('?')[0];
    if (p === '/repos/o/r') return { default_branch: 'main', ...(opts.push === undefined ? {} : { permissions: { push: opts.push, pull: true } }) };
    if (p === '/repos/o/r/contents/.github/workflows/ddv-tests.yml') return { sha: 'w', path: p };
    if (p === '/repos/o/r/actions/workflows/ddv-tests.yml/dispatches' && method === 'POST') {
      posts.push({ path: p, body });
      const inputs = (body as { inputs: Record<string, string> }).inputs;
      runs.unshift({ id: 77, display_title: `ddv test ${inputs.request}`, head_sha: inputs.sha, status: 'in_progress', conclusion: null, created_at: new Date().toISOString(), html_url: 'https://github.com/o/r/actions/runs/77', head_branch: 'main' });
      return undefined;
    }
    if (p === '/repos/o/r/actions/workflows/ddv-tests.yml/runs') return { workflow_runs: runs };
    if (p === '/repos/o/r/actions/runs/77') return { ...runs[0], status: 'completed', conclusion: 'success' };
    if (p === '/repos/o/r/actions/runs/77/jobs') return { jobs: [] };
    throw new GitHubError('notFound', 404, 'Not Found');
  });
  return { client: { rest }, rest, posts };
}

async function snapshotOf(): Promise<TargetSnapshot> {
  const reader = new MemoryRepoReader({ 'ddv.config.yaml': 'docsRoot: docs\n', 'docs/req.md': '---\nid: REQ-1\nkind: requirement\ntitle: 要件\n---\n# 要件\n' });
  const config = await loadConfigFrom(reader);
  return { target: { owner: 'o', repo: 'r', kind: 'ref', ref: 'main' }, defaultBranch: 'main', private: false, permission: 'write', commitSha: SHA, reader: reader as never, config };
}

function depsOf(gh: ReturnType<typeof fakeGitHub>, pat: PatView, gate: () => GateResult, onActions?: (e: unknown) => void): TargetContextDeps {
  return {
    github: gh.client as never,
    pat,
    gate: { check: gate },
    pending: {} as never,
    refresh: async () => {},
    ...(onActions ? { onActions: onActions as TargetContextDeps['onActions'] } : {}),
    actionsIntervals: { firstFind: 0, find: 0, track: 0 },
  };
}

const withPat: PatView = { state: 'session', lastClear: null };
const noPat: PatView = { state: 'none', lastClear: null };

describe('buildTarget の Actions（actions-run.md・services.md「PagesActionsTarget」）', () => {
  it('onActions を渡すと対象の ActionsService を作り、可否は PagesActionsTarget の対象で判定する', async () => {
    const gh = fakeGitHub({ push: true });
    const built = await buildTarget(await snapshotOf(), depsOf(gh, withPat, () => ({ enabled: true }), () => {}));
    const b = createPagesBackend(built.scope, () => built.context);
    const st = await b.actionsStatus();
    expect(st).toMatchObject({ state: 'ready', repo: 'o/r', defaultBranch: 'main', workflow: true, canInit: false, target: { ref: 'main', sha: SHA, fork: false } });
    built.dispose();
  });

  it('onActions が無ければ ActionsService を作らず Actions は hidden', async () => {
    const gh = fakeGitHub({ push: true });
    const built = await buildTarget(await snapshotOf(), depsOf(gh, withPat, () => ({ enabled: true })));
    expect(built.context.services.actions).toBeUndefined();
    await expect(createPagesBackend(built.scope, () => built.context).actionsStatus()).resolves.toMatchObject({ state: 'hidden' });
    expect(gh.rest).not.toHaveBeenCalled();
  });

  it('起動はゲート（actionsDispatch）を通し、追跡のイベントは onActions と購読の再送で届き、dispose で追跡を止める', async () => {
    const gh = fakeGitHub({ push: true });
    const events: ActionsEvent[] = [];
    const gate = vi.fn((): GateResult => ({ enabled: false, reason: 'PAT を設定してください（Actions: Write）' }));
    const built = await buildTarget(await snapshotOf(), depsOf(gh, withPat, gate, (e) => events.push(e as ActionsEvent)));
    const b = createPagesBackend(built.scope, () => built.context);
    await expect(b.actionsDispatch({ ids: ['REQ-1'] })).rejects.toMatchObject({ status: 403, code: 'permission', message: 'PAT を設定してください（Actions: Write）' });
    expect(gate).toHaveBeenCalledWith('actionsDispatch');
    expect(gh.posts).toEqual([]);

    gate.mockReturnValue({ enabled: true });
    const { request } = await b.actionsDispatch({});
    expect(request).toMatch(/^ddv-[0-9a-f]{8}$/);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tracker' && e.state === 'Completed')).toBe(true));
    expect(gh.posts).toEqual([{ path: '/repos/o/r/actions/workflows/ddv-tests.yml/dispatches', body: { ref: 'main', inputs: { request, mode: 'test', ids: '', runner: '', sha: SHA, run: '' } } }]);
    const states = events.filter((e): e is ActionsEvent & TrackerUpdate => e.type === 'tracker').map((e) => e.state);
    expect(states).toEqual(['Dispatching', 'Running', 'Completed']);
    expect(events.filter((e) => e.type === 'tracker').at(-1)).toMatchObject({ request, resultId: '77-1', conclusion: 'success' });

    // A subscriber that comes later (the screens opened again) gets the latest update first.
    const got: BackendEvent[] = [];
    const off = b.subscribe((e) => got.push(e));
    expect(got).toEqual([{ type: 'actions', data: expect.objectContaining({ type: 'tracker', request, state: 'Completed' }) }]);
    off();

    built.dispose();
    const n = events.length;
    built.context.services.actions!.trackers.get(request)!.patch({ error: 'x' });
    expect(events).toHaveLength(n);
  });

  it('基準画像の承認もゲート（snapshotApprove）を通す', async () => {
    const gh = fakeGitHub({ push: true });
    const gate = vi.fn((): GateResult => ({ enabled: false, reason: '権限を確認中です' }));
    const built = await buildTarget(await snapshotOf(), depsOf(gh, withPat, gate, () => {}));
    await expect(createPagesBackend(built.scope, () => built.context).actionsApprove('77-1', ['BD-X'])).rejects.toMatchObject({ status: 403, code: 'permission' });
    expect(gate).toHaveBeenCalledWith('snapshotApprove');
    built.dispose();
  });

  it('PAT が無ければ実行できない（readonly・PAT が無いため…）が、結果の一覧は読む', async () => {
    const gh = fakeGitHub();
    const built = await buildTarget(await snapshotOf(), depsOf(gh, noPat, () => ({ enabled: true }), () => {}));
    const b = createPagesBackend(built.scope, () => built.context);
    await expect(b.actionsStatus()).resolves.toMatchObject({ state: 'readonly', reason: GATE_MESSAGES.noPat, workflow: true });
    await expect(b.actionsRuns()).resolves.toMatchObject({ index: { state: 'noBranch' }, rows: [] });
    await expect(b.actionsDispatch({})).rejects.toMatchObject({ status: 403, code: 'readonly' });
    expect(gh.posts).toEqual([]);
    built.dispose();
  });
});
