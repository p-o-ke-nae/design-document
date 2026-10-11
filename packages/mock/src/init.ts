import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DdvConfig } from '@ddv/core';
import { safeJoin } from '@ddv/core/node';
import { MOCK_RUNTIME_FILE, MOCK_VERSION, runtimeVersionOf } from './version.ts';

export const SCENARIO_SPEC_FILE = 'e2e/ddv-scenarios.spec.ts';

export const SCENARIO_SPEC_TEXT = `// ddv mock init が配置。編集しない
import { defineScenarioTests } from '@ddv/mock/playwright';
defineScenarioTests({ repoRoot: '..' });
`;

/** Built runtime bundle (`npm run build -w @ddv/mock-runtime`). */
export const DEFAULT_RUNTIME_DIST = fileURLToPath(new URL('../../mock-runtime/dist/mock-runtime.js', import.meta.url));

export interface InitMocksResult {
  runtime: 'created' | 'updated' | 'unchanged';
  spec: 'created' | 'unchanged';
  runtimePath: string;
  specPath: string;
}

/** `ddv mock init`: deploys `<mocksRoot>/_ddv/mock-runtime.js` (only when version or content differs) and the fixed E2E spec (only when missing). */
export async function initMocks(repoRoot: string, config: DdvConfig, opts: { runtimeFile?: string } = {}): Promise<InitMocksResult> {
  const src = opts.runtimeFile ?? DEFAULT_RUNTIME_DIST;
  if (!existsSync(src)) throw new Error(`mock-runtime のビルド成果物がありません（${src}）。先に npm run build -w @ddv/mock-runtime を実行してください`);
  const bundle = await fs.readFile(src, 'utf8');
  const v = runtimeVersionOf(bundle);
  if (v !== MOCK_VERSION) throw new Error(`mock-runtime のビルドの版（${v ?? '不明'}）が ddv の版（${MOCK_VERSION}）と違います。npm run build -w @ddv/mock-runtime で作り直してください`);

  const mocksRoot = config.mocksRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const runtimeRel = `${mocksRoot}/${MOCK_RUNTIME_FILE}`;
  const runtimePath = safeJoin(repoRoot, runtimeRel);
  let runtime: InitMocksResult['runtime'] = 'created';
  if (existsSync(runtimePath)) {
    const current = await fs.readFile(runtimePath, 'utf8');
    runtime = runtimeVersionOf(current) === v && current === bundle ? 'unchanged' : 'updated';
  }
  if (runtime !== 'unchanged') {
    await fs.mkdir(path.dirname(runtimePath), { recursive: true });
    await fs.writeFile(runtimePath, bundle, 'utf8');
  }

  const specPath = safeJoin(repoRoot, SCENARIO_SPEC_FILE);
  let spec: InitMocksResult['spec'] = 'unchanged';
  if (!existsSync(specPath)) {
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, SCENARIO_SPEC_TEXT, 'utf8');
    spec = 'created';
  }
  return { runtime, spec, runtimePath: runtimeRel, specPath: SCENARIO_SPEC_FILE };
}
