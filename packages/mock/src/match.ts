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

/** Compares the transition steps (auxiliary steps excluded) with a path; `step` / message numbers are file positions. */
export function matchPath(scenario: Pick<Scenario, 'start' | 'steps'>, path: PathSpec): MatchResult {
  const at = scenario.steps.flatMap((s, i) => (s.event !== undefined ? [i] : []));
  const steps = at.map((i) => scenario.steps[i]);
  if (scenario.start !== path.start) {
    return { ok: false, kind: 'start', expected: path.start, actual: scenario.start, message: `start が経路と一致しません（期待: ${path.start}、実際: ${scenario.start}）` };
  }
  if (steps.length !== path.transitions.length) {
    const e = String(path.transitions.length);
    const a = String(steps.length);
    return { ok: false, kind: 'count', expected: e, actual: a, message: `ステップ数が経路の遷移数と一致しません（期待: ${e}、実際: ${a}）` };
  }
  for (let i = 0; i < path.transitions.length; i++) {
    const expected = transitionLabel(path.transitions[i]);
    const actual = normalizeEvent(steps[i].event ?? '');
    if (expected !== actual) return { ok: false, kind: 'event', step: at[i], expected, actual, message: `ステップ ${at[i] + 1} の event が経路と一致しません（期待: ${expected}、実際: ${actual}）` };
  }
  for (let i = 0; i < path.transitions.length; i++) {
    const expected = path.transitions[i].to;
    const actual = steps[i].expect?.screen ?? '';
    if (expected !== actual) return { ok: false, kind: 'screen', step: at[i], expected, actual, message: `ステップ ${at[i] + 1} の expect.screen が遷移先と一致しません（期待: ${expected}、実際: ${actual}）` };
  }
  return { ok: true };
}
