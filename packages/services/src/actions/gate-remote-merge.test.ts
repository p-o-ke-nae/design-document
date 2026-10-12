import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../history.ts';
import { actionsGate, GATE_MESSAGES, type ActionsGateInput } from './gate.ts';
import { latestOf, mergeRunRecords } from './merge.ts';
import { parseGitHubRemote } from './remote.ts';

const repo = { owner: 'acme', repo: 'order-app' };
const base: ActionsGateInput = { remote: repo, workflow: true, fork: false, canPush: true, authenticated: true, defaultBranch: 'main' };

describe('actionsGate', () => {
  it('[DD-ACTSVC-GATE-P001][DD-ACTSVC-GATE-T001][DD-ACTSVC-GATE-T002] remote が無ければ他の入力を見ずに hidden', () => {
    expect(actionsGate({ ...base, remote: null })).toEqual({ state: 'hidden', reason: '' });
    expect(actionsGate({ ...base, remote: null, workflow: null, authenticated: false })).toEqual({ state: 'hidden', reason: '' });
  });

  it('[DD-ACTSVC-GATE-P002][DD-ACTSVC-GATE-T003][DD-ACTSVC-GATE-T004] workflow が確認できないと readonly（未ログイン・Pages・lookupError）', () => {
    expect(actionsGate({ ...base, workflow: null, authenticated: false })).toEqual({ state: 'readonly', reason: GATE_MESSAGES.loginLocal });
    expect(actionsGate({ ...base, workflow: null, authenticated: false, edition: 'pages' })).toEqual({ state: 'readonly', reason: 'PAT を設定すると Actions の結果と実行が使えます' });
    expect(actionsGate({ ...base, workflow: null, lookupError: 'GitHub との通信に失敗しました: x' })).toEqual({ state: 'readonly', reason: 'GitHub との通信に失敗しました: x' });
  });

  it('[DD-ACTSVC-GATE-P003][DD-ACTSVC-GATE-T005] workflow が無ければ setup（既定ブランチ名を理由に入れる）', () => {
    expect(actionsGate({ ...base, workflow: false })).toEqual({ state: 'setup', reason: '既定ブランチ（main）に ddv ワークフロー（.github/workflows/ddv-tests.yml）がありません' });
  });

  it('[DD-ACTSVC-GATE-P004][DD-ACTSVC-GATE-T006][DD-ACTSVC-GATE-T007] fork の PR は fork', () => {
    expect(actionsGate({ ...base, fork: true })).toEqual({ state: 'fork', reason: 'fork からの PR は Actions で実行しません。PR の CI の結果を表示します' });
  });

  it('[DD-ACTSVC-GATE-P005][DD-ACTSVC-GATE-T008][DD-ACTSVC-GATE-T009] push 権限が無ければ readonly（PAT なしと権限なしで文言が違う）', () => {
    expect(actionsGate({ ...base, canPush: false })).toEqual({ state: 'readonly', reason: '書き込み権限が無いため実行できません。実行済みの結果だけを表示します' });
    expect(actionsGate({ ...base, canPush: false, authenticated: false })).toEqual({ state: 'readonly', reason: 'PAT が無いため実行できません。実行済みの結果だけを表示します' });
  });

  it('[DD-ACTSVC-GATE-P006][DD-ACTSVC-GATE-T010] すべて満たせば ready', () => {
    expect(actionsGate(base)).toEqual({ state: 'ready', reason: '' });
  });
});

describe('parseGitHubRemote', () => {
  it('[DD-ACTSVC-REMOTE-P001][DD-ACTSVC-REMOTE-T001][DD-ACTSVC-REMOTE-T002][DD-ACTSVC-REMOTE-T008] scp 形式で GitHub 以外は null', () => {
    expect(parseGitHubRemote('git@gitlab.com:acme/order-app.git')).toBeNull();
    expect(parseGitHubRemote('git@www.github.com:acme/order-app.git')).toBeNull();
  });

  it('[DD-ACTSVC-REMOTE-P002][DD-ACTSVC-REMOTE-T009][DD-ACTSVC-REMOTE-T010][DD-ACTSVC-REMOTE-T011] scp 形式で owner/repo に分かれなければ null', () => {
    expect(parseGitHubRemote('git@github.com:acme/order-app/extra.git')).toBeNull();
    expect(parseGitHubRemote('git@github.com:acme.git')).toBeNull();
  });

  it('[DD-ACTSVC-REMOTE-P003][DD-ACTSVC-REMOTE-T012] scp 形式の github.com は owner と repo', () => {
    expect(parseGitHubRemote('git@github.com:acme/order-app.git')).toEqual(repo);
    expect(parseGitHubRemote('GitHub.com:acme/order-app')).toEqual(repo);
  });

  it('[DD-ACTSVC-REMOTE-P004][DD-ACTSVC-REMOTE-T003][DD-ACTSVC-REMOTE-T004] URL として読めないもの（Windows のパス・空）は null', () => {
    expect(parseGitHubRemote('C:\\work\\order-app')).toBeNull();
    expect(parseGitHubRemote('')).toBeNull();
    expect(parseGitHubRemote('../order-app')).toBeNull();
  });

  it('[DD-ACTSVC-REMOTE-P005][DD-ACTSVC-REMOTE-T005][DD-ACTSVC-REMOTE-T006] 対象外のスキームは null', () => {
    expect(parseGitHubRemote('file:///home/u/order-app.git')).toBeNull();
    expect(parseGitHubRemote('ftp://github.com/acme/order-app.git')).toBeNull();
  });

  it('[DD-ACTSVC-REMOTE-P006][DD-ACTSVC-REMOTE-T007] URL のホストが github.com でなければ null', () => {
    expect(parseGitHubRemote('https://ghe.example.com/acme/order-app.git')).toBeNull();
  });

  it('[DD-ACTSVC-REMOTE-P007] URL のパスが owner/repo でなければ null', () => {
    expect(parseGitHubRemote('https://github.com/acme')).toBeNull();
    expect(parseGitHubRemote('https://github.com/acme/order-app/tree/main')).toBeNull();
  });

  it('[DD-ACTSVC-REMOTE-P008] URL（ユーザー情報・ポート・末尾の / と .git）は無視して owner と repo', () => {
    expect(parseGitHubRemote('https://github.com/acme/order-app.git')).toEqual(repo);
    expect(parseGitHubRemote('https://x-access-token@github.com/acme/order-app/')).toEqual(repo);
    expect(parseGitHubRemote('ssh://git@github.com:22/acme/order-app.git')).toEqual(repo);
    expect(parseGitHubRemote('git+ssh://git@github.com/acme/order-app')).toEqual(repo);
    expect(parseGitHubRemote('http://GITHUB.COM/acme/order-app')).toEqual(repo);
  });
});

const rec = (id: string, startedAt: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  startedAt,
  status: 'passed',
  request: {},
  runners: [],
  results: { 'DD-A-B-T001': { status: 'passed', durationMs: 1, runner: 'r', test: 't' } },
  log: [],
  ...extra,
});

describe('mergeRunRecords', () => {
  it('[DD-ACTSVC-MERGE-P001][DD-ACTSVC-MERGE-T001][DD-ACTSVC-MERGE-T002][DD-ACTSVC-MERGE-T006][DD-ACTSVC-MERGE-T008][DD-ACTSVC-MERGE-T012] 手元の記録は local と id をキーに残し、新しい順・同時刻は id の順', () => {
    const out = mergeRunRecords([rec('b', '2025-01-01T00:00:00Z'), rec('a', '2025-01-01T00:00:00Z'), rec('c', '2025-01-02T00:00:00Z', { source: 'local' })], []);
    expect(out.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('[DD-ACTSVC-MERGE-P002][DD-ACTSVC-MERGE-T009][DD-ACTSVC-MERGE-T010][DD-ACTSVC-MERGE-T013] 結果ブランチから読んだ記録は同じキーを置き換える', () => {
    const local = rec('1-1', '2025-01-01T00:00:00Z', { source: 'actions', actionsRunId: '1', commit: 'aaaaaaa', status: 'failed' });
    const branch = rec('1-1', '2025-01-01T00:00:00Z', { source: 'actions', actionsRunId: '1', commit: 'aaaaaaa', status: 'passed' });
    const out = mergeRunRecords([local], [branch]);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('passed');
  });

  it('[DD-ACTSVC-MERGE-P003][DD-ACTSVC-MERGE-T011] 手元で同じキーが重なれば後のものを除く', () => {
    const out = mergeRunRecords([rec('x', '2025-01-02T00:00:00Z', { status: 'failed' }), rec('x', '2025-01-01T00:00:00Z')], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('failed');
  });

  it('[DD-ACTSVC-MERGE-P004][DD-ACTSVC-MERGE-T003][DD-ACTSVC-MERGE-T004] test 以外・実行中の Actions の記録は除く', () => {
    const out = mergeRunRecords([], [rec('1-1', '2025-01-01T00:00:00Z', { source: 'actions', kind: 'snapshot' }), rec('2-1', '2025-01-01T00:00:00Z', { source: 'actions', status: 'running' })]);
    expect(out).toEqual([]);
  });

  it('[DD-ACTSVC-MERGE-P005][DD-ACTSVC-MERGE-T005][DD-ACTSVC-MERGE-T007] Actions の記録は dirty を false にし、同じ id の手元の記録とは別に残す', () => {
    const out = mergeRunRecords([rec('5-1', '2025-01-01T00:00:00Z')], [rec('5-1', '2025-01-02T00:00:00Z', { source: 'actions', dirty: true, kind: 'test' }), rec('5-2', '2025-01-03T00:00:00Z', { source: 'actions' })]);
    expect(out.map((r) => [r.id, r.source ?? 'local', r.dirty])).toEqual([
      ['5-2', 'actions', false],
      ['5-1', 'actions', false],
      ['5-1', 'local', undefined],
    ]);
  });

  it('[DD-ACTSVC-MERGE-P006] 手元の .ddv/runs にある Actions の記録は結果ブランチの同じ結果IDで置き換える', () => {
    const out = mergeRunRecords([rec('7-1', '2025-01-01T00:00:00Z', { source: 'actions', log: ['local'] })], [rec('7-1', '2025-01-01T00:00:00Z', { source: 'actions', log: ['branch'] })]);
    expect(out.map((r) => r.log)).toEqual([['branch']]);
  });

  it('[DD-ACTSVC-MERGE-P007] 手元の .ddv/runs に同じ結果IDの Actions の記録が 2 つあれば後のものを除く', () => {
    const out = mergeRunRecords([rec('8-1', '2025-01-01T00:00:00Z', { source: 'actions', log: ['first'] }), rec('8-1', '2025-01-01T00:00:00Z', { source: 'actions', log: ['second'] })], []);
    expect(out.map((r) => r.log)).toEqual([['first']]);
  });

  it('latestOf は新しい実行の結果を採り、Actions の結果だけ source と actionsRunId を付ける', () => {
    const runs = mergeRunRecords([rec('l1', '2025-01-01T00:00:00Z')], [rec('9-1', '2025-01-02T00:00:00Z', { source: 'actions', actionsRunId: '9' })]);
    expect(latestOf(runs)['DD-A-B-T001']).toMatchObject({ runId: '9-1', source: 'actions', actionsRunId: '9' });
    expect(latestOf([rec('l1', '2025-01-01T00:00:00Z')])['DD-A-B-T001']).not.toHaveProperty('source');
  });
});
