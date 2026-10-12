import { useMemo, useState, type FormEvent } from 'react';
import type { PagesConfig } from '@ddv/core';
import { formatHostedHash, inputOf, targetKey, targetOfConfig, validateTarget, type HostedTarget, type TargetError, type TargetInput, type TargetKind } from '../pages/hash-route.ts';
import { recentToTarget, type RecentTargets } from '../pages/recent-targets.ts';
import type { LoadError } from '../pages/target-loader.ts';

export interface OpenTargetPageProps {
  config: PagesConfig;
  recent: Pick<RecentTargets, 'list'>;
  /** `open-error` of the URL (`TargetLoader.openError`). */
  openError: TargetError | null;
  /** `fetch-error` (`TargetLoader.error` when Failed). */
  fetchError: LoadError | null;
  /** The last target (Failed): its values are kept in the form. */
  last: HostedTarget | null;
  /** Called with the hash to open (PagesApp sets `location.hash` and opens it even when the hash did not change). */
  onOpen(hash: string): void;
}

interface RecentItem {
  key: string;
  target: HostedTarget;
  text: string;
}

/** 対象の指定 (pages-viewer.md「画面」). */
export function OpenTargetPage({ config, recent, openError, fetchError, last, onOpen }: OpenTargetPageProps) {
  const init: TargetInput = openError?.input ?? (last ? inputOf(last) : { repo: '', kind: 'pr', target: '' });
  const [repo, setRepo] = useState(init.repo);
  const [kind, setKind] = useState<TargetKind>(init.kind);
  const [target, setTarget] = useState(init.target);
  const [error, setError] = useState<string | null>(openError?.message ?? null);

  const items = useMemo(() => {
    const out: RecentItem[] = [];
    const seen = new Set<string>();
    const push = (t: HostedTarget | null, label: string) => {
      if (!t) return;
      const key = targetKey(t);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ key, target: t, text: `${t.owner}/${t.repo} ${label}`.trim() });
    };
    for (const r of recent.list()) push(recentToTarget(r), r.kind === 'pr' ? `#${r.pr} ${r.label}` : r.label);
    for (const c of config.recentTargets ?? []) push(targetOfConfig(c, config), c.label ?? (c.pr !== undefined ? `#${c.pr}` : (c.ref ?? '')));
    return out;
  }, [recent, config]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validateTarget({ repo, kind, target }, config);
    if (!v.target) return setError(v.error.message);
    setError(null);
    onOpen(formatHostedHash(v.target));
  };

  return (
    <main className="main doc pages-open" data-testid="open-target">
      <h2>開く対象</h2>
      <form className="form" onSubmit={submit} autoComplete="off" noValidate>
        <label htmlFor="repo">リポジトリ（owner/repo）</label>
        <input id="repo" data-testid="repo" maxLength={100} placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <label htmlFor="kind">種類</label>
        <select id="kind" data-testid="kind" value={kind} onChange={(e) => setKind(e.target.value as TargetKind)}>
          <option value="pr">PR</option>
          <option value="ref">branch・tag</option>
        </select>
        <label htmlFor="target">PR 番号 または branch・tag 名（branch・tag は省略で既定ブランチ）</label>
        <input id="target" data-testid="target" maxLength={100} placeholder="12 / main / v1.0" value={target} onChange={(e) => setTarget(e.target.value)} />
        {error && (
          <p className="error" data-testid="open-error" role="alert">
            {error}
          </p>
        )}
        {fetchError && !error && (
          <p className="error" data-testid="fetch-error" role="alert">
            {fetchError.message}
          </p>
        )}
        <div>
          <button type="submit" className="primary" data-testid="open-submit">
            開く
          </button>
        </div>
      </form>
      <h3>最近開いた対象</h3>
      <ul data-testid="recent">
        {items.map((i) => (
          <li key={i.key}>
            <a href={formatHostedHash(i.target)} data-testid="recent-item">
              {i.text}
            </a>
          </li>
        ))}
      </ul>
      <p className="note">
        URL に対象を含めて開くと、この画面を出さずに表示します（例：<code>#/gh/acme/order-app/pr/12/doc/basic/order.md</code>）。
      </p>
    </main>
  );
}
