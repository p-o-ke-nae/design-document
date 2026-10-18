// Browser-safe platform helpers (`only:` and step planning). No runtime imports.
import type { Expect } from './types.ts';

export const PLATFORMS = ['web', 'wpf', 'winforms'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const DESKTOP_PLATFORMS: readonly Platform[] = ['wpf', 'winforms'];
/** Values accepted by `only:` (`desktop` = wpf + winforms). */
export const ONLY_VALUES = ['web', 'wpf', 'winforms', 'desktop'] as const;
export type PlatformOrGroup = (typeof ONLY_VALUES)[number];
export type OnlyValue = PlatformOrGroup | PlatformOrGroup[];

export const isPlatform = (v: unknown): v is Platform => typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v);
export const isOnlyValue = (v: unknown): v is PlatformOrGroup => typeof v === 'string' && (ONLY_VALUES as readonly string[]).includes(v);

/** `only` values as a list (a single value becomes a one-element list). */
export function onlyList(only: string | readonly string[] | undefined): string[] {
  if (only === undefined) return [];
  return typeof only === 'string' ? [only] : [...only];
}

/** Platforms of `only` (`desktop` → wpf, winforms), unique, in `PLATFORMS` order. Unknown values are ignored. */
export function expandOnly(only: string | readonly string[] | undefined): Platform[] {
  const set = new Set<Platform>();
  for (const v of onlyList(only)) {
    if (v === 'desktop') DESKTOP_PLATFORMS.forEach((p) => set.add(p));
    else if (isPlatform(v)) set.add(v);
  }
  return PLATFORMS.filter((p) => set.has(p));
}

/** Minimal step shape for planning (the viewer's and the scenario's steps both fit). */
export interface PlanStep {
  event?: string;
  only?: string | readonly string[];
  expect?: Partial<Expect>;
}

/** Whether the step runs on `platform`: no `only`, or `expandOnly(only)` includes it. */
export function stepApplies(step: Pick<PlanStep, 'only'>, platform: Platform): boolean {
  return step.only === undefined || expandOnly(step.only).includes(platform);
}

/** `expect` with the screen always set (filled from the previous screen for auxiliary steps). */
export type PlannedExpect = Expect & { screen: string };

export interface StepPlan<S extends PlanStep = PlanStep> {
  /** 0-based index in the scenario file (auxiliary steps included). */
  index: number;
  step: S;
  /** false = skipped on this platform (`only`). */
  run: boolean;
  expect: PlannedExpect;
}

/**
 * Decides which steps run on `platform` and the expectation each one is judged with (detailed design: ステップの計画).
 * The "previous screen" starts at `scenario.start` and only changes on steps that run.
 */
export function planSteps<S extends PlanStep>(scenario: { start?: string; steps: readonly S[] }, platform: Platform): StepPlan<S>[] {
  let screen = scenario.start ?? '';
  return scenario.steps.map((step, index) => {
    const run = stepApplies(step, platform);
    const own = step.expect?.screen;
    const next = run && own !== undefined ? own : screen;
    if (run) screen = next;
    return { index, step, run, expect: { ...(step.expect ?? {}), screen: next } as PlannedExpect };
  });
}
