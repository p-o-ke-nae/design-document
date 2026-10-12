import { describe, expect, it, vi } from 'vitest';
import { PatFormatError } from './pat-format.ts';
import { PAT_NOT_SET_MESSAGE, PAT_STORAGE_DISABLED_MESSAGE, PatStore, patStorageKey, type PatStorageEvent } from './pat-store.ts';

/** `Storage` on a Map (sessionStorage / localStorage stand-in). */
class MemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

class BrokenStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('SecurityError');
  }
  override setItem(): void {
    throw new Error('SecurityError');
  }
}

const BASE = '/design-document/';
const KEY = patStorageKey(BASE);
const A = 'ghp_' + 'a'.repeat(36);
const B = 'github_pat_' + 'b'.repeat(40);

function setup(init: { session?: string; local?: string } = {}) {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  if (init.session !== undefined) session.setItem(KEY, init.session);
  if (init.local !== undefined) local.setItem(KEY, init.local);
  const store = new PatStore({ base: BASE, session, local });
  store.load();
  const notify = vi.fn();
  store.subscribe(notify);
  return { store, session, local, notify };
}

const storage = (local: Storage, newValue: string | null, key: string | null = KEY): PatStorageEvent => ({ key, newValue, storageArea: local });

describe('PatStore (DD-PAT-PATSTORE)', () => {
  it('キーは ddv:pat:<BASE_URL>', () => {
    expect(KEY).toBe('ddv:pat:/design-document/');
  });

  it('[DD-PAT-PATSTORE-T001] load：どちらにも無ければ未設定', async () => {
    const { store } = setup();
    expect(store.state).toBe('none');
    expect(store.kind).toBeNull();
    expect(await store.authorization()).toBeNull();
  });

  it('[DD-PAT-PATSTORE-T002] load：sessionStorage にあればタブ限り（sessionStorage を先に見る）', async () => {
    const { store } = setup({ session: A, local: B });
    expect(store.state).toBe('session');
    expect(store.kind).toBe('classic');
    expect(await store.authorization()).toBe(`Bearer ${A}`);
  });

  it('[DD-PAT-PATSTORE-T003] load：localStorage にあれば端末に保存。形式 NG の値は消して未設定', async () => {
    const { store } = setup({ local: B });
    expect(store.state).toBe('stored');
    expect(store.kind).toBe('fineGrained');
    expect(await store.authorization()).toBe(`Bearer ${B}`);
    const bad = setup({ session: 'oops', local: 'gho_' + 'x'.repeat(36) });
    expect(bad.store.state).toBe('none');
    expect(bad.session.getItem(KEY)).toBeNull();
    expect(bad.local.getItem(KEY)).toBeNull();
  });

  it('[DD-PAT-PATSTORE-T004] 未設定で set [形式NG]：PatFormatError を投げ、状態と保存先を変えない', () => {
    const { store, session, local, notify } = setup();
    expect(() => store.set('ghp_short', true)).toThrow(PatFormatError);
    expect(() => store.set('', false)).toThrow('PAT を入力してください');
    expect(store.state).toBe('none');
    expect(session.length + local.length).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('[DD-PAT-PATSTORE-T005] 未設定で set [保存しない]：sessionStorage に PAT の文字列だけ書いてタブ限り', () => {
    const { store, session, local, notify } = setup();
    store.set(` ${A}\n`, false);
    expect(store.state).toBe('session');
    expect(session.getItem(KEY)).toBe(A);
    expect(local.getItem(KEY)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[DD-PAT-PATSTORE-T006] 未設定で set [この端末に保存]：localStorage に書いて端末に保存。lastClear を null に戻す', () => {
    const { store, session, local } = setup();
    store.set(A, false);
    store.unauthorized();
    expect(store.lastClear).toBe('invalid');
    store.set(B, true);
    expect(store.state).toBe('stored');
    expect(store.kind).toBe('fineGrained');
    expect(local.getItem(KEY)).toBe(B);
    expect(session.getItem(KEY)).toBeNull();
    expect(store.lastClear).toBeNull();
  });

  it('[DD-PAT-PATSTORE-T007] タブ限りで set [保存しない]：PAT を置き換えてタブ限りのまま', async () => {
    const { store, session, notify } = setup({ session: A });
    store.set(B, false);
    expect(store.state).toBe('session');
    expect(session.getItem(KEY)).toBe(B);
    expect(await store.authorization()).toBe(`Bearer ${B}`);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[DD-PAT-PATSTORE-T008] タブ限りで set [この端末に保存]：sessionStorage から消して localStorage へ', () => {
    const { store, session, local } = setup({ session: A });
    store.set(B, true);
    expect(store.state).toBe('stored');
    expect(session.getItem(KEY)).toBeNull();
    expect(local.getItem(KEY)).toBe(B);
  });

  it('[DD-PAT-PATSTORE-T009] 端末に保存で set [保存しない]：localStorage から消して sessionStorage へ', () => {
    const { store, session, local } = setup({ local: A });
    store.set(B, false);
    expect(store.state).toBe('session');
    expect(local.getItem(KEY)).toBeNull();
    expect(session.getItem(KEY)).toBe(B);
  });

  it('[DD-PAT-PATSTORE-T010] 端末に保存で set [この端末に保存]：localStorage の PAT を置き換える', () => {
    const { store, session, local, notify } = setup({ local: A });
    store.set(B, true);
    expect(store.state).toBe('stored');
    expect(local.getItem(KEY)).toBe(B);
    expect(session.getItem(KEY)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[DD-PAT-PATSTORE-T011] タブ限りで persist：端末に保存へ移り sessionStorage から消す', () => {
    const { store, session, local, notify } = setup({ session: A });
    store.persist();
    expect(store.state).toBe('stored');
    expect(local.getItem(KEY)).toBe(A);
    expect(session.getItem(KEY)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[DD-PAT-PATSTORE-T012] 端末に保存で unpersist：タブ限りへ移り（このタブでは使い続ける）localStorage から消す', async () => {
    const { store, session, local } = setup({ local: A });
    store.unpersist();
    expect(store.state).toBe('session');
    expect(local.getItem(KEY)).toBeNull();
    expect(session.getItem(KEY)).toBe(A);
    expect(await store.authorization()).toBe(`Bearer ${A}`);
  });

  it('[DD-PAT-PATSTORE-T013] タブ限りで clear：両方の保存先から消して未設定、lastClear = reason', async () => {
    const { store, session, notify } = setup({ session: A });
    store.clear('user');
    expect(store.state).toBe('none');
    expect(store.lastClear).toBe('user');
    expect(session.getItem(KEY)).toBeNull();
    expect(await store.authorization()).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[DD-PAT-PATSTORE-T014] 端末に保存で clear：localStorage からも消して未設定', () => {
    const { store, local } = setup({ local: A });
    store.clear('user');
    expect(store.state).toBe('none');
    expect(local.getItem(KEY)).toBeNull();
  });

  it('[DD-PAT-PATSTORE-T015] タブ限りで unauthorized：clear(invalid) して false（取り直さない）', () => {
    const { store, session } = setup({ session: A });
    expect(store.unauthorized()).toBe(false);
    expect(store.state).toBe('none');
    expect(store.lastClear).toBe('invalid');
    expect(session.getItem(KEY)).toBeNull();
  });

  it('[DD-PAT-PATSTORE-T016] 端末に保存で unauthorized：localStorage からも消えるので他のタブも未設定になる', () => {
    const { store, local } = setup({ local: A });
    const other = new PatStore({ base: BASE, session: new MemoryStorage(), local });
    other.load();
    expect(other.state).toBe('stored');
    expect(store.unauthorized()).toBe(false);
    expect(store.state).toBe('none');
    expect(local.getItem(KEY)).toBeNull();
    other.onStorage(storage(local, null));
    expect(other.state).toBe('none');
    expect(other.lastClear).toBe('otherTab');
  });

  it('[DD-PAT-PATSTORE-T017] 未設定で storage [他タブで保存]：端末に保存。形式 NG・別のキーは無視', () => {
    const { store, local, notify } = setup();
    store.onStorage(storage(local, 'not-a-pat'));
    store.onStorage({ key: patStorageKey('/other/'), newValue: A, storageArea: local });
    expect(store.state).toBe('none');
    store.onStorage(storage(local, A));
    expect(store.state).toBe('stored');
    expect(store.kind).toBe('classic');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[DD-PAT-PATSTORE-T018] 端末に保存で storage [他タブで置き換え]：新しい PAT を使う', async () => {
    const { store, local, notify } = setup({ local: A });
    store.onStorage(storage(local, B));
    expect(store.state).toBe('stored');
    expect(await store.authorization()).toBe(`Bearer ${B}`);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[DD-PAT-PATSTORE-T019] 端末に保存で storage [他タブで消去]：未設定（key が null の clear() も同じ）', () => {
    const a = setup({ local: A });
    a.store.onStorage(storage(a.local, null));
    expect(a.store.state).toBe('none');
    expect(a.store.lastClear).toBe('otherTab');
    const b = setup({ local: A });
    b.store.onStorage(storage(b.local, null, null));
    expect(b.store.state).toBe('none');
  });

  it('[DD-PAT-PATSTORE-X001] [DD-PAT-PATSTORE-X002] 未設定での persist・unpersist は Error（PAT が設定されていません）', () => {
    const { store, notify } = setup();
    expect(() => store.persist()).toThrow(PAT_NOT_SET_MESSAGE);
    expect(() => store.unpersist()).toThrow(PAT_NOT_SET_MESSAGE);
    expect(store.state).toBe('none');
    expect(notify).not.toHaveBeenCalled();
  });

  it('[DD-PAT-PATSTORE-X003] [DD-PAT-PATSTORE-X004] 未設定での clear・unauthorized は何もしない（通知もしない）', () => {
    const { store, notify } = setup();
    store.clear('user');
    expect(store.unauthorized()).toBe(false);
    expect(store.state).toBe('none');
    expect(store.lastClear).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('[DD-PAT-PATSTORE-X005] タブ限りでの unpersist は何もしない', () => {
    const { store, session, notify } = setup({ session: A });
    store.unpersist();
    expect(store.state).toBe('session');
    expect(session.getItem(KEY)).toBe(A);
    expect(notify).not.toHaveBeenCalled();
  });

  it('[DD-PAT-PATSTORE-X006] タブ限りでの storage イベントは無視する（タブ限りの PAT を優先）', async () => {
    const { store, local, notify } = setup({ session: A });
    store.onStorage(storage(local, B));
    store.onStorage(storage(local, null));
    expect(store.state).toBe('session');
    expect(await store.authorization()).toBe(`Bearer ${A}`);
    expect(notify).not.toHaveBeenCalled();
  });

  it('[DD-PAT-PATSTORE-X007] 端末に保存での persist は何もしない', () => {
    const { store, local, notify } = setup({ local: A });
    store.persist();
    expect(store.state).toBe('stored');
    expect(local.getItem(KEY)).toBe(A);
    expect(notify).not.toHaveBeenCalled();
  });

  it('ストレージが使えないときはメモリだけでタブ限り。persist は Error', async () => {
    const store = new PatStore({ base: BASE, session: new BrokenStorage(), local: new BrokenStorage() });
    store.load();
    expect(store.state).toBe('none');
    store.set(A, false);
    expect(store.state).toBe('session');
    expect(await store.authorization()).toBe(`Bearer ${A}`);
    expect(() => store.persist()).toThrow(PAT_STORAGE_DISABLED_MESSAGE);
    expect(() => store.set(B, true)).toThrow(PAT_STORAGE_DISABLED_MESSAGE);
    expect(store.state).toBe('session');
  });

  it('redact は PAT（と base64 の形）を *** にする。unsubscribe 後は通知しない', () => {
    const { store, notify } = setup({ session: A });
    expect(store.redact(`token ${A} leaked`)).toBe('token *** leaked');
    store.dispose();
    store.clear('user');
    expect(notify).not.toHaveBeenCalled();
    const s = setup();
    const n = vi.fn();
    const off = s.store.subscribe(n);
    off();
    s.store.set(A, false);
    expect(n).not.toHaveBeenCalled();
  });
});

/** The basic design's PAT state machine (hosted-viewer.md「PAT の扱い」) driven through PatStore. Closing a tab = a new PatStore on a fresh sessionStorage and the same localStorage. */
describe('PAT の状態（BD-HOSTV-PAT）', () => {
  const reopen = (local: Storage) => {
    const s = new PatStore({ base: BASE, session: new MemoryStorage(), local });
    s.load();
    return s;
  };

  it('[BD-HOSTV-PAT-T001] 開始すると未設定', () => {
    expect(setup().store.state).toBe('none');
  });

  it('[BD-HOSTV-PAT-T002] 未設定で設定 [保存しない]：タブ限り', () => {
    const { store } = setup();
    store.set(A, false);
    expect(store.state).toBe('session');
  });

  it('[BD-HOSTV-PAT-T003] 未設定で設定 [この端末に保存]：端末に保存', () => {
    const { store } = setup();
    store.set(A, true);
    expect(store.state).toBe('stored');
  });

  it('[BD-HOSTV-PAT-T004] タブ限りでこの端末に保存：端末に保存（タブを閉じても残る）', () => {
    const { store, local } = setup({ session: A });
    store.persist();
    expect(store.state).toBe('stored');
    expect(reopen(local).state).toBe('stored');
  });

  it('[BD-HOSTV-PAT-T005] 端末に保存で端末から消す：タブ限り（タブを閉じると消える）', () => {
    const { store, local } = setup({ local: A });
    store.unpersist();
    expect(store.state).toBe('session');
    expect(reopen(local).state).toBe('none');
  });

  it('[BD-HOSTV-PAT-T006] [BD-HOSTV-PAT-T007] タブ限り・端末に保存で消す：未設定', () => {
    for (const init of [{ session: A }, { local: A }]) {
      const { store, local } = setup(init);
      store.clear('user');
      expect(store.state).toBe('none');
      expect(reopen(local).state).toBe('none');
    }
  });

  it('[BD-HOSTV-PAT-T008] タブ限りでタブを閉じる：未設定', () => {
    const { store, local } = setup();
    store.set(A, false);
    expect(reopen(local).state).toBe('none');
  });

  it('[BD-HOSTV-PAT-T009] [BD-HOSTV-PAT-T010] タブ限り・端末に保存で 401：未設定（保存していた PAT も消える）', () => {
    for (const init of [{ session: A }, { local: A }]) {
      const { store, session, local } = setup(init);
      expect(store.unauthorized()).toBe(false);
      expect(store.state).toBe('none');
      expect(store.lastClear).toBe('invalid');
      expect(session.getItem(KEY)).toBeNull();
      expect(reopen(local).state).toBe('none');
    }
  });

  it('[BD-HOSTV-PAT-X001] [BD-HOSTV-PAT-X002] [BD-HOSTV-PAT-X003] [BD-HOSTV-PAT-X004] [BD-HOSTV-PAT-X005] 未設定でこの端末に保存・端末から消す・消す・タブを閉じる・401 は未設定のまま', () => {
    const { store, local, notify } = setup();
    expect(() => store.persist()).toThrow(PAT_NOT_SET_MESSAGE);
    expect(() => store.unpersist()).toThrow(PAT_NOT_SET_MESSAGE);
    store.clear('user');
    expect(store.unauthorized()).toBe(false);
    expect(store.state).toBe('none');
    expect(reopen(local).state).toBe('none');
    expect(notify).not.toHaveBeenCalled();
  });

  it('[BD-HOSTV-PAT-X007] タブ限りで端末から消すは何もしない', () => {
    const { store } = setup({ session: A });
    store.unpersist();
    expect(store.state).toBe('session');
  });

  it('[BD-HOSTV-PAT-X009] [BD-HOSTV-PAT-X010] 端末に保存でこの端末に保存・タブを閉じるは端末に保存のまま', () => {
    const { store, local } = setup({ local: A });
    store.persist();
    expect(store.state).toBe('stored');
    expect(reopen(local).state).toBe('stored');
  });
});
