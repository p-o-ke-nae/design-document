import { describe, expect, it } from 'vitest';
import { LOCAL_CAPABILITIES, PAGES_CAPABILITIES } from '../backend/capabilities.ts';
import type { OperationId } from '../backend/types.ts';
import { OperationGate } from './operation-gate.ts';
import { PERMISSION_PENDING_MESSAGE, PermissionProbe, type GitHubOp } from './permission.ts';

const probeWith = (access: unknown, missing: (op: GitHubOp) => string | null = () => null) => ({
  access,
  calls: [] as GitHubOp[],
  missing(op: GitHubOp) {
    this.calls.push(op);
    const m = missing(op);
    return m ? { reason: 'role' as const, permissions: [], message: m } : null;
  },
});

describe('OperationGate.check（DD-PAGESV-GATE）', () => {
  it('[DD-PAGESV-GATE-P001] [DD-PAGESV-GATE-T001] [DD-PAGESV-GATE-T002] ローカル版は常に enabled', () => {
    const g = new OperationGate('local', LOCAL_CAPABILITIES, null);
    for (const op of ['runLocal', 'comment', 'saveFile'] as OperationId[]) expect(g.check(op)).toEqual({ enabled: true });
    // Pages の表を渡しても版がローカルなら enabled
    expect(new OperationGate('local', PAGES_CAPABILITIES, null).check('runLocal')).toEqual({ enabled: true });
  });

  it('[DD-PAGESV-GATE-P002] [DD-PAGESV-GATE-T003] [DD-PAGESV-GATE-T004] Pages 版で使えない操作は無効と使えない理由', () => {
    const g = new OperationGate('pages', PAGES_CAPABILITIES, probeWith({}));
    expect(g.check('runLocal')).toEqual({ enabled: false, reason: 'Pages 版は Actions で実行します' });
    expect(g.check('generateTestIds')).toEqual({ enabled: false, reason: '手元の ddv で実行してください' });
    expect(g.check('viewUncommitted')).toEqual({ enabled: false, reason: 'Pages 版はコミット済みの内容だけを表示します' });
    expect(g.check('saveFile')).toEqual({ enabled: false, reason: 'ファイルの保存はローカル版で行います。PR には suggestion として付けられます' });
  });

  it('[DD-PAGESV-GATE-P003] [DD-PAGESV-GATE-T005] [DD-PAGESV-GATE-T006] 使えて書き込みでもない操作は enabled（権限を見ない）', () => {
    const probe = probeWith(null);
    const g = new OperationGate('pages', { ...PAGES_CAPABILITIES, comment: { kind: 'available' } }, probe);
    expect(g.check('comment')).toEqual({ enabled: true });
    expect(probe.calls).toEqual([]);
  });

  it('[DD-PAGESV-GATE-P004] [DD-PAGESV-GATE-T007] [DD-PAGESV-GATE-T008] access 未取得の書き込みは「権限を確認中です」', () => {
    expect(new OperationGate('pages', PAGES_CAPABILITIES, probeWith(null)).check('comment')).toEqual({ enabled: false, reason: PERMISSION_PENDING_MESSAGE });
    expect(PERMISSION_PENDING_MESSAGE).toBe('権限を確認中です');
  });

  it('[DD-PAGESV-GATE-P005] [DD-PAGESV-GATE-T009] [DD-PAGESV-GATE-T010] missing が null の書き込みは enabled（gitHubOp を渡す）', () => {
    const probe = probeWith({});
    const g = new OperationGate('pages', PAGES_CAPABILITIES, probe);
    expect(g.check('submitReview')).toEqual({ enabled: true });
    expect(g.check('suggestMock')).toEqual({ enabled: true });
    expect(g.check('actionsDispatch')).toEqual({ enabled: true });
    expect(probe.calls).toEqual(['reviewSubmit', 'suggestion', 'actionsDispatch']);
  });

  it('[DD-PAGESV-GATE-P006] [DD-PAGESV-GATE-T011] missing があれば無効と MissingPermission の message（実際の PermissionProbe）', () => {
    const pat = { state: 'none' as const, kind: null };
    const probe = new PermissionProbe({ restWithHeaders: async () => ({ data: {} as never, headers: new Headers() }) }, pat);
    probe.fromRepo({ private: false }, new Headers(), null);
    const g = new OperationGate('pages', PAGES_CAPABILITIES, probe);
    expect(g.check('comment')).toEqual({ enabled: false, reason: 'PAT を設定してください（Pull requests: Write）' });
    const withPat = new PermissionProbe({ restWithHeaders: async () => ({ data: {} as never, headers: new Headers() }) }, { state: 'session', kind: 'fineGrained' });
    withPat.fromRepo({ permissions: { pull: true, push: false } }, new Headers(), 'fineGrained');
    expect(new OperationGate('pages', PAGES_CAPABILITIES, withPat).check('approveStatus')).toEqual({ enabled: false, reason: 'このリポジトリへの書き込み権限がありません（必要なロール：Write）' });
  });
});
