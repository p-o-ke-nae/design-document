import { splitLabel } from '@ddv/graph';
import type { PathSpec, PathTransition, Scenario } from './types.ts';

export type MatchResult =
  | { ok: true }
  | { ok: false; kind: 'start' | 'count' | 'event' | 'screen'; /** 0-based step index */ step?: number; expected: string; actual: string; message: string };

const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Normalizes `イベント [ガード]` (whitespace-insensitive). */
export function normalizeEvent(label: string): string {
  const { event, guard } = splitLabel(label);
  return guard ? `${ws(event)} [${ws(guard)}]` : ws(event);
}

export function transitionLabel(t: Pick<PathTransition, 'event' | 'guard'>): string {
  return t.guard ? `${ws(t.event)} [${ws(t.guard)}]` : ws(t.event);
}

export function matchPath(scenario: Pick<Scenario, 'start' | 'steps'>, path: PathSpec): MatchResult {
  if (scenario.start !== path.start) {
    return { ok: false, kind: 'start', expected: path.start, actual: scenario.start, message: `start が経路と一致しません（期待: ${path.start}、実際: ${scenario.start}）` };
  }
  if (scenario.steps.length !== path.transitions.length) {
    const e = String(path.transitions.length);
    const a = String(scenario.steps.length);
    return { ok: false, kind: 'count', expected: e, actual: a, message: `ステップ数が経路の遷移数と一致しません（期待: ${e}、実際: ${a}）` };
  }
  for (let i = 0; i < path.transitions.length; i++) {
    const expected = transitionLabel(path.transitions[i]);
    const actual = normalizeEvent(scenario.steps[i].event);
    if (expected !== actual) return { ok: false, kind: 'event', step: i, expected, actual, message: `ステップ ${i + 1} の event が経路と一致しません（期待: ${expected}、実際: ${actual}）` };
  }
  for (let i = 0; i < path.transitions.length; i++) {
    const expected = path.transitions[i].to;
    const actual = scenario.steps[i].expect.screen;
    if (expected !== actual) return { ok: false, kind: 'screen', step: i, expected, actual, message: `ステップ ${i + 1} の expect.screen が遷移先と一致しません（期待: ${expected}、実際: ${actual}）` };
  }
  return { ok: true };
}
