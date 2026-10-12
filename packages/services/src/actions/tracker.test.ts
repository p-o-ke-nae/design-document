import { GitHubError, type GhWorkflowRun } from '@ddv/github';
import { describe, expect, it } from 'vitest';
import { ActionsRunTracker, DispatchFailure, findRun, toRunInfo, TRACK_MESSAGES, type TrackerState, type TrackerUpdate } from './tracker.ts';

const repo = { owner: 'acme', repo: 'order-app' };
const REQ = 'ddv-0000abcd';

const ghRun = (status: string, conclusion: string | null = null, extra: Partial<GhWorkflowRun> = {}): GhWorkflowRun => ({
  id: 42,
  run_attempt: 1,
  display_title: `ddv test ${REQ}`,
  head_branch: 'feature/x',
  head_sha: 'b'.repeat(40),
  status,
  conclusion,
  created_at: '2025-01-01T00:00:00Z',
  html_url: 'https://github.com/acme/order-app/actions/runs/42',
  actor: { login: 'alice' },
  ...extra,
});

describe('findRun', () => {
  type Resp = 'net' | 'hit' | 'miss' | 'hard';
  async function play(resps: Resp[], deadline: number) {
    let now = 0;
    const sleeps: number[] = [];
    const queue = [...resps];
    const paths: string[] = [];
    const client = {
      rest: async <T,>(_m: string, path: string): Promise<T> => {
        paths.push(path);
        const r = queue.shift();
        if (r === 'net') throw new GitHubError('network', 502, 'GitHub との通信に失敗しました: x');
        if (r === 'hard') throw new GitHubError('auth', 401, 'GitHub の認証に失敗しました: Bad credentials');
        if (r === 'hit')
          return {
            workflow_runs: [
              ghRun('queued', null, { id: 7, display_title: `ddv test ${REQ}x` }),
              ghRun('queued', null, { id: 8, created_at: '2025-01-01T00:00:01Z' }),
              ghRun('in_progress', null, { id: 9, created_at: '2025-01-01T00:00:05Z', run_attempt: 2, triggering_actor: { login: 'bob' } }),
            ],
          } as T;
        return { workflow_runs: [ghRun('queued', null, { display_title: 'ddv test ddv-ffffffff' })] } as T;
      },
    };
    const timers = { now: () => now, sleep: async (ms: number) => void (sleeps.push(ms), (now += ms)) };
    const result = await findRun({ client, repo, timers }, REQ, 'feature/x', deadline).then(
      (v) => ({ ok: v }),
      (e: DispatchFailure) => ({ err: e }),
    );
    expect(queue).toEqual([]);
    expect(sleeps.every((s) => s === 3_000)).toBe(true);
    return { result, paths, sleeps };
  }
  const NOT = 'notDetected';
  const expectFail = (r: { ok?: unknown; err?: DispatchFailure }, kind: 'hard' | typeof NOT) => {
    expect(r.err).toBeInstanceOf(DispatchFailure);
    expect(r.err!.message).toBe(kind === NOT ? TRACK_MESSAGES.notDetected : 'GitHub の認証に失敗しました: Bad credentials');
  };
  const expectHit = (r: { ok?: unknown }) => expect(r.ok).toMatchObject({ id: '9', attempt: 2, resultId: '9-2', request: REQ, mode: 'test', actor: 'bob', status: 'in_progress' });

  it('[DD-ACTSVC-FINDRUN-P001][DD-ACTSVC-FINDRUN-T001][DD-ACTSVC-FINDRUN-T002][DD-ACTSVC-FINDRUN-T003] 認証などの失敗は起動失敗（理由つき）', async () => {
    const { result, paths } = await play(['hard'], 1e9);
    expectFail(result, 'hard');
    expect(paths[0]).toBe('/repos/acme/order-app/actions/workflows/ddv-tests.yml/runs?event=workflow_dispatch&branch=feature%2Fx&per_page=20');
  });
  it('[DD-ACTSVC-FINDRUN-P002][DD-ACTSVC-FINDRUN-T004][DD-ACTSVC-FINDRUN-T008] 通信失敗で期限を過ぎていれば検出できない', async () => {
    expectFail((await play(['net'], 0)).result, NOT);
  });
  it('[DD-ACTSVC-FINDRUN-P003][DD-ACTSVC-FINDRUN-T009][DD-ACTSVC-FINDRUN-T010] 通信失敗 → 3 秒待つ → 認証の失敗', async () => {
    const { result, sleeps } = await play(['net', 'hard'], 1e9);
    expectFail(result, 'hard');
    expect(sleeps).toEqual([3_000]);
  });
  it('[DD-ACTSVC-FINDRUN-P004] 通信失敗 → 3 秒待つ → 通信失敗で期限切れ', async () => {
    expectFail((await play(['net', 'net'], 3_000)).result, NOT);
  });
  it('[DD-ACTSVC-FINDRUN-P005] 通信失敗 → 3 秒待つ → 検出', async () => {
    expectHit((await play(['net', 'hit'], 1e9)).result);
  });
  it('[DD-ACTSVC-FINDRUN-P006] 通信失敗 → 3 秒待つ → 該当なしで期限切れ', async () => {
    expectFail((await play(['net', 'miss'], 3_000)).result, NOT);
  });
  it('[DD-ACTSVC-FINDRUN-P007][DD-ACTSVC-FINDRUN-T005][DD-ACTSVC-FINDRUN-T006] display_title の語が依頼IDと一致する実行のうち新しいものを返す', async () => {
    expectHit((await play(['hit'], 1e9)).result);
  });
  it('[DD-ACTSVC-FINDRUN-P008][DD-ACTSVC-FINDRUN-T007] 該当なしで期限を過ぎていれば検出できない', async () => {
    expectFail((await play(['miss'], 0)).result, NOT);
  });
  it('[DD-ACTSVC-FINDRUN-P009] 該当なし → 3 秒待つ → 認証の失敗', async () => {
    expectFail((await play(['miss', 'hard'], 1e9)).result, 'hard');
  });
  it('[DD-ACTSVC-FINDRUN-P010] 該当なし → 3 秒待つ → 通信失敗で期限切れ', async () => {
    expectFail((await play(['miss', 'net'], 3_000)).result, NOT);
  });
  it('[DD-ACTSVC-FINDRUN-P011] 該当なし → 3 秒待つ → 検出', async () => {
    expectHit((await play(['miss', 'hit'], 1e9)).result);
  });
  it('[DD-ACTSVC-FINDRUN-P012] 該当なし → 3 秒待つ → 該当なしで期限切れ', async () => {
    expectFail((await play(['miss', 'miss'], 3_000)).result, NOT);
  });

  it('toRunInfo は approve の語と待機系の状態をまとめる', () => {
    expect(toRunInfo(ghRun('waiting', null, { display_title: 'ddv approve ddv-12345678' }))).toMatchObject({ mode: 'approve', request: 'ddv-12345678', status: 'queued', actor: 'alice', ref: 'feature/x' });
    expect(toRunInfo(ghRun('completed', 'cancelled', { display_title: 'ddv tests' }))).not.toHaveProperty('request');
  });
});

describe('ActionsRunTracker', () => {
  type Ev = 'reject' | 'undetected' | 'detected' | 'hard' | 'timeout' | 'stop' | 'progress' | 'fail' | 'done' | 'cancel';

  async function play(how: 'start' | 'attach', events: Ev[], opts: { firstFind?: number } = {}) {
    let now = 1_000_000;
    const queue = [...events];
    const calls: Array<{ path: string; state: TrackerState | null }> = [];
    const updates: TrackerUpdate[] = [];
    let tracker!: ActionsRunTracker;
    const take = (allowed: Ev[]) => {
      const e = queue[0];
      if (e && allowed.includes(e)) return queue.shift();
      return undefined;
    };
    const client = {
      rest: async <T,>(m: string, path: string): Promise<T> => {
        calls.push({ path: `${m} ${path}`, state: tracker.state });
        if (path.endsWith('/dispatches')) {
          if (take(['reject'])) throw new GitHubError('forbidden', 403, '権限がありません: x');
          return undefined as T;
        }
        if (path.includes('/workflows/ddv-tests.yml/runs')) {
          const e = take(['undetected', 'detected', 'hard', 'timeout']);
          if (e === 'hard') throw new GitHubError('auth', 401, 'GitHub の認証に失敗しました: x');
          if (e === 'detected') return { workflow_runs: [ghRun('in_progress')] } as T;
          if (e === 'timeout') now += 61_000;
          return { workflow_runs: [] } as T;
        }
        if (path.endsWith('/jobs?per_page=100')) return { jobs: [{ id: 1, name: 'test', status: 'in_progress', steps: [{ number: 1, name: 'checkout', status: 'completed', conclusion: 'success' }] }] } as T;
        if (path.includes('/actions/runs/42')) {
          const e = take(['progress', 'fail', 'done', 'cancel']);
          if (e === 'fail') throw new GitHubError('network', 502, 'GitHub との通信に失敗しました: x');
          if (e === 'done') return ghRun('completed', 'failure') as T;
          if (e === 'cancel') return ghRun('completed', 'cancelled') as T;
          if (e === 'progress') return ghRun('in_progress') as T;
          throw new Error(`no scripted status: ${queue.join(',')}`);
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const timers = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        if (take(['stop'])) tracker.stop();
      },
    };
    tracker = new ActionsRunTracker(how === 'start' ? REQ : '', 'test', { client, repo, timers, intervals: { firstFind: opts.firstFind ?? 2_000 }, onUpdate: (u) => updates.push(u) });
    if (how === 'start') {
      const p = tracker.start(() => client.rest('POST', '/repos/acme/order-app/actions/workflows/ddv-tests.yml/dispatches'), 'feature/x');
      await p;
    } else {
      const p = tracker.attach('42');
      if (take(['stop'])) tracker.stop();
      await p;
    }
    expect(queue).toEqual([]);
    const states = updates.map((u) => u.state).filter((s, i, a) => i === 0 || a[i - 1] !== s);
    return { tracker, states, calls, updates };
  }


  it('[DD-ACTSVC-TRACK-P001][DD-ACTSVC-TRACK-T001][DD-ACTSVC-TRACK-T003][DD-ACTSVC-TRACK-T015] start → dispatch 拒否 → 起動失敗', async () => {
    const { states, tracker, updates } = await play('start', ['reject']);
    expect(states).toEqual(['Dispatching', 'Failed']);
    expect(tracker.error).toBe('権限がありません: x');
    expect(updates.at(-1)).toMatchObject({ type: 'tracker', request: REQ, mode: 'test', state: 'Failed', code: 'github-forbidden' });
  });
  it('[DD-ACTSVC-TRACK-P002][DD-ACTSVC-TRACK-T004] 未検出 → 一覧の取得が認証で失敗 → 起動失敗', async () => {
    expect((await play('start', ['undetected', 'hard'])).states).toEqual(['Dispatching', 'Failed']);
  });
  it('[DD-ACTSVC-TRACK-P003][DD-ACTSVC-TRACK-T005][DD-ACTSVC-TRACK-T007][DD-ACTSVC-TRACK-T009][DD-ACTSVC-TRACK-T013] 未検出 → 検出 → 実行中 → 完了', async () => {
    const { states, tracker, updates } = await play('start', ['undetected', 'detected', 'progress', 'done']);
    expect(states).toEqual(['Dispatching', 'Running', 'Completed']);
    expect(tracker).toMatchObject({ runId: '42', resultId: '42-1' });
    expect(updates.find((u) => u.jobs)?.jobs?.[0]).toMatchObject({ name: 'test', steps: [{ name: 'checkout', conclusion: 'success' }] });
    expect(updates.at(-1)).toMatchObject({ state: 'Completed', conclusion: 'failure', url: 'https://github.com/acme/order-app/actions/runs/42' });
  });
  it('[DD-ACTSVC-TRACK-P004][DD-ACTSVC-TRACK-T010][DD-ACTSVC-TRACK-T014] 未検出 → 検出 → 実行中 → キャンセル', async () => {
    const { states, tracker } = await play('start', ['undetected', 'detected', 'progress', 'cancel']);
    expect(states).toEqual(['Dispatching', 'Running', 'Cancelled']);
    expect(tracker.error).toBe('待機中に新しい実行が起動されたためキャンセルされました');
  });
  it('[DD-ACTSVC-TRACK-P005][DD-ACTSVC-TRACK-T012][DD-ACTSVC-TRACK-T016] 未検出 → 検出 → 実行中 → 停止', async () => {
    expect((await play('start', ['undetected', 'detected', 'progress', 'stop'])).states).toEqual(['Dispatching', 'Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P006][DD-ACTSVC-TRACK-T008] 未検出 → 検出 → 取得失敗（表示を残して続ける）→ 完了', async () => {
    const { states, updates } = await play('start', ['undetected', 'detected', 'fail', 'done']);
    expect(states).toEqual(['Dispatching', 'Running', 'Completed']);
    expect(updates.some((u) => u.state === 'Running' && u.error === '状態を取得できません（再試行中）')).toBe(true);
    expect(updates.at(-1)!.error).toBeUndefined();
  });
  it('[DD-ACTSVC-TRACK-P007] 未検出 → 検出 → 取得失敗 → キャンセル', async () => {
    expect((await play('start', ['undetected', 'detected', 'fail', 'cancel'])).states).toEqual(['Dispatching', 'Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P008] 未検出 → 検出 → 取得失敗 → 停止', async () => {
    expect((await play('start', ['undetected', 'detected', 'fail', 'stop'])).states).toEqual(['Dispatching', 'Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P009] 未検出 → 検出 → 完了', async () => {
    expect((await play('start', ['undetected', 'detected', 'done'])).states).toEqual(['Dispatching', 'Running', 'Completed']);
  });
  it('[DD-ACTSVC-TRACK-P010] 未検出 → 検出 → キャンセル', async () => {
    expect((await play('start', ['undetected', 'detected', 'cancel'])).states).toEqual(['Dispatching', 'Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P011] 未検出 → 検出 → 停止', async () => {
    expect((await play('start', ['undetected', 'detected', 'stop'])).states).toEqual(['Dispatching', 'Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P012][DD-ACTSVC-TRACK-T006] 未検出 → 60 秒を超えた → 起動失敗', async () => {
    const { states, tracker } = await play('start', ['undetected', 'timeout']);
    expect(states).toEqual(['Dispatching', 'Failed']);
    expect(tracker.error).toBe('60 秒以内に Actions の実行を検出できませんでした。Actions の画面で確認してください');
  });
  it('[DD-ACTSVC-TRACK-P013][DD-ACTSVC-TRACK-T011] 未検出 → 停止', async () => {
    const { states, calls } = await play('start', ['undetected', 'stop']);
    expect(states).toEqual(['Dispatching', 'Stopped']);
    expect(calls.filter((c) => c.path.includes('/workflows/ddv-tests.yml/runs'))).toHaveLength(1);
  });
  it('[DD-ACTSVC-TRACK-P014] 検出 → 実行中 → 完了（最初の確認は 204 の 2 秒後）', async () => {
    expect((await play('start', ['detected', 'progress', 'done'])).states).toEqual(['Dispatching', 'Running', 'Completed']);
  });
  it('[DD-ACTSVC-TRACK-P015] 検出 → 実行中 → キャンセル', async () => {
    expect((await play('start', ['detected', 'progress', 'cancel'])).states).toEqual(['Dispatching', 'Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P016] 検出 → 実行中 → 停止', async () => {
    expect((await play('start', ['detected', 'progress', 'stop'])).states).toEqual(['Dispatching', 'Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P017] 検出 → 取得失敗 → 完了', async () => {
    expect((await play('start', ['detected', 'fail', 'done'])).states).toEqual(['Dispatching', 'Running', 'Completed']);
  });
  it('[DD-ACTSVC-TRACK-P018] 検出 → 取得失敗 → キャンセル', async () => {
    expect((await play('start', ['detected', 'fail', 'cancel'])).states).toEqual(['Dispatching', 'Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P019] 検出 → 取得失敗 → 停止', async () => {
    expect((await play('start', ['detected', 'fail', 'stop'])).states).toEqual(['Dispatching', 'Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P020] 検出 → 完了', async () => {
    expect((await play('start', ['detected', 'done'])).states).toEqual(['Dispatching', 'Running', 'Completed']);
  });
  it('[DD-ACTSVC-TRACK-P021] 検出 → キャンセル', async () => {
    expect((await play('start', ['detected', 'cancel'])).states).toEqual(['Dispatching', 'Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P022] 検出 → 停止', async () => {
    expect((await play('start', ['detected', 'stop'])).states).toEqual(['Dispatching', 'Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P023] 最初の確認で 60 秒を超えていれば起動失敗', async () => {
    const { states, calls } = await play('start', ['timeout'], { firstFind: 61_000 });
    expect(states).toEqual(['Dispatching', 'Failed']);
    expect(calls.filter((c) => c.path.includes('/workflows/ddv-tests.yml/runs'))).toHaveLength(1);
  });
  it('[DD-ACTSVC-TRACK-P024] 起動中に停止', async () => {
    const { states, calls } = await play('start', ['stop']);
    expect(states).toEqual(['Dispatching', 'Stopped']);
    expect(calls.map((c) => c.path)).toEqual(['POST /repos/acme/order-app/actions/workflows/ddv-tests.yml/dispatches']);
  });
  it('[DD-ACTSVC-TRACK-P025][DD-ACTSVC-TRACK-T002] attach → 実行中 → 完了（依頼IDは実行から補う）', async () => {
    const { states, tracker } = await play('attach', ['progress', 'progress', 'done']);
    expect(states).toEqual(['Running', 'Completed']);
    expect(tracker.request).toBe(REQ);
  });
  it('[DD-ACTSVC-TRACK-P026] attach → 実行中 → キャンセル', async () => {
    expect((await play('attach', ['progress', 'cancel'])).states).toEqual(['Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P027] attach → 実行中 → 停止', async () => {
    expect((await play('attach', ['progress', 'stop'])).states).toEqual(['Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P028] attach → 取得失敗 → 完了', async () => {
    expect((await play('attach', ['fail', 'done'])).states).toEqual(['Running', 'Completed']);
  });
  it('[DD-ACTSVC-TRACK-P029] attach → 取得失敗 → キャンセル', async () => {
    expect((await play('attach', ['fail', 'cancel'])).states).toEqual(['Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P030] attach → 取得失敗 → 停止', async () => {
    expect((await play('attach', ['fail', 'stop'])).states).toEqual(['Running', 'Stopped']);
  });
  it('[DD-ACTSVC-TRACK-P031] attach → 完了', async () => {
    expect((await play('attach', ['done'])).states).toEqual(['Running', 'Completed']);
  });
  it('[DD-ACTSVC-TRACK-P032] attach → キャンセル', async () => {
    expect((await play('attach', ['cancel'])).states).toEqual(['Running', 'Cancelled']);
  });
  it('[DD-ACTSVC-TRACK-P033] attach → 停止', async () => {
    const { states, tracker } = await play('attach', ['stop']);
    expect(states).toEqual(['Running', 'Stopped']);
    expect(tracker.jobs).toEqual([]);
  });

  it('[DD-ACTSVC-TRACK-X001][DD-ACTSVC-TRACK-X002][DD-ACTSVC-TRACK-X003] 起動中は状態を取得せず、実行中は dispatch も検出の確認もしない', async () => {
    const { calls } = await play('start', ['undetected', 'detected', 'progress', 'fail', 'done']);
    expect(calls.filter((c) => c.state === 'Dispatching' && /\/actions\/runs\/42/.test(c.path))).toEqual([]);
    const running = calls.filter((c) => c.state === 'Running');
    expect(running.length).toBeGreaterThan(0);
    expect(running.filter((c) => c.path.endsWith('/dispatches') || c.path.includes('/workflows/ddv-tests.yml/runs'))).toEqual([]);
  });

  const terminal: Array<[TrackerState, Ev[], string]> = [
    ['Completed', ['detected', 'done'], '[DD-ACTSVC-TRACK-X004][DD-ACTSVC-TRACK-X005][DD-ACTSVC-TRACK-X006][DD-ACTSVC-TRACK-X007]'],
    ['Cancelled', ['detected', 'cancel'], '[DD-ACTSVC-TRACK-X008][DD-ACTSVC-TRACK-X009][DD-ACTSVC-TRACK-X010][DD-ACTSVC-TRACK-X011]'],
    ['Failed', ['reject'], '[DD-ACTSVC-TRACK-X012][DD-ACTSVC-TRACK-X013][DD-ACTSVC-TRACK-X014][DD-ACTSVC-TRACK-X015]'],
    ['Stopped', ['detected', 'stop'], '[DD-ACTSVC-TRACK-X016][DD-ACTSVC-TRACK-X017][DD-ACTSVC-TRACK-X018][DD-ACTSVC-TRACK-X019]'],
  ];
  for (const [state, events, ids] of terminal)
    it(`${ids} ${state} の後は dispatch・検出の確認・状態の取得をせず、stop・2 回目の start / attach は効かない`, async () => {
      const { tracker, calls, updates } = await play('start', events);
      expect(tracker.state).toBe(state);
      const n = calls.length;
      const u = updates.length;
      tracker.stop();
      expect(tracker.state).toBe(state);
      expect(() => tracker.start(async () => undefined, 'x')).toThrow('追跡はすでに始まっています');
      expect(() => tracker.attach('42')).toThrow('追跡はすでに始まっています');
      await new Promise((r) => setTimeout(r, 5));
      expect(calls.length).toBe(n);
      expect(updates.length).toBe(u);
    });

  it('停止の後に届いた取得の結果は捨てる', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const updates: TrackerUpdate[] = [];
    const client = {
      rest: async <T,>(_m: string, path: string): Promise<T> => {
        await gate;
        return (path.endsWith('/jobs?per_page=100') ? { jobs: [] } : ghRun('completed', 'success')) as T;
      },
    };
    const t = new ActionsRunTracker('', 'test', { client, repo, timers: { now: () => 0, sleep: async () => undefined }, onUpdate: (u) => updates.push(u) });
    const p = t.attach('42');
    t.stop();
    release();
    await p;
    expect(t.state).toBe('Stopped');
    expect(updates.map((u) => u.state)).toEqual(['Running', 'Stopped']);
  });
});
