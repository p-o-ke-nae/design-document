import { describe, expect, it } from 'vitest';
import { GitHubError } from '@ddv/github';
import { ReviewError, ServiceError, TestDataError } from '@ddv/services';
import { toApiError } from './errors.ts';
import { ApiError, type PatView } from './types.ts';

const pat = (state: PatView['state'], lastClear: PatView['lastClear'] = null, redact?: (t: string) => string): PatView => ({ state, lastClear, ...(redact ? { redact } : {}) });
const gh = (kind: GitHubError['kind'], message = `GitHub ${kind}`, resetAt?: Date) => new GitHubError(kind, 0, message, resetAt);

describe('toApiError (DD-SVC-ERRMAP)', () => {
  it('[DD-SVC-ERRMAP-P001] [DD-SVC-ERRMAP-T001] [DD-SVC-ERRMAP-T002] ApiError はそのまま返す', () => {
    const e = new ApiError('x', 405, 'unsupported');
    expect(toApiError(e, pat('none'))).toBe(e);
  });

  it('[DD-SVC-ERRMAP-P002] [DD-SVC-ERRMAP-T003] [DD-SVC-ERRMAP-T004] ServiceError（とその子）は status・code・message・extra を写す', () => {
    const t = toApiError(new TestDataError(409, 'conflict', '競合しました', { files: ['a'] }), pat('session'));
    expect(t).toBeInstanceOf(ApiError);
    expect(t).toMatchObject({ status: 409, code: 'conflict', message: '競合しました', body: { error: '競合しました', code: 'conflict', message: '競合しました', files: ['a'] } });
    const r = toApiError(new ReviewError(422, 'comment-required', 'コメントを入力してください'), pat('none'));
    expect(r).toMatchObject({ status: 422, code: 'comment-required', message: 'コメントを入力してください' });
    const plain = toApiError(new ServiceError(400, '', '不正です'), pat('none'));
    expect(plain).toMatchObject({ status: 400, code: undefined, message: '不正です', body: { error: '不正です' } });
  });

  it('[DD-SVC-ERRMAP-P003] [DD-SVC-ERRMAP-T003] [DD-SVC-ERRMAP-T005] [DD-SVC-ERRMAP-T006] GitHubError でもない例外は 500 と message', () => {
    expect(toApiError(new Error('壊れました'), pat('stored'))).toMatchObject({ status: 500, code: undefined, message: '壊れました' });
    expect(toApiError('oops', pat('none'))).toMatchObject({ status: 500, message: 'oops' });
  });

  it('[DD-SVC-ERRMAP-P010] [DD-SVC-ERRMAP-T005] [DD-SVC-ERRMAP-T007] [DD-SVC-ERRMAP-T008] [DD-SVC-ERRMAP-T016] auth で PatStore の lastClear が invalid なら 401 pat-invalid', () => {
    expect(toApiError(gh('auth'), pat('none', 'invalid'))).toMatchObject({ status: 401, code: 'pat-invalid', body: { code: 'pat-invalid' } });
  });

  it('[DD-SVC-ERRMAP-P011] [DD-SVC-ERRMAP-T008] [DD-SVC-ERRMAP-T017] auth で lastClear が invalid でなければ 401 pat-required', () => {
    expect(toApiError(gh('auth'), pat('none'))).toMatchObject({ status: 401, code: 'pat-required' });
    expect(toApiError(gh('auth'), pat('none', 'user'))).toMatchObject({ status: 401, code: 'pat-required' });
    expect(toApiError(gh('auth'), pat('session', 'otherTab'))).toMatchObject({ status: 401, code: 'pat-required' });
  });

  it('[DD-SVC-ERRMAP-P012] [DD-SVC-ERRMAP-T011] [DD-SVC-ERRMAP-T018] notFound で PatStore の state が none なら 401 pat-required（非公開リポジトリかもしれない）', () => {
    expect(toApiError(gh('notFound'), pat('none'))).toMatchObject({ status: 401, code: 'pat-required' });
  });

  it('[DD-SVC-ERRMAP-P013] [DD-SVC-ERRMAP-T011] [DD-SVC-ERRMAP-T019] notFound で PAT があれば 404 github-notFound', () => {
    expect(toApiError(gh('notFound'), pat('session'))).toMatchObject({ status: 404, code: 'github-notFound' });
    expect(toApiError(gh('notFound'), pat('stored'))).toMatchObject({ status: 404, code: 'github-notFound' });
  });

  it('[DD-SVC-ERRMAP-P008] [DD-SVC-ERRMAP-T014] rateLimit は 429 github-rateLimit、body.resetAt に ISO 文字列', () => {
    const at = new Date('2030-01-02T03:04:05Z');
    const e = toApiError(gh('rateLimit', 'limit', at), pat('session'));
    expect(e).toMatchObject({ status: 429, code: 'github-rateLimit', body: { resetAt: '2030-01-02T03:04:05.000Z' } });
    expect(toApiError(gh('rateLimit'), pat('none')).body).not.toHaveProperty('resetAt');
  });

  it('[DD-SVC-ERRMAP-P009] [DD-SVC-ERRMAP-T015] forbidden・validation・network は GITHUB_STATUS の status と github-<kind>、message は redact を通す', () => {
    expect(toApiError(gh('forbidden'), pat('session'))).toMatchObject({ status: 403, code: 'github-forbidden' });
    expect(toApiError(gh('validation'), pat('session'))).toMatchObject({ status: 422, code: 'github-validation' });
    expect(toApiError(gh('network'), pat('none'))).toMatchObject({ status: 502, code: 'github-network' });
    const secret = 'ghp_' + 'a'.repeat(36);
    const e = toApiError(gh('network', `failed ${secret}`), pat('session', null, (t) => t.split(secret).join('***')));
    expect(e.message).toBe('failed ***');
  });
});