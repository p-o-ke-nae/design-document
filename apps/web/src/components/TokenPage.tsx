import { PAT_NOTE } from '../pages/pat-ui.ts';
import type { PatStore } from '../pages/pat-store.ts';
import type { HostedTarget } from '../pages/hash-route.ts';
import type { LoadError } from '../pages/target-loader.ts';
import { PatForm } from './PatForm.tsx';

/** PAT が必要 (pages-viewer.md「画面」). Setting the PAT refetches through `PatStore`'s change notification. */
export function TokenPage({ target, error, store, onChangeTarget }: { target: HostedTarget; error: LoadError | null; store: PatStore; onChangeTarget(): void }) {
  return (
    <main className="main doc pages-token">
      <h2>
        {target.owner}/{target.repo} を開くには PAT が必要です
      </h2>
      <p data-testid="token-reason">{error?.message}</p>
      <PatForm store={store} mode="page" onChangeTarget={onChangeTarget} />
      <p className="note" data-testid="pat-note">
        {PAT_NOTE}
      </p>
    </main>
  );
}
