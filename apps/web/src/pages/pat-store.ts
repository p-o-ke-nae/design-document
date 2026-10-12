import { redact, type TokenProvider } from '@ddv/github';
import type { Unsubscribe } from '../backend/types.ts';
import { parsePat, type PatKind } from './pat-format.ts';

/** Where the PAT lives (pat.md「PAT の保管」, DD-PAT-PATSTORE). */
export type PatState = 'none' | 'session' | 'stored';
export type PatClearReason = 'user' | 'invalid' | 'otherTab';

export const PAT_NOT_SET_MESSAGE = 'PAT が設定されていません';
export const PAT_STORAGE_DISABLED_MESSAGE = 'この端末に保存できません（ブラウザの設定でストレージが無効です）';
export const PAT_INVALID_MESSAGE = 'PAT が無効です（失効・取り消しの可能性があります）。設定し直してください';

/** The parts of a `StorageEvent` that `onStorage` reads. */
export interface PatStorageEvent {
  key: string | null;
  newValue: string | null;
  storageArea?: Storage | null;
}

export interface PatStoreOptions {
  /** `import.meta.env.BASE_URL`: the key is `ddv:pat:<base>` (project sites share one origin). */
  base?: string;
  /** Defaults to `window.sessionStorage`; `null` = unusable (memory only). */
  session?: Storage | null;
  /** Defaults to `window.localStorage`; `null` = unusable. */
  local?: Storage | null;
}

export const patStorageKey = (base: string) => `ddv:pat:${base}`;

function defaultStorage(name: 'sessionStorage' | 'localStorage'): Storage | null {
  try {
    return (globalThis as unknown as Record<string, Storage | undefined>)[name] ?? null;
  } catch {
    return null;
  }
}

/** One per tab. Satisfies `TokenProvider` for the Pages edition: a 401 clears the PAT and never retries. */
export class PatStore implements TokenProvider {
  state: PatState = 'none';
  kind: PatKind | null = null;
  lastClear: PatClearReason | null = null;
  private token = '';
  readonly key: string;
  private readonly session: Storage | null;
  private readonly local: Storage | null;
  /** `sessionStorage` threw: the Session PAT is kept in memory only. */
  private memoryOnly = false;
  private readonly listeners = new Set<() => void>();

  constructor(opts: PatStoreOptions = {}) {
    this.key = patStorageKey(opts.base ?? '/');
    this.session = opts.session === undefined ? defaultStorage('sessionStorage') : opts.session;
    this.local = opts.local === undefined ? defaultStorage('localStorage') : opts.local;
  }

  /** sessionStorage first (closing the tab forgets it), then localStorage. A malformed value is removed. */
  load(): void {
    const fromSession = this.read(this.session, true);
    if (fromSession !== null) {
      const p = parsePat(fromSession);
      if (p.ok) return this.apply('session', p.token, p.kind);
      this.remove(this.session);
    }
    const fromLocal = this.read(this.local, false);
    if (fromLocal !== null) {
      const p = parsePat(fromLocal);
      if (p.ok) return this.apply('stored', p.token, p.kind);
      this.remove(this.local);
    }
    this.apply('none', '', null);
  }

  /** Throws `PatFormatError` (state and storages unchanged) when `raw` is malformed. */
  set(raw: string, persist: boolean): void {
    const p = parsePat(raw);
    if (!p.ok) throw p.error;
    if (persist) {
      this.writeLocal(p.token);
      this.remove(this.session);
    } else {
      this.writeSession(p.token);
      this.remove(this.local);
    }
    this.lastClear = null;
    this.apply(persist ? 'stored' : 'session', p.token, p.kind);
  }

  persist(): void {
    if (this.state === 'none') throw new Error(PAT_NOT_SET_MESSAGE);
    if (this.state === 'stored') return;
    this.writeLocal(this.token);
    this.remove(this.session);
    this.apply('stored', this.token, this.kind);
  }

  unpersist(): void {
    if (this.state === 'none') throw new Error(PAT_NOT_SET_MESSAGE);
    if (this.state === 'session') return;
    this.writeSession(this.token);
    this.remove(this.local);
    this.apply('session', this.token, this.kind);
  }

  clear(reason: PatClearReason): void {
    if (this.state === 'none') return;
    this.remove(this.session);
    this.remove(this.local);
    this.lastClear = reason;
    this.apply('none', '', null);
  }

  async authorization(): Promise<string | null> {
    return this.token ? `Bearer ${this.token}` : null;
  }

  /** A 401: the PAT is invalid (revoked or expired). Clearing localStorage also clears the other tabs. Never retries. */
  unauthorized(): boolean {
    this.clear('invalid');
    return false;
  }

  redact(text: string): string {
    return redact(text, [this.token]);
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** `storage` events of localStorage (another tab). A Session PAT wins over the other tabs' changes. */
  onStorage(event: PatStorageEvent): void {
    if (event.storageArea && this.local && event.storageArea !== this.local) return;
    if (event.key !== null && event.key !== this.key) return;
    if (this.state === 'session') return;
    const value = event.key === null ? null : event.newValue;
    if (value === null) {
      if (this.state === 'stored') {
        this.lastClear = 'otherTab';
        this.apply('none', '', null);
      }
      return;
    }
    const p = parsePat(value);
    if (!p.ok) return;
    this.lastClear = null;
    this.apply('stored', p.token, p.kind);
  }

  dispose(): void {
    this.listeners.clear();
  }

  private apply(state: PatState, token: string, kind: PatKind | null): void {
    const changed = state !== this.state || token !== this.token;
    this.state = state;
    this.token = token;
    this.kind = kind;
    if (changed) for (const l of [...this.listeners]) l();
  }

  private read(storage: Storage | null, isSession: boolean): string | null {
    if (!storage) {
      if (isSession) this.memoryOnly = true;
      return null;
    }
    try {
      return storage.getItem(this.key);
    } catch {
      if (isSession) this.memoryOnly = true;
      return null;
    }
  }

  private writeSession(token: string): void {
    if (this.memoryOnly || !this.session) {
      this.memoryOnly = true;
      return;
    }
    try {
      this.session.setItem(this.key, token);
    } catch {
      this.memoryOnly = true;
    }
  }

  private writeLocal(token: string): void {
    if (this.memoryOnly || !this.local) throw new Error(PAT_STORAGE_DISABLED_MESSAGE);
    try {
      this.local.setItem(this.key, token);
    } catch {
      throw new Error(PAT_STORAGE_DISABLED_MESSAGE);
    }
  }

  private remove(storage: Storage | null): void {
    try {
      storage?.removeItem(this.key);
    } catch {
      // unusable storage holds nothing
    }
  }
}

/** The tab's `PatStore`: loaded, and following the other tabs through `window`'s `storage` event. `dispose()` detaches it. */
export function createPatStore(base: string = import.meta.env.BASE_URL): PatStore {
  const store = new PatStore({ base });
  store.load();
  if (typeof window !== 'undefined') {
    const onStorage = (e: StorageEvent) => store.onStorage(e);
    window.addEventListener('storage', onStorage);
    const dispose = store.dispose.bind(store);
    store.dispose = () => {
      window.removeEventListener('storage', onStorage);
      dispose();
    };
  }
  return store;
}
