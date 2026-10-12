import type { DdvConfig, DocEntry } from '@ddv/core';
import { mockRefs, screenDiagram } from './paths.ts';

export const RETIRED_DIR = '_retired';

export interface MockTarget {
  name: string;
  /** html path relative to mocksRoot */
  target: string;
  doc: DocEntry;
  /** screen transition diagram id given by `{diagram=<id>}` */
  diagram?: string;
}

/**
 * Mocks referenced from documents (`::mock[name/index.html]`). A reference from a basic design owns the mock
 * (other references, e.g. from detailed designs, only display it); otherwise the first reference wins.
 */
export function mockTargets(docs: DocEntry[]): MockTarget[] {
  const out = new Map<string, MockTarget>();
  for (const owner of [true, false])
    for (const doc of docs) {
      if ((doc.kind === 'basic') !== owner) continue;
      for (const r of mockRefs(doc))
        if (r.name && !out.has(r.name)) out.set(r.name, { name: r.name, target: r.target, doc, ...(r.diagram ? { diagram: r.diagram } : {}) });
    }
  return [...out.values()];
}

/** The screen transition diagram of a mock target. */
export function targetDiagram(t: MockTarget) {
  return screenDiagram(t.doc, t.diagram);
}

export function scenariosDir(config: DdvConfig, mock: string): string {
  return `${config.mocksRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${mock}/scenarios`;
}

export const mocksRootOf = (config: DdvConfig) => config.mocksRoot.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');

/** The `id:` value of a scenario text even when the file is otherwise invalid. */
export function scenarioIdOf(text: string): string | null {
  return /^id:\s*["']?([^"'#\s]+)/m.exec(text)?.[1] ?? null;
}

/** Scenario files of a scenarios folder listing: `*.yaml` / `*.yml` not starting with `_`. */
export const isScenarioFileName = (name: string) => /\.ya?ml$/.test(name) && !name.startsWith('_');
