import { useState, type FormEvent } from 'react';
import { requiredPermissionLines } from '../pages/permission.ts';
import { PAT_CREATE_URL, patFormInit, submitPat, type PatFormStore } from '../pages/pat-ui.ts';

/** `scopes` list and the link to GitHub's PAT creation page (shared by PatForm and PatMenu). */
export function PatScopes() {
  return (
    <div className="pat-scopes">
      <h3>必要な権限（fine-grained PAT）</h3>
      <p>
        <a data-testid="pat-create-link" href={PAT_CREATE_URL} target="_blank" rel="noopener noreferrer">
          PAT を作成する（GitHub）
        </a>
      </p>
      <ul data-testid="scopes">
        {requiredPermissionLines().map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export interface PatFormProps {
  store: PatFormStore;
  /** `page`: the 「PAT が必要」 screen (with `token-change`). `dialog`: PatMenu's dialog (with `pat-cancel`). */
  mode: 'page' | 'dialog';
  /** After `PatStore.set` succeeded (the store's change notification refetches the target). */
  onDone?(): void;
  onChangeTarget?(): void;
  onCancel?(): void;
}

/** PAT input (pat.md「PAT の入力」). Never submitted as a form: the PAT must not reach a URL. */
export function PatForm({ store, mode, onDone, onChangeTarget, onCancel }: PatFormProps) {
  const [init] = useState(() => patFormInit(store));
  const [raw, setRaw] = useState('');
  const [persist, setPersist] = useState(init.persist);
  const [error, setError] = useState<string | null>(init.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const r = submitPat(store, raw, persist);
    if (!r.ok) return setError(r.error);
    setRaw('');
    setError(null);
    onDone?.();
  };

  return (
    <form className="pat-form" onSubmit={onSubmit} autoComplete="off">
      <label htmlFor="pat">Personal Access Token</label>
      <input id="pat" data-testid="pat" type="password" maxLength={255} autoComplete="off" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
      <label>
        <input type="checkbox" data-testid="pat-store" checked={persist} onChange={(e) => setPersist(e.target.checked)} /> この端末に保存（既定はタブを閉じると消えます）
      </label>
      {error && (
        <p className="error" data-testid="pat-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {mode === 'page' && (
          <button type="button" data-testid="token-change" onClick={() => onChangeTarget?.()}>
            対象を変更
          </button>
        )}
        {mode === 'dialog' && (
          <button type="button" data-testid="pat-cancel" onClick={() => onCancel?.()}>
            キャンセル
          </button>
        )}
        <button type="submit" className="primary" data-testid="pat-submit">
          設定
        </button>
      </div>
      {mode === 'page' && <PatScopes />}
    </form>
  );
}
