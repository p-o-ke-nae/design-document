import { normalizeEvent } from './match.ts';
import type { Scenario, Step } from './types.ts';

export interface MergeSource {
  /** Index of the matched existing step, or null when the generated step is used as is. */
  step: number | null;
  input: 'existing' | 'generated' | 'none';
}

export interface MergeResult {
  scenario: Scenario;
  /** true when the result equals `existing` (no write needed). */
  unchanged: boolean;
  /** Existing steps that matched no generated step (deleted). */
  removed: number;
  sources: MergeSource[];
}

/** Stable JSON (sorted keys, undefined dropped) for equality checks. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

const pairKey = (s: Step) => `${normalizeEvent(s.event)}\u0000${s.expect.screen}`;

export function mergeScenario(existing: Scenario | undefined, generated: Scenario): MergeResult {
  if (!existing) {
    return {
      scenario: structuredClone(generated),
      unchanged: false,
      removed: 0,
      sources: generated.steps.map((s) => ({ step: null, input: s.input ? 'generated' : 'none' })),
    };
  }
  const used = new Set<number>();
  const sources: MergeSource[] = [];
  const steps = generated.steps.map((g) => {
    const key = pairKey(g);
    const j = existing.steps.findIndex((e, idx) => !used.has(idx) && pairKey(e) === key);
    if (j < 0) {
      sources.push({ step: null, input: g.input ? 'generated' : 'none' });
      return structuredClone(g);
    }
    used.add(j);
    const e = existing.steps[j];
    const input = e.input !== undefined ? e.input : g.input;
    const extra = Object.keys(e.expect).some((k) => k !== 'screen' && (e.expect as unknown as Record<string, unknown>)[k] !== undefined);
    const step = { event: g.event } as Step;
    if (input !== undefined) step.input = structuredClone(input);
    if (g.click !== undefined) step.click = g.click;
    if (e.do !== undefined) step.do = e.do;
    if (e.wait !== undefined) step.wait = e.wait;
    step.expect = extra ? { ...structuredClone(e.expect), screen: g.expect.screen } : structuredClone(g.expect);
    sources.push({ step: j, input: e.input !== undefined ? 'existing' : g.input !== undefined ? 'generated' : 'none' });
    return step;
  });
  const scenario: Scenario = { id: generated.id, title: generated.title, fixtures: [...existing.fixtures], start: generated.start, steps };
  return { scenario, unchanged: canonical(scenario) === canonical(existing), removed: existing.steps.length - used.size, sources };
}
