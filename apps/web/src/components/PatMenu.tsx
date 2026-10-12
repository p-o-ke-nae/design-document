import { useCallback, useState, useSyncExternalStore } from 'react';
import type { Unsubscribe } from '../backend/types.ts';
import { PAT_NOTE, patMenuItems, patMenuLabel, type PatFormStore } from '../pages/pat-ui.ts';
import type { PatClearReason } from '../pages/pat-store.ts';
import { PatForm, PatScopes } from './PatForm.tsx';

/** What PatMenu reads and calls of `PatStore`. */
export interface PatMenuStore extends PatFormStore {
  persist(): void;
  unpersist(): void;
  clear(reason: PatClearReason): void;
  subscribe(listener: () => void): Unsubscribe;
}

/** Header PAT menu (pat.md「PAT メニュー」). Every operation notifies the store's subscribers, which refetch the target. */
export function PatMenu({ store }: { store: PatMenuStore }) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const state = useSyncExternalStore(subscribe, () => store.state);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [scopes, setScopes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = patMenuItems(state);

  const run = (fn: () => void) => {
    try {
      fn();
      setError(null);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="pat-menu">
      <button type="button" data-testid="pat-menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {patMenuLabel(state)}
      </button>
      {open && (
        <div className="menu" data-testid="pat-menu-list">
          <button
            type="button"
            data-testid="pat-menu-set"
            onClick={() => {
              setDialog(true);
              setOpen(false);
            }}
          >
            {items.setLabel}
          </button>
          {items.showPersist && (
            <button type="button" data-testid="pat-menu-persist" onClick={() => run(() => store.persist())}>
              この端末に保存
            </button>
          )}
          {items.showUnpersist && (
            <button type="button" data-testid="pat-menu-unpersist" onClick={() => run(() => store.unpersist())}>
              端末から消す
            </button>
          )}
          <button type="button" data-testid="pat-menu-clear" disabled={items.clearDisabled} onClick={() => run(() => store.clear('user'))}>
            PAT を消す
          </button>
          <button type="button" data-testid="pat-menu-scopes" aria-expanded={scopes} onClick={() => setScopes((s) => !s)}>
            必要な権限
          </button>
          {scopes && <PatScopes />}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="muted" data-testid="pat-menu-note">
            {PAT_NOTE}
          </p>
        </div>
      )}
      {dialog && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal="true" data-testid="pat-dialog">
            <h3>{items.setLabel}</h3>
            <PatForm store={store} mode="dialog" onDone={() => setDialog(false)} onCancel={() => setDialog(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
