// Default capture of `ddv evidence try`: the real runner's `captureOne` with a host without a driver
// (`ctx.page` / `ctx.app` undefined, empty input scope). Files are written to `<outDir>/evidence/`.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeJoin } from '@ddv/core/node';
import type { EvidenceHost } from '@ddv/mock';
import type { TryCapture } from './cli.ts';
import { DEFAULT_HOOKS_FILE } from './hooks-scan.ts';
import type { EvidenceHooks } from './index.ts';
import { Redactor } from './redact.ts';
import { createResolver, EvidenceRunner } from './runner.ts';
import { EvidenceStore } from './store.ts';

export const NO_SCREEN = 'try では画面を撮れません（E2E の実行で使ってください）';

/** A host for `try`: no screen and no mock. */
export const tryHost: EvidenceHost = {
  platform: 'web',
  target: 'app',
  screenshot: () => Promise.reject(new Error(NO_SCREEN)),
  screenshotElement: () => Promise.reject(new Error(NO_SCREEN)),
  mockTables: () => Promise.resolve(null),
  hookContext: () => ({}),
};

/** `evidence` of the hooks file, or `{}` when it is absent or cannot be loaded. */
export async function loadEvidenceHooks(repoRoot: string, hooksFile = DEFAULT_HOOKS_FILE): Promise<EvidenceHooks> {
  let abs: string;
  try {
    abs = safeJoin(repoRoot, hooksFile);
  } catch {
    return {};
  }
  if (!existsSync(abs)) return {};
  try {
    const mod = (await import(pathToFileURL(abs).href)) as { evidence?: EvidenceHooks; default?: { evidence?: EvidenceHooks } };
    return mod.evidence ?? mod.default?.evidence ?? {};
  } catch {
    return {};
  }
}

export const defaultTryCapture: TryCapture = async ({ repoRoot, config, registry, spec, outDir }) => {
  const hooks = registry.hooks.providers.some((p) => p.name === spec.use) ? await loadEvidenceHooks(repoRoot) : {};
  const runner = new EvidenceRunner({
    config,
    resolver: createResolver(repoRoot, config, hooks),
    store: new EvidenceStore(outDir, '.', config),
    testId: 'try',
    redactor: Redactor.fromConfig(config),
  });
  const r = await runner.captureOne(spec, tryHost, new Map(), { step: 1, seq: 1 });
  return {
    status: r.status === 'ok' ? 'ok' : 'failed',
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    files: r.files.map((f) => ({ kind: f.kind, path: path.join(outDir, ...f.path.split('/')), bytes: f.bytes })),
    durationMs: r.durationMs,
  };
};
