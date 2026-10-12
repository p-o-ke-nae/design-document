import type { DdvConfig, DocEntry } from '@ddv/core';
import {
  activeIds,
  docMatrices,
  isScenarioLinkFile,
  linksInText,
  LOCK_PATH,
  parseLock,
  runnerFileFilter,
  scenarioLinksInText,
  testIdPattern,
  type DiagramMatrix,
  type TestIdLock,
  type TestLink,
} from '@ddv/testid/core';
import type { LatestResult, LatestResults } from './history.ts';
import type { RepoReader } from './repo-reader.ts';

/** `scanTestLinks` over a `RepoReader`. */
export async function scanTestLinksIn(reader: RepoReader, config: DdvConfig): Promise<TestLink[]> {
  const re = testIdPattern(config);
  const links: TestLink[] = [];
  for (const r of config.runners) {
    for (const file of await reader.listFiles(r.cwd, runnerFileFilter(r))) links.push(...linksInText(await reader.readText(file), file, r, re));
    if (r.type === 'playwright' && r.scenarios)
      for (const file of await reader.listFiles(config.mocksRoot, isScenarioLinkFile)) links.push(...scenarioLinksInText(await reader.readText(file), file, r, re));
  }
  return links;
}

export function linkIndex(links: TestLink[]): Record<string, TestLink[]> {
  const out: Record<string, TestLink[]> = {};
  for (const l of links) (out[l.id] ??= []).push(l);
  return out;
}

export type MatrixWithLinks = Omit<DiagramMatrix, 'cases'> & { cases: Array<DiagramMatrix['cases'][number] & { links: TestLink[] }> };

export interface TestCaseRow {
  id: string;
  diagramKey: string;
  signature: string;
  title: string;
  doc: string;
  level: 'unit' | 'integration';
  links: TestLink[];
  latest: LatestResult | null;
}

export interface TestsResponse {
  cases: TestCaseRow[];
  unknown: TestLink[];
  runners: Array<{ name: string; type: string; level: unknown; cwd: string }>;
}

/** Test ids, their links to the test code and the matrices of a document. */
export class MatrixService {
  private memo: { revision: string; config: DdvConfig; links: Promise<TestLink[]> } | null = null;

  constructor(
    private readonly reader: RepoReader,
    private readonly getConfig: () => DdvConfig,
  ) {}

  async lock(): Promise<TestIdLock> {
    return parseLock(await this.reader.tryReadText(LOCK_PATH));
  }

  /** Links found in the test code (memoized per `reader.revision` and config). */
  links(): Promise<TestLink[]> {
    const config = this.getConfig();
    const revision = this.reader.revision;
    if (this.memo && this.memo.revision === revision && this.memo.config === config && !revision.startsWith('worktree:')) return this.memo.links;
    const links = scanTestLinksIn(this.reader, config);
    this.memo = { revision, config, links };
    links.catch(() => {
      if (this.memo?.links === links) this.memo = null;
    });
    return links;
  }

  async matrices(doc: DocEntry): Promise<MatrixWithLinks[]> {
    const lock = await this.lock();
    const matrices = docMatrices(doc, this.getConfig(), lock);
    const links = linkIndex(await this.links());
    return matrices.map((m) => ({ ...m, cases: m.cases.map((cs) => ({ ...cs, links: links[cs.id] ?? [] })) }));
  }

  async tests(latest: LatestResults): Promise<TestsResponse> {
    const config = this.getConfig();
    const ids = activeIds(await this.lock());
    const links = await this.links();
    const byId = linkIndex(links);
    const unitPrefix = `${config.idPrefix.detailed}-`;
    // Design level of the case: detailed-design ids are unit tests, requirement/basic-design ids are integration tests.
    const cases = [...ids].map(([id, v]) => ({ id, ...v, level: id.startsWith(unitPrefix) ? ('unit' as const) : ('integration' as const), links: byId[id] ?? [], latest: latest[id] ?? null }));
    const unknown = links.filter((l) => !ids.has(l.id));
    return { cases, unknown, runners: config.runners.map((r) => ({ name: r.name, type: r.type, level: r.level, cwd: r.cwd })) };
  }
}
