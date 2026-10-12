import { promises as fs, existsSync } from 'node:fs';
import type { DdvConfig } from '@ddv/core';
import { safeJoin, type DocEntry, type LintIssue } from '@ddv/core/node';
import { readLock, type TestIdLock } from '@ddv/testid';
import { checkMocksWith, type MockCheckIo } from './check-core.ts';
import { listScenarioFiles, loadMockModel } from './scaffold-cli.ts';
import { MOCK_VERSION } from './version.ts';

export * from './check-core.ts';

/** File access of `checkMocksWith` on the local file system. */
export function fsMockCheckIo(repoRoot: string, config: DdvConfig): MockCheckIo {
  return {
    dirExists: async (rel) => existsSync(safeJoin(repoRoot, rel)),
    mockModel: (target) => loadMockModel(repoRoot, config, target),
    scenarioFiles: (mock) => listScenarioFiles(repoRoot, config, mock),
    readText: (rel) => fs.readFile(safeJoin(repoRoot, rel), 'utf8'),
    tryReadText: async (rel) => {
      const p = safeJoin(repoRoot, rel);
      return existsSync(p) ? fs.readFile(p, 'utf8') : null;
    },
  };
}

/** ddv-lint extension for mocks and scenarios (basic design: 検査). */
export async function checkMocks(repoRoot: string, config: DdvConfig, docs: DocEntry[], lock?: TestIdLock): Promise<LintIssue[]> {
  return checkMocksWith(fsMockCheckIo(repoRoot, config), config, docs, lock ?? (await readLock(repoRoot)), MOCK_VERSION);
}
