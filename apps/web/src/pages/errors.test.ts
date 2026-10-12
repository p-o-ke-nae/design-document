import { describe, expect, it } from 'vitest';
import { GitHubError } from '@ddv/github';
import type { PatView } from '../backend/types.ts';
import { toApiError } from '../backend/errors.ts';
import { formatGitHubError } from './errors.ts';
import { PAT_INVALID_MESSAGE } from './pat-store.ts';

const secret = 'ghp_' + 's'.repeat(36);
const view = (state: PatView['state'], lastClear: PatView['lastClear'] = null): PatView => ({ state, lastClear, redact: (t) => t.split(secret).join('***') });

describe('formatGitHubError（Pages 版のエラー表示）', () => {
  it('401 で直前に PAT を消していれば「PAT が無効です」', () => {
    expect(formatGitHubError(new GitHubError('auth', 401, 'GitHub の認証に失敗しました: Bad credentials'), view('none', 'invalid'))).toBe(PAT_INVALID_MESSAGE);
    expect(formatGitHubError(new GitHubError('auth', 401, 'x'), view('none'))).toBe('x');
  });

  it('403 で SSO が要るときは SSO 承認の案内、操作中は MissingPermission の message', () => {
    const sso = new GitHubError('forbidden', 403, '権限がありません: SSO');
    sso.sso = 'required; url=https://github.com/orgs/acme/sso';
    expect(formatGitHubError(sso, view('session'))).toBe('この組織では PAT の SSO 承認が必要です（GitHub の PAT の設定で「Configure SSO」から承認してください）');
    const e = new GitHubError('forbidden', 403, '権限がありません');
    expect(formatGitHubError(e, view('session'), { reason: 'fineGrained', permissions: ['Actions: Write'], message: 'PAT に次の権限がありません：Actions: Write（PAT の設定で追加してください）' })).toContain('Actions: Write');
    expect(formatGitHubError(e, view('session'))).toBe('権限がありません');
  });

  it('rateLimit は PAT が未設定なら「PAT を設定すると上限が上がります」を添える', () => {
    const e = new GitHubError('rateLimit', 403, 'GitHub API の利用上限に達しました（19:42 に再開）');
    expect(formatGitHubError(e, view('none'))).toBe('GitHub API の利用上限に達しました（19:42 に再開）。PAT を設定すると上限が上がります');
    expect(formatGitHubError(e, view('stored'))).toBe('GitHub API の利用上限に達しました（19:42 に再開）');
  });

  it('その他は redact した message（PAT を表示しない）', () => {
    expect(formatGitHubError(new GitHubError('network', 502, `failed ${secret}`), view('session'))).toBe('failed ***');
    expect(formatGitHubError(new TypeError(`fetch ${secret}`), view('session'))).toBe('fetch ***');
  });

  it('toApiError の message は formatGitHubError の文言', () => {
    expect(toApiError(new GitHubError('auth', 401, 'Bad credentials'), view('none', 'invalid')).message).toBe(PAT_INVALID_MESSAGE);
    expect(toApiError(new GitHubError('rateLimit', 429, '上限'), view('none')).message).toBe('上限。PAT を設定すると上限が上がります');
  });
});
