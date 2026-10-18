import { normalizeEvent } from './match.ts';
import type { Scenario, Step } from './types.ts';

export interface MergeSource {
  /** Index of the matched existing step, or null when the generated step is used as is. */
  step: number | null;
  input: 'existing' | 'generated' | 'none';
  /** Existing auxiliary step kept unchanged (`step` is its index in the existing file). */
  aux?: true;
}

export interface MergeResult {
  scenario: Scenario;
  /** true when the result equals `existing` (no write needed). */
  unchanged: boolean;
  /** Existing transition steps that matched no generated step (deleted). */
  removed: number;
  /** Existing auxiliary steps deleted with their unmatched transition step (「補助ステップを N 件削除」). */
  auxRemoved: number;
  /** One per merged step. */
  sources: MergeSource[];
  /** Index in the merged steps of each generated step. */
  positions: number[];
}

/** Stable JSON (sorted keys, undefined dropped) for equality checks. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

const pairKey = (s: Step) => `${normalizeEvent(s.event ?? '')}\u0000${s.expect?.screen ?? ''}`;

/** Existing steps grouped as「先頭の補助ステップ」and「遷移のステップ + 後に続く補助ステップ」(file indices). */
function groupSteps(steps: Step[]): { head: number[]; groups: Map<number, number[]> } {
  const head: number[] = [];
  const groups = new Map<number, number[]>();
  let current: number[] = head;
  steps.forEach((s, i) => {
    if (s.event !== undefined) {
      current = [];
      groups.set(i, current);
    } else current.push(i);
  });
  return { head, groups };
}

/**
 * Merges regenerated skeleton steps into an existing scenario (detailed design: scenario.md#マージ, desktop-scenario.md#マージ).
 * Auxiliary steps follow their transition step unchanged; leading ones stay at the top; those of a removed transition are deleted.
 */
export function mergeScenario(existing: Scenario | undefined, generated: Scenario): MergeResult {
  if (!existing) {
    return {
      scenario: structuredClone(generated),
      unchanged: false,
      removed: 0,
      auxRemoved: 0,
      sources: generated.steps.map((s) => ({ step: null, input: s.input ? 'generated' : 'none' })),
      positions: generated.steps.map((_, i) => i),
    };
  }
  const { head, groups } = groupSteps(existing.steps);
  const used = new Set<number>();
  const sources: MergeSource[] = [];
  const steps: Step[] = [];
  const positions: number[] = [];
  const keepAux = (idx: number[]) => {
    for (const j of idx) {
      steps.push(structuredClone(existing.steps[j]));
      sources.push({ step: j, input: existing.steps[j].input !== undefined ? 'existing' : 'none', aux: true });
    }
  };
  keepAux(head);
  for (const g of generated.steps) {
    const key = pairKey(g);
    const j = existing.steps.findIndex((e, idx) => e.event !== undefined && !used.has(idx) && pairKey(e) === key);
    positions.push(steps.length);
    if (j < 0) {
      sources.push({ step: null, input: g.input ? 'generated' : 'none' });
      steps.push(structuredClone(g));
      continue;
    }
    used.add(j);
    const e = existing.steps[j];
    const eExpect = e.expect ?? {};
    const input = e.input !== undefined ? e.input : g.input;
    const extra = Object.keys(eExpect).some((k) => k !== 'screen' && (eExpect as unknown as Record<string, unknown>)[k] !== undefined);
    const step = { event: g.event } as Step;
    if (input !== undefined) step.input = structuredClone(input);
    if (g.click !== undefined) step.click = g.click;
    if (e.do !== undefined) step.do = e.do;
    if (e.wait !== undefined) step.wait = e.wait;
    step.expect = extra ? { ...structuredClone(eExpect), screen: g.expect?.screen } : structuredClone(g.expect);
    sources.push({ step: j, input: e.input !== undefined ? 'existing' : g.input !== undefined ? 'generated' : 'none' });
    steps.push(step);
    keepAux(groups.get(j) ?? []);
  }
  let removed = 0;
  let auxRemoved = 0;
  for (const [j, aux] of groups) {
    if (used.has(j)) continue;
    removed++;
    auxRemoved += aux.length;
  }
  const scenario: Scenario = { id: generated.id, title: generated.title, fixtures: [...existing.fixtures], start: generated.start, steps };
  return { scenario, unchanged: canonical(scenario) === canonical(existing), removed, auxRemoved, sources, positions };
}
