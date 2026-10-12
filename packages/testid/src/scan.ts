import { promises as fs } from 'node:fs';
import type { DdvConfig } from '@ddv/core';
import { safeJoin, walk } from '@ddv/core/node';
import { isScenarioLinkFile, linksInText, runnerFileFilter, scenarioLinksInText, testIdPattern, type TestLink } from './scan-core.ts';

export * from './scan-core.ts';

export async function scanTestLinks(repoRoot: string, config: DdvConfig): Promise<TestLink[]> {
  const re = testIdPattern(config);
  const links: TestLink[] = [];
  for (const r of config.runners) {
    const files = await walk(repoRoot, r.cwd, runnerFileFilter(r));
    for (const file of files) links.push(...linksInText(await fs.readFile(safeJoin(repoRoot, file), 'utf8'), file, r, re));
    if (r.type === 'playwright' && r.scenarios) {
      for (const file of await walk(repoRoot, config.mocksRoot, isScenarioLinkFile)) {
        links.push(...scenarioLinksInText(await fs.readFile(safeJoin(repoRoot, file), 'utf8'), file, r, re));
      }
    }
  }
  return links;
}
