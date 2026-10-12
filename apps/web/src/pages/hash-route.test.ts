import { describe, expect, it } from 'vitest';
import type { HrefView } from '../route.ts';
import { formatHostedHash, parseHostedHash, PATH_MESSAGE, PR_MESSAGE, REF_MESSAGE, REPO_MESSAGE, targetKey, targetWs, URL_MESSAGE, validateTarget, type HostedTarget } from './hash-route.ts';

const NONE = {};
const PR: HostedTarget = { owner: 'octo', repo: 'app', kind: 'pr', pr: 12 };
const REF: HostedTarget = { owner: 'octo', repo: 'app', kind: 'ref', ref: 'feature/x' };
const DEF: HostedTarget = { owner: 'octo', repo: 'app', kind: 'ref' };

describe('parseHostedHash（DD-PAGESV-HASH）', () => {
  it('[DD-PAGESV-HASH-P001] [DD-PAGESV-HASH-T001] [DD-PAGESV-HASH-T002] [DD-PAGESV-HASH-T003] 空・/ で defaultTarget があれば既定の対象の文書の先頭', () => {
    const cfg = { defaultTarget: { repo: 'octo/app', pr: 3 } };
    for (const h of ['', '#', '#/']) {
      const r = parseHostedHash(h, cfg);
      expect(r.error).toBeUndefined();
      expect(r.target).toEqual({ owner: 'octo', repo: 'app', kind: 'pr', pr: 3 });
      expect(r.route).toEqual({ ws: 'gh~octo~app~pr-3', view: 'doc', path: '', heading: '' });
    }
  });

  it('[DD-PAGESV-HASH-P002] [DD-PAGESV-HASH-T004] 空・/ で defaultTarget が無ければ対象の指定（エラーなし）', () => {
    const r = parseHostedHash('#/', NONE);
    expect(r).toEqual({ target: null, route: { ws: '', view: 'open', path: '', heading: '' } });
  });

  it('[DD-PAGESV-HASH-P003] [DD-PAGESV-HASH-T005] [DD-PAGESV-HASH-T006] /gh/owner/repo で始まらない・デコードできない URL は X1', () => {
    for (const h of ['#/doc?path=a.md', '#/gh/octo', '#/w/x/doc', '#/gh/%E0%A4%A/app']) {
      const r = parseHostedHash(h, NONE);
      expect(r.target).toBeNull();
      expect(r.route.view).toBe('open');
      expect(r.error).toMatchObject({ field: 'url', message: URL_MESSAGE });
    }
  });

  it('[DD-PAGESV-HASH-P004] [DD-PAGESV-HASH-T007] [DD-PAGESV-HASH-T008] [DD-PAGESV-HASH-T009] pr の番号が 1 以上の整数でなければ X2（入力欄に読めた値）', () => {
    for (const n of ['0', 'abc', '-1', '']) {
      const r = parseHostedHash(`#/gh/octo/app/pr/${n}`, NONE);
      expect(r.target).toBeNull();
      expect(r.error).toEqual({ field: 'pr', message: PR_MESSAGE, input: { repo: 'octo/app', kind: 'pr', target: n } });
    }
  });

  it('[DD-PAGESV-HASH-P005] [DD-PAGESV-HASH-T010] [DD-PAGESV-HASH-T017] PR の残りのパスなしは文書の先頭', () => {
    expect(parseHostedHash('#/gh/octo/app/pr/12', NONE)).toEqual({ target: PR, route: { ws: 'gh~octo~app~pr-12', view: 'doc', path: '', heading: '' } });
  });

  it('[DD-PAGESV-HASH-P006] [DD-PAGESV-HASH-T018] [DD-PAGESV-HASH-T019] PR の /doc/ に空・.・.. のセグメントがあれば X4', () => {
    for (const p of ['a//b.md', './a.md', 'docs/../x.md', 'a/']) {
      const r = parseHostedHash(`#/gh/octo/app/pr/12/doc/${p}`, NONE);
      expect(r.target).toBeNull();
      expect(r.error).toEqual({ field: 'path', message: PATH_MESSAGE, input: { repo: 'octo/app', kind: 'pr', target: '12' } });
    }
  });

  it('[DD-PAGESV-HASH-P007] [DD-PAGESV-HASH-T020] PR の /doc/パスは文書と h と view=diff', () => {
    const r = parseHostedHash('#/gh/octo/app/pr/12/doc/docs/%E8%A8%AD%E8%A8%88.md?h=intro&view=diff&x=1', NONE);
    expect(r.route).toEqual({ ws: 'gh~octo~app~pr-12', view: 'doc', path: 'docs/設計.md', heading: 'intro', diff: true });
  });

  it('[DD-PAGESV-HASH-P008] [DD-PAGESV-HASH-T021] PR の /tests 以下はテストタブ（history・trace・flaky）', () => {
    const ws = 'gh~octo~app~pr-12';
    expect(parseHostedHash('#/gh/octo/app/pr/12/tests', NONE).route).toEqual({ ws, view: 'tests', path: '', heading: '' });
    expect(parseHostedHash('#/gh/octo/app/pr/12/tests/flaky', NONE).route).toMatchObject({ view: 'tests', sub: 'flaky' });
    expect(parseHostedHash('#/gh/octo/app/pr/12/tests/history/DD-A-P001', NONE).route).toMatchObject({ view: 'tests', sub: 'history', testId: 'DD-A-P001' });
    expect(parseHostedHash('#/gh/octo/app/pr/12/tests/trace/run%2F1/DD-A-P001', NONE).route).toMatchObject({ view: 'tests', sub: 'trace', runId: 'run/1', testId: 'DD-A-P001' });
  });

  it('[DD-PAGESV-HASH-P009] [DD-PAGESV-HASH-T022] [DD-PAGESV-HASH-T023] PR の /review 以下はレビュー（/review/done は送信後）', () => {
    expect(parseHostedHash('#/gh/octo/app/pr/12/review', NONE).route).toEqual({ ws: 'gh~octo~app~pr-12', view: 'review', path: '', heading: '' });
    expect(parseHostedHash('#/gh/octo/app/pr/12/review/done', NONE).route.view).toBe('done');
  });

  it('[DD-PAGESV-HASH-P010] [DD-PAGESV-HASH-P011] [DD-PAGESV-HASH-T025] PR のその他の残りのパスは文書の先頭', () => {
    expect(parseHostedHash('#/gh/octo/app/pr/12/unknown/x', NONE).route).toEqual({ ws: 'gh~octo~app~pr-12', view: 'doc', path: '', heading: '' });
    // /doc だけ（パス無し）も文書の先頭
    expect(parseHostedHash('#/gh/octo/app/pr/12/doc', NONE).route).toEqual({ ws: 'gh~octo~app~pr-12', view: 'doc', path: '', heading: '' });
  });

  it('[DD-PAGESV-HASH-P012] [DD-PAGESV-HASH-T011] [DD-PAGESV-HASH-T012] ref のセグメントが空なら X3', () => {
    for (const h of ['#/gh/octo/app/ref', '#/gh/octo/app/ref/', '#/gh/octo/app/ref//doc/a.md']) {
      const r = parseHostedHash(h, NONE);
      expect(r.target).toBeNull();
      expect(r.error).toEqual({ field: 'ref', message: REF_MESSAGE, input: { repo: 'octo/app', kind: 'ref', target: '' } });
    }
  });

  it('[DD-PAGESV-HASH-P013] [DD-PAGESV-HASH-T013] ref の残りのパスなしは文書の先頭（%2F を含む ref）', () => {
    expect(parseHostedHash('#/gh/octo/app/ref/feature%2Fx', NONE)).toEqual({ target: REF, route: { ws: 'gh~octo~app~ref-feature~~x', view: 'doc', path: '', heading: '' } });
  });

  it('[DD-PAGESV-HASH-P014] ref の /doc/ に .. があれば X4', () => {
    expect(parseHostedHash('#/gh/octo/app/ref/main/doc/../a.md', NONE).error).toMatchObject({ field: 'path', message: PATH_MESSAGE, input: { repo: 'octo/app', kind: 'ref', target: 'main' } });
  });

  it('[DD-PAGESV-HASH-P015] ref の /doc/パスは文書と h（view=diff は ref では無視）', () => {
    expect(parseHostedHash('#/gh/octo/app/ref/v1.0/doc/docs/a.md?h=x&view=diff', NONE).route).toEqual({ ws: 'gh~octo~app~ref-v1.0', view: 'doc', path: 'docs/a.md', heading: 'x' });
  });

  it('[DD-PAGESV-HASH-P016] ref の /tests 以下はテストタブ', () => {
    expect(parseHostedHash('#/gh/octo/app/ref/main/tests/flaky', NONE).route).toEqual({ ws: 'gh~octo~app~ref-main', view: 'tests', path: '', heading: '', sub: 'flaky' });
  });

  it('[DD-PAGESV-HASH-P017] [DD-PAGESV-HASH-P024] [DD-PAGESV-HASH-T024] ref・既定ブランチの対象はレビューにならない（PR か → はい の経路は起きない）', () => {
    // PR の対象でない限り /review はレビューの画面にならない
    for (const h of ['#/gh/octo/app/ref/main/review', '#/gh/octo/app/review']) expect(parseHostedHash(h, NONE).route.view).not.toBe('review');
  });

  it('[DD-PAGESV-HASH-P018] ref の /review は文書の先頭', () => {
    expect(parseHostedHash('#/gh/octo/app/ref/main/review/done', NONE).route).toEqual({ ws: 'gh~octo~app~ref-main', view: 'doc', path: '', heading: '' });
  });

  it('[DD-PAGESV-HASH-P019] ref のその他の残りのパスは文書の先頭', () => {
    expect(parseHostedHash('#/gh/octo/app/ref/main/zzz', NONE).route).toEqual({ ws: 'gh~octo~app~ref-main', view: 'doc', path: '', heading: '' });
  });

  it('[DD-PAGESV-HASH-P020] [DD-PAGESV-HASH-T014] [DD-PAGESV-HASH-T015] 次のセグメントなしは既定ブランチの文書の先頭', () => {
    for (const h of ['#/gh/octo/app', '#/gh/octo/app/']) expect(parseHostedHash(h, NONE)).toEqual({ target: DEF, route: { ws: 'gh~octo~app~default', view: 'doc', path: '', heading: '' } });
  });

  it('[DD-PAGESV-HASH-P021] 既定ブランチの /doc/ に空のセグメントがあれば X4', () => {
    expect(parseHostedHash('#/gh/octo/app/doc//a.md', NONE).error).toMatchObject({ field: 'path', input: { repo: 'octo/app', kind: 'ref', target: '' } });
  });

  it('[DD-PAGESV-HASH-P022] 既定ブランチの /doc/パスは文書と h', () => {
    expect(parseHostedHash('#/gh/octo/app/doc/docs/a.md?h=b', NONE)).toEqual({ target: DEF, route: { ws: 'gh~octo~app~default', view: 'doc', path: 'docs/a.md', heading: 'b' } });
  });

  it('[DD-PAGESV-HASH-P023] 既定ブランチの /tests 以下はテストタブ', () => {
    expect(parseHostedHash('#/gh/octo/app/tests/history/X-1', NONE).route).toEqual({ ws: 'gh~octo~app~default', view: 'tests', path: '', heading: '', sub: 'history', testId: 'X-1' });
  });

  it('[DD-PAGESV-HASH-P025] [DD-PAGESV-HASH-P026] 既定ブランチの /review・その他は文書の先頭', () => {
    expect(parseHostedHash('#/gh/octo/app/review', NONE).route).toEqual({ ws: 'gh~octo~app~default', view: 'doc', path: '', heading: '' });
    expect(parseHostedHash('#/gh/octo/app/doc', NONE).route).toEqual({ ws: 'gh~octo~app~default', view: 'doc', path: '', heading: '' });
  });

  it('[DD-PAGESV-HASH-P027] [DD-PAGESV-HASH-T016] 次のセグメントがその他なら X1', () => {
    const r = parseHostedHash('#/gh/octo/app/blob/main', NONE);
    expect(r.target).toBeNull();
    expect(r.error).toEqual({ field: 'url', message: URL_MESSAGE, input: { repo: 'octo/app', kind: 'pr', target: '' } });
  });

  it('解釈できた対象も validateTarget を通す（allowedOwners）', () => {
    const r = parseHostedHash('#/gh/evil/app/pr/1', { allowedOwners: ['octo'] });
    expect(r.target).toBeNull();
    expect(r.error?.field).toBe('repo');
  });
});

describe('formatHostedHash・targetKey', () => {
  const views: Partial<HrefView>[] = [
    { view: 'doc', path: '', heading: '' },
    { view: 'doc', path: 'docs/設計 書/a.md', heading: 'x y' },
    { view: 'tests', path: '', heading: '' },
    { view: 'tests', path: '', heading: '', sub: 'flaky' },
    { view: 'tests', path: '', heading: '', sub: 'history', testId: 'DD-A/P001' },
    { view: 'tests', path: '', heading: '', sub: 'trace', runId: '2024-01-01T00:00', testId: 'DD-A-P001' },
  ];

  it('往復：parseHostedHash(formatHostedHash(t, v)) は元の t・v に戻る', () => {
    for (const t of [PR, REF, DEF, { owner: 'o-1', repo: 'r.x_y', kind: 'ref' as const, ref: 'release/1.2' }]) {
      for (const v of [...views, ...(t.kind === 'pr' ? [{ view: 'review' as const, path: '', heading: '' }, { view: 'done' as const, path: '', heading: '' }, { view: 'doc' as const, path: 'a.md', heading: 'h', diff: true }] : [])]) {
        const r = parseHostedHash(formatHostedHash(t, v), NONE);
        expect(r.target).toEqual(t);
        expect(r.route).toEqual({ ws: targetWs(t), ...v });
      }
    }
  });

  it('形：%2F の ref・パスのセグメントごとのエンコード・PAT や SHA を含まない', () => {
    expect(formatHostedHash(REF, { view: 'doc', path: 'docs/a b.md', heading: 'h' })).toBe('#/gh/octo/app/ref/feature%2Fx/doc/docs/a%20b.md?h=h');
    expect(formatHostedHash(PR, { view: 'doc', path: 'a.md', heading: '', diff: true })).toBe('#/gh/octo/app/pr/12/doc/a.md?view=diff');
    expect(formatHostedHash(DEF)).toBe('#/gh/octo/app');
    expect(formatHostedHash(REF, { view: 'doc', path: 'a.md', heading: '', diff: true })).toBe('#/gh/octo/app/ref/feature%2Fx/doc/a.md');
  });

  it('targetKey と Route.ws', () => {
    expect(targetKey(PR)).toBe('octo/app#pr-12');
    expect(targetKey(REF)).toBe('octo/app@feature/x');
    expect(targetKey(DEF)).toBe('octo/app@');
    expect(targetWs(DEF)).toBe('gh~octo~app~default');
  });
});

describe('validateTarget（DD-PAGESV-TARGET）', () => {
  const owners = { allowedOwners: ['Octo', 'acme'] };

  it('[DD-PAGESV-TARGET-P001] [DD-PAGESV-TARGET-T001] [DD-PAGESV-TARGET-T002] owner/repo の形式でなければ repo の形式エラー', () => {
    for (const repo of ['', 'octo', 'octo/app/x', '-x/app', 'octo/..', 'o o/app']) {
      expect(validateTarget({ repo, kind: 'pr', target: '1' }, {})).toEqual({ target: null, error: { field: 'repo', message: REPO_MESSAGE, input: { repo: repo.trim(), kind: 'pr', target: '1' } } });
    }
  });

  it('[DD-PAGESV-TARGET-P002] [DD-PAGESV-TARGET-T003] [DD-PAGESV-TARGET-T004] [DD-PAGESV-TARGET-T008] [DD-PAGESV-TARGET-T009] allowedOwners なしで PR 番号が不正なら pr の形式エラー', () => {
    for (const target of ['', '0', '1.5', 'x']) expect(validateTarget({ repo: 'octo/app', kind: 'pr', target }, {}).error).toMatchObject({ field: 'pr', message: PR_MESSAGE });
  });

  it('[DD-PAGESV-TARGET-P003] [DD-PAGESV-TARGET-T010] allowedOwners なしで PR の対象（前後の空白を除く）', () => {
    expect(validateTarget({ repo: ' octo/app ', kind: 'pr', target: ' 12 ' }, {})).toEqual({ target: PR });
  });

  it('[DD-PAGESV-TARGET-P004] [DD-PAGESV-TARGET-T011] [DD-PAGESV-TARGET-T012] ref が空なら既定ブランチの対象', () => {
    expect(validateTarget({ repo: 'octo/app', kind: 'ref', target: '  ' }, {})).toEqual({ target: DEF });
  });

  it('[DD-PAGESV-TARGET-P005] [DD-PAGESV-TARGET-T013] [DD-PAGESV-TARGET-T014] isSafeRefName に合わない ref は ref の形式エラー', () => {
    for (const target of ['a..b', 'x~1', 'a b', '-x', 'a.lock', 'a/']) expect(validateTarget({ repo: 'octo/app', kind: 'ref', target }, {}).error).toMatchObject({ field: 'ref', message: REF_MESSAGE });
  });

  it('[DD-PAGESV-TARGET-P006] [DD-PAGESV-TARGET-T015] ref の対象', () => {
    expect(validateTarget({ repo: 'octo/app', kind: 'ref', target: 'feature/x' }, {})).toEqual({ target: REF });
  });

  it('[DD-PAGESV-TARGET-P007] [DD-PAGESV-TARGET-T005] [DD-PAGESV-TARGET-T006] owner が allowedOwners に無ければ配信元の制限エラー', () => {
    expect(validateTarget({ repo: 'evil/app', kind: 'pr', target: '1' }, owners).error).toEqual({
      field: 'repo',
      message: 'このビューアで開けるのは次の owner のリポジトリだけです：Octo,acme',
      input: { repo: 'evil/app', kind: 'pr', target: '1' },
    });
  });

  it('[DD-PAGESV-TARGET-P008] [DD-PAGESV-TARGET-T007] allowedOwners に含まれ（大文字小文字を区別しない）PR 番号が不正なら pr の形式エラー', () => {
    expect(validateTarget({ repo: 'octo/app', kind: 'pr', target: '-3' }, owners).error?.field).toBe('pr');
  });

  it('[DD-PAGESV-TARGET-P009] allowedOwners に含まれる PR の対象', () => {
    expect(validateTarget({ repo: 'ACME/app', kind: 'pr', target: '7' }, owners)).toEqual({ target: { owner: 'ACME', repo: 'app', kind: 'pr', pr: 7 } });
  });

  it('[DD-PAGESV-TARGET-P010] allowedOwners に含まれる既定ブランチの対象', () => {
    expect(validateTarget({ repo: 'octo/app', kind: 'ref', target: '' }, owners)).toEqual({ target: DEF });
  });

  it('[DD-PAGESV-TARGET-P011] allowedOwners に含まれ ref が不正なら ref の形式エラー', () => {
    expect(validateTarget({ repo: 'octo/app', kind: 'ref', target: 'a:b' }, owners).error?.field).toBe('ref');
  });

  it('[DD-PAGESV-TARGET-P012] allowedOwners に含まれる ref の対象', () => {
    expect(validateTarget({ repo: 'octo/app', kind: 'ref', target: 'feature/x' }, owners)).toEqual({ target: REF });
  });
});
