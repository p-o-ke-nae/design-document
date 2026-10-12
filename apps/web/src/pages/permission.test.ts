import { describe, expect, it, vi } from 'vitest';
import { GitHubError } from '@ddv/github';
import { PermissionProbe, REQUIRED_PERMISSIONS, parseAcceptedPermissions, requiredPermissionLines, type GitHubOp } from './permission.ts';
import type { PatKind } from './pat-format.ts';
import type { PatState } from './pat-store.ts';

const repoJson = (o: { private?: boolean; pull?: boolean; push?: boolean } = {}) => ({ private: o.private ?? false, ...(o.pull === undefined && o.push === undefined ? {} : { permissions: { pull: o.pull ?? false, push: o.push ?? false } }) });

function probeWith(state: PatState, kind: PatKind | null, repo: ReturnType<typeof repoJson>, scopes?: string) {
  const headers = new Headers(scopes === undefined ? {} : { 'x-oauth-scopes': scopes });
  const client = { restWithHeaders: vi.fn(async () => ({ data: repo, headers })) };
  const p = new PermissionProbe(client as never, { state, kind });
  p.fromRepo(repo, headers, kind);
  return { p, client };
}

const forbidden = (headers: Record<string, string> = {}) => {
  const e = new GitHubError('forbidden', 403, '権限がありません: Resource not accessible by personal access token');
  if (headers.accepted) e.acceptedPermissions = headers.accepted;
  if (headers.sso) e.sso = headers.sso;
  return e;
};

describe('PermissionProbe.missing (DD-PAT-PERM)', () => {
  it('[DD-PAT-PERM-P001] [DD-PAT-PERM-T001] [DD-PAT-PERM-T002] PAT が無ければ noPat（fine-grained 列の権限を案内）', () => {
    const { p } = probeWith('none', null, repoJson());
    expect(p.access).toEqual({ pull: true, push: false, private: false, tokenKind: null, scopes: null });
    expect(p.missing('reviewComment')).toEqual({ reason: 'noPat', permissions: ['Pull requests: Write'], message: 'PAT を設定してください（Pull requests: Write）' });
    expect(p.missing('actionsDispatch')?.message).toBe('PAT を設定してください（Actions: Write）');
  });

  it('[DD-PAT-PERM-P002] [DD-PAT-PERM-T003] [DD-PAT-PERM-T004] ロールが足りなければ role（push が要る操作で read のみ）', () => {
    const { p } = probeWith('session', 'fineGrained', repoJson({ pull: true, push: false }));
    expect(p.missing('approveStatus')).toEqual({ reason: 'role', permissions: ['write'], message: 'このリポジトリへの書き込み権限がありません（必要なロール：Write）' });
    expect(p.missing('snapshotApprove')?.reason).toBe('role');
    expect(p.missing('reviewComment')).toBeNull();
    const { p: noPull } = probeWith('session', 'classic', repoJson({ pull: false, push: false }), 'repo');
    expect(noPull.missing('reviewReply')?.message).toBe('このリポジトリへの書き込み権限がありません（必要なロール：Read）');
  });

  it('[DD-PAT-PERM-P003] [DD-PAT-PERM-T005] [DD-PAT-PERM-T006] [DD-PAT-PERM-T007] classic で必要なスコープが無ければ scope', () => {
    const pub = probeWith('stored', 'classic', repoJson({ pull: true, push: true }), 'read:org, gist');
    expect(pub.p.access?.scopes).toEqual(['read:org', 'gist']);
    expect(pub.p.missing('reviewComment')).toEqual({ reason: 'scope', permissions: ['public_repo'], message: 'PAT に public_repo スコープがありません' });
    const priv = probeWith('stored', 'classic', repoJson({ private: true, pull: true, push: true }), 'public_repo');
    expect(priv.p.missing('approveStatus')).toEqual({ reason: 'scope', permissions: ['repo'], message: 'PAT に repo スコープがありません' });
  });

  it('[DD-PAT-PERM-P004] [DD-PAT-PERM-T006] [DD-PAT-PERM-T008] classic で repo、または公開で public_repo があれば使える', () => {
    expect(probeWith('session', 'classic', repoJson({ pull: true, push: true }), 'public_repo').p.missing('actionsDispatch')).toBeNull();
    expect(probeWith('session', 'classic', repoJson({ private: true, pull: true, push: true }), 'repo, workflow').p.missing('approveStatus')).toBeNull();
  });

  it('[DD-PAT-PERM-P005] [DD-PAT-PERM-T009] [DD-PAT-PERM-T010] fine-grained で 403 を覚えた操作は fineGrained（x-accepted-github-permissions の最初の組）', () => {
    const { p } = probeWith('session', 'fineGrained', repoJson({ pull: true, push: true }));
    p.recordDenied('actionsDispatch', forbidden({ accepted: 'actions=write; contents=write,workflows=write' }));
    expect(p.missing('actionsDispatch')).toEqual({ reason: 'fineGrained', permissions: ['Actions: Write'], message: 'PAT に次の権限がありません：Actions: Write（PAT の設定で追加してください）' });
    p.recordDenied('reviewComment', forbidden());
    expect(p.missing('reviewComment')?.permissions).toEqual(['Pull requests: Write']);
    expect(p.missing('reviewReply')).toBeNull();
  });

  it('[DD-PAT-PERM-P006] [DD-PAT-PERM-T009] [DD-PAT-PERM-T011] fine-grained で覚えた 403 が無ければ使える。SSO・rateLimit は覚えない', () => {
    const { p } = probeWith('stored', 'fineGrained', repoJson({ pull: true, push: true }));
    expect(p.missing('approveStatus')).toBeNull();
    p.recordDenied('approveStatus', forbidden({ sso: 'required; url=https://github.com/orgs/acme/sso' }));
    p.recordDenied('approveStatus', new GitHubError('rateLimit', 403, '上限'));
    expect(p.missing('approveStatus')).toBeNull();
  });
});

describe('PermissionProbe（その他）', () => {
  it('probe は GET /repos/o/r を 1 回呼び、permissions と private を RepoAccess にする', async () => {
    const { p, client } = probeWith('session', 'classic', repoJson({ private: true, pull: true, push: false }), 'repo');
    p.reset();
    expect(p.access).toBeNull();
    const a = await p.probe('acme', 'order-app');
    expect(client.restWithHeaders).toHaveBeenCalledWith('GET', '/repos/acme/order-app');
    expect(a).toEqual({ pull: true, push: false, private: true, tokenKind: 'classic', scopes: ['repo'] });
  });

  it('access が未取得のあいだは「権限を確認中です」。reset で覚えた 403 も捨てる', () => {
    const { p } = probeWith('session', 'fineGrained', repoJson({ pull: true, push: true }));
    p.recordDenied('reviewSubmit', forbidden());
    p.reset();
    expect(p.missing('reviewSubmit')).toEqual({ reason: 'pending', permissions: [], message: '権限を確認中です' });
    p.fromRepo(repoJson({ pull: true, push: true }), new Headers(), 'fineGrained');
    expect(p.missing('reviewSubmit')).toBeNull();
  });

  it('classic で scope が足りているのに 403 になった操作も覚える', () => {
    const { p } = probeWith('session', 'classic', repoJson({ pull: true, push: true }), 'repo');
    p.recordDenied('snapshotApprove', forbidden({ accepted: 'actions=write' }));
    expect(p.missing('snapshotApprove')?.reason).toBe('fineGrained');
  });

  it('x-accepted-github-permissions の名前の対応', () => {
    expect(parseAcceptedPermissions('contents=write,pull_requests=read,metadata=read,workflows=write,statuses=write,issues=write')).toEqual([
      'Contents: Write',
      'Pull requests: Read',
      'Metadata: Read',
      'Workflows: Write',
      'Commit statuses: Write',
      'Issues: Write',
    ]);
    expect(parseAcceptedPermissions(undefined)).toBeNull();
    expect(parseAcceptedPermissions('')).toBeNull();
  });

  it('必要な権限の一覧は REQUIRED_PERMISSIONS から作る', () => {
    const ops = Object.keys(REQUIRED_PERMISSIONS) as GitHubOp[];
    expect(ops).toHaveLength(8);
    expect(requiredPermissionLines()).toEqual([
      '閲覧：Contents: Read、Pull requests: Read',
      'コメント・返信・解決・レビューの送信・suggestion：Pull requests: Write',
      'Approve の status 連動：Contents: Write',
      'Actions での実行・基準画像の承認：Actions: Write',
    ]);
  });
});
