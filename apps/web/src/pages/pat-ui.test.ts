import { describe, expect, it } from 'vitest';
import { PAT_INVALID_MESSAGE, PatStore } from './pat-store.ts';
import { PAT_CREATE_URL, PAT_NOTE, patFormInit, patMenuItems, patMenuLabel, submitPat } from './pat-ui.ts';

const A = 'ghp_' + 'a'.repeat(36);
const memory = (): Storage => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
};
const newStore = () => {
  const s = new PatStore({ base: '/', session: memory(), local: memory() });
  s.load();
  return s;
};

describe('PatMenu・PatForm の表示の規則', () => {
  it('メニューの表示は状態ごと（未設定・タブ限り・端末に保存）', () => {
    expect(patMenuLabel('none')).toBe('PAT：未設定');
    expect(patMenuLabel('session')).toBe('PAT：タブ限り');
    expect(patMenuLabel('stored')).toBe('PAT：端末に保存');
    expect(patMenuItems('none')).toEqual({ setLabel: 'PAT を設定', showPersist: false, showUnpersist: false, clearDisabled: true });
    expect(patMenuItems('session')).toEqual({ setLabel: 'PAT を置き換え', showPersist: true, showUnpersist: false, clearDisabled: false });
    expect(patMenuItems('stored')).toEqual({ setLabel: 'PAT を置き換え', showPersist: false, showUnpersist: true, clearDisabled: false });
    expect(PAT_NOTE).toBe('PAT は api.github.com への要求にだけ使い、URL・ログ・他のサイトには送りません');
    expect(PAT_CREATE_URL).toBe('https://github.com/settings/personal-access-tokens/new');
  });

  it('フォームの初期値：保存はオフ（Stored のときはオン）、直前の 401 は pat-error に「PAT が無効です」', () => {
    const s = newStore();
    expect(patFormInit(s)).toEqual({ persist: false, error: null });
    s.set(A, true);
    expect(patFormInit(s)).toEqual({ persist: true, error: null });
    s.unauthorized();
    expect(patFormInit(s)).toEqual({ persist: false, error: PAT_INVALID_MESSAGE });
  });

  it('設定：形式 NG は pat-error の文言を返し状態を変えない。OK なら set する', () => {
    const s = newStore();
    expect(submitPat(s, 'gho_' + 'x'.repeat(36), false)).toEqual({ ok: false, error: 'OAuth・GitHub App のトークンは使えません。ghp_ または github_pat_ で始まる PAT を入力してください' });
    expect(s.state).toBe('none');
    expect(submitPat(s, A, false)).toEqual({ ok: true });
    expect(s.state).toBe('session');
  });
});
