import { docEntryOf, type DdvConfig } from '@ddv/core';
import { activeIds, docMatrices } from '@ddv/testid/core';
import { classify, countClass, elementClasses, emptyCount, type CoverageClass, type DocCoverage, type LatestResults } from './history.ts';
import type { MatrixService } from './matrix.ts';
import { normalizeRepoPath } from './repo-path.ts';
import type { RepoReader } from './repo-reader.ts';

/** Design coverage of one document (DD-HIST-CLASSIFY / ELEMENT). */
export class CoverageService {
  constructor(
    private readonly reader: RepoReader,
    private readonly getConfig: () => DdvConfig,
    private readonly matrix: Pick<MatrixService, 'lock' | 'links'>,
  ) {}

  async coverage(docPath: string, latest: LatestResults): Promise<DocCoverage> {
    const config = this.getConfig();
    const rel = normalizeRepoPath(docPath);
    const doc = docEntryOf(rel, await this.reader.readText(rel));
    const lock = await this.matrix.lock();
    const active = activeIds(lock);
    const matrices = docMatrices(doc, config, lock);
    const linked = new Set((await this.matrix.links()).map((l) => l.id));
    const out: DocCoverage = { path: doc.path, total: emptyCount(), diagrams: {}, cases: {}, elements: {} };
    for (const m of matrices) {
      const counts = emptyCount();
      const classes: Record<string, CoverageClass> = {};
      for (const c of m.cases) {
        if (c.provisional || !active.has(c.id)) continue;
        // Results of an id that is no longer linked are ignored: it cannot be run now.
        const cls = classify(c.id, linked.has(c.id), latest[c.id]);
        classes[c.id] = cls;
        out.cases[c.id] = cls;
        countClass(counts, cls);
        countClass(out.total, cls);
      }
      out.diagrams[m.diagram] = counts;
      out.elements[m.diagram] = elementClasses(m, classes);
    }
    return out;
  }
}
