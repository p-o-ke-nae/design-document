// Default capture of `ddv evidence try`. Hook point for the runner stage (evidence-runner.md):
// replace the body with `createEvidenceRunner({ repoRoot, config, hooks, store, testId: 'try' }).captureOne(spec, host, scope)`
// using a host without a driver (`ctx.page` / `ctx.app` undefined) and an empty input scope.
import type { TryCapture } from './cli.ts';

export const RUNNER_MISSING = '証跡の取得の実行器（EvidenceRunner）はまだ組み込まれていません';

export const defaultTryCapture: TryCapture = async () => ({ status: 'failed', reason: RUNNER_MISSING, files: [], durationMs: 0 });
