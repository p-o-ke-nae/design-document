import { PAT_INVALID_MESSAGE, type PatClearReason, type PatState } from './pat-store.ts';

/** UI rules of PatMenu / PatForm (pat.md「画面」), kept out of the components so that they are unit tested. */

export const PAT_CREATE_URL = 'https://github.com/settings/personal-access-tokens/new';
export const PAT_NOTE = 'PAT は api.github.com への要求にだけ使い、URL・ログ・他のサイトには送りません';

const MENU_LABEL: Record<PatState, string> = { none: 'PAT：未設定', session: 'PAT：タブ限り', stored: 'PAT：端末に保存' };

export const patMenuLabel = (state: PatState) => MENU_LABEL[state];

export interface PatMenuItems {
  setLabel: string;
  /** `pat-menu-persist` is shown only in Session, `pat-menu-unpersist` only in Stored. */
  showPersist: boolean;
  showUnpersist: boolean;
  clearDisabled: boolean;
}

export function patMenuItems(state: PatState): PatMenuItems {
  return {
    setLabel: state === 'none' ? 'PAT を設定' : 'PAT を置き換え',
    showPersist: state === 'session',
    showUnpersist: state === 'stored',
    clearDisabled: state === 'none',
  };
}

/** What PatForm reads and calls of `PatStore`. */
export interface PatFormStore {
  readonly state: PatState;
  readonly lastClear: PatClearReason | null;
  set(raw: string, persist: boolean): void;
}

export interface PatFormInit {
  persist: boolean;
  error: string | null;
}

/** The PAT itself is never shown again; the checkbox is on when Stored; the previous 401 is shown as the error. */
export function patFormInit(store: Pick<PatFormStore, 'state' | 'lastClear'>): PatFormInit {
  return { persist: store.state === 'stored', error: store.lastClear === 'invalid' ? PAT_INVALID_MESSAGE : null };
}

export type PatSubmitResult = { ok: true } | { ok: false; error: string };

/** `pat-submit`: a malformed PAT (or unusable storage) shows `pat-error` and changes nothing. */
export function submitPat(store: PatFormStore, raw: string, persist: boolean): PatSubmitResult {
  try {
    store.set(raw, persist);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
