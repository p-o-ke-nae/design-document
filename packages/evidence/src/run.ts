// Evidence runner of one scenario run, saving into the run's trace directory (evidence-runner.md#組み込み).
import type { DbType } from './config.ts';
import type { DbConnector } from './db/types.ts';
import type { EvidenceHooks } from './index.ts';
import { createEvidenceRunner, type EvidenceRunner } from './runner.ts';
import { EvidenceStore } from './store.ts';
import { loadEvidenceHooks } from './try-capture.ts';

export interface RunEvidenceOptions {
  repoRoot: string;
  config: { evidence?: unknown };
  /** Hooks module relative to repoRoot (its `evidence` export), or the already loaded functions. */
  hooks?: string | EvidenceHooks;
  /** Trace directory of the run and the trace key (`<testId>` or `<testId>@<platform>`). */
  traceDir: string;
  key: string;
  testId: string;
  scenario: { steps: readonly { evidence?: readonly unknown[] }[] };
  env?: NodeJS.ProcessEnv;
  connectors?: Partial<Record<DbType, DbConnector>>;
}

/** undefined when neither the config nor the scenario has evidence (the run is unchanged, REQ-810). */
export async function evidenceRunnerForRun(opts: RunEvidenceOptions): Promise<EvidenceRunner | undefined> {
  if (opts.config.evidence === undefined && !opts.scenario.steps.some((s) => s.evidence?.length)) return undefined;
  const hooks = typeof opts.hooks === 'object' ? opts.hooks : await loadEvidenceHooks(opts.repoRoot, opts.hooks);
  return createEvidenceRunner({
    repoRoot: opts.repoRoot,
    config: opts.config,
    hooks,
    store: (c) => new EvidenceStore(opts.traceDir, opts.key, c),
    testId: opts.testId,
    scenario: opts.scenario,
    env: opts.env,
    connectors: opts.connectors,
  });
}
